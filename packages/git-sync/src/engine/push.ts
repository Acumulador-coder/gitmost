/**
 * Push cycle — vault -> Docmost (SPEC §6 "FS -> Docmost").
 *
 * This module mirrors the structure of `./pull.ts`: a set of VaultGit diff/ref
 * primitives (in `./git.ts`), a PURE planner (`computePushActions`) that turns
 * a git diff into a classified action set with NO IO, and a THIN injectable
 * applier (`applyPushActions`) exercised in tests via fakes only.
 *
 * Direction is vault -> Docmost. The diff is `main` against the last export
 * (SPEC §6 step 2); each `A`/`M`/`D`/`R` row is translated into a Docmost
 * mutation by `pageId` identity (SPEC §4):
 *   - A without pageId   -> create_page (the next export writes its id).
 *   - A with    pageId   -> update (restored/copied file; the page already exists).
 *   - M                  -> update content (collab/Yjs path, SPEC §2/§15.6).
 *   - D                  -> delete_page (pageId recovered from the PRE-IMAGE meta).
 *   - R                  -> rename/move.
 *
 * MOVE/RENAME APPLY: `classifyRenameMoves` (PURE) resolves
 * each `renamesMoves` entry into the Docmost op(s) it needs, comparing the PATH-
 * derived parent (SPEC §5: the file path is the source of truth for tree
 * position, NOT stale `meta.parentPageId`) and the meta title; `applyPushActions`
 * then calls `move_page` / `rename_page` (both for a reparent+retitle), or
 * records a NO-OP for a cosmetic local-only file-path rename.
 *
 * The client seam is the native `GitSyncClient` (`Pick<GitSyncClient, ...>`);
 * the gitmost server drives the engine in-process (there is no standalone CLI
 * entry point).
 */
import {
  type DocmostMdMeta,
  parsePageFile,
} from "@docmost/prosemirror-markdown";
import type { GitSyncClient } from "./client.types.js";
import type { DiffEntry } from "./git.js";
import { VaultGit, DEFAULT_BRANCH, GitStoppedError } from "./git.js";
import { CycleAbortedError, throwIfAborted } from "./abort.js";
import { markdownToProseMirror } from "./convert-pool.js";
import { stabilizePageBody } from "./stabilize.js";
import { type Settings } from "./settings.js";

// Re-export so callers/tests can import the diff row shape from either module.
export type { DiffEntry } from "./git.js";

/** A page to CREATE in Docmost (new local file, meta has no pageId yet). */
export interface CreateAction {
  /** Vault-relative path of the new file. */
  path: string;
}

/** A page whose CONTENT changed (meta carries the existing pageId). */
export interface UpdateAction {
  pageId: string;
  /** Vault-relative path of the changed file. */
  path: string;
  /**
   * Path in the push's diff-base commit (`ApplyPushDeps.baseRef`) to resolve the
   * 3-way merge BASE from; defaults to `path`. Set to the OLD path for
   * RENAME-derived updates: a renamed
   * file lives at its NEW `path` on `main`, but in the base tree
   * the file was at its OLD path — so the merge base must be looked up there, or
   * it resolves to `null` and the merge degrades to a 2-way (clobbering concurrent
   * Docmost-side edits). For a plain `M` update this is undefined -> uses `path`,
   * an honest 3-way merge at the same path.
   */
  basePath?: string;
}

/** A page to soft-delete in Docmost (Trash, SPEC §8). */
export interface DeleteAction {
  pageId: string;
  /** Vault-relative path of the deleted file. */
  path: string;
}

/** A renamed/moved page (same pageId, new path). Resolution DEFERRED. */
export interface RenameMoveAction {
  pageId: string;
  oldPath: string;
  newPath: string;
}

/**
 * A CLASSIFIED rename/move: a `RenameMoveAction` resolved into the
 * Docmost op(s) it actually needs. The file PATH is the source of truth for tree
 * position (SPEC §5: "the identity is the pageId, not the path" — the path is COSMETIC and
 * LOCAL, the page identity is its pageId), so we compare the RESOLVED parent of
 * the new path against the resolved parent of the old path, and the title in the
 * current meta against the title in the previous meta. Each sub-op is emitted
 * ONLY when something real changed:
 *   - `move`  — the resolved parent page changed (reparent in Docmost). A `null`
 *     `parentPageId` means the new parent is ROOT (the file sits at the space
 *     root, no enclosing folder).
 *   - `rename` — the page title changed (a pure title edit in Docmost).
 *   - `noop`  — neither changed: a purely LOCAL file-path rename (same parent,
 *     same title). The page identity is its pageId, so Docmost is NOT called.
 * `move` and `rename` are independent and may BOTH be present (reparent + retitle).
 */
export interface RenameMoveActionClassified {
  pageId: string;
  oldPath: string;
  newPath: string;
  /** Present iff the resolved parent changed -> `move_page` (reparent). */
  move?: { parentPageId: string | null };
  /** Present iff the title changed -> `rename_page` (title-only). */
  rename?: { title: string };
  /** True iff neither parent nor title changed (cosmetic local-only rename). */
  noop?: true;
}

/**
 * Injected resolvers for the PURE `classifyRenameMoves`. Both are PURE given a
 * path + side; production wires them to the file tree (`readFile` for `current`,
 * `git.showFileAtRef` for `prev`), tests pass plain lookups. SPEC §5 path-as-truth:
 *   - `metaAt`: the file's synthetic native meta at that side (title from the
 *     filename, pageId from the `gitmost_id` frontmatter).
 *   - `resolveParentPageId`: the pageId of the page whose FILE is the parent
 *     FOLDER's `.md` (one level up from the given path), or `null` for ROOT.
 */
export interface ClassifyRenameMovesDeps {
  metaAt: (path: string, side: MetaSide) => DocmostMdMeta | null;
  resolveParentPageId: (path: string, side: MetaSide) => string | null;
}

/**
 * PURE classifier for the `renamesMoves` produced by `computePushActions`
 * (SPEC §5/§6/§8). Resolves each `{pageId, oldPath, newPath}` into the
 * Docmost op(s) it needs, with NO IO (both resolvers are injected).
 *
 * SPEC §5 — the file PATH is the source of truth for tree position, NOT the
 * (possibly stale) `meta.parentPageId`. So the NEW parent is resolved from
 * `newPath`'s enclosing folder, and the OLD parent from `oldPath`'s enclosing
 * folder, via `deps.resolveParentPageId`. The title comes from the meta.
 *
 * For each entry:
 *   - `newParent = resolveParentPageId(newPath, 'current')`,
 *     `oldParent = resolveParentPageId(oldPath, 'prev')`.
 *   - `newTitle = metaAt(newPath,'current')?.title`,
 *     `oldTitle = metaAt(oldPath,'prev')?.title`.
 *   - include `move` iff `newParent !== oldParent` (a real reparent),
 *   - include `rename` iff `newTitle` is a NON-EMPTY string AND differs from
 *     `oldTitle` (a real title edit; an empty/absent new title is never a rename),
 *   - if NEITHER applies -> `noop: true` (a cosmetic local-only file-path rename;
 *     the page is its pageId, so Docmost is not touched).
 */
