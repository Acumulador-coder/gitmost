/**
 * Public surface of `@docmost/git-sync`.
 *
 * Exposes the pure converter (markdown <-> ProseMirror, file envelope,
 * canonicalization) and the sync engine (reconcile planner, vault layout,
 * pull/push, the git wrapper, and the settings parser) that the gitmost server
 * drives in-process.
 */

// Pure converter (markdown <-> ProseMirror, file envelope, canonicalization).
// Re-exported from the standalone `@docmost/prosemirror-markdown` package,
// which is the single source of truth for the converter core; git-sync keeps
// only the engine (vault/git/orchestrator) and re-surfaces the converter for
// in-process consumers of the git-sync barrel.
export {
  serializeDocmostMarkdown,
  serializeDocmostMarkdownBody,
  parseDocmostMarkdown,
  convertProseMirrorToMarkdown,
  canonicalizeContent,
  docsCanonicallyEqual,
} from "@docmost/prosemirror-markdown";
export type { DocmostMdMeta } from "@docmost/prosemirror-markdown";
// The converter's markdownToProseMirror, same signature, run on the converter
// worker pool (input budget + deadline) so a big page never blocks the
// caller's event loop.
export { markdownToProseMirror } from "./engine/convert-pool.js";

// Pure engine (no IO): reconcile planner, vault layout, sanitize, stabilize,
// loop-guard body hash.
export {
  planReconciliation,
  decideAbsenceDeletions,
  MASS_DELETE_MIN_EXISTING,
  MASS_DELETE_FRACTION,
} from "./engine/reconcile.js";
export type {
  LiveEntry,
  ExistingEntry,
  WriteEntry,
  MovedEntry,
  ReconciliationPlan,
  DeletionDecision,
} from "./engine/reconcile.js";

export { buildVaultLayout } from "./engine/layout.js";
export type { PageNode, VaultEntry } from "./engine/layout.js";

export { sanitizeTitle, disambiguate } from "./engine/sanitize.js";

export { stabilizePageFile } from "./engine/stabilize.js";
export type { PageMeta } from "./engine/stabilize.js";

export { bodyHash } from "./engine/loop-guard.js";

// IO engine: the client seam, the VaultGit git wrapper, the
// pull (Docmost->FS) + push (FS->Docmost) planners/appliers, and the (pure)
// settings parser. The engine consumes the native `GitSyncClient` seam (the
// server implements it) rather than any REST client.
export type { GitSyncClient, GitSyncPageNodeLite } from "./engine/client.types.js";

export {
  VaultGit,
  vaultGitEnv,
  buildCommitMessage,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
  PUSH_BUDGET,
} from "./engine/git.js";
export type { DiffEntry, MergeResult, CommitOptions } from "./engine/git.js";

export {
  readExisting,
  computePullActions,
  applyPullActions,
} from "./engine/pull.js";
export type {
  ReadExistingDeps,
  PullActionsInput,
  PullActions,
  ApplyPullActionsDeps,
  ApplyResult,
  PullFailure,
} from "./engine/pull.js";

export {
  classifyRenameMoves,
  computePushActions,
  applyPushActions,
  runPush,
  parentFolderFile,
  LOCAL_AUTHOR_NAME,
  LOCAL_AUTHOR_EMAIL,
  LOCAL_SOURCE_TRAILER,
} from "./engine/push.js";
export type {
  CreateAction,
  UpdateAction,
  DeleteAction,
  RenameMoveAction,
  RenameMoveActionClassified,
  ClassifyRenameMovesDeps,
  PushActions,
  PushActionsInput,
  MetaSide,
  ApplyPushDeps,
  WrittenBackPage,
  PushedPageRecord,
  PushFailure,
  PushNoop,
  ApplyPushResult,
  PushDeps,
  PushRunResult,
} from "./engine/push.js";

export type { Settings } from "./engine/settings.js";

// The engine's mirror branch, and the marker the server sets around an
// external push's receive-pack (DESIGN.md §3).
export { DOCMOST_BRANCH, RECEIVE_REF } from "./engine/vault-refs.js";

// What a cycle stopped by its AbortSignal throws (DESIGN.md §9).
export { CycleAbortedError } from "./engine/abort.js";

export { runCycle, recoverVault } from "./engine/cycle.js";
export type {
  RunCycleDeps,
  RunCycleResult,
  CycleFs,
  RecoverVaultDeps,
} from "./engine/cycle.js";

export {
  assertVaultPathSafe,
  isWithinRoot,
  VaultPathUnsafeError,
} from "./engine/path-guard.js";
export type { PathGuardIo, VaultPathUnsafeReason } from "./engine/path-guard.js";

export { parsePageFile, serializePageFile } from "@docmost/prosemirror-markdown";
