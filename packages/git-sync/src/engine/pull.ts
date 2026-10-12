/**
 * Export planning — Docmost -> vault (SPEC §6 "Docmost -> FS").
 *
 *   - `readExisting`: the page files `main` holds (`gitmost_id` frontmatter).
 *   - `computePullActions` (PURE): the live tree's layout reconciled against
 *     them — what to write, what moved, what to delete (with the SPEC §8
 *     suppression folded in) and each live page's export key.
 *   - `buildExportTree`: that plan applied to a tree with plumbing only (no
 *     working tree, no checkout); `runCycle` commits it.
 *
 * Nothing here writes to Docmost (read-only: listSpaceTree + getPageJson).
 */
import {
  parsePageFile,
  serializePageFile,
} from "@docmost/prosemirror-markdown";
import type { GitSyncClient } from "./client.types.js";
import { buildVaultLayout, type PageNode } from "./layout.js";
import type { VaultGit } from "./git.js";
import {
  planReconciliation,
  decideAbsenceDeletions,
  type LiveEntry,
  type MovedEntry,
  type DeletionDecision,
} from "./reconcile.js";
import { stabilizePageBody } from "./stabilize.js";
import { CycleAbortedError, throwIfAborted } from "./abort.js";

// Number of pages fetched/stabilized concurrently. Bounded so a large space
// does not open thousands of simultaneous requests/conversions at once.
const CONCURRENCY = 6;
// How often to log incremental progress (every N completed pages).
const PROGRESS_EVERY = 25;

/** Convert an absolute/relative segment list under the vault to a relPath. */
function segmentsToRelPath(segments: string[], stem: string): string {
  return [...segments, `${stem}.md`].join("/");
}

/** IO for `readExisting`; the cycle reads `main`, tests pass fakes. */
export interface ReadExistingDeps {
  /** Each `.md` file's first `gitmost_id:` line (`VaultGit.pageIdsAtRef`). */
  candidates: () => Promise<{ path: string; id: string }[]>;
  /** The texts of the given files; a file missing from the map is skipped. */
  readFiles: (paths: string[]) => Promise<Map<string, string>>;
}

/**
 * The tracked page files: `{ pageId, relPath }` of every candidate whose
 * `gitmost_id` FRONTMATTER parses (a body line can carry the key too, so a grep
 * hit alone is not identity). Files without one are not engine-tracked pages
 * yet — the apply step creates them.
 */
export async function readExisting(
  deps: ReadExistingDeps,
): Promise<{ pageId: string; relPath: string }[]> {
  const candidates = await deps.candidates();
  const texts = await deps.readFiles(candidates.map((c) => c.path));
  const existing: { pageId: string; relPath: string }[] = [];
  for (const { path } of candidates) {
    const text = texts.get(path);
    if (text === undefined) continue;
    const { id } = parsePageFile(text);
    if (id) existing.push({ pageId: id, relPath: path });
  }
  return existing;
}

/**
 * Input to the PURE `computePullActions` (R-Pull-2). All data, no IO: the live
 * tree nodes + completeness flag (from `listSpaceTree`) and the parsed
 * `existing` tracked files (from `readExisting`).
 */
export interface PullActionsInput {
  /**
   * Live page nodes for the space (from `listSpaceTree`). `updatedAt` feeds the
   * export key; a node without it is never treated as unchanged.
   */
  pages: (PageNode & { updatedAt?: string })[];
  /** Whether the live tree fetch was COMPLETE (SPEC §8 suppression). */
  treeComplete: boolean;
  /** Parsed tracked files: `{ pageId, relPath }` (from `readExisting`). */
  existing: { pageId: string; relPath: string }[];
  /**
   * The subset of tracked pageIds that correspond to a REAL page row (D-P3-1
   * ghost guard, from `client.pageIdsExist`). Only ids in this set may be
   * absence-deleted; a ghost id (never a page) is preserved. When omitted, all
   * absent ids are deletable (the historical behavior; pure unit callers that
   * do not model ghosts).
   */
  deletableIds?: string[];
  /**
   * pageId -> export key recorded after that page's last SUCCESSFUL export
   * (owned by the caller, see `RunCycleDeps.exportKeys`). A live page whose
   * current key equals its recorded key AND whose file is tracked at its relPath
   * is left out of `toWrite` (no `getPageJson`, no conversion). Omitted -> every
   * live page is written (a full pass).
   */
  exportKeys?: ReadonlyMap<string, string>;
}

