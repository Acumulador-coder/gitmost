// The KNOWN multi-replica gap of the per-space lock, stated as it is. Two
// SpaceLockService instances stand for two replicas sharing ONE redis store. If A's lock key lapses while A is still running (TTL
// expiry after its heartbeat refresh failed), nothing stops replica B from
// acquiring it and running concurrently: there are no fencing tokens. The only
// mitigation is that A's next heartbeat refresh CAS-misses and aborts A's
// signal. This spec pins both halves so a change to either is deliberate.
// (Within ONE process the in-process `running` set is the single-writer guard;
// that is covered by space-lock.service.spec.ts.)
import { Logger } from '@nestjs/common';
import { SpaceLockService } from './space-lock.service';
import {
  GIT_SYNC_LOCK_PREFIX,
  GIT_SYNC_LOCK_TTL_MS,
} from '../git-sync.constants';

/**
 * Minimal shared fake redis honoring exactly the two primitives the lock uses:
 *   - `SET key val PX ttl NX` → 'OK' only when the key is absent (NX semantics).
 *   - `eval(<get/del CAS>|<get/pexpire CAS>, 1, key, instanceId[, ttl])` →
 *     compares the stored value to ARGV[1] before del/pexpire (CAS).
 * TTL expiry is not time-driven here; tests simulate it by mutating `store`.
 */
function makeSharedRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, val: string, _px: 'PX', _ttl: number, nx: 'NX') {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, val);
      return 'OK';
    },
    async eval(
      lua: string,
      _numKeys: number,
      key: string,
      argInstanceId: string,
    ) {
      // Only act when WE still own the key (CAS), mirroring the Lua scripts.
      if (store.get(key) !== argInstanceId) return 0;
      if (lua.includes('del')) {
        store.delete(key);
        return 1;
      }
      // pexpire CAS refresh: value matches, "extend" is a no-op in the fake.
      return 1;
    },
  };
}

function buildInstance(redis: ReturnType<typeof makeSharedRedis>) {
  const redisService = { getOrThrow: jest.fn(() => redis) };
  return new SpaceLockService(redisService as any);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('SpaceLockService — known multi-replica gap (no fencing tokens)', () => {
  it("after A's key lapses, replica B CAN run concurrently with A; A's next heartbeat refresh then aborts A", async () => {
    jest.useFakeTimers();
    try {
      const redis = makeSharedRedis();
      const A = buildInstance(redis);
      const B = buildInstance(redis);

      let aRunning = false;
      let aSignal!: AbortSignal;
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      // A acquires 'X' and stays in-flight awaiting the gate.
      const aResult = A.withSpaceLock('X', async (signal) => {
        aSignal = signal;
        aRunning = true;
        await gateA;
        aRunning = false;
        return 'A-done';
      });
      await flushMicrotasks();
      expect(aRunning).toBe(true);
      expect(redis.store.has(GIT_SYNC_LOCK_PREFIX + 'X')).toBe(true);

      // TTL lapse with a failed heartbeat: the key vanishes while A runs.
      redis.store.delete(GIT_SYNC_LOCK_PREFIX + 'X');

      // THE GAP: B acquires the lapsed key and runs while A is still in flight.
      let bRanWhileARunning = false;
      const bResult = await B.withSpaceLock('X', async () => {
        bRanWhileARunning = aRunning;
        return 'B-done';
      });
      expect(bResult).toBe('B-done');
      expect(bRanWhileARunning).toBe(true);

      // B is done; a third holder now owns the key (as after any takeover).
      redis.store.set(GIT_SYNC_LOCK_PREFIX + 'X', 'replica-C');

      // THE MITIGATION: A's next heartbeat refresh CAS-misses and aborts A.
      expect(aSignal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(Math.floor(GIT_SYNC_LOCK_TTL_MS / 3));
      expect(aSignal.aborted).toBe(true);

      // A's release never deletes the key it no longer owns.
      releaseA();
      await expect(aResult).resolves.toBe('A-done');
      expect(redis.store.get(GIT_SYNC_LOCK_PREFIX + 'X')).toBe('replica-C');
    } finally {
      jest.useRealTimers();
    }
  });
});
