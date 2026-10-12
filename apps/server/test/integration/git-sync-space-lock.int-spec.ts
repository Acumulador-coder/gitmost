import Redis from 'ioredis';
import { Logger } from '@nestjs/common';
import { SpaceLockService } from 'src/integrations/git-sync/services/space-lock.service';
import {
  GIT_SYNC_LOCK_PREFIX,
  GIT_SYNC_LOCK_TTL_MS,
} from 'src/integrations/git-sync/git-sync.constants';

/**
 * TP-2 — the git-sync per-space lock against REAL Redis (logical DB 15, so
 * nothing touches dev data). The unit specs run the lock against a fake; this
 * one executes the real `SET NX PX` acquire and the two Lua CAS scripts
 * (release, heartbeat refresh) on a Redis server. Each SpaceLockService stands
 * for one replica (its own instance id).
 */
describe('SpaceLockService vs real Redis [integration]', () => {
  let redis: Redis;
  const SPACE = 'int-space';
  const KEY = GIT_SYNC_LOCK_PREFIX + SPACE;
  const HEARTBEAT_MS = Math.max(1, Math.floor(GIT_SYNC_LOCK_TTL_MS / 3));

  const replica = () =>
    new SpaceLockService({ getOrThrow: () => redis } as any);

  /** Poll until `cond` holds (real I/O in between). */
  async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
    const end = Date.now() + 5_000;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error('condition not reached in time');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Hold the space on `holder` until the returned `release()` is called; also
   * exposes the fn's abort signal and the heartbeat callback withSpaceLock
   * registered (captured so a test can fire a refresh without waiting TTL/3).
   */
  async function hold(holder: SpaceLockService) {
    const intervalSpy = jest.spyOn(global, 'setInterval');
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = holder.withSpaceLock(SPACE, async (s) => {
      signal = s;
      await gate;
      return 'held';
    });
    await until(() => signal !== undefined);
    const call = intervalSpy.mock.calls.find(([, ms]) => ms === HEARTBEAT_MS);
    intervalSpy.mockRestore();
    if (!call) throw new Error('heartbeat interval was not registered');
    return {
      result,
      release,
      signal: signal as AbortSignal,
      heartbeat: call[0] as () => void,
    };
  }

  beforeAll(async () => {
    // db:15 keeps this off the app's db 0, so dev Redis data is never touched.
    const url = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
    redis = new Redis(url, { db: 15, lazyConnect: false });
    // Surface an unreachable/wrong Redis here with a clear error, not mid-test.
    await redis.ping();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('a second holder gets lock-held while the first holds the space', async () => {
    const a = replica();
    const b = replica();
    const held = await hold(a);
    const fn = jest.fn(async () => 'b');

    await expect(b.withSpaceLock(SPACE, fn)).resolves.toEqual({
      skipped: 'lock-held',
    });
    expect(fn).not.toHaveBeenCalled();

    held.release();
    await expect(held.result).resolves.toBe('held');
  });

  it('release deletes the key, after which another holder acquires it', async () => {
    const a = replica();
    const b = replica();
    const held = await hold(a);
    expect(await redis.exists(KEY)).toBe(1);

    held.release();
    await held.result;
    expect(await redis.exists(KEY)).toBe(0);

    await expect(b.withSpaceLock(SPACE, async () => 'b-ran')).resolves.toBe(
      'b-ran',
    );
  });

  it('a heartbeat refresh extends the key PTTL back to the full TTL', async () => {
    const held = await hold(replica());
    await redis.pexpire(KEY, 1_000);
    expect(await redis.pttl(KEY)).toBeLessThanOrEqual(1_000);

    held.heartbeat();
    await until(async () => (await redis.pttl(KEY)) > 1_000);
    expect(await redis.pttl(KEY)).toBeLessThanOrEqual(GIT_SYNC_LOCK_TTL_MS);
    expect(held.signal.aborted).toBe(false);

    held.release();
    await held.result;
  });

  it('a refresh after another holder took the key over aborts the fn', async () => {
    const held = await hold(replica());
    // Takeover: the key now holds another replica's instance id.
    await redis.set(KEY, 'other-replica', 'PX', GIT_SYNC_LOCK_TTL_MS);

    held.heartbeat();
    await until(() => held.signal.aborted);
    // The refresh did not extend the other holder's key into ours.
    expect(await redis.get(KEY)).toBe('other-replica');

    held.release();
    await held.result;
  });

  it("release never deletes another holder's key", async () => {
    const held = await hold(replica());
    await redis.set(KEY, 'other-replica', 'PX', GIT_SYNC_LOCK_TTL_MS);

    held.release();
    await held.result;

    expect(await redis.get(KEY)).toBe('other-replica');
  });
});
