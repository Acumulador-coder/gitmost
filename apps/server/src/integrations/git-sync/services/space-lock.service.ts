import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  GIT_SYNC_LOCK_PREFIX,
  GIT_SYNC_LOCK_TTL_MS,
} from '../git-sync.constants';

/**
 * Thrown (and used as the abort reason) when a locked space operation outlives
 * its wall-clock deadline (`withSpaceLock`'s `deadlineMs`).
 */
export class GitSyncDeadlineError extends Error {
  constructor(
    public readonly spaceId: string,
    public readonly deadlineMs: number,
  ) {
    super(
      `git-sync: space ${spaceId}: the locked operation exceeded its ` +
        `${deadlineMs} ms deadline and was aborted`,
    );
    this.name = 'GitSyncDeadlineError';
  }
}

/**
 * The per-space lock used by the git-sync control plane: an in-process per-space
 * mutex (no overlapping cycles on one instance) PLUS a Redis leader lock
 * (single writer across replicas).
 *
 * KNOWN MULTI-REPLICA GAP: there are no fencing tokens. If a holder's Redis key
 * lapses (TTL expiry while a heartbeat refresh failed), another replica can
 * acquire it while the first holder is still running; the first holder's next
 * refresh CAS-misses and aborts its signal, but writes already in flight are not
 * rejected by the store. Deployments are single-instance until that is built.
 */
@Injectable()
export class SpaceLockService {
  private readonly logger = new Logger(SpaceLockService.name);
  private readonly redis: Redis;
  /** Unique per process instance — the leader-lock value (CAS on release). */
  private readonly instanceId = randomUUID();
  /** In-process per-space mutex: spaceIds held (or being entered) on this process. */
  private readonly running = new Set<string>();

  constructor(redisService: RedisService) {
    this.redis = redisService.getOrThrow();
  }

  // --- Redis leader lock -----------------------------------------

  /**
   * Acquire per-space leadership: `SET <key> <instanceId> PX <ttl> NX` returns
   * 'OK' only when the key did not exist. Any other reply means another replica
   * holds it.
   */
  private async acquire(spaceId: string): Promise<boolean> {
    const ok = await this.redis.set(
      GIT_SYNC_LOCK_PREFIX + spaceId,
      this.instanceId,
      'PX',
      GIT_SYNC_LOCK_TTL_MS,
      'NX',
    );
    return ok === 'OK';
  }

