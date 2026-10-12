import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { EventName } from '../common/events/event.contants';
import { EnvironmentService } from '../integrations/environment/environment.service';

/**
 * OR-2 — git-sync's PageChangeListener runs in the API process: GitSyncModule
 * is not loaded in the separate collab process (collab-main). There, a stored
 * editor edit emits PAGE_UPDATED that no git-sync listener hears, so the edit
 * reached git only on the next poll. The collab process publishes its
 * PAGE_UPDATED events on this Redis channel, and every process running
 * CollaborationModule re-emits the ones ANOTHER process published, marked
 * `relayed` so they are never published again. Only while git-sync is on.
 */
export const PAGE_UPDATED_RELAY_CHANNEL = 'collab:page-updated';

// This process's id on the channel: a process skips what it published itself.
const PROCESS_ID = randomUUID();

interface PageUpdatedEvent {
  pageIds?: string[];
  workspaceId?: string;
  relayed?: boolean;
}

interface RelayMessage {
  origin: string;
  pageIds: string[];
  workspaceId?: string;
}

/** Registered in the collab process only (CollabAppModule). */
@Injectable()
export class PageUpdatedPublisher {
  private readonly logger = new Logger(PageUpdatedPublisher.name);
  private readonly redis: Redis;

  constructor(
    redisService: RedisService,
    private readonly environmentService: EnvironmentService,
  ) {
    this.redis = redisService.getOrThrow();
  }

  @OnEvent(EventName.PAGE_UPDATED)
  async onPageUpdated(event: PageUpdatedEvent): Promise<void> {
    if (event?.relayed || !event?.pageIds?.length) return;
    if (!this.environmentService.isGitSyncEnabled()) return;
    const message: RelayMessage = {
      origin: PROCESS_ID,
      pageIds: event.pageIds,
      workspaceId: event.workspaceId,
    };
    try {
      await this.redis.publish(
        PAGE_UPDATED_RELAY_CHANNEL,
        JSON.stringify(message),
      );
    } catch (err) {
      this.logger.error(
        `PAGE_UPDATED relay publish failed for page(s) ${event.pageIds.join(', ')}; ` +
          `git-sync picks the change up on its next poll: ` +
          (err instanceof Error ? err.message : String(err)),
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}

/** Registered wherever CollaborationModule is (the API and collab processes). */
@Injectable()
export class PageUpdatedSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PageUpdatedSubscriber.name);
  private sub: Redis | null = null;

  constructor(
    private readonly redisService: RedisService,
    private readonly environmentService: EnvironmentService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.environmentService.isGitSyncEnabled()) return;
    this.sub = this.redisService.getOrThrow().duplicate();
    this.sub.on('error', (err) =>
      this.logger.error(
        `PAGE_UPDATED relay subscription error: ${err.message}`,
        err.stack,
      ),
    );
    this.sub.on('message', (_channel: string, raw: string) =>
      this.onMessage(raw),
    );
    await this.sub.subscribe(PAGE_UPDATED_RELAY_CHANNEL);
  }

  async onModuleDestroy(): Promise<void> {
    const sub = this.sub;
    this.sub = null;
    if (!sub) return;
    try {
      await sub.quit();
    } catch (err) {
      this.logger.error(
        `PAGE_UPDATED relay unsubscribe failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      sub.disconnect();
    }
  }

  private onMessage(raw: string): void {
    let message: RelayMessage;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      this.logger.error(
        `PAGE_UPDATED relay: unparseable message dropped: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (message?.origin === PROCESS_ID) return;
    if (
      !Array.isArray(message?.pageIds) ||
      !message.pageIds.every((id) => typeof id === 'string')
    ) {
      this.logger.error(
        `PAGE_UPDATED relay: message without a pageIds list dropped`,
      );
      return;
    }
    const event: PageUpdatedEvent = {
      pageIds: message.pageIds,
      workspaceId: message.workspaceId,
      relayed: true,
    };
    this.eventEmitter.emit(EventName.PAGE_UPDATED, event);
  }
}