/**
 * The export key of a live page: everything that decides the exported file —
 * the body version (`updatedAt`), its location (`relPath`, which already folds
 * in the ancestor names, the folder-note shape and sibling disambiguation) and
 * the node's own tree fields. The file itself carries only `gitmost_id` + the
 * body (`serializePageFile`). `null` when the node has no `updatedAt`: such a
 * page can never be proven unchanged, so it is always exported.
 */
export function exportKeyOf(
  node: PageNode & { updatedAt?: string },
  relPath: string,
): string | null {
  if (typeof node.updatedAt !== "string" || node.updatedAt.length === 0) {
    return null;
  }
  return JSON.stringify([
    node.updatedAt,
    relPath,
    node.title ?? null,
    node.slugId ?? null,
    node.parentPageId ?? null,
  ]);
}

/**
 * The PURE decisions object computed by `computePullActions` (no IO). It holds
 * the reconciliation plan plus the SPEC §8 absence-deletion decision, with the
 * suppression already folded in: `toDelete` is the POST-suppression set the
 * caller should actually remove (empty when `deletionDecision.apply` is false).
 */
export interface PullActions {
  /** Every live page at its layout path. */
  live: LiveEntry[];
  /**
   * Pages to (re)write at their relPath (add + update + move target). Excludes
   * live pages proven unchanged by `PullActionsInput.exportKeys`.
   */
  toWrite: { pageId: string; relPath: string }[];
  /**
   * The CURRENT export key of every live page that has one (see `exportKeyOf`).
   * The caller records these after the cycle commits the exports.
   */
  liveExportKeys: Map<string, string>;
  /** Moves: write new path, then remove old path (only on a successful write). */
  moved: MovedEntry[];
  /**
   * Absence-based paths to delete AFTER suppression. Empty when the decision
   * suppressed deletions this cycle, so the caller can apply it unconditionally.
   */
  toDelete: string[];
  /** Why absence deletions were (or were not) applied (for logging + tests). */
  deletionDecision: DeletionDecision;
  /** Tracked-file count (for the suppression log messages). */
  existingCount: number;
  /** Planned absence-delete count BEFORE suppression (for the log message). */
  plannedDeleteCount: number;
}

/**
 * PURE pull-action planner. Takes the live
 * tree nodes + completeness + existing tracked files and returns the full set of
 * decisions with NO IO:
 *
 *   - builds the vault layout (deterministic relPath per live page),
 *   - `planReconciliation` -> toWrite / moved / absence-toDelete,
 *   - `decideAbsenceDeletions` -> the SPEC §8 suppression (incomplete-fetch +
 *     empty-live + mass-delete guard), folded IN here so `toDelete` is the
 *     POST-suppression set (empty when suppressed).
 *
 * Moves are NOT governed by the suppression: a moved page is present in `live`,
 * so its old-path removal is real (the caller still gates it on the write
 * succeeding). The content fetch and the tree happen in `buildExportTree`.
 */
