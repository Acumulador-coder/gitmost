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
  LAST_EXPORT_REF,
  PUSH_BUDGET,
} from "./engine/git.js";
export type { DiffEntry, CommitOptions, TreeEntry } from "./engine/git.js";

export {
  readExisting,
  computePullActions,
  logDeletionDecision,
  buildExportTree,
} from "./engine/pull.js";
export type {
  ReadExistingDeps,
  PullActionsInput,
  PullActions,
  ExportTreeDeps,
  ExportTreePlan,
  ExportTreeResult,
  PullFailure,
} from "./engine/pull.js";

export {
  classifyRenameMoves,
  computePushActions,
  applyPushActions,
  runPush,
  parentFolderFile,
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
  CreatedPage,
  PushFailure,
  PushNoop,
  ApplyPushResult,
  PushDeps,
  PushRunResult,
} from "./engine/push.js";

export type { Settings } from "./engine/settings.js";

// What a cycle stopped by its AbortSignal throws.
export { CycleAbortedError } from "./engine/abort.js";

export { runCycle, prepareVault } from "./engine/cycle.js";
export type {
  RunCycleDeps,
  RunCycleResult,
  PrepareVaultDeps,
} from "./engine/cycle.js";
export { upgradeLegacyVault } from "./engine/upgrade.js";
export type { UpgradeVaultDeps } from "./engine/upgrade.js";

export { parsePageFile, serializePageFile } from "@docmost/prosemirror-markdown";
