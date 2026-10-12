/**
 * OR-2 — the PAGE_UPDATED relay between the collab process and the API
 * process, wired through a REAL Nest EventEmitterModule (the @OnEvent handlers
 * are registered by Nest, not called by hand) over an in-memory Redis pub/sub.
 * A message from another process is built exactly as that process's publisher
 * builds it.
 */
import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { EventName } from '../common/events/event.contants';
import { EnvironmentService } from '../integrations/environment/environment.service';
import {
  PAGE_UPDATED_RELAY_CHANNEL,
  PageUpdatedPublisher,
  PageUpdatedSubscriber,
} from './page-updated-relay';

class FakeRedisBus {
  published: { channel: string; message: string }[] = [];
  private subscribers: FakeRedis[] = [];

  client(): FakeRedis {
    return new FakeRedis(this);
  }

  add(sub: FakeRedis) {
    this.subscribers.push(sub);
  }

  async publish(channel: string, message: string) {
    this.published.push({ channel, message });
    for (const sub of this.subscribers) {
      if (sub.channels.has(channel)) {
        setImmediate(() => sub.listeners.forEach((l) => l(channel, message)));
      }
    }
    return 1;
  }
}

class FakeRedis {
  channels = new Set<string>();
  listeners: ((channel: string, message: string) => void)[] = [];
  quit = jest.fn(async () => 'OK');

  constructor(private readonly bus: FakeRedisBus) {}

  duplicate() {
    return this.bus.client();
  }

  publish(channel: string, message: string) {
    return this.bus.publish(channel, message);
  }

  async subscribe(channel: string) {
    this.channels.add(channel);
    this.bus.add(this);
  }

  on(event: string, listener: (channel: string, message: string) => void) {
    if (event === 'message') this.listeners.push(listener);
    return this;
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function startProcess(bus: FakeRedisBus, gitSyncEnabled: boolean) {
  const moduleRef = await Test.createTestingModule({
    imports: [EventEmitterModule.forRoot()],
    providers: [
      PageUpdatedPublisher,
      PageUpdatedSubscriber,
      { provide: RedisService, useValue: { getOrThrow: () => bus.client() } },
      {
        provide: EnvironmentService,
        useValue: { isGitSyncEnabled: () => gitSyncEnabled },
      },
    ],
  }).compile();
  await moduleRef.init();
  const emitter = moduleRef.get(EventEmitter2);
  const received: any[] = [];
  emitter.on(EventName.PAGE_UPDATED, (event) => received.push(event));
  return { moduleRef, emitter, received };
}

describe('PAGE_UPDATED relay (OR-2)', () => {
  it('publishes a local PAGE_UPDATED and does not re-emit its own message', async () => {
    const bus = new FakeRedisBus();
    const { moduleRef, emitter, received } = await startProcess(bus, true);

    emitter.emit(EventName.PAGE_UPDATED, {
      pageIds: ['p1'],
      workspaceId: 'w1',
    });
    await settle();
    await settle();

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].channel).toBe(PAGE_UPDATED_RELAY_CHANNEL);
    expect(JSON.parse(bus.published[0].message)).toMatchObject({
      pageIds: ['p1'],
      workspaceId: 'w1',
    });
    // Only the original event: the process skipped its own relay message.
    expect(received).toEqual([{ pageIds: ['p1'], workspaceId: 'w1' }]);
    await moduleRef.close();
  });

  it("re-emits another process's PAGE_UPDATED as relayed, and never republishes it", async () => {
    const bus = new FakeRedisBus();
    const { moduleRef, received } = await startProcess(bus, true);

    await bus.publish(
      PAGE_UPDATED_RELAY_CHANNEL,
      JSON.stringify({ origin: 'collab-process', pageIds: ['p2'] }),
    );
    await settle();
    await settle();

    expect(received).toEqual([
      { pageIds: ['p2'], workspaceId: undefined, relayed: true },
    ]);
    // The relayed event did not go back on the channel (no loop).
    expect(bus.published).toHaveLength(1);
    await moduleRef.close();
  });

  it('drops a message without a pageIds list', async () => {
    const bus = new FakeRedisBus();
    const { moduleRef, received } = await startProcess(bus, true);
    jest
      .spyOn((moduleRef.get(PageUpdatedSubscriber) as any).logger, 'error')
      .mockImplementation(() => undefined);

    await bus.publish(PAGE_UPDATED_RELAY_CHANNEL, '{"origin":"x"}');
    await bus.publish(PAGE_UPDATED_RELAY_CHANNEL, 'not json');
    await settle();

    expect(received).toEqual([]);
    await moduleRef.close();
  });

  it('is inert while git-sync is off', async () => {
    const bus = new FakeRedisBus();
    const { moduleRef, emitter, received } = await startProcess(bus, false);

    emitter.emit(EventName.PAGE_UPDATED, { pageIds: ['p3'] });
    await bus.publish(
      PAGE_UPDATED_RELAY_CHANNEL,
      JSON.stringify({ origin: 'collab-process', pageIds: ['p4'] }),
    );
    await settle();

    expect(bus.published).toHaveLength(1); // only the injected one
    expect(received).toEqual([{ pageIds: ['p3'] }]);
    await moduleRef.close();
  });
});
