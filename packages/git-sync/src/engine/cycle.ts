import { createHash } from "node:crypto";
import {
  VaultGit,
  DEFAULT_BRANCH,
  LAST_EXPORT_REF,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
} from "./git.js";
import { GitSyncClient, type GitSyncPageNodeLite } from "./client.types.js";
import { Settings } from "./settings.js";
import {
  readExisting,
  computePullActions,
  buildExportTree,
  logDeletionDecision,
  type PullFailure,
} from "./pull.js";
import { runPush, type CreatedPage, type PushFailure } from "./push.js";
import { upgradeLegacyVault, type UpgradeVaultDeps } from "./upgrade.js";
import { throwIfAborted } from "./abort.js";

/** Provenance of an export commit on `main` (SPEC §7.3): `docmost`. */
const SOURCE_TRAILER = "Docmost-Sync-Source";
/** The last-export pointer an export commit started from. */
const PREV_EXPORT_TRAILER = "Docmost-Sync-Prev-Export";
/** Where the pointer goes after it: a record commit, or `self`. */
const LAST_EXPORT_TRAILER = "Docmost-Sync-Last-Export";

/** The most per-page push failures one cycle names in the log. */
const LOGGED_PUSH_FAILURES = 20;

export interface RunCycleDeps {
  spaceId: string;
  /** The Docmost seam (reads for the export, writes for the apply). */
  client: GitSyncClient;
  /** The per-space bare git vault. */
  vault: VaultGit;
  /** Engine settings. */
  settings: Settings;
  log: (line: string) => void;
  /**
   * Warning channel for events an operator must notice (per-page failures, the
   * vault self-heals). Falls back to `log` when not supplied.
   */
  warn?: (line: string) => void;
  /**
   * The caller-owned export-key map of THIS space (pageId -> key of the page's
   * last successful export, see `exportKeyOf`). The export reuses the last
   * export's file of a live page whose key is unchanged. The cycle REBUILDS it
   * only after the whole cycle succeeded, so it holds at most one entry per live
   * page; it CLEARS it when the cycle throws or `prepareVault` had to repair the
   * vault, so the next cycle is a full pass. Omitted -> every cycle is a full
   * pass.
   */
  exportKeys?: Map<string, string>;
  /**
   * The caller-owned idle memo of THIS space: the fingerprint (`treeFingerprint`)
   * of the Docmost tree the last clean cycle exported. While it is set, the
   * cycle first reads that tree alone (no git) and, when its fingerprint is
   * unchanged, returns at once without running a single git command; otherwise
   * it clears the memo and runs in full. The cycle SETS it only after a clean
   * cycle (a complete tree, no apply or export failure, nothing kept back, the
   * pointer at `main`) and CLEARS it when the cycle throws. The skip relies on
   * nothing but the caller's own cycles moving the vault's refs: the caller
   * clears the memo whenever something else may have (a push's receive-pack).
   * Omitted -> every cycle is a full pass.
   */
  idle?: { fingerprint: string | null };
  /**
   * Optional cooperative-abort signal. The caller (orchestrator) aborts it when
   * a heartbeat refresh cannot CONFIRM the per-space lock is still held, or
   * when the cycle's deadline passes. The cycle checks it before the apply,
   * before the export and before `main` moves; the apply and the export check
   * it between page operations and hand it to every conversion. An abort ends
   * the cycle with a `CycleAbortedError` instead of writing blind after a
   * possible lock loss: no ref moves before `main`'s compare-and-swap, and the
   * next cycle re-applies the same changes, which is idempotent. A COARSE
   * best-effort guard, not a fenced cross-process single-writer.
   */
  signal?: AbortSignal;
}

export interface RunCycleResult {
  ran: boolean;
  /**
   * The export: pages fetched and files of removed pages dropped. `failures`
   * counts the live pages the export could not place (they did not reach git
   * this cycle and are retried the next); `firstFailure` is the first of them
   * (absent when none).
   */
  pull?: {
    written: number;
    deleted: number;
    failures: number;
    firstFailure?: PullFailure;
  };
  /** `firstFailure` is the first per-page apply failure (absent when none). */
  push?: { mode: string; failures: number; firstFailure?: PushFailure };
}

