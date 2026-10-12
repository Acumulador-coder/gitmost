// Custom-event request/reply protocol in RedisSyncExtension. git-sync routes
// its body write through a custom event (`gitSyncWriteBody`) which, when the doc
// is owned by another collab instance, runs remotely inside
// `handleRedisMessage`. The remote handler can THROW (markdown->ProseMirror
// transform on a malformed body); the throw must become an error-carrying
// `customEventComplete` reply that rejects the origin promptly with the real
// message (not a 'TIMEOUT' after customEventTTL, and no unhandledRejection on
// the owning instance). The no-throw and local paths stay unchanged.

import { RedisSyncExtension } from './redis-sync.extension';

type Listener = (channel: Buffer, message: Buffer) => unknown;

// Minimal in-memory pub/sub + lock store shared across FakeRedis duplicates,
// modelling the two-instance topology (origin + owner) over one Redis.
class FakeRedisBus {
  instances: FakeRedis[] = [];
  locks = new Map<string, string>();
  published: { channel: string; message: Buffer }[] = [];

  register(inst: FakeRedis) {
    this.instances.push(inst);
  }

  publish(channel: string, message: Buffer) {
    this.published.push({ channel, message });
    for (const inst of this.instances) {
      if (!inst.subscribed.has(channel)) continue;
      for (const listener of inst.messageListeners) {
        // ioredis delivers async; `void` mirrors the production listener
        // registration (`sub.on('messageBuffer', ...)`), whose rejection would
        // surface as an unhandledRejection if the handler did not catch.
        void listener(Buffer.from(channel), message);
      }
    }
  }
}

class FakeRedis {
  subscribed = new Set<string>();
  messageListeners: Listener[] = [];

  constructor(private bus: FakeRedisBus) {
    bus.register(this);
  }

  duplicate() {
    return new FakeRedis(this.bus);
  }

  subscribe(...channels: string[]) {
    for (const c of channels) this.subscribed.add(c);
    return Promise.resolve();
  }

  on(event: string, cb: any) {
    if (event === 'messageBuffer') this.messageListeners.push(cb as Listener);
    return this;
  }

  publish(channel: string, message: Buffer) {
    this.bus.publish(channel, message);
    return Promise.resolve(1);
  }

  // Models `SET key val PX ttl NX GET`: only writes when absent (NX); returns the
  // previous value (GET) so the origin observes the owner already holding the lock.
  set(key: string, val: string, ...args: any[]) {
    const hasNX = args.includes('NX');
    const hasGET = args.includes('GET');
    const old = this.bus.locks.get(key) ?? null;
    if (!hasNX || old === null) this.bus.locks.set(key, val);
    return Promise.resolve(hasGET ? old : 'OK');
  }

  del(key: string) {
    this.bus.locks.delete(key);
    return Promise.resolve(1);
  }

  disconnect() {}
}

const pack = (m: any) => Buffer.from(JSON.stringify(m));
const unpack = (b: Buffer) => JSON.parse(b.toString());

function makeExtension(
  bus: FakeRedisBus,
  serverId: string,
  customEvents: Record<string, (doc: string, payload: any) => Promise<any>>,
) {
  const ext = new RedisSyncExtension({
    redis: new FakeRedis(bus) as any,
    pack: pack as any,
    unpack: unpack as any,
    serverId,
    customEvents: customEvents as any,
    customEventTTL: 30_000,
  });
  // Doc is NOT loaded on this instance -> handleEvent takes the remote/proxy path.
  (ext as any).instance = { documents: new Map() };
  return ext;
}