export function classifyRenameMoves(
  renamesMoves: RenameMoveAction[],
  deps: ClassifyRenameMovesDeps,
): RenameMoveActionClassified[] {
  return renamesMoves.map((rm) => {
    const newParent = deps.resolveParentPageId(rm.newPath, "current");
    const oldParent = deps.resolveParentPageId(rm.oldPath, "prev");
    // Strip the cosmetic ` ~<slugId>` disambiguation suffix before comparing
    // titles: it is a LOCAL filesystem artifact (`buildVaultLayout` appends it to
    // a colliding sibling's stem), NOT part of the page's real title. A pure
    // disambiguation file-rename ('Report.md' -> 'Report ~a1.md') must therefore
    // NOT be pushed to Docmost as a title change (red-team #4b), and any title we
    // DO push must carry the real title ('Report'), never the suffixed form.
    const rawNewTitle = deps.metaAt(rm.newPath, "current")?.title;
    const rawOldTitle = deps.metaAt(rm.oldPath, "prev")?.title;
    // A PURE disambiguation rename only APPENDS a cosmetic ` ~<suffix>` to the
    // SAME title (layout.ts), so the real Docmost title is unchanged. Strip the
    // suffix ONLY when the new name is exactly the old title plus that suffix —
    // never blindly strip a genuine retitle whose new title legitimately ends in
    // ` ~token` (e.g. "Budget ~draft" -> "Budget ~final"), which would corrupt
    // the title in Docmost / drop a real rename (review finding).
    const isCosmeticDisambiguation =
      typeof rawNewTitle === "string" &&
      typeof rawOldTitle === "string" &&
      rawNewTitle !== rawOldTitle &&
      stripDisambiguationSuffix(rawNewTitle) === rawOldTitle;
    const newTitle = isCosmeticDisambiguation ? rawOldTitle : rawNewTitle;
    const oldTitle = rawOldTitle;

    const out: RenameMoveActionClassified = {
      pageId: rm.pageId,
      oldPath: rm.oldPath,
      newPath: rm.newPath,
    };
    // A reparent: the new path's resolved parent page differs from the old's.
    if (newParent !== oldParent) {
      out.move = { parentPageId: newParent };
    }
    // A title edit: only when there is a real, non-empty new title that changed.
    if (
      typeof newTitle === "string" &&
      newTitle.length > 0 &&
      newTitle !== oldTitle
    ) {
      out.rename = { title: newTitle };
    }
    // Neither changed -> a purely LOCAL file-path rename; do NOT call Docmost.
    if (!out.move && !out.rename) {
      out.noop = true;
    }
    return out;
  });
}

/** The classified set of push actions (PURE output of `computePushActions`). */
export interface PushActions {
  creates: CreateAction[];
  updates: UpdateAction[];
  deletes: DeleteAction[];
  renamesMoves: RenameMoveAction[];
  /**
   * Diff rows that could NOT be classified into an action, with a reason — e.g.
   * a deleted file whose PRE-IMAGE meta carried no recoverable pageId (the
   * untracked-file guard, SPEC §8: only files that were tracked with a pageId
   * are deleted in Docmost). Carried so the caller can log them.
   */
  skipped: { path: string; status: DiffEntry["status"]; reason: string }[];
}

/**
 * Which tree a `metaAt` lookup reads the file's native meta from:
 *   - `current`: the current `main` tree (the live file content) — used for
 *     A/M/R, where the file still exists.
 *   - `prev`: the PRE-IMAGE at the push's diff base (`git show <base>:<path>`)
 *     — used for D, where the file is gone from `main` but its pageId must be
 *     recovered from the version Docmost last knew (SPEC §6/§8).
 */
export type MetaSide = "current" | "prev";

/** Input to the PURE planner. `metaAt` is injected (no IO inside the planner). */
export interface PushActionsInput {
  /** Diff rows of `main` vs the last export (SPEC §6 step 2). */
  changes: DiffEntry[];
  /**
   * Resolve a file's synthetic native meta at a given side, or `null` if the file is
   * absent there / has no parseable meta. PURE injection: `runPush` reads
   * `main` (current) or the last export (prev); tests pass a plain lookup.
   */
  metaAt: (path: string, side: MetaSide) => DocmostMdMeta | null;
  /**
   * The pageIds present at ANY path in the current `main` tree (optional). When
   * given, a deleted file whose pageId still lives somewhere in the tree is NOT
   * a deletion but a MOVE — guards against trashing a live page when a layout
   * reshuffle relocated its file (possibly across two cycles, so the matching
   * add isn't in THIS diff). When omitted, only the in-diff D+A/M coalescing
   * applies.
   */
  currentPageIds?: Set<string>;
  /**
   * Files that duplicate another file's gitmost_id (copies, see `runPush`): each
   * is CREATED as a new page whatever its diff status or frontmatter id.
   */
  copyPaths?: Set<string>;
}

/**
 * Emit the action PAIR a move/rename needs: a `renamesMoves` entry (the
 * relocation, applied later as a move/rename — those ops are content-free) AND a
 * body `updates` entry for the NEW path, so a body edit riding along in the SAME
 * diff is not lost. `importPageMarkdown` targets by pageId and is a near-no-op for
 * a pure relocation. The merge BASE is taken from the OLD path (`basePath`): the
 * file lives at its NEW `path` on `main`, but at the base it was at
 * `oldPath`, so the 3-way base must be looked up THERE — otherwise it resolves to
 * null and the merge degrades to a 2-way, clobbering a concurrent Docmost-side
 * edit. A PURE relocation is then a no-op that PRESERVES the live page. Shared by
 * all three emit sites (ghost-move A, ghost-move M, and R/C).
 */
function emitMoveWithBody(
  actions: PushActions,
  pageId: string,
  oldPath: string,
  newPath: string,
): void {
  actions.renamesMoves.push({ pageId, oldPath, newPath });
  actions.updates.push({ pageId, path: newPath, basePath: oldPath });
}

/**
 * PURE push planner (SPEC §4/§6/§8). Classifies each diff row into a Docmost
 * action by `pageId` identity, with NO IO (the `metaAt` resolver is injected).
 *
 * Classification rules:
 *   - `A` (added):
 *       - current meta HAS a pageId  -> UPDATE (a restored/copied file whose
 *         page already exists; we push its content rather than create a dup).
 *       - current meta has NO pageId but HAS a non-empty spaceId -> CREATE (a
 *         brand-new local file; the page does not exist in Docmost yet).
 *       - current meta has NO pageId and NO usable spaceId -> SKIP with reason
 *         `create-without-spaceId`: Docmost `create_page` REQUIRES a spaceId
 *         (§16), and a new local file may carry only partial human meta. We
 *         refuse to create rather than guess a space (SPEC §8 guard spirit).
 *   - `M` (modified): current meta has a pageId -> UPDATE content. (If a modified
 *       file somehow lost its pageId it is skipped — there is nothing to target.)
 *   - `D` (deleted): recover the pageId from the PRE-IMAGE meta (`metaAt(path,
 *       'prev')`) -> DELETE. If no pageId can be recovered, SKIP with a reason
 *       (untracked-file guard, SPEC §8: never delete an untracked page).
 *   - `R` (renamed/moved): same pageId (from current meta), path changed ->
 *       RENAME/MOVE. Resolution of move-vs-rename + the new parentPageId happens
 *       in `classifyRenameMoves`; here we only record oldPath/newPath/
 *       pageId. If the renamed file has no recoverable pageId it is SKIPPED.
 *       (`C` copy is treated the same as `R` for recording purposes.)
 */
