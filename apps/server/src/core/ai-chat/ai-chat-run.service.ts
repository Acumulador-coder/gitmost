import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AiChatRunRepo } from '@docmost/db/repos/ai-chat/ai-chat-run.repo';
import { AiChatRun } from '@docmost/db/types/entity.types';
import { isUniqueViolation, violatedConstraint } from '@docmost/db/utils';
import { EnvironmentService } from '../../integrations/environment/environment.service';

/** Name of the partial unique index enforcing "one active run per chat" (see the
 *  ai_chat_runs migration). A 23505 on THIS constraint is the race-safe signal
 *  that a concurrent turn already owns the chat — distinct from any other unique
 *  collision, which must NOT be silently treated as "already active". */
export const ONE_ACTIVE_RUN_PER_CHAT_INDEX = 'ai_chat_runs_one_active_per_chat';

/**
 * Thrown by {@link AiChatRunService.beginRun} when the run-row INSERT loses the
 * race for a chat's single active slot (the partial unique index rejects it with
 * a 23505). This is the AUTHORITATIVE concurrency gate: the controller's cheap
 * pre-check is only a fast-path, and a request that slips past it must NOT run
 * untracked. The caller (AiChatService.stream) translates this into a 409 and
 * aborts the turn BEFORE any AI/provider call.
 */
export class RunAlreadyActiveError extends Error {
  constructor(public readonly chatId: string) {
    super(`An agent run is already in progress for chat ${chatId}`);
    this.name = 'RunAlreadyActiveError';
  }
}

/**
 * The terminal status of a TURN (the #183 assistant-row lifecycle) maps onto the
 * terminal status of a RUN (#184). A turn that completed -> the run succeeded; a
 * turn that errored -> the run failed; a turn aborted (explicit user stop) -> the
 * run aborted. Pure + unit-testable.
 */
export type TurnTerminalStatus = 'completed' | 'error' | 'aborted';
export type RunTerminalStatus = 'succeeded' | 'failed' | 'aborted';

/** The terminal run statuses — the row is done once it reads one of these. */
export const RUN_TERMINAL_STATUSES: readonly RunTerminalStatus[] = [
  'succeeded',
  'failed',
  'aborted',
];

/** Whether a persisted run status is terminal (settled). */
export function isRunTerminal(status: string | null | undefined): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'aborted'
  );
}

/**
 * The outcome a run's {@link AiChatRunService.finalizeRun} settled with.
 * `terminalWriteFailed` = the terminal write gave up after the bounded retry, so
 * the row is still 'running' and a ZOMBIE record holds the `intended` status for
 * a later re-drive (reconcile / supersede / boot sweep). Supersede uses it to
 * decide whether the slot is free or the intended status must be applied first.
 */
export interface RunSettleOutcome {
  status: RunTerminalStatus;
  error: string | null;
  terminalWriteFailed: boolean;
}

/**
 * How long a supersede waits for the target run to settle after Stop before it
 * degrades to `SUPERSEDE_TIMEOUT`. On a healthy DB an aborted run settles in
 * ms/hundreds of ms; under a DB brownout the timeout is the honest signal
 * (nothing persisted, the composer keeps the user's text), so do not raise it to
 * paper over a slow DB. Env-tunable, default 10s.
 */
export const SUPERSEDE_SETTLE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AI_CHAT_SUPERSEDE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

/**
 * The result of the supersede CAS ({@link AiChatRunService.supersede}).
 *  - `degrade`  : no active run on the chat (it ended between click and POST) —
 *                 the caller sends a NORMAL turn (NOT a mismatch);
 *  - `invalid`  : the target runId belongs to a DIFFERENT chat (malformed CAS 400);
 *  - `mismatch` : a DIFFERENT run is active than the one the client targeted —
 *                 409 SUPERSEDE_TARGET_MISMATCH carrying the current `activeRunId`
 *                 (the client does NOT auto-retry);
 *  - `timeout`  : the target did not settle within W — 409 SUPERSEDE_TIMEOUT,
 *                 nothing persisted;
 *  - `ready`    : the target was stopped AND settled (or its zombie's intended was
 *                 applied) — the slot is free; the caller may beginRun the new run.
 */