export function computePullActions(input: PullActionsInput): PullActions {
  const { pages, treeComplete, existing, deletableIds, exportKeys } = input;
  const layout = buildVaultLayout(pages);

  const live: LiveEntry[] = [];
  const liveExportKeys = new Map<string, string>();
  for (const p of pages) {
    if (!p || !p.id) continue;
    const entry = layout.get(p.id);
    if (!entry) continue;
    const relPath = segmentsToRelPath(entry.segments, entry.stem);
    live.push({ pageId: p.id, relPath });
    const key = exportKeyOf(p, relPath);
    if (key !== null) liveExportKeys.set(p.id, key);
  }

  // Plan reconciliation (pure). `plan.toDelete` is ABSENCE-based only;
  // `plan.moved` carries move old-path removals separately. The ghost guard
  // (D-P3-1) gates absence-deletes to ids that are a real page row; when
  // `deletableIds` is omitted, all absent ids are deletable (historical).
  const plan = planReconciliation(
    live,
    existing,
    deletableIds === undefined ? undefined : new Set(deletableIds),
  );

  // Decide whether the ABSENCE-based deletions may be applied this cycle
  // (SPEC §8): incomplete-fetch suppression + empty-live + mass-delete guard.
  // Moves are NOT governed by this.
  const deletionDecision = decideAbsenceDeletions({
    treeComplete,
    liveCount: live.length,
    existingCount: existing.length,
    deleteCount: plan.toDelete.length,
  });

  // Change detection: skip a live page whose export key is unchanged since its
  // last successful export AND whose file is still tracked at that exact path
  // (a deleted/moved/never-written file is re-exported even with a matching key).
  const trackedAt = new Set(existing.map((e) => `${e.pageId}\u0000${e.relPath}`));
  const toWrite = exportKeys
    ? plan.toWrite.filter((w) => {
        const key = liveExportKeys.get(w.pageId);
        const unchanged =
          key !== undefined &&
          exportKeys.get(w.pageId) === key &&
          trackedAt.has(`${w.pageId}\u0000${w.relPath}`);
        return !unchanged;
      })
    : plan.toWrite;

  return {
    live,
    toWrite,
    liveExportKeys,
    moved: plan.moved,
    // Fold the suppression in: a suppressed cycle deletes nothing.
    toDelete: deletionDecision.apply ? plan.toDelete : [],
    deletionDecision,
    existingCount: existing.length,
    plannedDeleteCount: plan.toDelete.length,
  };
}

/** Log why absence deletions were suppressed this cycle (SPEC §8), if they were. */
export function logDeletionDecision(
  log: (line: string) => void,
  actions: Pick<PullActions, "deletionDecision" | "existingCount" | "plannedDeleteCount">,
): void {
  const decision = actions.deletionDecision;
  if (decision.apply) return;
  if (decision.reason === "incomplete-fetch") {
    log("pull: tree fetch incomplete — deletions suppressed this cycle (SPEC §8)");
  } else if (decision.reason === "empty-live") {
    log(
      `pull: live fetch returned 0 pages but ${actions.existingCount} file(s) are ` +
        `tracked — deletions suppressed this cycle (SPEC §8). Re-run when ` +
        `Docmost is reachable.`,
    );
  } else {
    log(
      `pull: plan would delete ${actions.plannedDeleteCount} of ${actions.existingCount} ` +
        `tracked file(s) (mass-delete guard) — deletions suppressed this ` +
        `cycle (SPEC §8). Verify the live Docmost tree, then re-run.`,
    );
  }
}

/** IO for `buildExportTree`. */
export interface ExportTreeDeps {
  client: Pick<GitSyncClient, "getPageJson">;
  git: Pick<VaultGit, "hashObject" | "buildTree">;
  log: (line: string) => void;
  /**
   * The cycle's AbortSignal: checked before each page is fetched and handed to
   * every conversion. An abort stops the export with a `CycleAbortedError`.
   */
  signal?: AbortSignal;
}

/**
 * A live page the export could not place (its fetch, its conversion — over the
 * JSON budget, past its deadline, a converter error — or its blob write
 * failed). It does not reach git this cycle and is retried the next.
 */
export interface PullFailure {
  pageId: string;
  /** The error message captured from the thrown error. */
  error: string;
}

/** What one export changes in its start tree. */
export interface ExportTreePlan {
  /** The tree-ish the export starts from. */
  start: string;
  /**
   * Page files to place at `relPath`: the given `blob`, else the page fetched
   * and serialized in its fixpoint form (SPEC §11).
   */
  pages: { pageId: string; relPath: string; blob?: string }[];
  /**
   * Paths removed only when the page's file is placed by this export (a failed
   * fetch or a pinned layout path keeps them).
   */
  removeIfWritten: { pageId: string; path: string }[];
  /** Paths removed whatever the fetches did. */
  remove: string[];
  /** Paths left exactly as they are in `start`. */
  pinned?: ReadonlySet<string>;
}

/** The tree an export built, with its counters. */
export interface ExportTreeResult {
  tree: string;
  /** Pages fetched and serialized. */
  written: number;
  /** `removeIfWritten` paths removed. */
  movedApplied: number;
  /** `remove` paths removed. */
  deleted: number;
  /**
   * Pages not placed: their fetch, conversion or blob write failed, or their
   * layout path is pinned.
   */
  failedPageIds: string[];
  /** Pages whose fetch, conversion or blob write failed (pinned ones not counted). */
  failed: number;
  /** The first of the `failed` pages and its reason (absent when none failed). */
  firstFailure?: PullFailure;
}

