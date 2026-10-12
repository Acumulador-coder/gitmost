/**
 * CO-2 — the access-event relay from the API process to the collab process,
 * wired through REAL Nest EventEmitterModules (the @OnEvent handlers are
 * registered by Nest, not called by hand) over an in-memory Redis pub/sub. The
 * collab side runs the real AuthenticationExtension, so a relayed event is
 * shown to reach its re-check handlers. All "processes" here share this Jest
 * process's relay id, so a message from another process is the published one
 * re-sent with another origin, exactly as that process would send it.
 */
import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter/dist/constants';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { EventName } from '../common/events/event.contants';
import { TokenService } from '../core/auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { ApiKeyService } from '../core/api-key/api-key.service';
import { AuthenticationExtension } from './extensions/authentication.extension';
import {
  COLLAB_ACCESS_EVENTS,
  COLLAB_ACCESS_RELAY_CHANNEL,
  CollabAccessPublisher,
  CollabAccessSubscriber,
} from './collab-access-relay';

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

async function startProcess(bus: FakeRedisBus, providers: any[]) {
  const moduleRef = await Test.createTestingModule({
    imports: [EventEmitterModule.forRoot()],
    providers: [
      ...providers,
      { provide: RedisService, useValue: { getOrThrow: () => bus.client() } },
      { provide: TokenService, useValue: {} },
      { provide: UserRepo, useValue: {} },
      { provide: PageRepo, useValue: {} },
      { provide: SpaceMemberRepo, useValue: {} },
      { provide: PagePermissionRepo, useValue: {} },
      { provide: ApiKeyService, useValue: {} },
    ],
  }).compile();
  await moduleRef.init();
  const emitter = moduleRef.get(EventEmitter2);
  // `received`: the original events; `relayed`: COLLAB_ACCESS_RELAYED.
  const received: { event: string; payload: any }[] = [];
  for (const event of COLLAB_ACCESS_EVENTS) {
    emitter.on(event, (payload) => received.push({ event, payload }));
  }
  const relayed: { event: string; payload: any }[] = [];
  emitter.on(EventName.COLLAB_ACCESS_RELAYED, (e) => relayed.push(e));
  return { moduleRef, emitter, received, relayed };
}