export type SupersedeResult =
  | { kind: 'degrade' }
  | { kind: 'invalid' }
  | { kind: 'mismatch'; activeRunId: string }
  | { kind: 'timeout' }
  | { kind: 'ready' };

/** A one-shot settle notifier (#487): `resolve` is called EXACTLY ONCE. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/**
 * A run whose terminal write gave up (every bounded attempt failed). The row is
 * stranded 'running'; this record is the only thing that distinguishes it from a
 * live run, and carries the `intended` terminal status for a re-drive via the
 * conditional UPDATE. Process-local: a restart drops it, and the boot sweep then
 * writes 'aborted' over the intended status (see finalizeRun).
 */
interface ZombieRun {
  workspaceId: string;
  chatId: string;
  intended: { status: RunTerminalStatus; error: string | null };
}

export function mapTurnStatusToRun(
  status: TurnTerminalStatus,
): RunTerminalStatus {
  switch (status) {
    case 'completed':
      return 'succeeded';
    case 'error':
      return 'failed';
    case 'aborted':
      return 'aborted';
  }
}

/** An in-flight run held in process memory: its AbortController is the ONLY thing
 *  that can stop the turn (an explicit user stop), independent of the browser
 *  socket. A mere disconnect never touches it, so the run keeps going (except
 *  #714: a new chat whose client left before the first frame). */
interface ActiveRun {
  controller: AbortController;
  chatId: string;
  workspaceId: string;
}

/** The live handle the streaming path drives a run through (returned by
 *  {@link AiChatRunService.beginRun}). The `signal` governs the agent loop's
 *  abort — wired to the run, NOT to the HTTP socket. */
export interface RunHandle {
  runId: string;
  signal: AbortSignal;
}

/**
 * Owns the agent RUN as a server-side lifecycle object detached from the HTTP
 * request / browser window:
 *  - create a run row when a turn starts (inserted directly as 'running';
 *    'pending' is only the column default) and register an in-memory
 *    AbortController for it;
 *  - finalize the run row (succeeded / failed / aborted) and unregister it;
 *  - service an explicit user stop (`requestStop`) — the only thing that aborts a
 *    run; a browser disconnect does not (except: the stream controller stops a
 *    new chat's run whose client left before the first frame);
 *  - sweep dangling runs on startup and reclaim stale active runs periodically
 *    (`reconcileStaleRuns`, driven by the AiChatService reconcile timer).
 *
 * The agent loop itself runs in AiChatService.stream; this service only wraps it
 * in a durable lifecycle and an abort handle that outlives the subscriber.
 */
@Injectable()
export class AiChatRunService implements OnModuleInit {
  private readonly logger = new Logger(AiChatRunService.name);

  // runId -> ActiveRun. Process-local on purpose (phase 1 is single-process /
  // in-memory transport; a cross-process BullMQ runner + Redis stop-signal is
  // deferred to phase 2). A stop for a runId not in this map (e.g. after a
  // restart) still records `stop_requested_at` on the row.
  private readonly active = new Map<string, ActiveRun>();

  // runIds whose TERMINAL row write has SUCCEEDED — the idempotency once-gate
  // (F6). A finalize must short-circuit only AFTER the terminal write has landed,
  // NOT merely after the in-memory entry was dropped: a transient UPDATE failure
  // has to stay retryable, so "already settled" means "row already terminal", not
  // "entry already gone". Grows by one short UUID per finished run over process
  // uptime — negligible in phase 1's single process.
  private readonly settled = new Set<string>();