describe('RedisSyncExtension custom-event error propagation', () => {
  let unhandled: unknown[];
  let onUnhandled: (e: unknown) => void;

  beforeEach(() => {
    // Fake timers so the 30s TTL fallback timer never fires (and never dangles).
    jest.useFakeTimers();
    unhandled = [];
    onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    jest.useRealTimers();
  });

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('owner publishes an error-carrying reply (no unhandledRejection) when the remote handler throws', async () => {
    const bus = new FakeRedisBus();
    const owner = makeExtension(bus, 'owner', {
      boom: async () => {
        throw new Error('kaboom');
      },
    });

    // Drive the remote branch directly, as if the origin's customEventStart arrived.
    await (owner as any).handleRedisMessage(
      Buffer.from('collabMsg:owner'),
      pack({
        type: 'customEventStart',
        documentName: 'page.x',
        eventName: 'boom',
        payload: {},
        replyTo: 'collabMsg:origin',
        replyId: 7,
      }),
    );
    await flush();

    const replies = bus.published
      .filter((p) => p.channel === 'collabMsg:origin')
      .map((p) => unpack(p.message));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      type: 'customEventComplete',
      replyId: 7,
      error: 'kaboom',
    });
    expect(unhandled).toHaveLength(0);
  });

  it('origin rejects PROMPTLY with the real error (not a TTL TIMEOUT) when the remote handler throws', async () => {
    const bus = new FakeRedisBus();
    // Owner already holds the document lock.
    bus.locks.set('collabLock:page.x', 'owner');
    makeExtension(bus, 'owner', {
      boom: async () => {
        throw new Error('kaboom');
      },
    });
    const origin = makeExtension(bus, 'origin', {
      boom: async () => undefined,
    });

    const promise = (origin as any).handleEvent('boom', 'page.x', { foo: 1 });
    // Attach a catch immediately so a rejection is never momentarily unhandled.
    const settled = promise.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await flush();
    // Resolves WITHOUT advancing any timer -> the 30s TIMEOUT fallback did not fire.
    const result = await settled;
    expect(result.ok).toBe(false);
    expect((result as any).error).toBeInstanceOf(Error);
    expect(((result as any).error as Error).message).toBe('kaboom');
    expect(unhandled).toHaveLength(0);
  });

  it('origin resolves with the payload when the remote handler succeeds (unchanged behavior)', async () => {
    const bus = new FakeRedisBus();
    bus.locks.set('collabLock:page.x', 'owner');
    makeExtension(bus, 'owner', {
      ok: async (_doc: string, payload: any) => ({ echoed: payload }),
    });
    const origin = makeExtension(bus, 'origin', {
      ok: async () => undefined,
    });

    const promise = (origin as any).handleEvent('ok', 'page.x', { foo: 1 });
    await flush();
    await expect(promise).resolves.toEqual({ echoed: { foo: 1 } });
    expect(unhandled).toHaveLength(0);
  });

  it('an aborted origin call rejects at once with the reason and aborts the remote handler', async () => {
    const bus = new FakeRedisBus();
    bus.locks.set('collabLock:page.x', 'owner');
    let ownerSignal: AbortSignal | undefined;
    let release!: () => void;
    makeExtension(bus, 'owner', {
      slow: (_doc: string, _payload: any, signal?: AbortSignal) => {
        ownerSignal = signal;
        return new Promise<void>((resolve) => (release = resolve));
      },
    } as any);
    const origin = makeExtension(bus, 'origin', {
      slow: async () => undefined,
    });

    const controller = new AbortController();
    const promise = (origin as any).handleEvent(
      'slow',
      'page.x',
      {},
      controller.signal,
    );
    const settled = promise.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );
    await flush();
    expect(ownerSignal?.aborted).toBe(false);

    const reason = new Error('write deadline passed');
    controller.abort(reason);
    await flush();

    expect(await settled).toEqual({ ok: false, error: reason });
    expect(ownerSignal?.aborted).toBe(true);
    // The owner's late reply finds no pending entry and is dropped.
    release();
    await flush();
    expect((origin as any).pendingReplies).toEqual({});
    expect(unhandled).toHaveLength(0);
  });

  it('a lost reply rejects with an Error naming the event, the document and the owner', async () => {
    const bus = new FakeRedisBus();
    bus.locks.set('collabLock:page.x', 'owner'); // nobody answers as 'owner'
    const origin = makeExtension(bus, 'origin', { ok: async () => undefined });

    const promise = (origin as any).handleEvent('ok', 'page.x', {});
    const settled = promise.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );
    await flush();
    jest.advanceTimersByTime(30_000);

    const result: any = await settled;
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe(
      'collab event "ok" for page.x: no reply from the owning instance owner within 30000 ms',
    );
  });
});
