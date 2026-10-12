/**
 * Cooperative cancellation of engine work. The caller hands a cycle an
 * AbortSignal (a lost space lock, the cycle's deadline); the engine checks it
 * between page operations and hands it to every conversion, and stops with a
 * `CycleAbortedError` that names where it stopped and why. A stop leaves
 * nothing to undo: no ref moves before the export's compare-and-swap on
 * `main`, and the next cycle, once `prepareVault` has repaired the refs,
 * re-applies the same changes, which is idempotent.
 */

/** Engine work stopped by the cycle's AbortSignal. `cause` is the signal's reason. */
export class CycleAbortedError extends Error {
  constructor(what: string, reason: unknown) {
    super(
      `git-sync stopped ${what}: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
      { cause: reason },
    );
    this.name = "CycleAbortedError";
  }
}

/** Throw a `CycleAbortedError` naming `what` when `signal` is aborted. */
export function throwIfAborted(
  signal: AbortSignal | undefined,
  what: string,
): void {
  if (signal?.aborted) throw new CycleAbortedError(what, signal.reason);
}