/**
 * Run ONE reconcile cycle for a space, under the caller's space lock. There is
 * one merge domain — the collaboration layer's block 3-way merge — and the
 * vault never runs `git merge`:
 *
 *   -. IDLE: with `deps.idle` set and Docmost's tree unchanged since the last
 *      clean cycle, the cycle ends here, before any git command.
 *   0. `prepareVault`: repo, stale locks, legacy upgrade, `main`, pointer.
 *   1. APPLY: when `main`'s tree differs from the last export's, the user's
 *      changes since that export reach Docmost by `gitmost_id` (`runPush`); an
 *      update is a block 3-way merge with the last export's body as its base,
 *      and git wins a block both sides changed.
 *   2. EXPORT: Docmost (read after step 1) becomes a tree built with plumbing
 *      on top of `main`'s, committed on `main` with a compare-and-swap
 *      `update-ref`; the pointer moves after it. A page whose apply failed
 *      keeps git's file on `main`, and the pointer keeps its last-export
 *      version, so the next cycle retries it alone.
 *
 * Lock POLICY lives in the caller; this owns only the mechanics. Deletes are
 * soft (Trash, reversible) and always logged.
 *
 * Any throw clears `deps.exportKeys` and `deps.idle` (the next cycle is a full
 * pass) and is re-thrown unchanged.
 */
export async function runCycle(deps: RunCycleDeps): Promise<RunCycleResult> {
  try {
    return await runCycleOnce(deps);
  } catch (err) {
    deps.exportKeys?.clear();
    if (deps.idle) deps.idle.fingerprint = null;
    throw err;
  }
}

/**
 * The fingerprint of what an export reads from Docmost: sha256 of the canonical
 * JSON (object keys sorted) of the tree's `complete` flag, every page node with
 * all its fields (sorted by id) and the engine settings.
 */