export function computePushActions(input: PushActionsInput): PushActions {
  const { metaAt, currentPageIds } = input;
  const copyPaths = input.copyPaths ?? new Set<string>();
  // PAGE-FILE FILTER: only `.md` files OUTSIDE any dot-folder
  // are Docmost pages. `.obsidian/*`, attachments, and other non-page files are
  // committed to the vault (no `.gitignore`) and so appear in the diff, but they
  // are NEVER pages — Obsidian owns them. Without this filter every ADDED such
  // file would be mis-classified as a CREATE (nativeMeta always supplies a
  // spaceId, so the `create-without-spaceId` skip does not screen them),
  // creating junk pages in Docmost and corrupting the file with a `gitmost_id`
  // frontmatter. Filter BEFORE any classification so non-page A/M/D/R are ignored.
  const changes = input.changes.filter((c) => isPageFile(c.path));
  const actions: PushActions = {
    creates: [],
    updates: [],
    deletes: [],
    renamesMoves: [],
    skipped: [],
  };

  // GHOST-MOVE coalescing (data-loss guard). git's rename detection (`-M`)
  // can miss a move when the two files are too dissimilar — which is exactly the
  // case for the tiny meta-only files a layout RESHUFFLE produces (e.g.
  // several untitled pages sharing the `_` fallback name; retitling one frees the
  // bare `_` and another page's file relocates `_ ~slug.md` -> `_.md`). git then
  // reports the move as a DELETE of the old path + an ADD of the new one. Taken
  // literally that soft-deletes a page that merely MOVED — a live page vanishing
  // into Trash. Identity is the pageId, not git's heuristic: a pageId that is
  // BOTH deleted (pre-image) and added (current) is one page that relocated, so
  // we classify it as a rename/move and NEVER as a delete.
  // A pageId can land at its new path two ways: as an ADD (the path was free) or
  // as a MODIFY (the path was occupied by ANOTHER page that left — the reshuffle
  // case, where `_.md`'s occupant changes pageId). Both are "the page survives at
  // a new path", so the surviving side is the CURRENT-meta pageId of A *and* M.
  const deletedPath = new Map<string, string>();
  const survivingPath = new Map<string, string>();
  for (const change of changes) {
    if (change.status === "D") {
      const pid = metaAt(change.path, "prev")?.pageId;
      if (pid) deletedPath.set(pid, change.path);
    } else if (
      (change.status === "A" || change.status === "M") &&
      !copyPaths.has(change.path)
    ) {
      const pid = metaAt(change.path, "current")?.pageId;
      if (pid) survivingPath.set(pid, change.path);
    }
  }
  const ghostMove = new Map<string, { oldPath: string; newPath: string }>();
  for (const [pid, oldPath] of deletedPath) {
    const newPath = survivingPath.get(pid);
    if (newPath && newPath !== oldPath) {
      ghostMove.set(pid, { oldPath, newPath });
    }
  }

  for (const change of changes) {
    if (change.status !== "D" && copyPaths.has(change.path)) {
      // A copy of another page's file: a new page of its own.
      actions.creates.push({ path: change.path });
      continue;
    }
    switch (change.status) {
      case "A": {
        const meta = metaAt(change.path, "current");
        const pageId = meta?.pageId;
        if (pageId && ghostMove.has(pageId)) {
          // Half of a git-undetected move (a matching DELETE exists): record it
          // as a rename/move (like a real `R`) PLUS a body update for the new path
          // (F4); the `D` side is suppressed so the page is never soft-deleted.
          emitMoveWithBody(
            actions,
            pageId,
            ghostMove.get(pageId)!.oldPath,
            change.path,
          );
        } else if (pageId) {
          // Added but already carries a pageId (restored/copied file): the page
          // exists in Docmost, so push content as an UPDATE — never a duplicate.
          actions.updates.push({ pageId, path: change.path });
        } else if (meta?.spaceId) {
          // Brand-new local file with a target space -> create the page; the
          // export then writes the file again with the assigned id.
          // `meta.spaceId` is truthy here, so empty-string is also rejected.
          actions.creates.push({ path: change.path });
        } else {
          // A create needs a spaceId (Docmost `create_page` requires it, §16). A
          // new file with partial meta and no usable spaceId is SKIPPED rather
          // than created into a guessed space (SPEC §8 guard spirit).
          actions.skipped.push({
            path: change.path,
            status: "A",
            reason: "create-without-spaceId",
          });
        }
        break;
      }
      case "M": {
        const meta = metaAt(change.path, "current");
        const pageId = meta?.pageId;
        if (pageId && ghostMove.has(pageId)) {
          // This path's occupant changed pageId: the previous page left and THIS
          // page relocated here (a reshuffle). Its old file was DELETED elsewhere
          // — coalesce into a rename/move (plus a body update for the new path, F4)
          // so the page is never trashed.
          emitMoveWithBody(
            actions,
            pageId,
            ghostMove.get(pageId)!.oldPath,
            change.path,
          );
        } else if (pageId) {
          actions.updates.push({ pageId, path: change.path });
        } else {
          // The current file has no `gitmost_id` — but it was MODIFIED, so a prior
          // version existed at this path. Recover the identity from the PRE-IMAGE
          // (the base version at the same path, which still carried the id),
          // mirroring the `D` branch. Without this, an edit that also dropped the
          // frontmatter (e.g. a tool that rewrote the whole file) is silently
          // skipped and then reverted by the next export — the edit is lost. The
          // export writes the file back with its frontmatter, so the
          // file self-heals. If the pre-image ALSO lacked an id
          // (a page never tracked), there is genuinely nothing to update -> skip.
          const prevPageId = metaAt(change.path, "prev")?.pageId;
          if (prevPageId && !ghostMove.has(prevPageId)) {
            actions.updates.push({ pageId: prevPageId, path: change.path });
          } else {
            actions.skipped.push({
              path: change.path,
              status: "M",
              reason: "modified file has no pageId in meta (nor in pre-image)",
            });
          }
        }
        break;
      }
      case "D": {
        // The file is gone from `main`; recover its pageId from the PRE-IMAGE
        // (the version at the last export) so we delete the RIGHT page.
        const prevMeta = metaAt(change.path, "prev");
        const pageId = prevMeta?.pageId;
        if (pageId && ghostMove.has(pageId)) {
          // The same pageId was re-ADDED at a new path: this is a git-undetected
          // MOVE, handled by the `A` branch above. Suppress the delete so a moved
          // page is never trashed (⭐ data-loss guard).
          actions.skipped.push({
            path: change.path,
            status: "D",
            reason: "ghost-move (re-added at a new path) — not a deletion",
          });
        } else if (pageId && currentPageIds?.has(pageId)) {
          // The pageId still EXISTS elsewhere in the current tree: the file moved
          // (a layout reshuffle whose matching add was in an earlier cycle, so it
          // is not in this diff). A live page must never be trashed because its
          // FILENAME changed — identity is the pageId (⭐ data-loss guard).
          actions.skipped.push({
            path: change.path,
            status: "D",
            reason: "pageId still present in the tree (moved) — not a deletion",
          });
        } else if (pageId) {
          actions.deletes.push({ pageId, path: change.path });
        } else {
          // Untracked-file guard (SPEC §8): a file with no recoverable pageId was
          // never a Docmost page — do NOT translate its removal into a delete.
          actions.skipped.push({
            path: change.path,
            status: "D",
            reason: "deleted file has no recoverable pageId (pre-image meta)",
          });
        }
        break;
      }
      case "R":
      case "C": {
        // Same page, new path. Identity comes from the CURRENT (post-rename) meta
        // since the file still exists. RESOLUTION (move vs rename, parentPageId)
        // is deferred — record oldPath/newPath/pageId only.
        const meta = metaAt(change.path, "current");
        const pageId = meta?.pageId;
        const oldPath = change.oldPath ?? change.path;
        if (pageId) {
          // Record the rename/move PLUS a body update for the new path (F4): git
          // `-M` reports a rename+edit as a SINGLE `R` row, so a body edit made in
          // the same commit as the move would otherwise be lost. For a `C` copy
          // `oldPath` is the SOURCE (it exists in the ref tree), so the copy's body
          // 3-way-merges against its source's base text.
          emitMoveWithBody(actions, pageId, oldPath, change.path);
        } else {
          actions.skipped.push({
            path: change.path,
            status: change.status,
            reason: "renamed/moved file has no pageId in meta",
          });
        }
        break;
      }
      default: {
        // Unreachable for A/M/D/R/C; defensive for any future status.
        actions.skipped.push({
          path: change.path,
          status: change.status,
          reason: `unhandled diff status ${change.status}`,
        });
      }
    }
  }

  return actions;
}

// --- thin apply (create/update/delete/move/rename) ---------------------------

/**
 * Injectable IO for `applyPushActions`. In production these are wired to the live
 * client (the native GitmostDataSource) and the vault git wrapper —
 * `applyPushActions` runs LIVE via runPush -> runCycle -> the orchestrator's
 * driveCycle. Tests substitute FAKES through the same seam.
 *   - `client`: the create/update/delete/move/rename subset of `GitSyncClient`,
 *     plus `getPageJson` for the retry-adopt check.
 *   - `readFile`: read a changed file at the `main` commit the diff ends at (by
 *     vault-relative path; rejects when the file is not there).
 */
export interface ApplyPushDeps {
  client: Pick<
    GitSyncClient,
    | "listSpaceTree"
    | "getPageJson"
    | "importPageMarkdown"
    | "createPage"
    | "deletePage"
    | "movePage"
    | "renamePage"
  >;
  /** Read a changed file's full text by its vault-relative path. */
  readFile: (path: string) => Promise<string>;
  /**
   * The Docmost spaceId this vault mirrors. A CREATE targets this space (the
   * native file carries no spaceId — every file in the vault belongs to it), and
   * it backs the synthetic native meta the classifier reads.
   */
  spaceId: string;
  /**
   * `showFileAtRef` reads a file's text at `baseRef` (the 3-way merge base of an
   * update, and the PREVIOUS parent folder's `.md` / meta for the move/rename
   * classifier, SPEC §5 path-as-truth). `commitAddingPath` finds where git
   * created or moved a file whose folder note is gone (its parent, see
   * `formerFolderPageId`). `pageIdsAtRef` lists the pages the base holds (the
   * retry-adopt check).
   */
  git: Pick<VaultGit, "showFileAtRef" | "commitAddingPath" | "pageIdsAtRef">;
  /**
   * The commit the push diff was computed from (the last export — what Docmost
   * held when it was exported). Every pre-image read comes from it, so the
   * planner and the applier agree on "before".
   */
  baseRef: string;
  /** Warning channel (a create that could not be compared for adoption). */
  warn?: (line: string) => void;
  /**
   * The cycle's AbortSignal (lost lock, deadline). Checked before every page
   * operation and handed to every conversion: aborted, the apply stops with a
   * `CycleAbortedError`.
   */
  signal?: AbortSignal;
}