/**
 * Build the export tree with plumbing only (no working tree, no checkout):
 * fetch each page without a blob through a bounded-concurrency pool, store it
 * with `hash-object`, then apply removals and page files to `start` in a private
 * index. One bad page never aborts the export: it lands in `failedPageIds` and
 * every path tied to it by `removeIfWritten` stays. So does a page whose layout
 * path is pinned (held by a page whose apply failed): it is not fetched or
 * placed until that path is released.
 */
export async function buildExportTree(
  deps: ExportTreeDeps,
  plan: ExportTreePlan,
): Promise<ExportTreeResult> {
  const { client, git, log, signal } = deps;
  const pinned = plan.pinned ?? new Set<string>();
  const blobs = new Map<string, string>();
  const failedPageIds = new Set<string>();
  for (const p of plan.pages) {
    if (!pinned.has(p.relPath)) continue;
    failedPageIds.add(p.pageId);
    log(`pull: ${p.relPath} is held by a failed page — ${p.pageId} keeps its files`);
  }
  const toFetch = plan.pages.filter(
    (p) => p.blob === undefined && !failedPageIds.has(p.pageId),
  );
  let written = 0;
  let failed = 0;
  let firstFailure: PullFailure | undefined;
  let completed = 0;
  let nextIndex = 0;

  const fetchOne = async (p: { pageId: string; relPath: string }) => {
    try {
      const page = await client.getPageJson(p.pageId);
      // Native-Obsidian format: a minimal `gitmost_id` frontmatter + the fixpoint
      // markdown body; title/parent/space are derived from the path.
      const text = serializePageFile(
        page.id,
        await stabilizePageBody(page.content, signal),
      );
      blobs.set(p.pageId, await git.hashObject(text));
      written++;
    } catch (err) {
      // An abort ends the export, it is not this page's failure.
      if (err instanceof CycleAbortedError) throw err;
      failedPageIds.add(p.pageId);
      failed++;
      const error = err instanceof Error ? err.message : String(err);
      firstFailure ??= { pageId: p.pageId, error };
      // Every failed page is named here; the cycle WARNs the count and the
      // first one.
      log(`pull: failed page ${p.pageId}: ${error}`);
    } finally {
      completed++;
      if (completed % PROGRESS_EVERY === 0) {
        log(`pulled ${completed}/${toFetch.length}`);
      }
    }
  };
  const runner = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= toFetch.length) return;
      throwIfAborted(signal, `before exporting page ${toFetch[i].pageId}`);
      await fetchOne(toFetch[i]);
    }
  };
  // Every runner is waited for, an aborted one included, so no fetch or blob
  // write is still running when the export has stopped.
  const runs = await Promise.allSettled(
    Array.from({ length: Math.min(CONCURRENCY, toFetch.length) || 1 }, () =>
      runner(),
    ),
  );
  for (const run of runs) if (run.status === "rejected") throw run.reason;

  const placed = new Map<string, { relPath: string; blob: string }>();
  for (const p of plan.pages) {
    const blob = p.blob ?? blobs.get(p.pageId);
    if (blob !== undefined && !failedPageIds.has(p.pageId)) {
      placed.set(p.pageId, { relPath: p.relPath, blob });
    }
  }
  const changes = new Map<string, string | null>();
  let movedApplied = 0;
  for (const r of plan.removeIfWritten) {
    if (pinned.has(r.path)) continue;
    if (!placed.has(r.pageId)) {
      log(`pull: ${r.pageId} was not exported — keeping ${r.path} (SPEC §8)`);
      continue;
    }
    changes.set(r.path, null);
    movedApplied++;
  }
  let deleted = 0;
  for (const path of plan.remove) {
    if (pinned.has(path)) continue;
    changes.set(path, null);
    deleted++;
  }
  for (const { relPath, blob } of placed.values()) changes.set(relPath, blob);
  const tree = await git.buildTree(
    plan.start,
    [...changes].map(([path, sha]) => ({ path, sha })),
  );
  return {
    tree,
    written,
    movedApplied,
    deleted,
    failedPageIds: [...failedPageIds],
    failed,
    ...(firstFailure ? { firstFailure } : {}),
  };
}
