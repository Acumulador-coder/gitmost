import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import type { PullFailure, PushFailure, Settings } from '@docmost/git-sync';
import { loadGitSync } from '../git-sync.loader';
import { EnvironmentService } from '../../environment/environment.service';
import {
  incGitSyncCycle,
  setGitSyncFailingSpaces,
  setGitSyncPushFailingSpaces,
} from '../../metrics/metrics.registry';
import { GitmostDataSourceService } from './gitmost-datasource.service';
import { VaultRegistryService } from './vault-registry.service';
import { GitSyncDeadlineError, SpaceLockService } from './space-lock.service';
import {
  GIT_SYNC_RESTRICTED_SPACE_REASON,
  GitSyncRestrictionsService,
} from './git-sync-restrictions.service';
import {
  GIT_SYNC_PUSH_LOCK_RETRY_BASE_MS,
  GIT_SYNC_PUSH_LOCK_RETRY_MAX_MS,
  GIT_SYNC_PUSH_LOCK_RETRY_TOTAL_MS,
} from '../git-sync.constants';

/** A space the poll loop should reconcile: its id + the workspace it lives in. */
interface EnabledSpace {
  spaceId: string;
  workspaceId: string;
}

/**
 * Wall-clock deadline of one locked space operation: a cycle, or a push's
 * receive-pack plus its cycle. Generous on purpose — the first full export or
 * import of a large space must fit — because its job is to make every cycle end,
 * not to pace it. On expiry the cycle is aborted, logged at ERROR and recorded as
 * a failed cycle in the space's status.
 */
export const GIT_SYNC_CYCLE_DEADLINE_MS = 30 * 60_000;

/**
 * How many poll-launched cycles may run at once. A hung space holds one slot
 * (until its deadline) while the others keep being reconciled.
 */
const GIT_SYNC_POLL_MAX_CONCURRENT_CYCLES = 2;

/**
 * Thrown by `ingestExternalPush` when the per-space lock cannot be acquired (a
 * poll cycle is mid-flight on this or another replica). The /git HTTP handler
 * maps it to a 503 so the git client retries rather than racing a cycle's
 * ref updates.
 */
export class GitSyncLockHeldError extends Error {
  constructor(public readonly spaceId: string) {
    super(`git-sync: space ${spaceId} is busy (lock held); retry the push`);
    this.name = 'GitSyncLockHeldError';
  }
}

/** Small status summary returned by `runOnce` (for the admin trigger + logs). */
export interface GitSyncRunStatus {
  spaceId: string;
  ran: boolean;
  /** Why the cycle did not run (lock held elsewhere, busy, space not enabled). */
  skipped?:
    | 'lock-held'
    | 'in-progress'
    | 'space-not-enabled';
  pull?: {
    written: number;
    deleted: number;
    failures: number;
    firstFailure?: PullFailure;
  };
  push?: { mode: string; failures: number; firstFailure?: PushFailure };
  error?: string;
}

/**
 * Health of one space's git-sync, as reported by POST /api/git-sync/status. Kept
 * in memory by the orchestrator (one entry per space that ran a cycle, or was
 * skipped because its lock was held, since the process started; a restart just
 * starts empty).
 */
export interface GitSyncSpaceStatus {
  spaceId: string;
  /** ISO time the last cycle (ok or failed) finished (null: none yet). */
  lastRunAt: string | null;
  lastResult: 'ok' | 'failed' | null;
  /** Why the last cycle failed (null when it succeeded). */
  lastError: string | null;
  /** ISO time of the last successful cycle (null: none since process start). */
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  /**
   * Live pages the last cycle's pull could not write into the vault — they did
   * not reach git (0 when the cycle itself failed).
   */
  pullFailures: number;
  /** The first of those: its page id and reason. */
  firstPullFailure: {
    pageId: string;
    reason: string;
  } | null;
  /** Per-page push failures of the last cycle (0 when the cycle itself failed). */
  pushFailures: number;
  /** The first of those per-page failures: its page path (or id) and reason. */
  firstPushFailure: {
    path: string | null;
    pageId: string | null;
    reason: string;
  } | null;
  /** ISO time a cycle or push was last skipped (null: none since process start). */
  lastSkippedAt: string | null;
  /** Why: the space's lock was held by another holder. */
  lastSkipReason: 'lock-held' | null;
  /**
   * Since when this process has found the lock held, across consecutive skips
   * (null once a cycle runs).
   */
  lockHeldSince: string | null;
  /** ISO time the cycle running on this process started (null: none running). */
  runningSince: string | null;
}