/** A file a create gave a page (a fresh page or an adopted one). */
export interface CreatedPage {
  path: string;
  pageId: string;
}

/**
 * One page whose operation FAILED during apply (SPEC §12 resumability). The bad
 * page is isolated — recorded here — and the rest of the batch still runs. The
 * cycle keeps its paths at their last-export version in the recorded base, so
 * the next cycle retries this page alone.
 */
export interface PushFailure {
  kind: "update" | "create" | "delete" | "move" | "rename";
  /** The pageId for update/delete/move/rename; absent for a never-id'd create. */
  pageId?: string;
  /** The page file's vault-relative path (the new path of a move/rename). */
  path: string;
  /** The page's path before a move/rename (or a rename-derived update). */
  oldPath?: string;
  /** The error message captured from the thrown error. */
  error: string;
}

/**
 * A rename/move action that resolved to a NO-OP (push #3, SPEC §5): a purely
 * LOCAL file-path rename whose resolved parent AND title are both unchanged. The
 * page identity is its pageId and the path is COSMETIC/local-only, so Docmost is
 * NOT called — the skip is recorded here (with the reason) for logging.
 */
export interface PushNoop {
  pageId: string;
  oldPath: string;
  newPath: string;
  /** Why no Docmost op was emitted (currently always a path-only rename). */
  reason: "path-only-rename";
}

/** Structured outcome of `applyPushActions` (counts + created pages + noops). */
export interface ApplyPushResult {
  created: number;
  updated: number;
  deleted: number;
  /** Pages reparented in Docmost via `move_page` (push #3, SPEC §5/§16). */
  moved: number;
  /** Pages retitled in Docmost via `rename_page` (push #3, SPEC §5/§6). */
  renamed: number;
  /** The file -> page of every create; the export writes each one's id. */
  createdPages: CreatedPage[];
  /** Pages whose operation threw — isolated and recorded, the batch continued. */
  failures: PushFailure[];
  /**
   * Rename/move actions that resolved to a NO-OP — a purely LOCAL file-path
   * rename (same parent, same title). NO Docmost call was made for these (SPEC
   * §5: the page is its pageId, the path is local-only). Recorded for logging.
   */
  noops: PushNoop[];
  /** Diff rows the planner could not classify (carried through for logging). */
  skipped: PushActions["skipped"];
}

/**
 * THIN IO applier. Runs LIVE in production (via runPush -> runCycle ->
 * orchestrator); tests drive it with FAKES.
 *
 *   - UPDATE: `client.importPageMarkdown(pageId, body, baseBody)` — the
 *     collab/Yjs block 3-way merge (SPEC §2/§15.6), never a raw overwrite; the
 *     base is the file at `baseRef` (the old path for a rename-derived update).
 *   - CREATE: title from the filename, parent from the enclosing folder's
 *     folder-note, space from the run; `client.createPage(...)`. The assigned
 *     id is reported in `createdPages` (the export writes it into the file).
 *   - DELETE: `client.deletePage(pageId)` — soft-delete to Trash (SPEC §8).
 *   - RENAME/MOVE (SPEC §5/§6/§16): classify each `renamesMoves` entry
 *     with `classifyRenameMoves`, then `move` -> `client.movePage`, `rename` ->
 *     `client.renamePage` (both: move first), `noop` -> no call, recorded.
 *
 * FAIL-SAFE / per-page isolation (SPEC §12 resumability). Each page's operation
 * is wrapped in its own try/catch: a single failing page is recorded in
 * `failures[]` (with its kind + pageId/path(s) + error) and the batch CONTINUES.
 *
 * CANCELLATION. `deps.signal` is checked before every page operation; an abort
 * throws a `CycleAbortedError` out of the batch (it is not a per-page failure).
 * No ref has moved yet, so the next cycle applies the same changes again.
 */