  // #487 runId -> one-shot settle notifier. Kept in a SEPARATE map from `active`
  // ON PURPOSE: it must OUTLIVE the `active.delete` claim inside finalizeRun (the
  // claim frees the slot the instant finalize starts), so a subscriber can still
  // await the outcome after the entry is gone. Created in beginRun, resolved
  // EXACTLY ONCE in finalizeRun, then removed (bounded). Absence => this replica
  // has no live notifier: a subscriber falls back to the zombie map, then to the
  // row (see peekSettled). Process-local (phase-1 single-process assumption).
  private readonly settledPromises = new Map<string, Deferred<RunSettleOutcome>>();

  // #487 runId -> ZOMBIE record: a run whose terminal write gave up (row stranded
  // non-terminal). BOUNDED — an entry is added only on give-up and removed on a
  // successful re-drive (settleZombie) or when the row is found already terminal;
  // a process restart clears it (and the boot sweep settles the stranded row).
  // Process-local (phase-1 single-process assumption).
  private readonly zombies = new Map<string, ZombieRun>();

  // Bounded retry for the terminal write (F6): a single PK UPDATE can fail
  // transiently under many fire-and-forget writes (pool exhaustion, deadlock, a
  // brief connection blip). Riding out that blip in-place matters because the
  // dominant success path (streamText onFinish) settles exactly ONCE — if that
  // write is dropped and never retried, the row is stranded 'running' and the
  // one-active-run gate 409s every future turn in the chat until the periodic
  // reconcile re-drives it as a zombie (every 2 min by default).
  private static readonly FINALIZE_MAX_ATTEMPTS = 3;
  private static readonly FINALIZE_RETRY_BASE_MS = 50;

  constructor(
    private readonly runRepo: AiChatRunRepo,
    private readonly environment: EnvironmentService,
  ) {}