function treeFingerprint(
  tree: { pages: GitSyncPageNodeLite[]; complete: boolean },
  settings: Settings,
): string {
  const pages = [...tree.pages].sort((a, b) => {
    const x = a?.id ?? "";
    const y = b?.id ?? "";
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const json = JSON.stringify(
    { complete: tree.complete, pages, settings },
    (_key, value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
          )
        : value,
  );
  return createHash("sha256").update(json).digest("hex");
}

/** IO for `prepareVault`. */
export type PrepareVaultDeps = UpgradeVaultDeps;

/**
 * Bring the vault to a state a cycle can run on: an initialized repo, no stale
 * git locks, a legacy vault upgraded to the bare layout, a `main` branch and a
 * last-export pointer that is not behind an export commit on `main`. Runs under
 * the space lock, before every cycle and before an external push's
 * receive-pack. Returns true when it had to repair anything.
 */
export async function prepareVault(deps: PrepareVaultDeps): Promise<boolean> {
  const { vault } = deps;
  await vault.assertGitAvailable();
  let repaired = await vault.ensureRepo();
  if ((await vault.clearStaleGitLocks()) > 0) repaired = true;
  if (await upgradeLegacyVault(deps)) repaired = true;
  if (await vault.ensureMainBranch()) repaired = true;
  if (await repairPointer(deps)) repaired = true;
  return repaired;
}

/**
 * An export moves `main` first and the pointer second. When a crash fell
 * between the two, `main`'s tip is that export commit and the pointer is still
 * at the export's start (its Prev trailer): move the pointer where the export
 * meant it to go (its Last trailer, `self` for the commit itself).
 */
async function repairPointer(deps: PrepareVaultDeps): Promise<boolean> {
  const { spaceId, vault } = deps;
  const warn = deps.warn ?? deps.log;
  const tip = await vault.revParse(`refs/heads/${DEFAULT_BRANCH}`);
  const pointer = await vault.revParse(LAST_EXPORT_REF);
  if (tip === null || pointer === null || tip === pointer) return false;
  const trailers = new Map<string, string>();
  for (const line of (await vault.commitMessage(tip)).split("\n")) {
    const m = line.match(/^([\w-]+): (.+)$/);
    if (m) trailers.set(m[1], m[2]);
  }
  if (trailers.get(SOURCE_TRAILER) !== "docmost") return false;
  if (trailers.get(PREV_EXPORT_TRAILER) !== pointer) return false;
  const last = trailers.get(LAST_EXPORT_TRAILER);
  if (last === undefined) return false;
  const target = last === "self" ? tip : last;
  // An export whose record is its own start (every change it kept back) leaves
  // the pointer where it is: nothing was cut off.
  if (target === pointer) return false;
  await vault.updateRef(LAST_EXPORT_REF, target, pointer);
  warn(
    `space ${spaceId}: the export ${tip.slice(0, 8)} was cut off before the ` +
      `last-export pointer moved — moved it to ${target.slice(0, 8)}.`,
  );
  return true;
}

async function runCycleOnce(deps: RunCycleDeps): Promise<RunCycleResult> {
  const { spaceId, client, vault, settings, log, signal, exportKeys, idle } = deps;
  const warn = deps.warn ?? log;

  // An idle space: Docmost still holds the tree the last clean cycle exported,
  // and (the caller's contract) nothing else moved the vault since, so there is
  // nothing to apply and nothing to export.
  if (idle?.fingerprint) {
    if (treeFingerprint(await client.listSpaceTree(spaceId), settings) === idle.fingerprint) {
      return {
        ran: true,
        pull: { written: 0, deleted: 0, failures: 0 },
        push: { mode: "apply", failures: 0 },
      };
    }
    idle.fingerprint = null;
  }

  // 0. Any self-heal means the vault may not hold what the recorded export keys
  //    describe: forget them so this cycle re-exports every live page.
  if (await prepareVault({ spaceId, vault, log, warn })) exportKeys?.clear();

  const main0 = await vault.revParse(`refs/heads/${DEFAULT_BRANCH}`);
  const base0 = await vault.revParse(LAST_EXPORT_REF);
  if (main0 === null || base0 === null) {
    throw new Error(
      `space ${spaceId}: the vault has no '${DEFAULT_BRANCH}' or no ${LAST_EXPORT_REF}`,
    );
  }
  const mainTree = await vault.revParse(`${main0}^{tree}`);
  const baseTree = await vault.revParse(`${base0}^{tree}`);
  // A symlink entry is never a page: never applied, never read as one.
  const symlinks = new Set(
    (await vault.lsTree(main0)).filter((e) => e.mode === "120000").map((e) => e.path),
  );

  // 1. APPLY ---------------------------------------------------------------
  throwIfAborted(signal, "before applying the user's changes");
  let failures: PushFailure[] = [];
  let created: CreatedPage[] = [];
  if (mainTree !== baseTree) {
    const pushed = await runPush(
      {
        settings,
        git: vault,
        makeClient: () => client,
        baseRef: base0,
        headRef: main0,
        symlinks,
        log,
        signal,
      },
      { dryRun: false },
    );
    failures = pushed.failures ?? [];
    created = pushed.created ?? [];
    // Name each failed page and its reason (the status carries only the first
    // one), capped so a mass failure cannot flood the log.
    for (const f of failures.slice(0, LOGGED_PUSH_FAILURES)) {
      warn(`space ${spaceId}: push ${f.kind} of ${f.path} failed: ${f.error}`);
    }
    if (failures.length > LOGGED_PUSH_FAILURES) {
      warn(
        `space ${spaceId}: … and ${failures.length - LOGGED_PUSH_FAILURES} ` +
          `more push failure(s)`,
      );
    }
  }

  // 2. EXPORT --------------------------------------------------------------
  const tree = await client.listSpaceTree(spaceId);
  const existing = await readExisting({
    candidates: async () =>
      (await vault.pageIdsAtRef(main0)).filter((e) => !symlinks.has(e.path)),
    readFiles: (paths) => vault.readFilesAtRef(main0, paths),
  });

  // D-P3-1 ghost guard: an absence-delete must not remove a git file whose
  // pageId was NEVER a page (a hand-authored file with an unknown id). Only the
  // tracked ids absent from the live tree that the datasource knows as a page
  // row (incl. trashed / other spaces) may be absence-deleted. On an INCOMPLETE
  // fetch many live pages look absent, but `computePullActions` then suppresses
  // every absence delete anyway.
  const livePageIds = new Set(tree.pages.filter((p) => p && p.id).map((p) => p.id));
  const candidateDeleteIds = existing
    .map((e) => e.pageId)
    .filter((id) => !livePageIds.has(id));
  const deletableIds =
    candidateDeleteIds.length > 0 ? await client.pageIdsExist(candidateDeleteIds) : [];

  const plan = computePullActions({
    pages: tree.pages,
    treeComplete: tree.complete,
    existing,
    deletableIds,
    exportKeys,
  });
  logDeletionDecision(log, plan);

  // Bail before the export moves any ref if the lock was lost.
  throwIfAborted(signal, "before the export");

  // A failed page keeps git's files on `main` (no export of it this cycle), and
  // its paths keep their last-export version in the recorded base.
  const pinnedPaths = new Set(
    failures.flatMap((f) => (f.oldPath !== undefined ? [f.path, f.oldPath] : [f.path])),
  );
  const pinnedIds = new Set(failures.flatMap((f) => (f.pageId ? [f.pageId] : [])));
  // A page whose export key is unchanged since the last export (and whose file
  // `main` holds at its path) takes the last export's blob, unfetched.
  const toFetch = new Set(plan.toWrite.map((w) => w.pageId));
  const baseBlobs = new Map(
    (await vault.lsTree(base0))
      .filter((e) => e.mode === "100644")
      .map((e) => [e.path, e.sha] as const),
  );
  const filesById = new Map<string, string[]>();
  for (const e of existing) {
    filesById.set(e.pageId, [...(filesById.get(e.pageId) ?? []), e.relPath]);
  }
  const pages = plan.live
    .filter((p) => !pinnedIds.has(p.pageId))
    .map((p) => {
      const blob = toFetch.has(p.pageId) ? undefined : baseBlobs.get(p.relPath);
      return blob === undefined ? p : { ...p, blob };
    });
  const exported = await buildExportTree(
    { client, git: vault, log, signal },
    {
      start: main0,
      pages,
      // Each page's files elsewhere on `main` go once its file is placed.
      removeIfWritten: pages.flatMap((p) =>
        (filesById.get(p.pageId) ?? [])
          .filter((path) => path !== p.relPath)
          .map((path) => ({ pageId: p.pageId, path })),
      ),
      // A created file is placed again, with its id, at the page's layout path.
      // When that page is not exported this cycle (failed fetch, pinned layout
      // path), its file is absent from `main` until the next export places it;
      // its text is already in Docmost. Keeping the file would leave an id-less
      // copy beside the page or, kept out of the record, have the next cycle
      // create the page again.
      remove: [...created.map((c) => c.path), ...plan.toDelete],
      pinned: pinnedPaths,
    },
  );
  // Pages the export could not place never reach git while the cycle itself
  // succeeds: WARN the count and the first one (the export's log names each).
  if (exported.failed > 0) {
    const first = exported.firstFailure;
    warn(
      `space ${spaceId}: the export could not place ${exported.failed} ` +
        `page(s) in the vault (retried next cycle)` +
        (first ? `; first: page ${first.pageId}: ${first.error}` : ""),
    );
  }

  const recordTree =
    pinnedPaths.size === 0
      ? exported.tree
      : await vault.treeWithPathsFrom(exported.tree, base0, [...pinnedPaths]);
  const bot = { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL };
  const newBase =
    recordTree === exported.tree
      ? null
      : recordTree === baseTree
        ? base0
        : await vault.commitTree(
            recordTree,
            [base0],
            `docmost: record (${failures.length} failed, kept back)`,
            bot,
          );
  // Removed paths of pages Docmost no longer has (a created file's old path is
  // not one: its page is placed again).
  const deleted = plan.toDelete.filter((p) => !pinnedPaths.has(p)).length;
  // The subject names what happened in the wiki: pages whose file this commit
  // adds, changes or moves (created, edited, renamed, moved), and pages deleted;
  // a deletion-only commit says only that. Edits are counted on the commit's own
  // diff, not `exported.written`: that counts every page fetched, which is the
  // whole space after a restart or a failed cycle.
  const edited =
    exported.tree === mainTree
      ? 0
      : (await vault.diffNameStatus(main0, exported.tree)).filter((e) => e.status !== "D")
          .length;
  const actions: string[] = [];
  if (edited > 0 || deleted === 0) actions.push(`edit ${edited} page(s)`);
  if (deleted > 0) actions.push(`delete ${deleted} page(s)`);
  const subject = `docmost: ${actions.join(", ")}`;
  // The last check before `main` moves: the export may have run long.
  throwIfAborted(signal, `before moving '${DEFAULT_BRANCH}'`);
  const newMain =
    exported.tree === mainTree
      ? main0
      : await vault.commitTree(exported.tree, [main0], subject, {
          ...bot,
          trailers: [
            `${SOURCE_TRAILER}: docmost`,
            `${PREV_EXPORT_TRAILER}: ${base0}`,
            `${LAST_EXPORT_TRAILER}: ${newBase ?? "self"}`,
          ],
        });
  // `main` first, then the pointer: a crash in between leaves the pointer at the
  // export's start, which `repairPointer` moves on. Under the space lock nothing
  // else moves `main`, so a failed compare-and-swap throws.
  if (newMain !== main0) {
    await vault.updateRef(`refs/heads/${DEFAULT_BRANCH}`, newMain, main0);
  }
  const pointer = newBase ?? newMain;
  if (pointer !== base0) await vault.updateRef(LAST_EXPORT_REF, pointer, base0);

  // Record the export keys only NOW that the export landed. Rebuilt from the
  // live tree, so a page that left the tree loses its key; a page whose export
  // or apply failed gets none (it is exported again next cycle).
  if (exportKeys) {
    const skip = new Set([...exported.failedPageIds, ...pinnedIds]);
    exportKeys.clear();
    for (const [pageId, key] of plan.liveExportKeys) {
      if (!skip.has(pageId)) exportKeys.set(pageId, key);
    }
  }

  // Remember the tree this export read only when the vault now holds exactly
  // it: nothing failed, nothing was kept back, and the pointer is at `main`.
  if (idle) {
    const clean =
      tree.complete &&
      failures.length === 0 &&
      exported.failed === 0 &&
      pinnedPaths.size === 0 &&
      pointer === newMain;
    idle.fingerprint = clean ? treeFingerprint(tree, settings) : null;
  }

  return {
    ran: true,
    pull: {
      written: exported.written,
      deleted,
      failures: exported.failed,
      ...(exported.firstFailure ? { firstFailure: exported.firstFailure } : {}),
    },
    push: {
      mode: "apply",
      failures: failures.length,
      ...(failures.length ? { firstFailure: failures[0] } : {}),
    },
  };
}