export async function applyPushActions(
  deps: ApplyPushDeps,
  actions: PushActions,
): Promise<ApplyPushResult> {
  const { client } = deps;

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let moved = 0;
  let renamed = 0;
  const createdPages: CreatedPage[] = [];
  const failures: PushFailure[] = [];
  const noops: PushNoop[] = [];

  // 1. UPDATES — collab/Yjs write path (SPEC §2/§15.6), never a raw overwrite.
  //    Each update is isolated: a thrown page is recorded and the batch goes on.
  for (const u of actions.updates) {
    throwIfAborted(deps.signal, `before pushing the update of ${u.path}`);
    try {
      // Push the CLEAN body only (no `gitmost_id` frontmatter): the frontmatter
      // is engine metadata, never page content.
      const body = parsePageFile(await deps.readFile(u.path)).body;
      // The version Docmost held at the last export is the common ancestor of
      // the block 3-way merge against the live page, so concurrent human edits
      // are not clobbered (review #5). Null when the file is new there. Resolved
      // from `basePath` (the OLD path of a rename-derived update) when set.
      const baseFull = await deps.git.showFileAtRef(
        deps.baseRef,
        u.basePath ?? u.path,
      );
      await client.importPageMarkdown(
        u.pageId,
        body,
        baseFull === null ? null : parsePageFile(baseFull).body,
      );
      updated++;
    } catch (err: unknown) {
      failures.push({
        kind: "update",
        pageId: u.pageId,
        path: u.path,
        ...(u.basePath !== undefined ? { oldPath: u.basePath } : {}),
        error: errMessage(err),
      });
    }
  }

  // 2. CREATES — create the page; the export writes its id into the file.
  //    Isolated per page like updates.
  //
  // RETRY-ADOPT (idempotency): a create is not atomic with the export that
  // records its id. If a cycle dies in between, the next cycle sees the file as
  // a create again. A live page with the file's (parentPageId|root, title) that
  // git-sync itself created since the last export, still empty or holding the
  // file's body, is that create: it is ADOPTED instead of duplicated. Any other
  // match — a page a user made meanwhile — keeps its text, and git's file
  // becomes a new page.
  let liveByParentTitle: Map<string, string> | null = null;
  // A (parentPageId, title) that more than ONE live page shares is AMBIGUOUS:
  // adopting one of them would silently overwrite an arbitrary, possibly-unrelated
  // sibling (red-team #6). Such keys are recorded here and EXCLUDED from adoption.
  const ambiguousAdoptKeys = new Set<string>();
  // The pages a parent found in history may name (`formerFolderPageId`): live,
  // and not deleted by this push (a child placed under one would be trashed
  // with it). Listed once, on first need.
  let liveParentIds: Set<string> | null = null;
  const liveParents = (pages: { id: string }[]): Set<string> => {
    const ids = new Set(pages.map((n) => n.id));
    for (const d of actions.deletes) ids.delete(d.pageId);
    return ids;
  };
  const getLiveParentIds = async (): Promise<Set<string>> => {
    if (liveParentIds === null) {
      liveParentIds = liveParents(
        (await client.listSpaceTree(deps.spaceId)).pages,
      );
    }
    return liveParentIds;
  };
  // The pages the last export held, listed on the first adoption candidate.
  let baseIds: Set<string> | null = null;
  const getBaseIds = async (): Promise<Set<string>> => {
    baseIds ??= new Set(
      (await deps.git.pageIdsAtRef(deps.baseRef)).map((e) => e.id),
    );
    return baseIds;
  };
  if (actions.creates.length > 0) {
    const live = await client.listSpaceTree(deps.spaceId);
    liveParentIds = liveParents(live.pages);
    // Only trust a COMPLETE tree for retry-adopt: a truncated tree could miss an
    // already-created page and let us create a DUPLICATE (the very thing adopt
    // prevents). The native client always returns complete:true (reads the DB);
    // on an incomplete tree we leave the map null -> fall back to plain createPage.
    if (live.complete) {
      liveByParentTitle = new Map();
      for (const n of live.pages) {
        const key = `${n.parentPageId ?? " root"} ${n.title ?? ""}`;
        // First node claims the key; a SECOND match marks it ambiguous so neither
        // is ever adopted-over (the create falls back to a fresh createPage).
        if (liveByParentTitle.has(key)) ambiguousAdoptKeys.add(key);
        else liveByParentTitle.set(key, n.id);
      }
    }
  }
  // Order creates PARENT-before-CHILD (red-team #12): a child whose parent is
  // ALSO a fresh create must run AFTER its parent so the parent's just-assigned
  // pageId is available to parent it (otherwise it is placed at the space ROOT).
  const orderedCreates = orderCreatesParentFirst(actions.creates);
  // Track pageIds assigned (or adopted) to each create's PATH in THIS batch, so a
  // child can resolve its freshly-created parent's id (red-team #12).
  const createdIdByPath = new Map<string, string>();
  const createPaths = new Set(actions.creates.map((x) => x.path));
  for (const c of orderedCreates) {
    throwIfAborted(deps.signal, `before pushing the create of ${c.path}`);
    try {
      const body = parsePageFile(await deps.readFile(c.path)).body;
      // Derive create args from the PATH (native-Obsidian, SPEC §5): title from
      // the filename, parent from the enclosing folder's folder-note, space from
      // the run (the vault's space). `parentPageId: null` -> created at ROOT.
      const title = titleFromPath(c.path);
      // Resolve the parent from the PATH (SPEC §5). Prefer an id assigned to the
      // parent's folder-note EARLIER in this same batch (red-team #12; creates
      // are ordered parent-before-child so the parent already ran).
      const parentFile = parentFolderFile(c.path);
      // The parent is a create of this same batch that did not get a page (it
      // failed): fail the child too instead of creating it at the root. Both
      // paths then stay out of the recorded base and both creates are retried
      // in order next cycle.
      if (
        parentFile !== null &&
        createPaths.has(parentFile) &&
        !createdIdByPath.has(parentFile)
      ) {
        failures.push({
          kind: "create",
          path: c.path,
          error: `parent page ${parentFile} was not created in this push`,
        });
        continue;
      }
      const parentPageId =
        (parentFile !== null ? createdIdByPath.get(parentFile) : undefined) ??
        (await resolveParentPageIdViaTree(deps, c.path, "current")) ??
        (await formerFolderPageId(deps, c.path, getLiveParentIds)) ??
        undefined;
      // Retry-adopt (#1 idempotency), see above. SKIP adoption when the (parent,
      // title) is AMBIGUOUS — adopting an arbitrary duplicate-title sibling
      // would silently overwrite it (red-team #6).
      const adoptKey = `${parentPageId ?? " root"} ${title}`;
      const candidate = ambiguousAdoptKeys.has(adoptKey)
        ? undefined
        : liveByParentTitle?.get(adoptKey);
      if (
        candidate !== undefined &&
        (await isUnfinishedCreate(deps, candidate, c.path, body, getBaseIds))
      ) {
        await client.importPageMarkdown(candidate, body, null);
        createdIdByPath.set(c.path, candidate);
        createdPages.push({ path: c.path, pageId: candidate });
        created++;
        continue;
      }
      const result = await client.createPage(
        title,
        body,
        deps.spaceId,
        parentPageId,
      );
      // `createPage` returns `{ data: { id, ... }, success }`; the assigned
      // pageId is at `result.data.id`.
      const assignedPageId: string | undefined = result?.data?.id;
      if (assignedPageId) {
        createdIdByPath.set(c.path, assignedPageId);
        createdPages.push({ path: c.path, pageId: assignedPageId });
      }
      created++;
    } catch (err: unknown) {
      // An abort (the adopt check's conversions honour the signal) ends the
      // push, it is not this page's failure.
      if (err instanceof CycleAbortedError) throw err;
      failures.push({ kind: "create", path: c.path, error: errMessage(err) });
    }
  }

  // 3. DELETES — soft-delete to Trash (SPEC §8), reversible. Isolated per page.
  for (const d of actions.deletes) {
    throwIfAborted(deps.signal, `before pushing the delete of ${d.path}`);
    try {
      await client.deletePage(d.pageId);
      deleted++;
    } catch (err: unknown) {
      failures.push({
        kind: "delete",
        pageId: d.pageId,
        path: d.path,
        error: errMessage(err),
      });
    }
  }

  // 4. RENAME/MOVE (push #3, SPEC §5/§6/§16). Classify each entry against the
  //    tree-backed resolvers (the NEW parent comes from the new path's enclosing
  //    folder `.md`, the OLD parent from the old path's at the base — PATH is
  //    the truth, not stale `meta.parentPageId`; the title from the meta), then
  //    apply only the real ops. Each page is isolated like the cases above: a
  //    thrown op is recorded in `failures` and the batch continues. ORDER for a
  //    page that needs both: reparent (move) FIRST, then retitle (rename).
  if (actions.renamesMoves.length > 0) {
    // The classifier is PURE over sync resolvers; the tree reads are async, so
    // prefetch every (path, side) lookup it will make into plain tables first.
    const parentTable = new Map<string, string | null>();
    const metaTable = new Map<string, DocmostMdMeta | null>();
    // A tree read (readFile / git.showFileAtRef) throwing must isolate THAT page
    // into `failures`, NOT abort the whole batch (§12 resumability). The helpers
    // already swallow their own errors, but this per-entry try/catch keeps the
    // batch-isolation invariant holding regardless of future changes to them.
    const prefetchFailed = new Set<string>();
    for (const rm of actions.renamesMoves) {
      // newParent + newTitle from the CURRENT tree; oldParent + oldTitle from the
      // base pre-image (`prev`). Keyed by `path|side` so duplicates fold.
      try {
        parentTable.set(
          `${rm.newPath}|current`,
          (await resolveParentPageIdViaTree(deps, rm.newPath, "current")) ??
            (await formerFolderPageId(deps, rm.newPath, getLiveParentIds)),
        );
        parentTable.set(
          `${rm.oldPath}|prev`,
          await resolveParentPageIdViaTree(deps, rm.oldPath, "prev"),
        );
        metaTable.set(
          `${rm.newPath}|current`,
          await metaAtViaTree(deps, rm.newPath, "current", deps.spaceId),
        );
        metaTable.set(
          `${rm.oldPath}|prev`,
          await metaAtViaTree(deps, rm.oldPath, "prev", deps.spaceId),
        );
      } catch (err: unknown) {
        prefetchFailed.add(rm.pageId);
        failures.push({
          kind: "move",
          pageId: rm.pageId,
          path: rm.newPath,
          oldPath: rm.oldPath,
          error: errMessage(err),
        });
      }
    }
    const classified = classifyRenameMoves(
      actions.renamesMoves.filter((rm) => !prefetchFailed.has(rm.pageId)),
      {
        metaAt: (path, side) => metaTable.get(`${path}|${side}`) ?? null,
        resolveParentPageId: (path, side) =>
          parentTable.get(`${path}|${side}`) ?? null,
      },
    );

    for (const c of classified) {
      if (c.noop) {
        // Cosmetic local-only file-path rename — no Docmost op (SPEC §5).
        noops.push({
          pageId: c.pageId,
          oldPath: c.oldPath,
          newPath: c.newPath,
          reason: "path-only-rename",
        });
        continue;
      }
      throwIfAborted(deps.signal, `before pushing the move of ${c.newPath}`);
      // Track which op is in flight so a failure is attributed to the op that
      // ACTUALLY threw: for a page needing both, a move that succeeds then a
      // rename that throws must be recorded as `rename`, not `move`.
      let failingKind: "move" | "rename" = c.move ? "move" : "rename";
      try {
        // Reparent FIRST so the page is in its new tree position, THEN retitle.
        if (c.move) {
          failingKind = "move";
          // TODO(next): compute a fractional-index position between siblings
          // (SPEC §16). `position` is UNDEFINED here; the client supplies a valid
          // default. Pass `parentPageId: null` for a move to the space ROOT.
          await client.movePage(c.pageId, c.move.parentPageId);
          moved++;
        }
        if (c.rename) {
          failingKind = "rename";
          await client.renamePage(c.pageId, c.rename.title);
          renamed++;
        }
      } catch (err: unknown) {
        // Isolate the failed page: the op that ACTUALLY threw is recorded so a
        // re-run can retry. A move that threw before its rename leaves `rename`
        // for the next run; both paths stay out of the advanced base.
        failures.push({
          kind: failingKind,
          pageId: c.pageId,
          path: c.newPath,
          oldPath: c.oldPath,
          error: errMessage(err),
        });
      }
    }
  }

  return {
    created,
    updated,
    deleted,
    moved,
    renamed,
    createdPages,
    failures,
    noops,
    skipped: actions.skipped,
  };
}