describe('access-event relay (CO-2)', () => {
  it('an API-process access event reaches the collab process as COLLAB_ACCESS_RELAYED, with only the re-check fields', async () => {
    const bus = new FakeRedisBus();
    const api = await startProcess(bus, [CollabAccessPublisher]);
    const collab = await startProcess(bus, [
      CollabAccessSubscriber,
      AuthenticationExtension,
    ]);
    const ext = collab.moduleRef.get(AuthenticationExtension);
    const onAccessChanged = jest
      .spyOn(ext, 'onCollabAccessChanged')
      .mockResolvedValue(undefined);
    const onPagesAccessChanged = jest
      .spyOn(ext, 'onPagesAccessChanged')
      .mockResolvedValue(undefined);
    const onSpaceDeleted = jest
      .spyOn(ext, 'onSpaceDeleted')
      .mockResolvedValue(undefined);

    api.emitter.emit(EventName.COLLAB_ACCESS_CHANGED, {
      workspaceId: 'w1',
      spaceId: 's1',
      userIds: ['u1'],
    });
    api.emitter.emit(EventName.PAGE_SOFT_DELETED, {
      pageIds: ['p1'],
      workspaceId: 'w1',
      pages: [{ id: 'p1', title: 'not relayed' }],
    });
    api.emitter.emit(EventName.PAGE_RESTORED, {
      pageIds: ['p2'],
      workspaceId: 'w1',
      spaceId: 's1',
    });
    api.emitter.emit(EventName.PAGE_DELETED, {
      pageIds: ['p3'],
      workspaceId: 'w1',
    });
    api.emitter.emit(EventName.SPACE_DELETED, { spaceId: 's2' });
    await settle();
    await settle();

    expect(bus.published).toHaveLength(5);
    expect(
      bus.published.every((p) => p.channel === COLLAB_ACCESS_RELAY_CHANNEL),
    ).toBe(true);
    // Same relay id: the collab module skipped them as its own.
    expect(collab.relayed).toEqual([]);

    for (const { channel, message } of [...bus.published]) {
      await bus.publish(
        channel,
        JSON.stringify({ ...JSON.parse(message), origin: 'api-process' }),
      );
    }
    await settle();
    await settle();

    expect(collab.relayed).toEqual([
      {
        event: EventName.COLLAB_ACCESS_CHANGED,
        payload: { workspaceId: 'w1', spaceId: 's1', userIds: ['u1'] },
      },
      {
        event: EventName.PAGE_SOFT_DELETED,
        payload: { pageIds: ['p1'], workspaceId: 'w1' },
      },
      {
        event: EventName.PAGE_RESTORED,
        payload: { pageIds: ['p2'], workspaceId: 'w1', spaceId: 's1' },
      },
      {
        event: EventName.PAGE_DELETED,
        payload: { pageIds: ['p3'], workspaceId: 'w1' },
      },
      {
        event: EventName.SPACE_DELETED,
        payload: { spaceId: 's2' },
      },
    ]);
    // The original events are not re-emitted in the collab process, so their
    // other listeners there (AI queue jobs) do not run a second time.
    expect(collab.received).toEqual([]);
    // The extension's re-check handlers run on the relayed events.
    expect(onAccessChanged).toHaveBeenCalledWith(collab.relayed[0].payload);
    expect(onPagesAccessChanged.mock.calls.map(([e]) => e.pageIds)).toEqual([
      ['p1'],
      ['p2'],
      ['p3'],
    ]);
    expect(onSpaceDeleted).toHaveBeenCalledTimes(1);
    // The API process itself only saw its own five events, once each, and the
    // relayed ones were not published again.
    expect(api.received).toHaveLength(5);
    expect(bus.published).toHaveLength(10);
    await api.moduleRef.close();
    await collab.moduleRef.close();
  });

  it('a process running both skips its own message: each event is handled once', async () => {
    const bus = new FakeRedisBus();
    const both = await startProcess(bus, [
      CollabAccessPublisher,
      CollabAccessSubscriber,
    ]);

    both.emitter.emit(EventName.COLLAB_ACCESS_CHANGED, {
      workspaceId: 'w1',
      userIds: ['u1'],
    });
    await settle();
    await settle();

    expect(bus.published).toHaveLength(1);
    expect(both.received).toEqual([
      {
        event: EventName.COLLAB_ACCESS_CHANGED,
        payload: { workspaceId: 'w1', userIds: ['u1'] },
      },
    ]);
    await both.moduleRef.close();
  });

  it("re-emits another process's message as COLLAB_ACCESS_RELAYED and never republishes it", async () => {
    const bus = new FakeRedisBus();
    const both = await startProcess(bus, [
      CollabAccessPublisher,
      CollabAccessSubscriber,
    ]);

    // A message exactly as another process's publisher builds it.
    await bus.publish(
      COLLAB_ACCESS_RELAY_CHANNEL,
      JSON.stringify({
        origin: 'api-process',
        event: EventName.COLLAB_ACCESS_CHANGED,
        payload: { workspaceId: 'w1', userIds: ['u1'] },
      }),
    );
    await settle();
    await settle();

    expect(both.relayed).toEqual([
      {
        event: EventName.COLLAB_ACCESS_CHANGED,
        payload: { workspaceId: 'w1', userIds: ['u1'] },
      },
    ]);
    expect(both.received).toEqual([]);
    // Only the injected message: the relayed event did not go back out.
    expect(bus.published).toHaveLength(1);
    await both.moduleRef.close();
  });

  it('drops a message for an event it does not relay, or a malformed one', async () => {
    const bus = new FakeRedisBus();
    const collab = await startProcess(bus, [CollabAccessSubscriber]);
    const loggerError = jest
      .spyOn(
        (collab.moduleRef.get(CollabAccessSubscriber) as any).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    const otherEvents: any[] = [];
    collab.emitter.on(EventName.WORKSPACE_DELETED, (e) => otherEvents.push(e));

    await bus.publish(
      COLLAB_ACCESS_RELAY_CHANNEL,
      JSON.stringify({
        origin: 'x',
        event: EventName.WORKSPACE_DELETED,
        payload: { workspaceId: 'w1' },
      }),
    );
    await bus.publish(
      COLLAB_ACCESS_RELAY_CHANNEL,
      JSON.stringify({
        origin: 'x',
        event: EventName.PAGE_DELETED,
        payload: { pageIds: 'p1' },
      }),
    );
    await bus.publish(COLLAB_ACCESS_RELAY_CHANNEL, 'not json');
    await settle();

    expect(collab.relayed).toEqual([]);
    expect(otherEvents).toEqual([]);
    expect(loggerError).toHaveBeenCalledTimes(3);
    await collab.moduleRef.close();
  });
});

describe('COLLAB_ACCESS_EVENTS parity with AuthenticationExtension (AGENTS.md invariant 7)', () => {
  /**
   * Each AuthenticationExtension method registered as a listener, with the
   * event names it is registered for, read from the @OnEvent metadata Nest
   * subscribes them from. An array event is
   * kept as the comma-joined name EventEmitter2 actually registers it under
   * (no wildcard), so `@OnEvent([a, b])`, which never fires, fails here too.
   */
  function extensionListeners(): Map<string, string[]> {
    const prototype = AuthenticationExtension.prototype;
    const listeners = new Map<string, string[]>();
    for (const key of Object.getOwnPropertyNames(prototype)) {
      const method = Object.getOwnPropertyDescriptor(prototype, key)?.value;
      if (typeof method !== 'function') continue;
      const metadata: { event: unknown }[] =
        Reflect.getMetadata(EVENT_LISTENER_METADATA, method) ?? [];
      if (metadata.length === 0) continue;
      listeners.set(
        key,
        metadata.map(({ event }) => String(event)),
      );
    }
    return listeners;
  }

  it('the extension listens to exactly COLLAB_ACCESS_EVENTS, plus COLLAB_ACCESS_RELAYED', () => {
    const listened = new Set([...extensionListeners().values()].flat());
    // The relayed form of the same events, in the separate collab process.
    expect(listened.has(EventName.COLLAB_ACCESS_RELAYED)).toBe(true);
    listened.delete(EventName.COLLAB_ACCESS_RELAYED);

    expect([...listened].sort()).toEqual([...COLLAB_ACCESS_EVENTS].sort());
  });

  // onAccessEventRelayed routes a relayed event by name: it must reach the same
  // method as the original event does in a single process.
  it.each(COLLAB_ACCESS_EVENTS)(
    'a relayed %s reaches the method that carries @OnEvent of it',
    async (event) => {
      const listeners = extensionListeners();
      const handlers = [...listeners.keys()].filter(
        (method) =>
          !listeners.get(method).includes(EventName.COLLAB_ACCESS_RELAYED),
      );
      const expected = handlers.filter((method) =>
        listeners.get(method).includes(event),
      );
      expect(expected).toHaveLength(1);

      const collab = await startProcess(new FakeRedisBus(), [
        AuthenticationExtension,
      ]);
      const ext = collab.moduleRef.get(AuthenticationExtension);
      const spies = handlers.map((method) => ({
        method,
        spy: jest.spyOn(ext as any, method).mockResolvedValue(undefined),
      }));

      collab.emitter.emit(EventName.COLLAB_ACCESS_RELAYED, {
        event,
        payload: { workspaceId: 'w1', pageIds: ['p1'] },
      });
      await settle();

      expect(
        spies.map(({ method, spy }) => [method, spy.mock.calls.length]),
      ).toEqual(
        handlers.map((method) => [method, method === expected[0] ? 1 : 0]),
      );
      await collab.moduleRef.close();
    },
  );
});
