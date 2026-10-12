import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { EventName } from '../common/events/event.contants';

/**
 * CO-2 — the events that change who may open a page are emitted in the API
 * process, but AuthenticationExtension re-checks the open connections in the
 * process that holds them: in production the separate collab process
 * (collab-main). The API process publishes these events on this Redis channel,
 * and the collab process re-emits the ones ANOTHER process published under ONE
 * name, COLLAB_ACCESS_RELAYED: the API-side listeners of the original events
 * (AI queue jobs, loaded in the collab process too) do not run twice, and a
 * relayed event is never published again.
 */
export const COLLAB_ACCESS_RELAY_CHANNEL = 'collab:access-changed';

/**
 * The ONE list of the events that change who may open a page. The publisher
 * relays exactly these, and AuthenticationExtension's @OnEvent handlers must
 * listen to exactly these (plus COLLAB_ACCESS_RELAYED): collab-access-relay.spec
 * reads the extension's listener metadata and fails on any drift, so an event
 * the extension handles can never miss the separate collab process.
 */
export const COLLAB_ACCESS_EVENTS = [
  EventName.COLLAB_ACCESS_CHANGED,
  EventName.PAGE_SOFT_DELETED,
  EventName.PAGE_RESTORED,
  EventName.PAGE_DELETED,
  EventName.SPACE_DELETED,
] as const;

const RELAYED_EVENTS: ReadonlySet<string> = new Set(COLLAB_ACCESS_EVENTS);

// This process's id on the channel: a process skips what it published itself.
const PROCESS_ID = randomUUID();

// The fields of an access event the re-check reads; nothing else is relayed.
interface AccessEvent {
  workspaceId?: string;
  spaceId?: string;
  pageIds?: string[];
  userIds?: string[];
}

interface RelayMessage {
  origin: string;
  event: string;
  payload: AccessEvent;
}

/** Registered in the API process only (AppModule). */
@Injectable()
export class CollabAccessPublisher implements OnModuleInit {
  private readonly logger = new Logger(CollabAccessPublisher.name);
  private readonly redis: Redis;

  constructor(
    redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.redis = redisService.getOrThrow();
  }

  // One listener per event of COLLAB_ACCESS_EVENTS, so each knows the event it
  // relays. Not `@OnEvent(COLLAB_ACCESS_EVENTS)`: with the default
  // (non-wildcard) EventEmitter2 an array registers ONE listener under the
  // comma-joined name, which no emit ever matches. The event-emitter module
  // removes these with its own listeners on application shutdown.
  onModuleInit(): void {
    for (const event of COLLAB_ACCESS_EVENTS) {
      this.eventEmitter.on(event, (payload: AccessEvent) =>
        this.publish(event, payload),
      );
    }
  }

  private async publish(event: EventName, payload: AccessEvent) {
    const message: RelayMessage = {
      origin: PROCESS_ID,
      event,
      payload: {
        workspaceId: payload?.workspaceId,
        spaceId: payload?.spaceId,
        pageIds: payload?.pageIds,
        userIds: payload?.userIds,
      },
    };
    try {
      await this.redis.publish(
        COLLAB_ACCESS_RELAY_CHANNEL,
        JSON.stringify(message),
      );
    } catch (err) {
      this.logger.error(
        `${event} relay publish failed (workspace ${payload?.workspaceId}); ` +
          `the collab process re-checks its open documents only on their ` +
          `next token re-check or reconnect: ` +
          (err instanceof Error ? err.message : String(err)),
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}

/** Registered in the collab process (CollabAppModule). */
@Injectable()
export class CollabAccessSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CollabAccessSubscriber.name);
  private sub: Redis | null = null;

  constructor(
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    this.sub = this.redisService.getOrThrow().duplicate();
    this.sub.on('error', (err) =>
      this.logger.error(
        `Access relay subscription error: ${err.message}`,
        err.stack,
      ),
    );
    this.sub.on('message', (_channel: string, raw: string) =>
      this.onMessage(raw),
    );
    await this.sub.subscribe(COLLAB_ACCESS_RELAY_CHANNEL);
  }

  async onModuleDestroy(): Promise<void> {
    const sub = this.sub;
    this.sub = null;
    if (!sub) return;
    try {
      await sub.quit();
    } catch (err) {
      this.logger.error(
        `Access relay unsubscribe failed: ` +
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
        `Access relay: unparseable message dropped: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (message?.origin === PROCESS_ID) return;
    const payload = message?.payload;
    if (
      !RELAYED_EVENTS.has(message?.event) ||
      typeof payload !== 'object' ||
      payload === null ||
      !isStringList(payload.pageIds) ||
      !isStringList(payload.userIds)
    ) {
      this.logger.error(
        `Access relay: malformed message for event ${message?.event} dropped`,
      );
      return;
    }
    this.eventEmitter.emit(EventName.COLLAB_ACCESS_RELAYED, {
      event: message.event,
      payload,
    });
  }
}

function isStringList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((id) => typeof id === 'string'))
  );
}