/**
 * Canonicalize a file's TRAILING whitespace: drop trailing blank /
 * whitespace-only lines and end with exactly one newline (an empty body becomes
 * "\n"), the trailing form `serializePageFile` writes.
 */
function normalizeTrailingWhitespace(text: string): string {
  // `trimEnd` strips exactly the regex `\s` set (U+FEFF included) in linear
  // time; a `/[\s\uFEFF]+$/` replace retries its whitespace run from every
  // start position, quadratic on a long whitespace run followed by more text.
  const body = text.trimEnd();
  return body.length > 0 ? `${body}\n` : "\n";
}

/**
 * Whether live page `pageId` is git-sync's own create of the file at `path`,
 * cut off before the export recorded its id (with or without its body
 * written): the page is not in the last export, git-sync made its last write,
 * and it is still empty or already holds the file's body in canonical form.
 *
 * Adopting a page writes the file's body into it, so the body check keeps that
 * from changing anything the page holds: a page that only looks like such a
 * create (restored from the trash, or every page of a re-made vault) keeps its
 * own text. A body the converter cannot take is never adopted. The
 * conversions run on the converter pool and honour `deps.signal`.
 */
async function isUnfinishedCreate(
  deps: Pick<ApplyPushDeps, "client" | "warn" | "signal">,
  pageId: string,
  path: string,
  body: string,
  baseIds: () => Promise<Set<string>>,
): Promise<boolean> {
  if ((await baseIds()).has(pageId)) return false;
  const live = await deps.client.getPageJson(pageId);
  if (live.lastUpdatedSource !== "git-sync") return false;
  try {
    const pageBody = await stabilizePageBody(live.content, deps.signal);
    if (pageBody.trim().length === 0) return true;
    const gitBody = await stabilizePageBody(
      await markdownToProseMirror(body, undefined, deps.signal),
      deps.signal,
    );
    return (
      normalizeTrailingWhitespace(gitBody) === normalizeTrailingWhitespace(pageBody)
    );
  } catch (err) {
    // An abort is not "cannot compare": it must not turn into a new page.
    if (err instanceof CycleAbortedError) throw err;
    deps.warn?.(
      `push: could not compare ${path} with page ${pageId}; creating a new ` +
        `page for it: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return false;
  }
}

/** Stringify a thrown value into a stable error message. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * SPEC §5 path-as-truth: the parent FOLDER's `.md` file for a vault-relative
 * (forward-slash) path. `buildVaultLayout` puts a page with children at
 * `<...>/Title.md` and nests its children under `<...>/Title/`, so for
 * `newPath = <dir>/Child.md` the parent page's file is `<dir>.md` (the enclosing
 * folder, one level up). A path with NO enclosing folder (`Child.md`, at the
 * space root) has no parent folder file -> `null` (the parent is ROOT).
 */
export function parentFolderFile(path: string): string | null {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return null; // root-level file: parent is ROOT.
  const dir = path.slice(0, slash); // the enclosing folder
  // The page that OWNS the enclosing folder is its folder-note `<dir>/<base>.md`.
  const folderNote = `${dir}/${baseSegment(dir)}.md`;
  if (path === folderNote) {
    // This path IS its folder's folder-note, so its parent is ONE LEVEL UP: the
    // folder-note of the grandparent folder (or ROOT at the top level).
    const up = dir.lastIndexOf("/");
    if (up < 0) return null; // top-level folder -> parent is ROOT.
    const grandDir = dir.slice(0, up);
    return `${grandDir}/${baseSegment(grandDir)}.md`;
  }
  // A leaf (or a nested folder-note) sitting inside `dir`: its parent is `dir`'s
  // folder-note.
  return folderNote;
}

/**
 * Order CREATE actions so a create whose parent folder-note is ALSO being created
 * appears AFTER its parent (red-team #12). A child created before its fresh parent
 * cannot resolve the parent's pageId and would be placed at the space ROOT.
 * Topological over the `parentFolderFile` relation, restricted to paths within the
 * create set; an `inProgress` guard makes a malformed parent cycle safe.
 */
export function orderCreatesParentFirst(creates: CreateAction[]): CreateAction[] {
  const byPath = new Map<string, CreateAction>();
  for (const c of creates) byPath.set(c.path, c);
  const ordered: CreateAction[] = [];
  const visited = new Set<string>();
  const inProgress = new Set<string>();
  const visit = (c: CreateAction): void => {
    if (visited.has(c.path) || inProgress.has(c.path)) return;
    inProgress.add(c.path);
    const parent = parentFolderFile(c.path);
    if (parent !== null && parent !== c.path) {
      const parentCreate = byPath.get(parent);
      if (parentCreate) visit(parentCreate);
    }
    inProgress.delete(c.path);
    visited.add(c.path);
    ordered.push(c);
  };
  for (const c of creates) visit(c);
  return ordered;
}

/**
 * Whether a vault path is a Docmost PAGE file: a `.md` file
 * with NO dot-segment anywhere in its path. This excludes `.obsidian/` config,
 * `.trash/`, dotfiles (`.foo.md`), and every non-`.md` file (attachments, JSON,
 * …) — Obsidian owns those; they live in the vault but are never pages. Used to
 * screen the PUSH diff so non-page files are never created/updated/deleted in
 * Docmost (and never get a `gitmost_id` frontmatter written into them).
 */
export function isPageFile(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  return !path.split("/").some((seg) => seg.startsWith("."));
}

/** The last path segment of a forward-slash path (the folder/file base name). */
function baseSegment(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/**
 * The page TITLE derived from a vault path: the file's base name without the
 * `.md` extension. In the native-Obsidian layout the filename IS the title — for
 * a folder-note `<dir>/<base>.md` that base equals the folder name, so the same
 * rule yields the folder's title. Self-consistent across pull/push: a pulled
 * (possibly disambiguated) filename round-trips to the same title, so a stable
 * file never pushes a spurious rename.
 */
function titleFromPath(path: string): string {
  const base = baseSegment(path);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/**
 * The exact ` ~<slugId>` disambiguation suffix `buildVaultLayout`/`disambiguate`
 * append to a colliding sibling's file stem (layout.ts): a single trailing
 * ` ~<one path component>` (no slash, no further `~`). It is a COSMETIC, local
 * filesystem artifact — never part of the page's real Docmost title — so it is
 * stripped before a path-derived title is compared/pushed (red-team #4b).
 */
const DISAMBIGUATION_SUFFIX_RE = / ~[^/~]+$/;

/** Remove a single trailing ` ~<slugId>` disambiguation suffix, if present. */
function stripDisambiguationSuffix(title: string): string {
  return title.replace(DISAMBIGUATION_SUFFIX_RE, "");
}

/**
 * Build the synthetic `DocmostMdMeta` the planner/classifier consume, from the
 * NATIVE format: `pageId` from the `gitmost_id` frontmatter, `title` from the
 * filename, `spaceId` from the run (the vault's space — every file belongs to
 * it). `parentPageId` is intentionally absent: tree position is resolved from the
 * PATH (`resolveParentPageId`), never from a stored field (SPEC §5).
 */
function nativeMeta(
  text: string,
  path: string,
  spaceId: string,
): DocmostMdMeta {
  const { id } = parsePageFile(text);
  const meta: DocmostMdMeta = { version: 1, title: titleFromPath(path), spaceId };
  if (id) meta.pageId = id;
  return meta;
}

/**
 * Build the `resolveParentPageId(path, side)` resolver `classifyRenameMoves`
 * needs, reading the PARENT FOLDER's `.md` (SPEC §5 path-as-truth):
 *   - `current` -> `deps.readFile(<dir>.md)` (`main`),
 *   - `prev`    -> `git.showFileAtRef(deps.baseRef, <dir>.md)` (the pre-image
 *     the push diff was computed from),
 * then read its `gitmost_id` frontmatter and return that page's pageId. A root-level path
 * (no enclosing folder), a missing/unreadable parent file, or a parent file with
 * no parseable pageId all resolve to `null` (parent is ROOT / unknown ->
 * `parentPageId: null`, SPEC §16 "parentPageId: null -> to root").
 *
 * The IO is async, so this returns an ASYNC resolver; the call sites prefetch the
 * parent pageIds (the classifier itself stays pure/sync over a plain table).
 */
async function resolveParentPageIdViaTree(
  deps: Pick<ApplyPushDeps, "readFile" | "git" | "baseRef">,
  path: string,
  side: MetaSide,
): Promise<string | null> {
  const parentFile = parentFolderFile(path);
  if (parentFile === null) return null; // root-level: parent is ROOT.
  let text: string | null;
  try {
    text =
      side === "current"
        ? await deps.readFile(parentFile)
        : await deps.git.showFileAtRef(deps.baseRef, parentFile);
  } catch (err) {
    if (err instanceof GitStoppedError) throw err;
    // Parent folder file missing at that side -> treat as ROOT.
    return null;
  }
  if (text === null) return null; // showFileAtRef returns null when absent.
  // The parent page's identity is its `gitmost_id` frontmatter; folder position
  // is irrelevant here, only the pageId.
  return parsePageFile(text).id;
}

/**
 * The parent of a file git created or moved into a folder whose folder note is
 * gone from `main`: the page that held that folder note when git put
 * the file at `path`. Docmost renamed or moved that folder page meanwhile and
 * an export moved its note away, so the path alone no longer names it. `null`
 * when the note is still there, the folder had no note then, or that page is
 * not in `liveIds()`.
 */
async function formerFolderPageId(
  deps: Pick<ApplyPushDeps, "readFile" | "git">,
  path: string,
  liveIds: () => Promise<Set<string>>,
): Promise<string | null> {
  const parentFile = parentFolderFile(path);
  if (parentFile === null) return null;
  try {
    await deps.readFile(parentFile);
    return null;
  } catch (err) {
    if (err instanceof GitStoppedError) throw err;
    // The folder note is gone: read it where git added the file.
  }
  const added = await deps.git.commitAddingPath(DEFAULT_BRANCH, path);
  if (added === null) return null;
  const text = await deps.git.showFileAtRef(added, parentFile);
  const id = text === null ? null : parsePageFile(text).id;
  return id !== null && (await liveIds()).has(id) ? id : null;
}

/**
 * Resolve the synthetic native meta at a side for the rename/move classifier (the
 * title — derived from the path — comes from here). Mirrors
 * `resolveParentPageIdViaTree`'s IO sides: `current` reads `main`,
 * `prev` reads `deps.baseRef`. Returns `null` only when the file is
 * missing/unreadable at that side (a real absence the classifier must see).
 */
async function metaAtViaTree(
  deps: Pick<ApplyPushDeps, "readFile" | "git" | "baseRef">,
  path: string,
  side: MetaSide,
  spaceId: string,
): Promise<DocmostMdMeta | null> {
  let text: string | null;
  try {
    text =
      side === "current"
        ? await deps.readFile(path)
        : await deps.git.showFileAtRef(deps.baseRef, path);
  } catch (err) {
    if (err instanceof GitStoppedError) throw err;
    return null;
  }
  if (text === null) return null;
  return nativeMeta(text, path, spaceId);
}

// --- runnable push orchestration (`runPush`) ---------------------------------
//
// `runPush` wires the VaultGit diff/ref primitives + the PURE
// `computePushActions` planner + the THIN `applyPushActions` applier into the
// cycle's apply step: the user's commits since the last export, applied to
// Docmost. It is driven IN-PROCESS by the NestJS server. SAFE BY DEFAULT — it
// defaults to DRY-RUN (plan only, NO Docmost writes) unless the caller passes
// `opts.dryRun === false`; that apply path is the ONLY one that builds a client
// and mutates Docmost.

/**
 * Injectable deps for `runPush` (everything that touches the outside world is
 * here so tests pass fakes). `makeClient` is a FACTORY, not a client — a dry-run
 * must build NO client at all (it is never called), and only the apply path
 * (`opts.dryRun === false`) invokes it.
 */
export interface PushDeps {
  settings: Settings;
  git: Pick<
    VaultGit,
    | "assertGitAvailable"
    | "ensureRepo"
    | "diffNameStatus"
    | "pageIdsAtRef"
    | "showFileAtRef"
    | "readFilesAtRef"
    | "commitAddingPath"
  >;
  /** Build a real client — called ONLY on the apply path, never on dry-run. */
  makeClient: (settings: Settings) => ApplyPushDeps["client"];
  /** The last export: what Docmost held when it was exported (the diff base). */
  baseRef: string;
  /** The `main` commit the user's changes end at. */
  headRef: string;
  /** Paths that are symlinks at `headRef`: never pages. */
  symlinks?: ReadonlySet<string>;
  /** Structured logger (a recorder in tests). */
  log: (line: string) => void;
  /** The cycle's AbortSignal, handed to `applyPushActions` (see there). */
  signal?: AbortSignal;
}

/** The structured outcome of a `runPush` cycle (returned + summarized). */
export interface PushRunResult {
  /** Which path ran: `dry-run` (plan only) or `apply` (Docmost mutated). */
  mode: "dry-run" | "apply";
  /** The diff base the plan was computed against: the last export. */
  base: { sha: string };
  /** The `main` commit the plan targets. */
  pushedCommit: string;
  /** Planned action counts from the PURE planner. */
  planned: {
    creates: number;
    updates: number;
    deletes: number;
    renamesMoves: number;
    skipped: number;
  };
  /** The applier's structured result — ONLY present on the apply path. */
  applied?: ApplyPushResult;
  /** Per-page failures from the applier (empty/absent on a clean run). */
  failures?: PushFailure[];
  /** The file -> page of every create (apply path). */
  created?: CreatedPage[];
}

/**
 * Apply the user's changes since the last export to Docmost (SPEC §6 "FS ->
 * Docmost"), DRY-RUN BY DEFAULT (the apply path runs only when
 * `opts.dryRun === false`).
 *
 * Steps:
 *   1. Preflight git: `assertGitAvailable` + `ensureRepo`.
 *   2. `diffNameStatus(baseRef, headRef)` -> changes (symlinks dropped: never
 *      pages); build the `metaAt(path, side)` resolver (current = `headRef`,
 *      prev = `baseRef`); run the PURE `computePushActions`.
 *   3. DRY-RUN (default): LOG the full plan and RETURN — NO client, NO Docmost
 *      calls.
 *   4. Apply path: build the client, run `applyPushActions`, log a one-line
 *      summary, and return the failures and created pages to the cycle.
 */
export async function runPush(
  deps: PushDeps,
  opts: { dryRun: boolean },
): Promise<PushRunResult> {
  const { git, settings, log } = deps;
  const dryRun = opts.dryRun;

  // 1. Preflight git. Fail fast (the thrown error propagates to the caller) if
  //    the git binary is missing — the vault state store relies on it.
  await git.assertGitAvailable();
  await git.ensureRepo();

  const base = { sha: deps.baseRef };
  const pushedCommit = deps.headRef;
  const readFile = async (path: string): Promise<string> => {
    const text = await git.showFileAtRef(pushedCommit, path);
    if (text === null) throw new Error(`${path} is not in ${pushedCommit}`);
    return text;
  };

  // 2. Diff the base against `main` and build the `metaAt` resolver (PURE planner
  //    input). `current` reads `main`; `prev` reads the base commit's pre-image
  //    (so a DELETE recovers its pageId). A symlink is never a page.
  const symlinks = deps.symlinks ?? new Set<string>();
  const changes = (await git.diffNameStatus(base.sha, pushedCommit)).filter(
    (c) => c.status === "D" || !symlinks.has(c.path),
  );
  // Synchronous resolver over PREFETCHED meta tables: `computePushActions` is
  // PURE/sync, but the reads are async — so we prefetch every (path, side) the
  // diff will ask for into a table first, then resolve from it.
  const metaTable = new Map<string, DocmostMdMeta | null>();
  for (const change of changes) {
    // `current`: A/M/R/C still have the file on `main`. `prev`: D needs the
    // pre-image; R/C also benefit (old title). Prefetch both sides per path.
    const currentPath = change.path;
    const prevPath = change.oldPath ?? change.path;
    if (!metaTable.has(`${currentPath}|current`)) {
      metaTable.set(
        `${currentPath}|current`,
        await readMetaCurrent(readFile, currentPath, settings.docmostSpaceId),
      );
    }
    if (!metaTable.has(`${prevPath}|prev`)) {
      metaTable.set(
        `${prevPath}|prev`,
        await readMetaPrev(deps, base.sha, prevPath, settings.docmostSpaceId),
      );
    }
  }
  const metaAt = (path: string, side: MetaSide): DocmostMdMeta | null =>
    metaTable.get(`${path}|${side}`) ?? null;

  // The set of pageIds that STILL EXIST somewhere in the current `main` tree.
  // Identity is the pageId, NOT the filename: a file vanishing from one path
  // while the SAME pageId lives at another path is a MOVE (often a layout
  // reshuffle of `_`-fallback names, whose two halves can even land in separate
  // cycles), never a deletion. Built only when the diff contains deletes — the
  // guard's whole job is to stop a phantom delete from trashing a live page.
  // `git grep` finds each file's first `gitmost_id:` line; one batch read
  // confirms it is the file's frontmatter id.
  let currentPageIds: Set<string> | undefined;
  if (changes.some((c) => c.status === "D")) {
    const hits = (await git.pageIdsAtRef(pushedCommit)).filter(
      (h) => !symlinks.has(h.path),
    );
    const texts = await git.readFilesAtRef(
      pushedCommit,
      hits.map((h) => h.path),
    );
    currentPageIds = new Set<string>();
    for (const h of hits) {
      const text = texts.get(h.path);
      const pid = text === undefined ? null : parsePageFile(text).id;
      if (pid) currentPageIds.add(pid);
    }
  }

  // COPIES: two files on `main` carrying the same gitmost_id (a `cp` or an
  // editor's "Make a copy" duplicates the frontmatter). The id's file in the base
  // commit stays the page; every other one is a copy and becomes a NEW page —
  // never an update of the original (a rename removes the old path, a copy keeps
  // both). When no candidate is at the id's base path, the page is the file git
  // paired with that path as a rename, else the first by path; its update is
  // always 3-way against the id's base file. Only ids carried by a changed file
  // can have gained a copy.
  const changedIds = new Set<string>();
  for (const change of changes) {
    const pid =
      change.status !== "D" && isPageFile(change.path)
        ? metaAt(change.path, "current")?.pageId
        : undefined;
    if (pid) changedIds.add(pid);
  }
  const copyPaths = new Set<string>();
  // The page file chosen for a duplicated id -> the id's base path.
  const pageBasePath = new Map<string, string>();
  if (changedIds.size > 0) {
    const pathsById = new Map<string, string[]>();
    for (const { path, id } of await git.pageIdsAtRef(pushedCommit)) {
      if (!changedIds.has(id) || !isPageFile(path) || symlinks.has(path)) continue;
      pathsById.set(id, [...(pathsById.get(id) ?? []), path]);
    }
    for (const [id, paths] of pathsById) {
      if (paths.length < 2) continue;
      const files: string[] = [];
      for (const path of paths.sort()) {
        const meta = await readMetaCurrent(readFile, path, settings.docmostSpaceId);
        if (meta?.pageId === id) files.push(path);
      }
      if (files.length < 2) continue;
      let page: string | undefined;
      for (const path of files) {
        const prev = await readMetaPrev(deps, base.sha, path, settings.docmostSpaceId);
        if (prev?.pageId === id) {
          page = path;
          break;
        }
      }
      if (page === undefined) {
        // The id's base file left its path (deleted, renamed, or reused by
        // another page): that diff row's pre-image carries the id.
        const left = changes.find(
          (c) =>
            c.status !== "A" &&
            metaAt(c.oldPath ?? c.path, "prev")?.pageId === id,
        );
        const basePath = left ? (left.oldPath ?? left.path) : undefined;
        const renamed = changes.find(
          (c) =>
            c.status === "R" && c.oldPath === basePath && files.includes(c.path),
        );
        page = renamed?.path ?? files[0];
        if (basePath !== undefined) pageBasePath.set(page, basePath);
      }
      for (const path of files) if (path !== page) copyPaths.add(path);
    }
  }
  if (copyPaths.size > 0) {
    log(
      `push: ${copyPaths.size} file(s) duplicate another page's gitmost_id — ` +
        `created as new pages: ${[...copyPaths].join(", ")}`,
    );
  }

  const actions = computePushActions({
    changes,
    metaAt,
    currentPageIds,
    copyPaths,
  });
  for (const u of actions.updates) {
    if (u.basePath === undefined) u.basePath = pageBasePath.get(u.path);
  }
  const planned = {
    creates: actions.creates.length,
    updates: actions.updates.length,
    deletes: actions.deletes.length,
    renamesMoves: actions.renamesMoves.length,
    skipped: actions.skipped.length,
  };

  // 3. DRY-RUN (default): log the full plan and RETURN — build NO client, make
  //    ZERO Docmost calls. This is the SAFE default.
  logPlan(log, base, pushedCommit, actions, planned, dryRun);
  if (dryRun) {
    return { mode: "dry-run", base, pushedCommit, planned };
  }

  // 4. Apply path: build the REAL client and execute. This is the ONLY write path.
  const client = deps.makeClient(settings);
  const applied = await applyPushActions(
    {
      client,
      // Pass the WHOLE `git` object so its methods keep their `this` binding.
      git,
      readFile,
      spaceId: settings.docmostSpaceId,
      baseRef: base.sha,
      warn: log,
      signal: deps.signal,
    },
    actions,
  );

  log(
    `push complete: ${applied.created} created, ${applied.updated} updated, ` +
      `${applied.deleted} deleted, ${applied.moved} moved, ${applied.renamed} ` +
      `renamed, ${applied.noops.length} no-op(s), ${applied.skipped.length} ` +
      `skipped, ${applied.failures.length} failure(s)`,
  );

  return {
    mode: "apply",
    base,
    pushedCommit,
    planned,
    applied,
    failures: applied.failures,
    created: applied.createdPages,
  };
}