/**
 * Size budget for the error strings kept per space in `GitSyncSpaceStatus`
 * (git stderr can list every file of the vault): at most this many characters
 * each, so the status map stays O(spaces), not O(vault size).
 */
const STATUS_ERROR_MAX_CHARS = 1000;

function clip(text: string): string {
  return text.length > STATUS_ERROR_MAX_CHARS
    ? `${text.slice(0, STATUS_ERROR_MAX_CHARS)}…`
    : text;
}

/** The status of a space nothing has been recorded for yet. */
function emptyStatus(spaceId: string): GitSyncSpaceStatus {
  return {
    spaceId,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    pullFailures: 0,
    firstPullFailure: null,
    pushFailures: 0,
    firstPushFailure: null,
    lastSkippedAt: null,
    lastSkipReason: null,
    lockHeldSince: null,
    runningSince: null,
  };
}

/**
 * The git-sync control plane. Drives the `@docmost/git-sync` engine in
 * process: under a Redis leader lock (single-writer across replicas) plus an
 * in-process per-space mutex (no overlapping cycles on one instance), it runs
 * the engine's cycle for a space: the user's commits are applied to Docmost,
 * then Docmost is exported to the vault.
 *
 * Enumeration of enabled spaces: STRICT opt-in. Only spaces whose
 * per-space flag `space.settings.gitSync.enabled === true` (written by the space
 * settings UI) are reconciled. There is intentionally NO all-spaces fallback:
 * syncing every space the moment GIT_SYNC_ENABLED flips on could mass-sync large
 * spaces. The whole loop is gated on the GIT_SYNC_ENABLED master switch first;
 * per-space opt-in is required on top of it.
 */
