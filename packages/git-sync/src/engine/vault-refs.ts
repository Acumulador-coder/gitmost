/**
 * The single declaration of the vault's branches and the engine's service refs
 * (DESIGN.md §3). Everything else that names one — the cycle, the pull, the
 * push, the stale-lock sweep and the pre-receive push guard — takes it from
 * here, so a ref cannot be added, renamed or retired in one place and missed in
 * another.
 */

/**
 * The human-facing branch: what a clone checks out and a push writes. Owned by
 * people (pushes) and by the engine's merge of `docmost` into it.
 */
export const MAIN_BRANCH = "main";

/**
 * The engine-only mirror of what Docmost holds. Written only by the engine (a
 * pull's export commit, a push's fast-forward or per-page record); a push to
 * it is refused by the pre-receive hook.
 */
export const DOCMOST_BRANCH = "docmost";

/** The namespace of the engine's service refs; a push into it is refused. */
export const SERVICE_REF_PREFIX = "refs/docmost/";

/**
 * Set for the whole pull, from before it checks out `docmost` until
 * `applyPullActions` returns on `main`. Everything the pull leaves uncommitted
 * on `main` is engine work derived from committed `main` and from Docmost, so
 * the next cycle DISCARDS it and redoes the pull instead of committing it as
 * user work.
 */
export const PULL_REF = `${SERVICE_REF_PREFIX}pulling`;

/**
 * Set from before a push writes its first file on `main` (an id write-back, a
 * conflict-free rewrite) until those writes are committed. A file left
 * uncommitted under it is the push's own write: recovery commits it only when
 * the write is complete and restores it from `HEAD` otherwise, so an
 * interrupted write is never committed as user work.
 */
export const PUSH_REF = `${SERVICE_REF_PREFIX}pushing`;

/**
 * Names a per-page record (`recordPushedPages`) from before `docmost` moves to
 * it until `main` has it, so `recoverVault` finishes a record a crash cut off.
 */
export const RECORD_REF = `${SERVICE_REF_PREFIX}recording`;

/**
 * Set by the server from before an external push's receive-pack runs until it
 * returned. A receive-pack cut off after it updated `main`'s working tree but
 * before it moved `main` leaves a possibly partial checkout of a push the
 * client never saw accepted: recovery DISCARDS a dirty `main` under it instead
 * of committing it as user work.
 */
export const RECEIVE_REF = `${SERVICE_REF_PREFIX}receiving`;

/** Every branch the engine owns or writes. */
export const ENGINE_BRANCHES: readonly string[] = [MAIN_BRANCH, DOCMOST_BRANCH];

/** Every service ref the engine sets; each is gone between cycles. */
export const SERVICE_REFS: readonly string[] = [
  PULL_REF,
  PUSH_REF,
  RECORD_REF,
  RECEIVE_REF,
];

/**
 * Service refs older engines wrote and nothing reads any more. `recoverVault`
 * deletes them from existing vaults. `refs/docmost/last-pushed` was written on
 * every push but never read once the push base became merge-base(`docmost`,
 * `main`): a second, stale source of truth.
 */
export const RETIRED_REFS: readonly string[] = [`${SERVICE_REF_PREFIX}last-pushed`];