  /**
   * Release the lock with a CAS Lua so we only delete it when WE still hold it
   * (the value matches our instanceId) — never another replica's lock that took
   * over after our TTL expired.
   */
  private async release(spaceId: string): Promise<void> {
    const lua =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
    try {
      await this.redis.eval(lua, 1, GIT_SYNC_LOCK_PREFIX + spaceId, this.instanceId);
    } catch (err) {
      this.logger.warn(
        `git-sync: failed to release lock for space ${spaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * CAS-guarded TTL refresh: extend the lock's TTL ONLY while WE still own it
   * (the stored value matches our instanceId) — never extend another replica's
   * lock that took over after our TTL expired. Used by the heartbeat in
   * `withSpaceLock` so a long-running push (client-controlled receive-pack + the
   * Docmost cycle) cannot outlive the lock and let a concurrent cycle race the
   * vault. Never throws (a thrown timer callback would crash the process),
   * but a refresh it cannot CONFIRM is treated as a LOST lock: it aborts the
   * supplied controller so the in-flight protected fn stops instead of writing
   * blind while another replica may already have taken over the lock.
   */
  private async refreshLock(
    spaceId: string,
    controller?: AbortController,
  ): Promise<void> {
    const lua =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
    try {
      const res = await this.redis.eval(
        lua,
        1,
        GIT_SYNC_LOCK_PREFIX + spaceId,
        this.instanceId,
        String(GIT_SYNC_LOCK_TTL_MS),
      );
      // CAS miss (res !== 1): we no longer own the key — our TTL lapsed and
      // another replica may hold it now. Abort the in-flight cycle rather than
      // swallowing the loss and racing the vault.
      if (res !== 1) {
        this.logger.warn(
          `git-sync: lock for space ${spaceId} lost during refresh — aborting in-flight cycle`,
        );
        controller?.abort();
      }
    } catch (err) {
      this.logger.warn(
        `git-sync: failed to refresh lock for space ${spaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // A refresh we cannot confirm means we may no longer hold the lock; abort.
      controller?.abort();
    }
  }

  /**
   * Options for `withSpaceLock`. `acquireRetry` (PUSH path only) bounds a
   * retry-acquire loop: if the lock cannot be entered on the first try, keep
   * retrying with a capped exponential backoff until `timeoutMs` elapses before
   * returning the skip sentinel. The poll cycle holds the lock while it
   * processes a whole space, so a legitimate external push that briefly overlaps
   * a cycle should WAIT a moment rather than immediately 503 (under continuous
   * polling most pushes would). The poll cycle passes NO retry (it
   * just skips and the next tick reconciles).
   *
   * `deadlineMs` bounds `fn` in wall-clock time. When it passes, the
   * signal handed to `fn` is aborted with a `GitSyncDeadlineError`, the lease
   * stops being renewed (so the Redis lock lapses within its TTL even if `fn`
   * ignores the abort) and this call rejects with that error at once, so the
   * caller is never blocked by a hung `fn`. The space stays reserved on this
   * process until `fn` really settles: two writers never share the vault.
   */
  async withSpaceLock<T>(
    spaceId: string,
    fn: (signal: AbortSignal) => Promise<T>,
    options?: {
      acquireRetry?: { timeoutMs: number; baseMs: number; maxMs: number };
      deadlineMs?: number;
    },
  ): Promise<T | { skipped: 'lock-held' | 'in-progress' }> {
    const retry = options?.acquireRetry;
    // Deadline for the bounded retry-acquire (push path). `Date.now()` once so a
    // slow first attempt does not over-extend the budget.
    const deadline = retry ? Date.now() + retry.timeoutMs : 0;
    let attempt = 0;
    for (;;) {
      // Reserve the in-process slot synchronously (before any await) so two
      // concurrent same-space calls on THIS instance cannot both pass the guard
      // and race acquire(). On any failure this is released before we retry/skip.
      const reservation = this.tryReserveInProcess(spaceId);
      if (reservation) {
        // Could not even reserve in-process (this instance mid-cycle). Retry
        // within the bound, else skip.
        if (retry && Date.now() < deadline) {
          await this.sleep(this.nextBackoff(attempt++, retry, deadline));
          continue;
        }
        return reservation;
      }
      // Reserved in-process — now contend for the Redis leader lock. Release the
      // in-process slot on EVERY non-running path so a retry/skip leaves no leak.
      let acquired = false;
      try {
        acquired = await this.acquire(spaceId);
      } finally {
        if (!acquired) this.releaseInProcess(spaceId);
      }
      if (!acquired) {
        if (retry && Date.now() < deadline) {
          await this.sleep(this.nextBackoff(attempt++, retry, deadline));
          continue;
        }
        return { skipped: 'lock-held' };
      }
      return this.runHeld(spaceId, fn, options?.deadlineMs);
    }
  }

  /**
   * Run `fn` with both locks held, under the lease heartbeat, releasing both in
   * `finally`. With `deadlineMs`, see `withSpaceLock`.
   */
  private runHeld<T>(
    spaceId: string,
    fn: (signal: AbortSignal) => Promise<T>,
    deadlineMs?: number,
  ): Promise<T> {
    // Lost-lock signal: a failed/CAS-missed heartbeat refresh (or the deadline)
    // aborts this so the protected fn can stop instead of writing blind.
    const controller = new AbortController();
    // Heartbeat: periodically (≈ TTL/3) extend the lock's TTL while `fn` runs so
    // a long push (client-controlled receive-pack + the Docmost cycle) cannot
    // outlive the fixed TTL and let a concurrent cycle race the vault. The
    // refresh is CAS-guarded (only extends while WE own it). `.unref()` keeps the
    // timer from holding the event loop open; it is ALWAYS cleared in `finally`.
    const heartbeat = setInterval(() => {
      void this.refreshLock(spaceId, controller);
    }, Math.max(1, Math.floor(GIT_SYNC_LOCK_TTL_MS / 3)));
    heartbeat.unref?.();
    const run = (async () => {
      try {
        return await fn(controller.signal);
      } finally {
        clearInterval(heartbeat);
        await this.release(spaceId);
        this.releaseInProcess(spaceId);
      }
    })();
    if (!deadlineMs) return run;

    return new Promise<T>((resolve, reject) => {
      const startedAt = Date.now();
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        // Stop renewing the lease: the lock now ends within its TTL however
        // long `fn` takes to notice the abort.
        clearInterval(heartbeat);
        const err = new GitSyncDeadlineError(spaceId, deadlineMs);
        this.logger.error(
          `${err.message}; its lock is no longer renewed, and the space stays ` +
            `busy on this process until the aborted work settles`,
        );
        controller.abort(err);
        reject(err);
      }, deadlineMs);
      timer.unref?.();
      run.then(
        (value) => {
          clearTimeout(timer);
          if (!expired) {
            resolve(value);
            return;
          }
          this.logger.warn(
            `git-sync: space ${spaceId}: the operation aborted at its deadline ` +
              `settled after ${Date.now() - startedAt} ms; the space is free again`,
          );
        },
        (err) => {
          clearTimeout(timer);
          if (!expired) {
            reject(err);
            return;
          }
          this.logger.error(
            `git-sync: space ${spaceId}: the operation aborted at its deadline ` +
              `settled after ${Date.now() - startedAt} ms with: ${
                err instanceof Error ? err.message : String(err)
              }; the space is free again`,
            err instanceof Error ? err.stack : undefined,
          );
        },
      );
    });
  }

  /**
   * Synchronously try to reserve the in-process single-writer slot for a space.
   * Returns a skip sentinel when a writer on this process holds it, or `null`
   * when the slot was reserved (caller MUST `releaseInProcess` later). The check
   * and the reservation happen with NO await between them so two concurrent
   * same-space calls cannot both pass.
   */
  private tryReserveInProcess(
    spaceId: string,
  ): { skipped: 'in-progress' } | null {
    if (this.running.has(spaceId)) {
      return { skipped: 'in-progress' };
    }
    this.running.add(spaceId);
    return null;
  }

  /** Release the in-process single-writer slot reserved by tryReserveInProcess. */
  private releaseInProcess(spaceId: string): void {
    this.running.delete(spaceId);
  }

  /**
   * Backoff (ms) before the next push lock-acquire attempt: capped exponential
   * (`baseMs * 2^attempt`, ceilinged at `maxMs`) clamped so it never overshoots
   * the retry `deadline`. Deterministic (no jitter) so the bound is testable.
   */
  private nextBackoff(
    attempt: number,
    retry: { baseMs: number; maxMs: number },
    deadline: number,
  ): number {
    const exp = retry.baseMs * 2 ** attempt;
    const capped = Math.min(exp, retry.maxMs);
    const remaining = Math.max(0, deadline - Date.now());
    return Math.max(0, Math.min(capped, remaining));
  }

  /** Promise-based delay (extracted so tests can reason about the retry loop). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }
}