@Injectable()
export class GitSyncOrchestrator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GitSyncOrchestrator.name);
  /** The registered poll-interval name, or null when none is registered. */
  private pollIntervalName: string | null = null;
  /**
   * Per-space export-key maps (pageId -> key of its last successful export),
   * handed to the engine's `runCycle` so a poll re-exports only changed pages.
   * Owned here, rebuilt/cleared by the engine; each holds at most one entry per
   * live page of its space. Empty after a restart -> one full pass per space.
   */
  private readonly exportKeysBySpace = new Map<string, Map<string, string>>();
  /** Per-space health (+ the workspace it belongs to, for /status scoping). */
  private readonly spaceHealth = new Map<
    string,
    { workspaceId: string; status: GitSyncSpaceStatus }
  >();

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly dataSource: GitmostDataSourceService,
    private readonly vaultRegistry: VaultRegistryService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly spaceLock: SpaceLockService,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly restrictions: GitSyncRestrictionsService,
  ) {}

  // --- enabled-space enumeration --------------------------------

  /**
   * Enumerate the spaces the poll loop should reconcile. STRICT opt-in: ONLY
   * spaces carrying the per-space flag (`settings->'gitSync'->>'enabled'
   * = 'true'`) are returned. There is intentionally NO
   * fallback to "all live spaces" — when no space is flagged this returns an empty
   * list and git-sync does nothing (correct opt-in behavior). The GIT_SYNC_ENABLED
   * master switch gates whether the loop runs at all; this flag gates which spaces.
   */
  private async enabledSpaces(): Promise<EnabledSpace[]> {
    return this.db
      .selectFrom('spaces')
      .select(['id as spaceId', 'workspaceId'])
      .where('deletedAt', 'is', null)
      .where(sql<boolean>`settings->'gitSync'->>'enabled' = 'true'`)
      .execute();
  }

  /**
   * Authoritative per-space opt-in check used by the EVENT path (runOnce), which
   * — unlike the poll path — is not pre-filtered by enabledSpaces(). Same STRICT
   * `settings.gitSync.enabled === 'true'` semantics; a missing/soft-deleted space
   * or any non-'true' value returns false (review #3).
   */
  private async isSpaceGitSyncEnabled(spaceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('spaces')
      .select(
        sql<boolean>`settings->'gitSync'->>'enabled' = 'true'`.as('enabled'),
      )
      .where('id', '=', spaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return row?.enabled ?? false;
  }

  // --- one sync cycle for a space -------------------------------

  /**
   * Build the engine `Settings` for a space. The engine reads exactly two
   * fields, `vaultPath` and `docmostSpaceId` (the poll interval and debounce are
   * the orchestrator's and the listener's own).
   */
  private buildSettings(spaceId: string): Settings {
    return {
      docmostSpaceId: spaceId,
      vaultPath: this.vaultRegistry.vaultPath(spaceId),
    };
  }

  /**
   * Run one full PULL + PUSH cycle for a space, under the Redis leader lock and
   * the in-process mutex, bounded by GIT_SYNC_CYCLE_DEADLINE_MS. Per-space
   * cycle errors (the deadline included) are caught, logged, and returned in the
   * status so a poll interval is never broken by one bad space.
   *
   * GIT_SYNC_ENABLED and GIT_SYNC_SERVICE_USER_ID need no check here: the module
   * is empty when the flag is off, and env validation requires the service user
   * when it is on.
   */
  async runOnce(
    spaceId: string,
    workspaceId: string,
  ): Promise<GitSyncRunStatus> {
    const serviceUserId = this.environmentService.getGitSyncServiceUserId();
    // Per-space opt-in gate (review #3). The global GIT_SYNC_ENABLED env switch is
    // NOT sufficient — sync must also be turned on for THIS space
    // (`space.settings.gitSync.enabled === true`). The poll path filters via
    // enabledSpaces(), but the event path (page-change listener) calls runOnce
    // directly; without this check an edit in ANY space would `git init` a vault
    // and export that space's whole history, violating the module's opt-in
    // contract (orchestrator docstring §79-86). STRICT: anything but 'true' skips.
    if (!(await this.isSpaceGitSyncEnabled(spaceId))) {
      // A space whose sync was switched off must stop reporting its last health.
      this.forgetSpaces([spaceId]);
      return { spaceId, ran: false, skipped: 'space-not-enabled' };
    }

    // Run the full cycle under the per-space lock. withSpaceLock owns the
    // in-process mutex (no overlapping cycles on this instance) AND the Redis
    // leader lock (single writer across replicas), and returns a skip sentinel
    // when it could not enter — surfaced here as the existing skipped:'in-progress'
    // / 'lock-held' status so runOnce's observable behavior is unchanged.
    try {
      const result = await this.spaceLock.withSpaceLock(
        spaceId,
        (signal) =>
          this.driveCycle(spaceId, workspaceId, serviceUserId, signal),
        { deadlineMs: GIT_SYNC_CYCLE_DEADLINE_MS },
      );
      if ('skipped' in result && !('spaceId' in result)) {
        if (result.skipped === 'lock-held') {
          this.recordLockHeldSkip(spaceId, workspaceId);
        }
        return { spaceId, ran: false, skipped: result.skipped };
      }
      this.recordCycleSuccess(spaceId, workspaceId, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Logged at ERROR only on the healthy -> failing transition (see
      // recordCycleFailure), not on every poll of a space that keeps failing.
      this.recordCycleFailure(spaceId, workspaceId, err);
      return { spaceId, ran: false, error: message };
    }
  }

  /**
   * Per-space health snapshot for POST /api/git-sync/status, limited to the
   * spaces of `workspaceId` (an admin never sees another workspace's spaces).
   */
  getSpaceStatuses(workspaceId: string): GitSyncSpaceStatus[] {
    const out: GitSyncSpaceStatus[] = [];
    for (const entry of this.spaceHealth.values()) {
      if (entry.workspaceId === workspaceId) out.push({ ...entry.status });
    }
    return out;
  }

  /**
   * Merge `patch` into the space's status (fields it omits keep their previous
   * value, or the empty default) and return the previous status, if any.
   */
  private patchStatus(
    spaceId: string,
    workspaceId: string,
    patch: Partial<GitSyncSpaceStatus>,
  ): GitSyncSpaceStatus | undefined {
    const prev = this.spaceHealth.get(spaceId)?.status;
    this.spaceHealth.set(spaceId, {
      workspaceId,
      status: { ...emptyStatus(spaceId), ...prev, ...patch },
    });
    return prev;
  }

  /** Record a completed cycle; logs (INFO) the failing -> healthy transition. */
  private recordCycleSuccess(
    spaceId: string,
    workspaceId: string,
    result: GitSyncRunStatus,
  ): void {
    const now = new Date().toISOString();
    const firstPull = result.pull?.firstFailure;
    const first = result.push?.firstFailure;
    const prev = this.patchStatus(spaceId, workspaceId, {
      lastRunAt: now,
      lastResult: 'ok',
      lastError: null,
      lastSuccessAt: now,
      consecutiveFailures: 0,
      pullFailures: result.pull?.failures ?? 0,
      firstPullFailure: firstPull
        ? { pageId: firstPull.pageId, reason: clip(firstPull.error) }
        : null,
      pushFailures: result.push?.failures ?? 0,
      firstPushFailure: first
        ? {
            path: first.path ?? null,
            pageId: first.pageId ?? null,
            reason: clip(first.error),
          }
        : null,
      lockHeldSince: null,
      runningSince: null,
    });
    if (prev && prev.consecutiveFailures > 0) {
      this.logger.log(
        `git-sync: space ${spaceId} RECOVERED — cycle succeeded after ` +
          `${prev.consecutiveFailures} consecutive failed cycle(s)`,
      );
    }
    incGitSyncCycle('ok');
    this.publishFailingSpaces();
  }

  /**
   * Record a failed cycle. ERROR (with the stack) only when the space goes from
   * healthy to failing; repeats are DEBUG so a broken space does not flood the
   * log every poll — its state stays visible in /status and the metrics. Also
   * forgets the space's export keys so the next cycle is a full pass.
   */
  private recordCycleFailure(
    spaceId: string,
    workspaceId: string,
    err: unknown,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    const consecutiveFailures =
      (this.spaceHealth.get(spaceId)?.status.consecutiveFailures ?? 0) + 1;
    this.exportKeysBySpace.get(spaceId)?.clear();
    this.patchStatus(spaceId, workspaceId, {
      lastRunAt: new Date().toISOString(),
      lastResult: 'failed',
      lastError: clip(message),
      consecutiveFailures,
      pullFailures: 0,
      firstPullFailure: null,
      pushFailures: 0,
      firstPushFailure: null,
      lockHeldSince: null,
      runningSince: null,
    });
    if (consecutiveFailures === 1) {
      this.logger.error(
        `git-sync: space ${spaceId} is now FAILING — cycle failed: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    } else {
      this.logger.debug(
        `git-sync: space ${spaceId} still failing ` +
          `(${consecutiveFailures} consecutive cycles): ${message}`,
      );
    }
    incGitSyncCycle('failed');
    this.publishFailingSpaces();
  }

  /**
   * Record a cycle, push or fetch skipped because the space's lock is held (by
   * another replica, or by a dead process until its lock expires), so the space
   * shows in /status even before it ever ran in this process.
   */
  private recordLockHeldSkip(spaceId: string, workspaceId: string): void {
    const now = new Date().toISOString();
    this.patchStatus(spaceId, workspaceId, {
      lastSkippedAt: now,
      lastSkipReason: 'lock-held',
      lockHeldSince: this.spaceHealth.get(spaceId)?.status.lockHeldSince ?? now,
    });
  }

  /**
   * Record that a cycle started on this process, so the space shows in /status
   * while it runs (a recovery cycle after a restart can take a while); the
   * cycle's success/failure record clears it.
   */
  private recordCycleStart(spaceId: string, workspaceId: string): void {
    this.patchStatus(spaceId, workspaceId, {
      lockHeldSince: null,
      runningSince: new Date().toISOString(),
    });
  }

  /**
   * Push the number of currently failing spaces, and of spaces whose last
   * (completed) cycle had per-page push failures, to the gauges.
   */
  private publishFailingSpaces(): void {
    let failing = 0;
    let pushFailing = 0;
    for (const { status } of this.spaceHealth.values()) {
      if (status.consecutiveFailures > 0) failing++;
      if (status.pushFailures > 0) pushFailing++;
    }
    setGitSyncFailingSpaces(failing);
    setGitSyncPushFailingSpaces(pushFailing);
  }

  /**
   * Drop the health entry and export keys of spaces whose sync is no longer
   * enabled (switched off, or the space deleted), so /status and the gauges
   * stop reporting them; re-enabling starts with a full pass.
   */
  private forgetSpaces(spaceIds: Iterable<string>): void {
    for (const spaceId of spaceIds) {
      this.spaceHealth.delete(spaceId);
      this.exportKeysBySpace.delete(spaceId);
    }
    this.publishFailingSpaces();
  }

  /**
   * Ingest a push that arrived over smart-HTTP (the /git host). Under the SAME
   * per-space lock the poll cycle uses, it:
   *   1. runs `runReceivePack()` — the closure that spawns `git http-backend` for
   *      the receive-pack request and finishes streaming the HTTP response to the
   *      client. The client's push result is determined here.
   *   2. THEN — still holding the lock — runs the full Docmost cycle (the same
   *      `driveCycle` body `runOnce` uses) so the freshly received commits on
   *      `main` flow back into Docmost pages.
   *
   * If the cycle body in step 2 throws, it is LOGGED but NOT rethrown: the push
   * already succeeded and the commits are durable on `main`, so the poll-interval
   * backstop will reconcile them on the next tick. The receive-pack itself is the
   * load-bearing step.
   *
   * Lock contention: if the lock cannot be acquired (a poll cycle is mid-flight),
   * this throws a `GitSyncLockHeldError`. The HTTP handler converts that to a 503
   * so git surfaces a retryable error to the user (chosen over blocking the
   * request behind a potentially long cycle). The receive-pack is NOT run when
   * the lock is held — we never move `main` concurrently with a cycle.
   *
   * `runReceivePack` receives the per-space lock's lost-lock `AbortSignal`: a
   * receive-pack moves `main`, so if the lock is lost mid-push (a long Redis
   * outage drops the heartbeat CAS) the signal fires and the receive-pack's
   * `git http-backend` child is killed — closing the window where another
   * replica could grab the lock and start a cycle while this child still writes.
   *
   * The whole locked operation (receive-pack + cycle) is bounded by
   * GIT_SYNC_CYCLE_DEADLINE_MS: past it the signal is aborted, the failure is
   * recorded in the space's status and the `GitSyncDeadlineError` is rethrown.
   */
  async ingestExternalPush(
    spaceId: string,
    workspaceId: string,
    runReceivePack: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const serviceUserId = this.environmentService.getGitSyncServiceUserId();

    let result: void | { skipped: 'lock-held' | 'in-progress' };
    try {
      result = await this.spaceLock.withSpaceLock(
        spaceId,
        async (signal) => {
          // 0) Prepare the vault first (legacy upgrade, `main`, the last-export
          // pointer), so the push lands on the layout the cycle runs on.
          const { prepareVault } = await loadGitSync();
          const vault = await this.vaultRegistry.getVault(spaceId);
          if (
            await prepareVault({ spaceId, vault, ...this.engineLog(spaceId) })
          ) {
            this.exportKeysFor(spaceId).clear();
          }

          // 1) Stream the receive-pack to the client (durable commits land on
          // main). Pass the lost-lock signal so the receive-pack child is killed
          // if the lock lapses mid-write (no concurrent writer across replicas).
          await runReceivePack(signal);

          // 2) Reconcile the new commits into Docmost.
          try {
            const status = await this.driveCycle(
              spaceId,
              workspaceId,
              serviceUserId,
              signal,
            );
            this.recordCycleSuccess(spaceId, workspaceId, status);
          } catch (err) {
            // A cycle cut off by the deadline is recorded once, below, when
            // withSpaceLock rejects with the deadline error.
            if (!(signal.reason instanceof GitSyncDeadlineError)) {
              this.recordCycleFailure(spaceId, workspaceId, err);
            }
            // Do NOT rethrow: the push succeeded and the commits are durable on
            // main; the poll-interval backstop retries the cycle. Log for
            // visibility.
            this.logger.error(
              `git-sync: post-push cycle failed for space ${spaceId} (push is ` +
                `durable; poll will retry): ${
                  err instanceof Error ? err.message : String(err)
                }`,
            );
          }
        },
        {
          // BOUNDED retry-acquire (push path only): a push that briefly overlaps
          // a poll cycle waits a moment (capped backoff up to the budget)
          // instead of immediately 503-ing — the cycle releases the lock in well
          // under a second for most spaces, so this turns a transient overlap
          // into a SUCCESS rather than a spurious failure. A genuinely
          // long/stuck cycle still skips after the bound -> GitSyncLockHeldError
          // -> 503, and git retries the whole push (the receive-pack only runs
          // once the lock is held, so there is never a half-applied ref on a
          // 503).
          acquireRetry: {
            timeoutMs: GIT_SYNC_PUSH_LOCK_RETRY_TOTAL_MS,
            baseMs: GIT_SYNC_PUSH_LOCK_RETRY_BASE_MS,
            maxMs: GIT_SYNC_PUSH_LOCK_RETRY_MAX_MS,
          },
          deadlineMs: GIT_SYNC_CYCLE_DEADLINE_MS,
        },
      );
    } catch (err) {
      if (err instanceof GitSyncDeadlineError) {
        this.recordCycleFailure(spaceId, workspaceId, err);
      }
      throw err;
    }

    // The lock was held (in-progress or another replica) — surface to the caller
    // so the HTTP handler can answer 503 and let git retry.
    if (typeof result === 'object' && result !== null && 'skipped' in result) {
      if (result.skipped === 'lock-held') {
        this.recordLockHeldSkip(spaceId, workspaceId);
      }
      throw new GitSyncLockHeldError(spaceId);
    }
  }

  /**
   * Drive ONE reconcile cycle for a space. The apply/export choreography lives
   * in the engine's `runCycle` (so it can never drift from the engine it ships
   * with); the orchestrator owns only the lock (its caller) and the service
   * binding. There is no delete cap — deletes apply unconditionally (they
   * are soft/reversible) and every cycle logs what it deleted via `log`.
   *
   * A space with page-level restricted pages is refused before anything is
   * exported or written: the throw is recorded as a failed cycle, so the reason
   * shows in the space's status and is logged at ERROR.
   */
  private async driveCycle(
    spaceId: string,
    workspaceId: string,
    serviceUserId: string,
    signal?: AbortSignal,
  ): Promise<GitSyncRunStatus> {
    signal?.throwIfAborted();
    if (await this.restrictions.spaceHasRestrictedPages(spaceId, workspaceId)) {
      throw new Error(
        `git-sync refuses space ${spaceId}: ${GIT_SYNC_RESTRICTED_SPACE_REASON}. ` +
          `Nothing was exported or written; remove the page-level ` +
          `restrictions or switch git sync off for this space.`,
      );
    }
    this.recordCycleStart(spaceId, workspaceId);
    const { runCycle } = await loadGitSync();
    const settings = this.buildSettings(spaceId);
    const vault = await this.vaultRegistry.getVault(spaceId);
    const client = this.dataSource.bind({
      workspaceId,
      userId: serviceUserId,
      spaceId,
      // Datasource calls stop as soon as the lock is lost or the deadline hits.
      signal,
    });

    const result = await runCycle({
      // Cooperative-abort signal from the per-space lock: if a heartbeat refresh
      // cannot confirm the lock, or the cycle deadline passes, the cycle bails
      // before its next destructive write phase instead of writing blind.
      signal,
      spaceId,
      client,
      vault,
      settings,
      // Every cycle logs its full push plan + per-action lines + completion
      // counts (created/updated/deleted/skipped/failures) through this `log`, so
      // what was deleted (and what was not) is always recorded. There is no
      // delete cap: deletes are soft (Trash, reversible), so a blocking limit
      // only got in the way of legitimate deletes; engine correctness (covered by
      // the reconcile/layout tests) is what prevents phantom deletions.
      ...this.engineLog(spaceId),
      // This space's export-key map: the export skips pages unchanged since
      // their last successful export (the engine rebuilds/clears it).
      exportKeys: this.exportKeysFor(spaceId),
    });

    return { spaceId, ...result };
  }

  /**
   * The engine's log channels for one space: `log` for the cycle's progress,
   * `warn` for the preflight self-heals an operator must notice (the line names
   * the space).
   */
  private engineLog(spaceId: string): {
    log: (line: string) => void;
    warn: (line: string) => void;
  } {
    return {
      log: (line: string) => this.logger.log(`git-sync[${spaceId}] ${line}`),
      warn: (line: string) => this.logger.warn(`git-sync: ${line}`),
    };
  }

  /** The (lazily created) export-key map of one space. */
  private exportKeysFor(spaceId: string): Map<string, string> {
    let keys = this.exportKeysBySpace.get(spaceId);
    if (!keys) {
      keys = new Map();
      this.exportKeysBySpace.set(spaceId, keys);
    }
    return keys;
  }

  // --- poll-safety interval -------------------------------------

  /** Registered interval name (shared by registration + teardown). */
  private static readonly POLL_INTERVAL_NAME = 'git-sync-poll';

  /**
   * Register the poll-safety interval DYNAMICALLY so it honors the configured
   * GIT_SYNC_POLL_INTERVAL_MS (a static `@Interval` decorator could only hardcode
   * a value at class-eval time, before config is readable — diverging from what
   * `/status` reports). When git-sync is disabled this provider does not exist
   * (GitSyncModule registers nothing), so nothing is registered.
   *
   * ScheduleModule: forRoot() is registered ONCE globally by TelemetryModule;
   * GitSyncModule imports the plain ScheduleModule so SchedulerRegistry is
   * injectable without a duplicate forRoot.
   *
   * KNOWN MULTI-REPLICA LIMITATION: this is an IN-PROCESS `setInterval` running
   * on EVERY replica. Cross-replica single-writer safety rests on the per-space
   * Redis lock (SpaceLockService) plus best-effort abort-on-failed-heartbeat —
   * NOT on fencing. Under an adversarial schedule (lock TTL lapse during a GC/IO
   * pause) two replicas could briefly both believe they hold a space's lock.
   * Closing it needs fencing tokens (and a BullMQ job per space instead of N
   * interval timers). See the KNOWN MULTI-REPLICA GAP note on SpaceLockService.
   */
  onModuleInit(): void {
    const ms = this.environmentService.getGitSyncPollIntervalMs();
    const handle = setInterval(() => {
      void this.pollTick();
    }, ms);
    // Do not keep the event loop alive solely for the poll timer.
    handle.unref?.();
    this.schedulerRegistry.addInterval(
      GitSyncOrchestrator.POLL_INTERVAL_NAME,
      handle,
    );
    this.pollIntervalName = GitSyncOrchestrator.POLL_INTERVAL_NAME;
    this.logger.log(`git-sync: poll interval registered (${ms}ms).`);
  }

  /** Tear down the dynamic interval on shutdown (guard against double-delete). */
  onModuleDestroy(): void {
    if (!this.pollIntervalName) return;
    try {
      // deleteInterval clears the timer and removes it from the registry.
      this.schedulerRegistry.deleteInterval(this.pollIntervalName);
    } catch (err) {
      this.logger.warn(
        `git-sync: failed to delete poll interval: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.pollIntervalName = null;
    }
  }

  /** True while a pollTick enumerates and launches cycles (re-entrancy guard). */
  private polling = false;
  /**
   * Spaces whose poll-launched cycle has not settled yet; each holds one of the
   * GIT_SYNC_POLL_MAX_CONCURRENT_CYCLES slots. Bounded by that cap.
   */
  private readonly pollInFlight = new Set<string>();
  /**
   * When each enabled space last got a poll slot, so the longest-waiting spaces
   * go first. One entry per enabled space; pruned with the disabled ones.
   */
  private readonly pollLaunchedAt = new Map<string, number>();

  /**
   * One poll tick: catches events missed by the listener and reconciles after
   * downtime. Each enabled space runs under its own lock (overlaps skipped).
   * Never throws.
   *
   * The tick does not wait for one space before starting the next. It hands
   * free slots (GIT_SYNC_POLL_MAX_CONCURRENT_CYCLES) to the spaces that have
   * waited longest and are not still running from an earlier tick; a hung cycle
   * holds one slot until its deadline while the other spaces keep being
   * reconciled. The returned promise settles when this tick's cycles have.
   *
   * Re-entrancy guard: the `polling` flag skips a tick while another is still
   * enumerating; it is in-process only (each replica guards its own ticks —
   * cross-replica overlap is handled by the Redis lock).
   */
  private async pollTick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const launched: Promise<void>[] = [];
    try {
      let spaces: EnabledSpace[];
      try {
        spaces = await this.enabledSpaces();
      } catch (err) {
        this.logger.error(
          `git-sync: failed to enumerate enabled spaces: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      // Forget spaces that are no longer enabled (the poll never runs them again).
      const enabled = new Set(spaces.map((s) => s.spaceId));
      this.forgetSpaces(
        [...this.spaceHealth.keys(), ...this.exportKeysBySpace.keys()].filter(
          (spaceId) => !enabled.has(spaceId),
        ),
      );
      for (const spaceId of [...this.pollLaunchedAt.keys()]) {
        if (!enabled.has(spaceId)) this.pollLaunchedAt.delete(spaceId);
      }
      const waiting = spaces
        .filter((s) => !this.pollInFlight.has(s.spaceId))
        .sort(
          (a, b) =>
            (this.pollLaunchedAt.get(a.spaceId) ?? 0) -
            (this.pollLaunchedAt.get(b.spaceId) ?? 0),
        );
      for (const { spaceId, workspaceId } of waiting) {
        if (this.pollInFlight.size >= GIT_SYNC_POLL_MAX_CONCURRENT_CYCLES)
          break;
        this.pollInFlight.add(spaceId);
        this.pollLaunchedAt.set(spaceId, Date.now());
        // runOnce records each cycle's outcome in the space's health (served by
        // /status, counted in the metrics) and logs the healthy <-> failing
        // transitions; only its opt-in read can still throw.
        launched.push(
          this.runOnce(spaceId, workspaceId)
            .then(
              () => undefined,
              (err) => {
                this.logger.error(
                  `git-sync: poll cycle for space ${spaceId} failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                  err instanceof Error ? err.stack : undefined,
                );
              },
            )
            .finally(() => this.pollInFlight.delete(spaceId)),
        );
      }
    } finally {
      this.polling = false;
    }
    await Promise.all(launched);
  }
}