/** Synthetic native meta from `main` (`current` side). */
async function readMetaCurrent(
  readFile: (path: string) => Promise<string>,
  path: string,
  spaceId: string,
): Promise<DocmostMdMeta | null> {
  let text: string;
  try {
    text = await readFile(path);
  } catch (err) {
    if (err instanceof GitStoppedError) throw err;
    return null; // absent on `main` (e.g. a D row's path) -> no current meta.
  }
  return nativeMeta(text, path, spaceId);
}

/** Synthetic native meta from the base ref's pre-image (`prev` side). */
async function readMetaPrev(
  deps: Pick<PushDeps, "git">,
  baseRef: string,
  path: string,
  spaceId: string,
): Promise<DocmostMdMeta | null> {
  let text: string | null;
  try {
    text = await deps.git.showFileAtRef(baseRef, path);
  } catch (err) {
    if (err instanceof GitStoppedError) throw err;
    return null;
  }
  if (text === null) return null; // path absent at the base ref.
  return nativeMeta(text, path, spaceId);
}

/** Emit the full plan (counts + per-item) to the injected logger. */
function logPlan(
  log: (line: string) => void,
  base: { sha: string },
  pushedCommit: string,
  actions: PushActions,
  planned: PushRunResult["planned"],
  dryRun: boolean,
): void {
  log(
    `push plan (${dryRun ? "DRY-RUN — no Docmost writes" : "APPLY"}): base=` +
      `last-export ${base.sha.slice(0, 8)} ` +
      `-> main ${pushedCommit.slice(0, 8)}`,
  );
  log(
    `push plan counts: ${planned!.creates} create, ${planned!.updates} update, ` +
      `${planned!.deletes} delete, ${planned!.renamesMoves} rename/move, ` +
      `${planned!.skipped} skipped`,
  );
  for (const c of actions.creates) log(`  create: ${c.path}`);
  for (const u of actions.updates) log(`  update: ${u.pageId} (${u.path})`);
  for (const d of actions.deletes) log(`  delete: ${d.pageId}`);
  for (const rm of actions.renamesMoves)
    log(`  rename/move: ${rm.oldPath} -> ${rm.newPath} (${rm.pageId})`);
  for (const s of actions.skipped)
    log(`  skipped [${s.status}] ${s.path}: ${s.reason}`);
}