  /**
   * Startup sweep: settle every run still pending/running to 'aborted',
   * unconditionally (no staleness window). Runs are single-process, so on a fresh
   * boot no live runner owns any of them, and a run left 'running' would make the
   * one-active-run gate 409 every future turn in that chat. A multi-instance
   * sweep would need a staleness window so a booting replica does not abort a run
   * another replica executes. Best-effort: failures are logged and never block
   * startup.
   */
  async onModuleInit(): Promise<void> {
    this.warnIfMultiInstance();
    try {
      // No `staleMs`: unconditional boot sweep (F1). See AiChatRunRepo.sweepRunning.
      const swept = await this.runRepo.sweepRunning();
      if (swept > 0) {
        this.logger.log(
          `Startup sweep: marked ${swept} dangling agent run(s) as 'aborted'.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Startup sweep of dangling runs failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Agent runs are single-instance only. A Stop and its in-memory AbortController
   * are process-local: a Stop aborts the live turn only on the replica that owns
   * the run (it stamps `stop_requested_at` cross-instance, but nothing reads it
   * during a run). Warn at startup when the deployment is horizontally scaled.
   *
   * The socket.io Redis adapter is always wired (REDIS_URL is mandatory), so it is
   * not a scaling signal; `CLOUD=true` (EnvironmentService.isCloud()) is. Operators
   * running multiple self-hosted replicas are covered by the deploy docs
   * (.env.example / AGENTS.md).
   */
  private warnIfMultiInstance(): void {
    if (this.environment.isCloud()) {
      this.logger.warn(
        'Agent runs are SINGLE-INSTANCE-ONLY in phase 1: a horizontally-scaled ' +
          'deployment was detected (CLOUD=true). An explicit Stop only aborts a run ' +
          'executing on the same replica that owns it (cross-instance Stop is not ' +
          'yet reliable — phase 2). Run a single instance.',
      );
    }
  }

  /**
   * Start a run for a turn: insert the run row (status 'running', startedAt now),
   * register a fresh AbortController for it, and return a {@link RunHandle} whose
   * `signal` the agent loop uses. The DB partial unique index guarantees at most
   * one active run per chat — a second concurrent start on the same chat REJECTS
   * at the insert (a 23505 on {@link ONE_ACTIVE_RUN_PER_CHAT_INDEX}). That
   * rejection is the AUTHORITATIVE race gate: it is surfaced as a distinct
   * {@link RunAlreadyActiveError} (NOT swallowed), so the caller turns it into a
   * 409 and never streams an untracked turn. The controller is registered AFTER a
   * successful insert so a rejected start leaks nothing.
   */
  async beginRun(args: {
    chatId: string;
    workspaceId: string;
    userId: string;
    trigger?: string;
  }): Promise<RunHandle> {
    let run: AiChatRun;
    try {
      run = await this.runRepo.insert({
        chatId: args.chatId,
        workspaceId: args.workspaceId,
        createdBy: args.userId,
        trigger: args.trigger ?? 'user',
        status: 'running',
        startedAt: new Date(),
      });
    } catch (err) {
      // The race backstop: a concurrent turn already holds this chat's single
      // active slot, so the partial unique index rejected our insert. Surface a
      // distinct signal — the caller MUST reject this turn (409), not run it
      // untracked. Any OTHER error propagates unchanged.
      if (
        isUniqueViolation(err) &&
        violatedConstraint(err) === ONE_ACTIVE_RUN_PER_CHAT_INDEX
      ) {
        throw new RunAlreadyActiveError(args.chatId);
      }
      throw err;
    }
    const controller = new AbortController();
    this.active.set(run.id, {
      controller,
      chatId: args.chatId,
      workspaceId: args.workspaceId,
    });
    // #487: arm the one-shot settle notifier BEFORE returning, so a subscriber
    // that races in immediately after begin always finds a promise to await. It
    // is resolved exactly once when the run settles (or gives up).
    this.settledPromises.set(run.id, this.makeDeferred<RunSettleOutcome>());
    return { runId: run.id, signal: controller.signal };
  }

  /** Link the assistant message (the #183 projection) to its run. Best-effort. */
  async linkAssistantMessage(
    runId: string,
    workspaceId: string,
    assistantMessageId: string,
  ): Promise<void> {
    try {
      await this.runRepo.update(runId, workspaceId, { assistantMessageId });
    } catch (err) {
      this.logger.warn(
        `Failed to link assistant message to run ${runId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /** Persist progress: bump the run's finished-step count. Best-effort (never
   *  blocks or breaks the stream). */
  async recordStep(
    runId: string,
    workspaceId: string,
    stepCount: number,
  ): Promise<void> {
    try {
      await this.runRepo.update(runId, workspaceId, { stepCount });
    } catch (err) {
      this.logger.warn(
        `Failed to record step for run ${runId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Finalize a run to its terminal status (succeeded / failed / aborted) via a
   * CONDITIONAL UPDATE, stamping finishedAt + any error.
   *
   * ATOMIC ONCE-CLAIM: two finalizeRun calls for the same run can race
   * (AiChatService.stream's safety-net catch vs a streamText terminal callback).
   * The claim is `active.delete`, a synchronous check-and-clear with no await
   * between gate and removal, so the second caller returns in the same tick.
   *
   * ALL TERMINAL WRITES ARE CONDITIONAL: `finalizeIfActive` only flips a row still
   * pending|running (like the message's `onlyIfStreaming`), so a settle that does
   * reach the UPDATE (e.g. a reconcile racing an owner finalize) can never clobber
   * a terminal status. `active.delete` is the fast in-process gate; the
   * conditional WHERE is the authoritative one.
   *
   * ZOMBIE ON GIVE-UP: if every bounded attempt throws, the entry is NOT restored
   * (a restore would make the dead run look live). A ZOMBIE `{ terminalWriteFailed,
   * intended }` is recorded and the settle notifier resolves with
   * `terminalWriteFailed: true`; settleZombie (periodic reconcile / supersede /
   * opportunistic paths) applies the intended status later.
   *
   * KNOWN LOSS: if the process restarts before a zombie is re-driven, the boot
   * sweep writes 'aborted' over the intended status; `intended` is not durable.
   *
   * IDEMPOTENT: the settle notifier resolves exactly once; a second settle stops
   * at `settled.has` or the `active.delete` claim.
   */
  async finalizeRun(
    runId: string,
    workspaceId: string,
    turnStatus: TurnTerminalStatus,
    error?: string,
  ): Promise<void> {
    // ---- Atomic once-claim (synchronous; NO await before the gate closes) ----
    // Already terminally written -> idempotent no-op.
    if (this.settled.has(runId)) return;
    // Capture the entry BEFORE the delete for the give-up log context.
    const entry = this.active.get(runId);
    // SYNCHRONOUS check-and-clear: the FIRST caller deletes (claims) the entry;
    // any concurrent SECOND caller finds nothing to delete and returns HERE, in
    // the same tick, before any await — so it can never reach the UPDATE.
    if (!this.active.delete(runId)) return;

    const status = mapTurnStatusToRun(turnStatus);
    const err = error ?? null;
    const chatId = entry?.chatId ?? 'unknown';

    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= AiChatRunService.FINALIZE_MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        const row = await this.runRepo.finalizeIfActive(runId, workspaceId, {
          status,
          error: err,
        });
        // No throw => the row is now terminal (we wrote it, or it was ALREADY
        // terminal — another writer won the conditional UPDATE, a benign no-op).
        this.settled.add(runId);
        this.zombies.delete(runId);
        // Resolve with the persisted outcome: our status when WE wrote it, else
        // the row's real terminal status (re-read on the already-terminal path so
        // a subscriber never sees a status we did not actually persist).
        const outcome: RunSettleOutcome = row
          ? { status, error: err, terminalWriteFailed: false }
          : await this.readTerminalOutcome(runId, workspaceId, status, err);
        this.resolveSettled(runId, outcome);
        return;
      } catch (err2) {
        lastError = err2;
        this.logger.warn(
          `Failed to finalize run ${runId} (attempt ${attempt}/${
            AiChatRunService.FINALIZE_MAX_ATTEMPTS
          }): ${err2 instanceof Error ? err2.message : 'unknown error'}`,
        );
        if (attempt < AiChatRunService.FINALIZE_MAX_ATTEMPTS) {
          await this.delay(AiChatRunService.FINALIZE_RETRY_BASE_MS * attempt);
        }
      }
    }
    // Every attempt threw: GIVE UP. The row is stranded non-terminal ('running').
    // Do NOT restore the entry (a restored entry is indistinguishable from a live
    // run); leave a ZOMBIE record instead, and resolve the notifier as
    // terminalWriteFailed so a subscriber knows the slot still needs the intended
    // status applied. One explicit, greppable ERROR so an operator can tell a
    // give-up from a per-attempt blip.
    this.logger.error(
      `Run ${runId} (chat ${chatId}) left NON-TERMINAL ('running'): terminal ` +
        `write failed after ${AiChatRunService.FINALIZE_MAX_ATTEMPTS} attempts; ` +
        `ZOMBIE recorded (intended '${status}'), recovery deferred to reconcile / ` +
        `supersede / boot sweep`,
      lastError,
    );
    this.zombies.set(runId, {
      workspaceId,
      chatId,
      intended: { status, error: err },
    });
    this.resolveSettled(runId, { status, error: err, terminalWriteFailed: true });
  }

  /**
   * Re-drive a zombie run's intended terminal write (the conditional UPDATE).
   * Called by the periodic reconcile, an opportunistic single-chat reconcile, and
   * supersede. When the row is terminal (written or found terminal) the zombie is
   * cleared and the once-gate armed; on failure the zombie is kept for a retry.
   * Returns true when the row is now terminal. Best-effort; never throws.
   */
  async settleZombie(runId: string): Promise<boolean> {
    const z = this.zombies.get(runId);
    if (!z) return false;
    try {
      await this.runRepo.finalizeIfActive(runId, z.workspaceId, {
        status: z.intended.status,
        error: z.intended.error,
      });
      this.zombies.delete(runId);
      this.settled.add(runId);
      return true;
    } catch (err) {
      this.logger.warn(
        `Re-drive of zombie run ${runId} (chat ${z.chatId}) failed; will retry ` +
          `later: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      return false;
    }
  }

  /**
   * Reconcile clause (c): abort runs the DB still shows active (pending|
   * running) but that this replica does NOT own — NO live entry AND NO zombie —
   * and that have been UNTOUCHED past `staleMs` (from last-progress `updated_at`,
   * NOT startedAt, so a legit long marathon is never a candidate). "No entry" is
   * the PRIMARY gate: a live entry (an actively-executing run on this replica) is
   * NEVER aborted, whatever its age. Returns the number aborted. Best-effort —
   * never throws (a periodic-job failure must not crash the process).
   */
  async reconcileStaleRuns(staleMs: number): Promise<number> {
    let candidates: Array<{ id: string; workspaceId: string; chatId: string }>;
    try {
      candidates = await this.runRepo.findStaleActive(staleMs);
    } catch (err) {
      this.logger.warn(
        `Reconcile (stale runs) query failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return 0;
    }
    let aborted = 0;
    for (const c of candidates) {
      // PRIMARY gate: never touch a live entry, and never race a zombie we are
      // already re-driving (settleZombie owns those).
      if (this.active.has(c.id) || this.zombies.has(c.id)) continue;
      try {
        const row = await this.runRepo.finalizeIfActive(c.id, c.workspaceId, {
          status: 'aborted',
          error: 'Run aborted by reconcile: no live runner (stale).',
        });
        if (row) {
          aborted += 1;
          this.settled.add(c.id);
        }
      } catch (err) {
        this.logger.warn(
          `Reconcile abort of stale run ${c.id} failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      }
    }
    return aborted;
  }

  /**
   * #487: the run's settle outcome as seen by THIS replica, or undefined when it
   * has no record (the caller then reads the row — the DB is the source of truth).
   * A LIVE deferred (still settling, or resolved-but-not-yet-consumed) wins; a
   * ZOMBIE synthesizes the give-up outcome. A subscriber (supersede) races this
   * against a timeout.
   */
  peekSettled(runId: string): Promise<RunSettleOutcome> | undefined {
    const d = this.settledPromises.get(runId);
    if (d) return d.promise;
    const z = this.zombies.get(runId);
    if (z) {
      return Promise.resolve({
        status: z.intended.status,
        error: z.intended.error,
        terminalWriteFailed: true,
      });
    }
    return undefined;
  }

  /**
   * Await a run's settle outcome, bounded by `timeoutMs`. Returns the outcome on
   * settle, or undefined on timeout (or when this replica has no record of the
   * run and its row is not terminal). Uses the live settle notifier / zombie
   * synth when present, else reads the row (the DB is the source of truth once
   * the in-memory record is gone).
   */
  async awaitSettled(
    runId: string,
    workspaceId: string,
    timeoutMs: number,
  ): Promise<RunSettleOutcome | undefined> {
    const pending = this.peekSettled(runId);
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref?.();
      });
      try {
        return await Promise.race([pending, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // No live notifier and no zombie: read the row (already settled-and-written,
    // or unknown here). A terminal row is an outcome; anything else -> undefined.
    const row = await this.runRepo.findById(runId, workspaceId);
    if (row && isRunTerminal(row.status)) {
      return {
        status: row.status as RunTerminalStatus,
        error: row.error ?? null,
        terminalWriteFailed: false,
      };
    }
    return undefined;
  }

  /**
   * The server supersede CAS for `POST /stream { supersede: { runId: X } }`:
   * transitions "X is the chat's active run" -> "X is stopped, settled, slot free"
   * so the caller can start a replacement run. See {@link SupersedeResult}.
   *
   * On `ready` the caller must still go through the beginRun gate (the partial
   * unique index): a neighbouring tab's POST can win the freed slot, and the loser
   * gets a MISMATCH carrying the new runId. There is no side-effect quiescence: an
   * in-flight write of the stopped run may land after the new run starts, so the
   * caller adds a prompt note to the new run.
   */
  async supersede(
    chatId: string,
    targetRunId: string,
    workspaceId: string,
    timeoutMs: number = SUPERSEDE_SETTLE_TIMEOUT_MS,
  ): Promise<SupersedeResult> {
    // Validate the target belongs to THIS chat (a CAS targeting another chat's run
    // is malformed -> 400). A missing row is NOT invalid: the run may have ended
    // and been pruned; the active-run check below decides degrade vs mismatch.
    const target = await this.getRun(targetRunId, workspaceId);
    if (target && target.chatId !== chatId) return { kind: 'invalid' };

    const active = await this.getActiveForChat(chatId, workspaceId);
    // No active run: it ended between the client's click and this POST — this is a
    // DEGRADE to a normal send, NOT a mismatch (the user's intent still holds).
    if (!active) return { kind: 'degrade' };
    // A DIFFERENT run is active than the one the client saw -> mismatch. The
    // client does not auto-retry; it surfaces the new runId.
    if (active.id !== targetRunId) {
      return { kind: 'mismatch', activeRunId: active.id };
    }

    // The target IS active: stop it, then await its settle within W.
    await this.requestStop(targetRunId, workspaceId);
    const outcome = await this.awaitSettled(targetRunId, workspaceId, timeoutMs);
    if (!outcome) return { kind: 'timeout' };
    // Gave up (terminal write failed): apply the intended status via the
    // conditional UPDATE so the slot actually frees. If that ALSO fails, the row
    // is still stranded -> treat as a timeout (nothing persisted for the new run).
    if (outcome.terminalWriteFailed) {
      const settled = await this.settleZombie(targetRunId);
      if (!settled && !(await this.rowIsTerminal(targetRunId, workspaceId))) {
        // settleZombie returned false in one of two ways:
        //   (1) our own re-drive threw (DB still down): the row is stranded
        //       non-terminal, a real SUPERSEDE_TIMEOUT; or
        //   (2) the periodic zombie reconcile settled and cleared this zombie
        //       between awaitSettled and this call: the row is terminal and the
        //       slot is free.
        // `rowIsTerminal` re-reads the row to tell them apart. A terminal row does
        // not occupy the partial unique index, and the caller re-gates through
        // beginRun anyway, so this never masks a real timeout. Only a
        // non-terminal (or unreadable) row is a timeout.
        return { kind: 'timeout' };
      }
    }
    return { kind: 'ready' };
  }

  /** #487 test/diagnostic seam: whether a give-up zombie is held for this run. */
  hasZombie(runId: string): boolean {
    return this.zombies.has(runId);
  }

  /** #487: every zombie runId held on this replica (reconcile clause a, commit 4). */
  zombieRunIds(): string[] {
    return [...this.zombies.keys()];
  }

  /** #487: create a one-shot deferred (resolve captured for a later single call). */
  private makeDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /** #487: resolve a run's settle notifier EXACTLY ONCE, then drop it (bounded).
   *  A subscriber that already grabbed the promise still resolves; a later one
   *  falls back to the zombie map / the row (see peekSettled). */
  private resolveSettled(runId: string, outcome: RunSettleOutcome): void {
    const d = this.settledPromises.get(runId);
    if (!d) return;
    this.settledPromises.delete(runId);
    d.resolve(outcome);
  }

  /** #487: read the persisted terminal outcome when the conditional finalize was a
   *  no-op (the row was already terminal). Falls back to the intended status when
   *  the read fails or the row is unexpectedly missing/non-terminal. */
  private async readTerminalOutcome(
    runId: string,
    workspaceId: string,
    fallbackStatus: RunTerminalStatus,
    fallbackError: string | null,
  ): Promise<RunSettleOutcome> {
    try {
      const row = await this.runRepo.findById(runId, workspaceId);
      if (row && isRunTerminal(row.status)) {
        return {
          status: row.status as RunTerminalStatus,
          error: row.error ?? null,
          terminalWriteFailed: false,
        };
      }
    } catch {
      // Fall through to the intended status — best-effort only.
    }
    return {
      status: fallbackStatus,
      error: fallbackError,
      terminalWriteFailed: false,
    };
  }

  /** Small async backoff between terminal-write retries (F6). Isolated so it is
   *  trivial to stub/fake-time in tests. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Request an explicit stop of a run (the user pressed Stop). This is the only
   * thing that aborts a run; a browser disconnect does not (except: a new chat's
   * client that left before the first frame never learned the chat id, so the
   * stream controller calls this itself). Aborts the in-process controller first
   * (the only thing that stops the run, if this replica owns it), then
   * best-effort stamps `stop_requested_at` (only while the row is active; it may
   * be skipped or lose the finalize race — the row still settles 'aborted').
   * Returns true when a stop took effect, false when nothing was active.
   */
  async requestStop(runId: string, workspaceId: string): Promise<boolean> {
    const entry = this.active.get(runId);
    if (entry) {
      // Abort the live turn FIRST -> streamText onAbort fires -> the partial is
      // persisted (#183) and finalizeRun settles the row as 'aborted'. This is
      // the ONLY thing that aborts a run, so it MUST NOT be hostage to the audit
      // write below: a transient failure on `markStopRequested` (pool exhaustion,
      // deadlock, dropped connection) must never leave the run executing despite
      // an explicit Stop. At worst only the `stop_requested_at` timestamp is lost.
      entry.controller.abort();
    }
    // Record `stop_requested_at` (best-effort). A transient DB failure here is
    // logged and treated as `marked = false`; the abort above already took
    // effect, so we never rethrow and skip stopping the run. Note: because
    // markStopRequested only stamps while the row is active, aborting first means
    // even a healthy write can lose the race against the resulting finalize and
    // skip the stamp — acceptable, as the row still settles as 'aborted' and only
    // this audit timestamp may be lost.
    let marked: unknown;
    try {
      marked = await this.runRepo.markStopRequested(runId, workspaceId);
    } catch (err) {
      marked = undefined;
      this.logger.warn(
        `requestStop: markStopRequested failed for run ${runId} ` +
          `(stop_requested_at not recorded); abort already issued: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return Boolean(marked) || Boolean(entry);
  }

  /** Latest persisted run for a chat — the reconnect target (an in-flight or
   *  finished run). Pure read-through to the repo. */
  getLatestForChat(
    chatId: string,
    workspaceId: string,
  ): Promise<AiChatRun | undefined> {
    return this.runRepo.findLatestByChat(chatId, workspaceId);
  }

  /** Fetch a run by id (workspace-scoped). Used to resolve + ownership-check an
   *  explicit stop targeting a runId. */
  getRun(runId: string, workspaceId: string): Promise<AiChatRun | undefined> {
    return this.runRepo.findById(runId, workspaceId);
  }

  /** #487/S5: whether the run's row is currently TERMINAL (the slot is free).
   *  Best-effort — a read failure returns false (conservative: the caller then
   *  treats the outcome as unconfirmed). Used by supersede to tell a genuine
   *  give-up (row still non-terminal) apart from the S5 reconcile race (zombie
   *  already re-driven, row terminal). NEVER throws. */
  private async rowIsTerminal(
    runId: string,
    workspaceId: string,
  ): Promise<boolean> {
    try {
      const row = await this.runRepo.findById(runId, workspaceId);
      return !!row && isRunTerminal(row.status);
    } catch {
      return false;
    }
  }

  /** The active run on a chat, if any (used to reject a concurrent start with a
   *  clean 409 before committing to the stream). */
  getActiveForChat(
    chatId: string,
    workspaceId: string,
  ): Promise<AiChatRun | undefined> {
    return this.runRepo.findActiveByChat(chatId, workspaceId);
  }

  /** Test/diagnostic seam: whether this replica is holding a live controller for
   *  the run. */
  isLocallyActive(runId: string): boolean {
    return this.active.has(runId);
  }
}
