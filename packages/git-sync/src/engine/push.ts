/**
 * Push cycle — vault -> Docmost (DESIGN.md §7), FIRST increment.
 *
 * This module mirrors the structure of `./pull.ts`: a set of VaultGit diff/ref
 * primitives (in `./git.ts`), a PURE planner (`computePushActions`) that turns
 * a git diff into a classified action set with NO IO, and a THIN injectable
 * applier (`applyPushActions`) exercised in tests via fakes only.
 *
 * Direction is vault -> Docmost. The diff is `main` against
 * merge-base(`docmost`, `main`) (DESIGN.md §7); each `A`/`M`/`D`/`R` row is
 * translated into a Docmost mutation by `pageId` identity (DESIGN.md §4):
 *   - A without pageId   -> create_page (then write the assigned pageId back).
 *   - A with    pageId   -> update (restored/copied file; the page already exists).
 *   - M                  -> update content (collab/Yjs path, DESIGN.md §7).
 *   - D                  -> delete_page (pageId recovered from the PRE-IMAGE meta).
 *   - R                  -> rename/move (CLASSIFIED here, APPLIED in push #3).
 *
 * MOVE/RENAME APPLY (push #3) — DONE here. `classifyRenameMoves` (PURE) resolves
 * each `renamesMoves` entry into the Docmost op(s) it needs, comparing the PATH-
 * derived parent (DESIGN.md §4: the file path is the source of truth for tree
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
  serializePageFile,
} from "@docmost/prosemirror-markdown";
import type { GitSyncClient } from "./client.types.js";
import type { DiffEntry } from "./git.js";
import {
  VaultGit,
  DEFAULT_BRANCH,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
  DOCMOST_SOURCE_TRAILER,
} from "./git.js";
import { CycleAbortedError, throwIfAborted } from "./abort.js";
import { markdownToProseMirror } from "./convert-pool.js";
import { bodyHash } from "./loop-guard.js";
import { isGitCopyPath } from "./sanitize.js";
import { type Settings } from "./settings.js";
import { stabilizePageBody } from "./stabilize.js";
import { DOCMOST_BRANCH, PUSH_REF, RECORD_REF } from "./vault-refs.js";

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
   * file lives at its NEW `path` in the working tree, but in the base tree
   * the file was at its OLD path — so the merge base must be looked up there, or
   * it resolves to `null` and the merge degrades to a 2-way (clobbering concurrent
   * Docmost-side edits). For a plain `M` update this is undefined -> uses `path`,
   * an honest 3-way merge at the same path (unchanged behavior).
   */
  basePath?: string;
}

/** A page to soft-delete in Docmost (Trash, DESIGN.md §7). */
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
 * A CLASSIFIED rename/move (push #3): a `RenameMoveAction` resolved into the
 * Docmost op(s) it actually needs. The file PATH is the source of truth for tree
 * position (DESIGN.md §4: "the identity is the pageId, not the path" — the path is COSMETIC and
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
 * Injected resolvers for the PURE `classifyRenameMoves` (push #3). Both are PURE
 * given a path + side; the real `main` (a follow-up) wires them to the file tree
 * (`readFile` for `current`, `git.showFileAtRef` for `prev`), tests pass plain
 * lookups. DESIGN.md §4 path-as-truth:
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
 * (push #3, DESIGN.md §4, §7). Resolves each `{pageId, oldPath, newPath}` into the
 * Docmost op(s) it needs, with NO IO (both resolvers are injected).
 *
 * DESIGN.md §4 — the file PATH is the source of truth for tree position, NOT the
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
   * untracked-file guard, DESIGN.md §7: only files that were tracked with a pageId
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
 *     recovered from the version Docmost last knew (DESIGN.md §7).
 */
export type MetaSide = "current" | "prev";

/** Input to the PURE planner. `metaAt` is injected (no IO inside the planner). */
export interface PushActionsInput {
  /** Diff rows of `main` vs merge-base(`docmost`, `main`) (DESIGN.md §7). */
  changes: DiffEntry[];
  /**
   * Resolve a file's synthetic native meta at a given side, or `null` if the file is
   * absent there / has no parseable meta. PURE injection: the real `main` reads
   * the working tree (current) or `git show <base>:<path>` (prev); tests
   * pass a plain lookup.
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
 * Emit the action PAIR a move/rename needs (F4): a `renamesMoves` entry (the
 * relocation, applied later as a move/rename — those ops are content-free) AND a
 * body `updates` entry for the NEW path, so a body edit riding along in the SAME
 * diff is not lost. `importPageMarkdown` targets by pageId and is a near-no-op for
 * a pure relocation. The merge BASE is taken from the OLD path (`basePath`): the
 * file lives at its NEW `path` in the working tree, but at the base it was at
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
 * PURE push planner (DESIGN.md §4, §7). Classifies each diff row into a Docmost
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
 *         (DESIGN.md §4), and a new local file may carry only partial human meta. We
 *         refuse to create rather than guess a space (DESIGN.md §7).
 *   - `M` (modified): current meta has a pageId -> UPDATE content. (If a modified
 *       file somehow lost its pageId it is skipped — there is nothing to target.)
 *   - `D` (deleted): recover the pageId from the PRE-IMAGE meta (`metaAt(path,
 *       'prev')`) -> DELETE. If no pageId can be recovered, SKIP with a reason
 *       (untracked-file guard, DESIGN.md §7: never delete an untracked page).
 *   - `R` (renamed/moved): same pageId (from current meta), path changed ->
 *       RENAME/MOVE. Resolution of move-vs-rename + the new parentPageId is
 *       DEFERRED to the next increment; here we only record oldPath/newPath/
 *       pageId. If the renamed file has no recoverable pageId it is SKIPPED.
 *       (`C` copy is treated the same as `R` for recording purposes.)
 */
export function computePushActions(input: PushActionsInput): PushActions {
  const { metaAt, currentPageIds } = input;
  const copyPaths = input.copyPaths ?? new Set<string>();
  // PAGE-FILE FILTER (design §"Adoption"): only `.md` files OUTSIDE any dot-folder
  // are Docmost pages. `.obsidian/*`, attachments, and other non-page files are
  // committed to the vault (no `.gitignore`) and so appear in the diff, but they
  // are NEVER pages — Obsidian owns them. Without this filter every ADDED such
  // file would be mis-classified as a CREATE (nativeMeta always supplies a
  // spaceId, so the old `create-without-spaceId` skip no longer screens them),
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

  // GHOST-MOVE coalescing (⭐ data-loss guard). git's rename detection (`-M`)
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
          // Brand-new local file with a target space -> create the page, then
          // write the assigned pageId back into its meta (in `applyPushActions`).
          // `meta.spaceId` is truthy here, so empty-string is also rejected.
          actions.creates.push({ path: change.path });
        } else {
          // A create needs a spaceId (Docmost `create_page` requires it). A
          // new file with partial meta and no usable spaceId is SKIPPED rather
          // than created into a guessed space (DESIGN.md §7).
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
          // skipped and then reverted by the next Docmost->git push — the edit is
          // lost (bug C10-D1). The pushed-back re-serialize restores the frontmatter
          // next cycle, so the file self-heals. If the pre-image ALSO lacked an id
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
        // (the version last pushed to Docmost) so we delete the RIGHT page.
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
          // Untracked-file guard (DESIGN.md §7): a file with no recoverable pageId was
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

// --- thin apply (create/update/delete) ---------------------------------------

/**
 * Injectable IO for `applyPushActions`. In production these are wired to the live
 * client (the native GitmostDataSource), `node:fs/promises`, and the vault git
 * wrapper — `applyPushActions` runs LIVE via runPush -> runCycle -> the
 * orchestrator's driveCycle. Tests substitute FAKES through the same seam.
 *   - `client`: the create/update/delete/move/rename subset of `GitSyncClient`,
 *     plus `getPageJson` to tell git-sync's own cut-off create (retry-adopt).
 *   - `readFile`/`writeFile`: read a changed file's body / write a file back
 *     (by vault-relative path; the applier does not resolve absolute paths so
 *     fakes stay trivial).
 *   - `git`: `fastForwardBranch` (advance the `docmost` mirror after a clean
 *     push, the loop-close — DESIGN.md §7).
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
  /** Write a file's full text by its vault-relative path. */
  writeFile: (path: string, text: string) => Promise<void>;
  /**
   * The Docmost spaceId this vault mirrors. A CREATE targets this space (the
   * native file carries no spaceId — every file in the vault belongs to it), and
   * it backs the synthetic native meta the classifier reads.
   */
  spaceId: string;
  /**
   * `fastForwardBranch` advances the `docmost` mirror after a clean push.
   * `showFileAtRef` reads a file's text at `baseRef` (the 3-way merge base of an
   * update, and the PREVIOUS parent folder's `.md` / meta for the move/rename
   * classifier — the path is the truth for tree position, DESIGN.md §4).
   * `commitAddingPath` finds where git created or moved a file whose folder
   * note is gone (its parent, see `formerFolderPageId`).
   */
  git: Pick<
    VaultGit,
    "fastForwardBranch" | "showFileAtRef" | "commitAddingPath"
  >;
  /**
   * The commit the push diff was computed from (runPush: merge-base of `docmost`
   * and `main` — what Docmost already holds). Every pre-image read comes from it,
   * so the planner and the applier agree on "before".
   */
  baseRef: string;
  /**
   * Per-space PUSH policy for a page body that still carries unresolved git
   * conflict markers (DESIGN.md §7). When TRUE, the marker lines are stripped and both
   * sides' content is pushed (the legacy `stripConflictMarkers` behavior). When
   * FALSE/undefined (the SAFE DEFAULT), the conflicted page is NOT pushed: it is
   * recorded as a per-page FAILURE (so its paths stay out of the advanced base
   * and the page is retried) and the user resolves the git conflict first.
   */
  autoMergeConflicts?: boolean;
  /**
   * The cycle's AbortSignal (lost lock, deadline). Checked before every page
   * operation and handed to every conversion: aborted, the apply stops with a
   * `CycleAbortedError` and the next cycle's recovery repairs the vault.
   */
  signal?: AbortSignal;
}

/**
 * Reason recorded on a per-page push FAILURE when a page is skipped because its
 * body still carries unresolved git conflict markers and `autoMergeConflicts` is
 * off (the SAFE default). Recorded as a failure (not a soft skip) on purpose: the
 * page is never marked as pushed and is retried until the human resolves the
 * conflict in git (DESIGN.md §7).
 */
export const CONFLICT_MARKERS_FAILURE_REASON =
  "unresolved conflict markers — resolve in git first";

/** A file whose meta was rewritten with a freshly-assigned pageId (post-create). */
export interface WrittenBackPage {
  path: string;
  pageId: string;
}

/**
 * The per-page push record consulted by a FUTURE poll-suppression (DESIGN.md §11): a
 * pulled page whose body hash + `updatedAt` match a record here is OUR OWN write
 * and must not be re-pulled. PRODUCED here; CONSUMED on the pull side later.
 */
export interface PushedPageRecord {
  /** The Docmost pageId that was updated/created. */
  pageId: string;
  /**
   * The `updatedAt` from the create/update client result, when the result
   * exposed one. Absent when the (fake) client did not return it.
   */
  updatedAt?: string;
  /** Stable hash of the markdown BODY that was pushed (DESIGN.md §11). */
  bodyHash: string;
}

/**
 * One page whose operation FAILED during apply (DESIGN.md §8). The bad
 * page is isolated — recorded here — and the rest of the batch still runs. Its
 * paths stay at their `docmost` version in the advanced base
 * (`recordPushedPages`), so the next push retries this page alone.
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
 * A rename/move action that resolved to a NO-OP (push #3, DESIGN.md §4): a purely
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

/** Structured outcome of `applyPushActions` (counts + write-backs + noops). */
export interface ApplyPushResult {
  created: number;
  updated: number;
  deleted: number;
  /** Pages reparented in Docmost via `move_page` (push #3, DESIGN.md §4). */
  moved: number;
  /** Pages retitled in Docmost via `rename_page` (push #3, DESIGN.md §4). */
  renamed: number;
  /**
   * Files whose `gitmost_id` frontmatter was written with the pageId Docmost assigned on
   * create — these now need a FOLLOW-UP commit (the meta on disk changed). The
   * commit itself is the caller's job (NEXT increment); recorded here so it is
   * not lost.
   */
  writtenBack: WrittenBackPage[];
  /**
   * Per-page push records (pageId + optional `updatedAt` + body hash) for every
   * page successfully updated/created — the loop-guard data (DESIGN.md §11) a future
   * poll-suppression (pull side) will consult so it does not re-pull our own
   * write. Deletes are not included (no body was pushed).
   */
  pushed: PushedPageRecord[];
  /**
   * Pages whose operation threw — isolated and recorded, the batch continued
   * (DESIGN.md §7). Non-empty here means the applier advanced no ref: `runPush`
   * records per page what reached Docmost (`recordPushedPages`).
   */
  failures: PushFailure[];
  /**
   * Rename/move actions that resolved to a NO-OP — a purely LOCAL file-path
   * rename (same parent, same title). NO Docmost call was made for these
   * (DESIGN.md §4: the page is its pageId, the path is local-only). Recorded for logging.
   */
  noops: PushNoop[];
  /** Diff rows the planner could not classify (carried through for logging). */
  skipped: PushActions["skipped"];
  /**
   * True when the push was CLEAN — every action reached Docmost (no failures)
   * and a `pushedCommit` was given — so the `docmost` mirror was advanced to it
   * (see `docmostFastForward`). A push with failures is recorded per page by
   * `runPush` instead.
   */
  clean: boolean;
  /**
   * Result of fast-forwarding the `docmost` mirror branch after a CLEAN push
   * (the loop-close, DESIGN.md §7). `null` when no advance was attempted (no
   * `pushedCommit`, or there were failures). `{ ok:false, reason }` when a
   * non-fast-forward was REFUSED (divergent `docmost` history is never clobbered).
   */
  docmostFastForward: { ok: boolean; reason?: string } | null;
}

/**
 * THIN IO applier for the COMMON push cases (create/update/delete). Runs LIVE in
 * production (via runPush -> runCycle -> orchestrator); tests drive it with FAKES.
 *
 *   - UPDATE: read the file body, then `client.importPageMarkdown(pageId, body)`.
 *     This is the collab/Yjs write path — NEVER a raw jsonb overwrite.
 *   - CREATE: derive title/spaceId/parentPageId from the file's current meta,
 *     `client.createPage(...)`, take the assigned pageId from the result, and
 *     write it BACK as the file's `gitmost_id` frontmatter (re-serialized via
 *     `serializePageFile`, body preserved) so the file becomes
 *     tracked. The write-back is recorded in `writtenBack`; `runPush` commits it.
 *   - DELETE: `client.deletePage(pageId)` — soft-delete to Trash.
 *   - RENAME/MOVE: classify each `renamesMoves` entry with
 *     `classifyRenameMoves` (resolvers read the parent FOLDER's `.md` for the
 *     parent pageId — path-as-truth — and the meta for the title), then:
 *       - `move`   -> `client.movePage(pageId, parentPageId, position?)` (reparent;
 *         `position` is UNDEFINED for now — the client supplies a default),
 *       - `rename` -> `client.renamePage(pageId, title)` (title-only),
 *       - BOTH     -> move (reparent) THEN rename (title), in that order,
 *       - `noop`   -> NO client call; recorded in `noops` (a cosmetic local-only
 *         file-path rename: the page is its pageId, the path is local).
 *
 * FAIL-SAFE / per-page isolation (DESIGN.md §7). Each page's operation
 * is wrapped in its own try/catch: a single failing page is recorded in
 * `failures[]` (with its kind + pageId/path(s) + error) and the batch CONTINUES —
 * one bad page must never block the rest. This applier advances `docmost` only
 * when `failures.length === 0`. A re-applied page is NOT a harmless no-op — the
 * pull moves the merge base every cycle, so a page re-sent from an old base
 * reverts Docmost edits made since and duplicates created pages — so after a
 * PARTIAL push `runPush` records per page what reached Docmost
 * (`recordPushedPages`) and only the failed pages are retried.
 *
 * LOOP-CLOSE (DESIGN.md §7). After a fully-successful push, when a
 * `pushedCommit` is supplied, the `docmost` mirror branch is fast-forwarded to
 * it via `git.fastForwardBranch('docmost', pushedCommit)` — so the mirror
 * reflects what Docmost now contains and the NEXT pull diffs EMPTY for these
 * pages (it does not re-pull our own write). The ff is REFUSED (not forced) if
 * `docmost` is not an ancestor of the pushed commit; the result is surfaced in
 * `docmostFastForward`, and `clean` says the push was clean. On ANY failure
 * this applier does not move `docmost`.
 *
 * LOOP-GUARD DATA (DESIGN.md §11). For every page successfully updated/created
 * the result carries a `pushed` record `{ pageId, updatedAt?, bodyHash }` — the
 * body hash of what was pushed plus the write's `updatedAt` (when the client
 * returned one). Produced here; nothing consumes it yet.
 *
 * CANCELLATION (DESIGN.md §9). `deps.signal` is checked before every page
 * operation; an abort throws a `CycleAbortedError` out of the batch (it is not
 * a per-page failure), leaving the pages applied so far and their write-backs
 * for the next cycle's recovery.
 *
 * @param pushedCommit The `main` commit just reflected into Docmost (SHA or
 *   commit-ish). When omitted, `docmost` is not advanced (e.g. a dry plan).
 */
export async function applyPushActions(
  deps: ApplyPushDeps,
  actions: PushActions,
  pushedCommit?: string,
): Promise<ApplyPushResult> {
  const { client, git } = deps;

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let moved = 0;
  let renamed = 0;
  const writtenBack: WrittenBackPage[] = [];
  const pushed: PushedPageRecord[] = [];
  const failures: PushFailure[] = [];
  const noops: PushNoop[] = [];

  // 1. UPDATES — collab/Yjs write path, never a raw overwrite.
  //    Each update is isolated: a thrown page is recorded and the batch goes on.
  for (const u of actions.updates) {
    throwIfAborted(deps.signal, `before pushing the update of ${u.path}`);
    try {
      // Push the CLEAN body only (no `gitmost_id` frontmatter): the frontmatter
      // is engine metadata, never page content. The server converts the markdown
      // it receives verbatim, so stripping here keeps the id out of Docmost.
      const rawBody = parsePageFile(await deps.readFile(u.path)).body;
      // Git conflict markers must NEVER reach Docmost (red-team #13).
      // Per-space policy (`autoMergeConflicts`): when OFF (the SAFE default), a
      // still-conflicted body is NOT pushed — record a failure so the refs are
      // held and the page is retried once the human resolves the conflict in git.
      // When ON, strip the marker lines and push both sides' content.
      if (!deps.autoMergeConflicts && hasConflictMarkers(rawBody)) {
        failures.push({
          kind: "update",
          pageId: u.pageId,
          path: u.path,
          ...(u.basePath !== undefined ? { oldPath: u.basePath } : {}),
          error: CONFLICT_MARKERS_FAILURE_REASON,
        });
        continue;
      }
      const conflicted = hasConflictMarkers(rawBody);
      const body = stripConflictMarkers(rawBody);
      // The version Docmost already holds (pre-image at `baseRef`) is the common
      // ancestor for a 3-way merge against the live page, so concurrent human
      // edits are not clobbered (review #5). Null when the file is new there. Its
      // body is stripped the SAME way (frontmatter AND conflict markers) so the
      // merge compares clean body-to-body: a base that itself carried markers
      // (from a prior conflict commit) must never reintroduce marker syntax or a
      // stale diff3 base region into the 3-way merge.
      // Resolve the merge base from `basePath` when set (the OLD path for a
      // rename-derived update), falling back to `u.path` for a plain `M` update —
      // identical behavior to before for non-renames. The BODY is still read from
      // `u.path` (the new working-tree location); only the BASE lookup changes.
      const baseFull = await deps.git.showFileAtRef(
        deps.baseRef,
        u.basePath ?? u.path,
      );
      const baseMarkdown =
        baseFull === null
          ? null
          : stripConflictMarkers(parsePageFile(baseFull).body);
      const result = await client.importPageMarkdown(
        u.pageId,
        body,
        baseMarkdown,
      );
      updated++;
      // CONFLICT VAULT-CLEAN (autoMergeConflicts ON, marker leak). On ON a
      // conflicted page is auto-merged INTO Docmost (the clean `body` above),
      // but the file on `main` still carries the raw `<<<<<<<`/`>>>>>>>` markers
      // a human committed. Left as-is they would (1) stay in the PUBLISHED vault
      // forever (external clones see raw markers) and (2) re-conflict every
      // cycle. So write the CLEAN body back to the vault file (`writeBack`, the
      // form recovery recognizes) and record it in `writtenBack` — `runPush`
      // step 7a commits it on `main` and re-advances `docmost`, so the published
      // vault converges to the merged content. Only conflicted files are
      // rewritten (no churn for clean updates).
      if (conflicted) {
        await deps.writeFile(u.path, writeBack(u.pageId, rawBody));
        writtenBack.push({ path: u.path, pageId: u.pageId });
      }
      // Loop-guard data: hash the BODY we pushed + capture `updatedAt`.
      pushed.push({
        pageId: u.pageId,
        ...extractUpdatedAt(result),
        bodyHash: bodyHash(body),
      });
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

  // 2. CREATES — create the page, then write the assigned pageId back to meta so
  //    the file becomes tracked. Isolated per page like updates.
  //
  // RETRY-ADOPT (#1 idempotency): create is NOT atomic with the pageId write-back
  // (createPage runs, then writeFile, then the write-back commit at runPush 7a). If
  // the write-back dies in between, the file on disk still has no pageId and the
  // next cycle re-classifies it as a CREATE -> a DUPLICATE page would be created.
  // The pull takes such a page over when its export lands at git's path (an
  // add/add, see pull.ts); a page whose export lands elsewhere (its title
  // sanitizes to another file name) is found here instead: a (parentPageId|root,
  // title) -> existing pageId map built ONCE from the LIVE Docmost tree (only when
  // there is at least one create). A match is ADOPTED only when it is provably
  // git-sync's own cut-off create of this file (`isOwnUnfinishedCreate`: last
  // written by git-sync, nobody edited it since, and empty or already holding
  // this body) — any other page that merely shares the title is never written
  // over (GL-4); the file is then created as a page of its own.
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
  // child can resolve its freshly-created parent's id without depending on the
  // on-disk write-back being observable yet (red-team #12).
  const createdIdByPath = new Map<string, string>();
  const createPaths = new Set(actions.creates.map((x) => x.path));
  for (const c of orderedCreates) {
    throwIfAborted(deps.signal, `before pushing the create of ${c.path}`);
    try {
      const text = await deps.readFile(c.path);
      const rawBody = parsePageFile(text).body;
      // Conflict markers must never reach Docmost (red-team #13). Honor
      // the per-space `autoMergeConflicts` policy on the create path too: OFF (the
      // SAFE default) records a failure (refs held, retried) rather than creating
      // a page from conflicted content; ON strips the markers and pushes both
      // sides' content.
      if (!deps.autoMergeConflicts && hasConflictMarkers(rawBody)) {
        failures.push({
          kind: "create",
          path: c.path,
          error: CONFLICT_MARKERS_FAILURE_REASON,
        });
        continue;
      }
      const body = stripConflictMarkers(rawBody);
      // Derive create args from the PATH (native-Obsidian, DESIGN.md §4): title
      // from the filename, parent from the enclosing folder's folder-note, space
      // from the run (the vault's space). `parentPageId: null` -> created at ROOT.
      const title = titleFromPath(c.path);
      // Resolve the parent from the PATH. Prefer an id assigned to the
      // parent's folder-note EARLIER in this same batch — a freshly-created parent
      // whose on-disk write-back may not be observable yet (red-team #12; creates
      // are ordered parent-before-child so the parent already ran).
      const parentFile = parentFolderFile(c.path);
      // The parent is a create of this same batch that did not get a page (it
      // failed or was refused): fail the child too instead of creating it at the
      // root. Its path then stays out of the recorded base and both creates are
      // retried in order next cycle — a root page would be recorded as nested
      // and the next pull would move the file to the root for good.
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
      // Retry-adopt (#1 idempotency): a prior cycle already created this page in
      // Docmost but failed to persist the pageId back to the file, so it was
      // re-seen as a create. Adopt the existing page instead of duplicating it:
      // write the id back (file becomes tracked) and push the body as an UPDATE
      // (idempotent — targets by pageId). Do NOT call createPage again. SKIP
      // adoption when the (parent, title) is AMBIGUOUS — adopting an arbitrary
      // duplicate-title sibling would silently overwrite it (red-team #6) — and
      // when the page is not provably git-sync's own cut-off create of this file
      // (GL-4: an unrelated page that only shares the title).
      const adoptKey = `${parentPageId ?? " root"} ${title}`;
      const candidateId = ambiguousAdoptKeys.has(adoptKey)
        ? undefined
        : liveByParentTitle?.get(adoptKey);
      const existingId =
        candidateId !== undefined &&
        (await isOwnUnfinishedCreate(
          await client.getPageJson(candidateId),
          null,
          body,
          deps.signal,
        ))
          ? candidateId
          : undefined;
      if (existingId) {
        await deps.writeFile(c.path, writeBack(existingId, rawBody));
        writtenBack.push({ path: c.path, pageId: existingId });
        createdIdByPath.set(c.path, existingId);
        const adopted = await client.importPageMarkdown(existingId, body, null);
        pushed.push({
          pageId: existingId,
          ...extractUpdatedAt(adopted),
          bodyHash: bodyHash(body),
        });
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
        // Write the assigned pageId back as the `gitmost_id` frontmatter, body
        // preserved — the file becomes engine-tracked.
        await deps.writeFile(c.path, writeBack(assignedPageId, rawBody));
        writtenBack.push({ path: c.path, pageId: assignedPageId });
        createdIdByPath.set(c.path, assignedPageId);
        // Loop-guard data for the created page (hash the pushed BODY).
        pushed.push({
          pageId: assignedPageId,
          ...extractUpdatedAt(result),
          bodyHash: bodyHash(body),
        });
      }
      created++;
    } catch (err: unknown) {
      // An abort (the adopt check's conversions honour the signal) ends the
      // push, it is not this page's failure.
      if (err instanceof CycleAbortedError) throw err;
      failures.push({ kind: "create", path: c.path, error: errMessage(err) });
    }
  }

  // 3. DELETES — soft-delete to Trash, reversible. Isolated per page.
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

  // 4. RENAME/MOVE. Classify each entry against the
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
    // into `failures`, NOT abort the whole batch (resumability). The helpers
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
        // Cosmetic local-only file-path rename — no Docmost op.
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
          // TODO(next): compute a fractional-index position between siblings.
          // `position` is UNDEFINED here; the client supplies a valid
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

  // 5. On a CLEAN push (no failures) with a pushed commit, close the loop
  //    (DESIGN.md §7): fast-forward the `docmost` mirror, so Docmost's new
  //    content is mirrored and the next pull diffs empty. A partial push is
  //    recorded per page by `runPush`.
  throwIfAborted(deps.signal, `before advancing '${DOCMOST_BRANCH}'`);
  const clean = Boolean(pushedCommit) && failures.length === 0;
  let docmostFastForward: { ok: boolean; reason?: string } | null = null;
  if (clean) {
    // Fast-forward the mirror (refused, not forced, on a non-fast-forward — the
    // caller logs the reason). Surfaced in the result.
    docmostFastForward = await git.fastForwardBranch(
      DOCMOST_BRANCH,
      pushedCommit!,
    );
  }

  return {
    created,
    updated,
    deleted,
    moved,
    renamed,
    writtenBack,
    pushed,
    failures,
    noops,
    skipped: actions.skipped,
    clean,
    docmostFastForward,
  };
}

/** Stringify a thrown value into a stable error message. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The file text the push writes back over a page file whose body was `rawBody`
 * when the push read it: the page's id as its `gitmost_id`, the body without
 * conflict markers. The ONE definition of a write-back — `isCompleteWriteBack`
 * recognizes a finished one by it.
 */
function writeBack(pageId: string, rawBody: string): string {
  return serializePageFile(pageId, stripConflictMarkers(rawBody));
}

/**
 * Whether `work`, a page file left uncommitted by an interrupted push, is a
 * COMPLETE write-back of `head` (its committed text): exactly what `writeBack`
 * makes of it. A write cut off part-way (an empty or truncated file) is not.
 */
export function isCompleteWriteBack(work: string, head: string): boolean {
  const id = parsePageFile(work).id;
  return id !== null && work === writeBack(id, parsePageFile(head).body);
}

/**
 * Whether a Docmost page is git-sync's own create of a git file whose body is
 * `gitBody`, cut off before the file got the page's id: the page's last write
 * was git-sync's (nobody edited it since) and the page is still empty or
 * already holds git's body as it would export after git-sync wrote it. Taking
 * such a page over writes git's body into it, so the body check keeps a page
 * that only looks like one — restored from the trash, every page of a re-made
 * vault, an unrelated page with the same title — from changing.
 *
 * `pageBody` is the page's export when the caller already has it; otherwise it
 * is made from `page.content`. Conversions run on the pool and honour `signal`;
 * a conversion error rejects.
 */
export async function isOwnUnfinishedCreate(
  page: { lastUpdatedSource?: string | null; content: unknown },
  pageBody: string | null,
  gitBody: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (page.lastUpdatedSource !== "git-sync") return false;
  const exported = pageBody ?? (await stabilizePageBody(page.content, signal));
  if (exported.trim().length === 0) return true;
  const gitExport = await stabilizePageBody(
    await markdownToProseMirror(gitBody, undefined, signal),
    signal,
  );
  return gitExport.trimEnd() === exported.trimEnd();
}

/**
 * DESIGN.md §4 path-as-truth: the parent FOLDER's `.md` file for a vault-relative
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
 * Whether a vault path is a Docmost PAGE file (design §"Adoption"): a `.md` file
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

/**
 * Git conflict-marker scan + strip (DESIGN.md §7 — conflict markers must NEVER reach
 * Docmost). Only a REAL conflict block counts, the shape git writes: a
 * `<<<<<<< <label>` line, optionally a diff3 `||||||| <label>` base section, a
 * `=======` line, then a `>>>>>>> <label>` line — in that order, each at a line
 * start, outside fenced code blocks. Lines that merely start with `<<<<<<<`,
 * `=======` or `>>>>>>>` (a page quoting a conflict in prose, a setext heading
 * underline) are ordinary text: flagging them used to hold such a page back
 * forever (autoMergeConflicts off) or strip its legitimate lines (on). Stripping
 * removes each real block's marker lines while both sides' content is kept (no
 * data loss: the conflict is visible and fixable in Docmost).
 *
 * `diff3`/`zdiff3` style: such a block adds a `|||||||` base section (the
 * `|||||||` line + the merge-BASE content, up to `=======`). `ensureRepo` pins
 * `merge.conflictStyle=merge` so the engine never produces it, but a vault that
 * predates the pin — or content arriving via an external push that a human
 * committed in diff3 style — could still carry it. The strip DROPS that base
 * region: the base text is neither side's current content, so keeping it would
 * inject obsolete lines.
 */
const CONFLICT_BEGIN_LINE_RE = /^<{7} /;
const CONFLICT_BASE_LINE_RE = /^\|{7} /;
const CONFLICT_SEP_LINE_RE = /^={7}\r?$/;
const CONFLICT_END_LINE_RE = /^>{7} /;

// A code-fence open/close line (``` or ~~~), matching markdown-to-prosemirror's
// CODE_FENCE_RE. Used to make conflict-marker detection fence-aware.
const CONFLICT_CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Indices of the lines that belong to a real conflict block's syntax: its
 * marker lines and its diff3 base region. Fence-aware (review #9): a page
 * documenting git (a ```-fenced block that literally contains a conflict) is not
 * a conflict, so everything inside a fence is inert.
 */
function conflictSyntaxLines(lines: string[]): Set<number> {
  const syntax = new Set<number>();
  let inFence = false;
  let fenceMarker = "";
  // The open candidate block: its begin, base and separator line indices.
  let begin = -1;
  let base = -1;
  let sep = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(CONFLICT_CODE_FENCE_RE);
    if (inFence) {
      // Close on a fence line of the same marker char, length >= the opener.
      if (
        fence &&
        fence[2][0] === fenceMarker[0] &&
        fence[2].length >= fenceMarker.length
      ) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (fence) {
      inFence = true;
      fenceMarker = fence[2];
      continue;
    }
    if (CONFLICT_BEGIN_LINE_RE.test(line)) {
      begin = i;
      base = -1;
      sep = -1;
    } else if (begin < 0) {
      continue;
    } else if (sep < 0 && base < 0 && CONFLICT_BASE_LINE_RE.test(line)) {
      base = i;
    } else if (sep < 0 && CONFLICT_SEP_LINE_RE.test(line)) {
      sep = i;
    } else if (CONFLICT_END_LINE_RE.test(line)) {
      if (sep >= 0) {
        syntax.add(begin);
        for (let j = base; j >= 0 && j < sep; j++) syntax.add(j);
        syntax.add(sep);
        syntax.add(i);
      }
      // An end without a separator closes no real block either.
      begin = -1;
    }
  }
  return syntax;
}

export function hasConflictMarkers(body: string): boolean {
  return conflictSyntaxLines(body.split("\n")).size > 0;
}

function stripConflictMarkers(body: string): string {
  const lines = body.split("\n");
  const syntax = conflictSyntaxLines(lines);
  if (syntax.size === 0) return body;
  return lines.filter((_, i) => !syntax.has(i)).join("\n");
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
 * PATH (`resolveParentPageId`), never from a stored field (DESIGN.md §4).
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
 * needs, reading the PARENT FOLDER's `.md` (DESIGN.md §4 path-as-truth):
 *   - `current` -> `deps.readFile(<dir>.md)` (the live working tree),
 *   - `prev`    -> `git.showFileAtRef(deps.baseRef, <dir>.md)` (the pre-image
 *     the push diff was computed from),
 * then read its `gitmost_id` frontmatter and return that page's pageId. A root-level path
 * (no enclosing folder), a missing/unreadable parent file, or a parent file with
 * no parseable pageId all resolve to `null` (parent is ROOT / unknown ->
 * `parentPageId: null`, i.e. at the root).
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
  } catch {
    // Parent folder file missing/unreadable at that side -> treat as ROOT.
    return null;
  }
  if (text === null) return null; // showFileAtRef returns null when absent.
  // The parent page's identity is its `gitmost_id` frontmatter; folder position
  // is irrelevant here, only the pageId.
  return parsePageFile(text).id;
}

/**
 * The parent of a file git created or moved into a folder whose folder note is
 * gone from the working tree: the page that held that folder note when git put
 * the file at `path`. Docmost renamed or moved that folder page meanwhile and
 * the pull moved its note away, so the path alone no longer names it. `null`
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
  } catch {
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
 * `resolveParentPageIdViaTree`'s IO sides: `current` reads the working tree,
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
  } catch {
    return null;
  }
  if (text === null) return null;
  return nativeMeta(text, path, spaceId);
}

/**
 * Pull an `updatedAt` out of a create/update client result, if present. The
 * shape is `{ data: { updatedAt? }, ... }` (createPage) or a flatter object;
 * absent in the simple fakes, so the field is omitted rather than `undefined`.
 */
function extractUpdatedAt(result: unknown): { updatedAt?: string } {
  const r = result as
    | { updatedAt?: unknown; data?: { updatedAt?: unknown } }
    | null
    | undefined;
  const raw = r?.data?.updatedAt ?? r?.updatedAt;
  return typeof raw === "string" ? { updatedAt: raw } : {};
}

// --- runnable push orchestration (`runPush`) ---------------------------------
//
// `runPush` is the FS->Docmost twin of the pull direction: it wires the VaultGit
// diff/ref primitives + the PURE `computePushActions` planner + the THIN
// `applyPushActions` applier into one runnable cycle. It is driven IN-PROCESS by
// the NestJS server (there is no standalone CLI). SAFE BY DEFAULT — a cycle
// defaults to DRY-RUN (plan only, NO Docmost writes, NO ref advance) unless the
// caller passes `opts.dryRun === false`; that apply path is the ONLY one that
// builds a client and mutates Docmost.
//
// Every external effect is injected (`PushDeps`): production wires the live
// Docmost client, git, and fs; tests substitute FAKES through the same seam.

/**
 * The human ("local") git identity used for engine-made commits on `main` in the
 * push direction (DESIGN.md §11). The provenance is carried by the trailer
 * (below); the identity is for history readability only.
 * When the vault repo already has a configured `user.name`/`user.email`, git
 * uses that for the working-tree commit; this is the fallback the engine stamps.
 */
export const LOCAL_AUTHOR_NAME = "Local";
export const LOCAL_AUTHOR_EMAIL = "local@local";

/** The provenance trailer marking a `main`-side (human/local) commit. */
export const LOCAL_SOURCE_TRAILER = "Docmost-Sync-Source: local";

/**
 * Stage EVERYTHING in the working tree (modified, deleted and untracked files)
 * and commit it on the current branch as `local: working-tree changes` with the
 * `local` identity + provenance trailer. Returns `false` when there
 * was nothing to commit. Shared by `runPush` step 3 and the cycle preflight's
 * dirty-`main` recovery so both record pending `main` content identically.
 */
export async function commitLocalWorkingTree(
  git: Pick<VaultGit, "stageAll" | "commit">,
): Promise<boolean> {
  await git.stageAll();
  return git.commit("local: working-tree changes", {
    authorName: LOCAL_AUTHOR_NAME,
    authorEmail: LOCAL_AUTHOR_EMAIL,
    trailers: [LOCAL_SOURCE_TRAILER],
  });
}

/**
 * Commit the push's write-backs on `main` as `local: record created pageIds`
 * (the `local` identity + trailer). Returns `false` when there was nothing to
 * commit. Shared by `runPush` step 7a and `finishPushWrites`.
 */
async function commitWriteBacks(
  git: Pick<VaultGit, "stageAll" | "commit">,
): Promise<boolean> {
  await git.stageAll();
  return git.commit("local: record created pageIds", {
    authorName: LOCAL_AUTHOR_NAME,
    authorEmail: LOCAL_AUTHOR_EMAIL,
    trailers: [LOCAL_SOURCE_TRAILER],
  });
}

/**
 * Finish the writes of a push cut off between its first write on `main` and
 * their commit (PUSH_REF set; `recoverVault`, DESIGN.md §8). Every uncommitted
 * path holding a COMPLETE write-back (`isCompleteWriteBack`) is committed, as
 * step 7a would have; every other one — a write cut off part-way (an empty or
 * truncated file), anything else — is put back to its HEAD state. An
 * interrupted engine write is never committed as content, so an emptied file
 * never clears its page. The caller deletes PUSH_REF afterwards.
 */
export async function finishPushWrites(
  git: Pick<
    VaultGit,
    | "listDirtyPaths"
    | "readWorkingFile"
    | "showFileAtRef"
    | "restorePathFromHead"
    | "stageAll"
    | "commit"
  >,
): Promise<{ kept: string[]; restored: string[] }> {
  const kept: string[] = [];
  const restored: string[] = [];
  for (const path of await git.listDirtyPaths()) {
    const work = await git.readWorkingFile(path);
    const head = await git.showFileAtRef("HEAD", path);
    if (work !== null && head !== null && isCompleteWriteBack(work, head)) {
      kept.push(path);
    } else {
      await git.restorePathFromHead(path);
      restored.push(path);
    }
  }
  if (kept.length > 0) await commitWriteBacks(git);
  return { kept, restored };
}

/**
 * Injectable deps for `runPush` (mirrors `pull.ts`'s wiring; everything that
 * touches the outside world is here so tests pass fakes). `makeClient` is a
 * FACTORY, not a client — a dry-run must build NO client at all (it is never
 * called), and only the apply path (`opts.dryRun === false`) invokes it.
 */
export interface PushDeps {
  settings: Settings;
  git: Pick<
    VaultGit,
    | "assertGitAvailable"
    | "ensureRepo"
    | "isMergeInProgress"
    | "checkout"
    | "stageAll"
    | "commit"
    | "mergeBase"
    | "revParse"
    | "diffNameStatus"
    | "pageIdsAtRef"
    | "showFileAtRef"
    | "updateRef"
    | "fastForwardBranch"
    | "listTrackedFiles"
    | "commitAddingPath"
    | "isAncestor"
    | "treeWithPathsFrom"
    | "commitTree"
    | "deleteRef"
  >;
  /** Build a real client — called ONLY on the apply path, never on dry-run. */
  makeClient: (settings: Settings) => ApplyPushDeps["client"];
  /** Read a file's full text by its vault-relative (forward-slash) path. */
  readFile: (path: string) => Promise<string>;
  /** Write a file's full text by its vault-relative path. */
  writeFile: (path: string, text: string) => Promise<void>;
  /** Structured logger (defaults to console in `main`; a recorder in tests). */
  log: (line: string) => void;
  /** The cycle's AbortSignal, handed to `applyPushActions` (see there). */
  signal?: AbortSignal;
}

/** The structured outcome of a `runPush` cycle (returned + summarized). */
export interface PushRunResult {
  /** Which path ran: `dry-run` (plan only) or `apply` (Docmost mutated). */
  mode: "dry-run" | "apply";
  /** Why the cycle stopped before planning, if it did (e.g. a left-over merge). */
  aborted?: "merge-in-progress";
  /** The diff base the plan was computed against: merge-base(`docmost`, `main`). */
  base?: { sha: string };
  /** The `main` commit the plan targets (the would-be pushed commit). */
  pushedCommit?: string;
  /** Planned action counts from the PURE planner (present once a plan was built). */
  planned?: {
    creates: number;
    updates: number;
    deletes: number;
    renamesMoves: number;
    skipped: number;
  };
  /** The applier's structured result — ONLY present on the apply path. */
  applied?: ApplyPushResult;
  /**
   * True when `applyPushActions` REFUSED to fast-forward a divergent `docmost`
   * mirror (the mirror invariant of DESIGN.md §3 is broken). Logged prominently
   * and surfaced on this result so the caller (the server orchestrator)
   * escalates it.
   */
  divergentDocmost?: boolean;
  /** Per-page failures from the applier (empty/absent on a clean run). */
  failures?: PushFailure[];
}

/**
 * Run one FS->Docmost push cycle (DESIGN.md §7), DRY-RUN BY DEFAULT
 * (the apply path runs only when `opts.dryRun === false`).
 *
 * Steps (mirrors `pull.ts`):
 *   1. Preflight git: `assertGitAvailable` + `ensureRepo`; ABORT (clear message +
 *      an `aborted: "merge-in-progress"` result) if a merge is in progress —
 *      never push on top of an unresolved conflict. Conflict markers must NEVER
 *      reach Docmost.
 *   2. Checkout `main` (the human-facing branch the push reads from).
 *   3. Commit the human's pending working-tree changes on `main` with the
 *      `local` provenance trailer. A no-op when nothing changed.
 *   4. Resolve `main` and the diff BASE: merge-base(`docmost`, `main`), the
 *      newest commit whose content Docmost already holds (throws if none).
 *   5. `diffNameStatus(base, main)` -> changes; build the `metaAt(path, side)`
 *      resolver (current = working tree, prev = `git show <base>:<path>`); run
 *      the PURE `computePushActions`.
 *   6. DRY-RUN (default): LOG the full plan and RETURN — NO client, NO Docmost
 *      calls, NO ref advance.
 *   7. Apply path (`opts.dryRun === false`): build the client, set PUSH_REF
 *      (the push's writes on `main` begin), run
 *      `applyPushActions(..., pushedCommit=main)`, then (a) if any pageIds were
 *      written back (creates), commit them on `main` with the `local` trailer,
 *      fast-forward `docmost` to that commit after a clean push, and drop
 *      PUSH_REF; (b) after a push with failures, record per page what reached
 *      Docmost (`recordPushedPages`); (c) ESCALATE a divergent-`docmost`
 *      refusal with a prominent WARNING and the `divergentDocmost` result flag.
 *      Then log a one-line summary.
 *
 * Refuses (throws) before any Docmost write when the plan would create more
 * than `MAX_GIT_COPY_CREATES` `~git` copy pages (see there). An abort of
 * `deps.signal` stops it with a `CycleAbortedError` (DESIGN.md §9).
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

  // 1b. Refuse to push on top of an unresolved merge. A merge left half-done
  //     could leak conflict markers into Docmost (the cardinal invariant).
  //     Detect it BEFORE any checkout/diff and stop with a clear, actionable
  //     message so re-runs converge once the human resolves (or aborts) the merge.
  if (await git.isMergeInProgress()) {
    log(
      `push: vault has an unresolved merge at ${settings.vaultPath} — resolve ` +
        `it (or 'git merge --abort') and re-run. Nothing was pushed to Docmost ` +
        `(conflict markers must never reach Docmost).`,
    );
    return { mode: dryRun ? "dry-run" : "apply", aborted: "merge-in-progress" };
  }

  // 2. Work on `main` — the human-facing branch the push diffs FROM.
  await git.checkout(DEFAULT_BRANCH);

  // 3. Commit the human's pending working-tree changes on `main` with the `local`
  //    provenance trailer. A no-op commit when nothing changed is
  //    fine (`commit` returns false).
  //    Even on a "plan only" dry-run this commits the working tree (it is the
  //    only way to diff `base..main`) — so make that
  //    LOCAL git mutation VISIBLE, never silent: a created commit is local-only
  //    and nothing is sent to Docmost.
  const committedWorkingTree = await commitLocalWorkingTree(git);
  if (committedWorkingTree) {
    const sha = await git.revParse(DEFAULT_BRANCH);
    log(
      `push: committed local working-tree changes on main` +
        (sha ? ` as ${sha.slice(0, 8)}` : "") +
        ` (local git only — nothing sent to Docmost).`,
    );
  } else {
    log("push: working tree clean (no local changes to push).");
  }

  const pushedCommit = await git.revParse(DEFAULT_BRANCH);
  if (!pushedCommit) {
    // `main` has no commit — `ensureRepo` always makes an initial one, so this is
    // defensive. Nothing to diff.
    log("push: `main` has no commit to push — nothing to do.");
    return { mode: dryRun ? "dry-run" : "apply" };
  }

  // 4. The diff BASE is merge-base(`docmost`, `main`): the newest commit whose
  //    content Docmost already holds. After this cycle's pull merged `docmost`
  //    into `main` it is the `docmost` tip, so the diff carries only what `main`
  //    has and Docmost lacks (human commits, git-won merge resolutions) — never
  //    the pull's own export, which would echo a stale DB body back into the
  //    live document.
  const mergeBase = await git.mergeBase(DOCMOST_BRANCH, DEFAULT_BRANCH);
  if (!mergeBase) {
    throw new Error(
      `push: '${DOCMOST_BRANCH}' and '${DEFAULT_BRANCH}' share no history in ` +
        `${settings.vaultPath} — cannot tell what Docmost already holds, so ` +
        `nothing was pushed.`,
    );
  }
  const base = { sha: mergeBase };

  // 5. Diff the base against `main` and build the `metaAt` resolver (PURE planner
  //    input). `current` reads the live working tree; `prev` reads the base
  //    commit's pre-image via `git show <base>:<path>` (so a DELETE recovers its
  //    pageId).
  const changes = await git.diffNameStatus(base.sha, DEFAULT_BRANCH);
  // Synchronous resolver over PREFETCHED meta tables: `computePushActions` is
  // PURE/sync, but the file/ref reads are async — so we prefetch every (path,
  // side) the diff will ask for into a table first, then resolve from it.
  const metaTable = new Map<string, DocmostMdMeta | null>();
  for (const change of changes) {
    // `current`: A/M/R/C still have the file on `main`. `prev`: D needs the
    // pre-image; R/C also benefit (old title). Prefetch both sides per path.
    const currentPath = change.path;
    const prevPath = change.oldPath ?? change.path;
    if (!metaTable.has(`${currentPath}|current`)) {
      metaTable.set(
        `${currentPath}|current`,
        await readMetaCurrent(deps, currentPath, settings.docmostSpaceId),
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
  let currentPageIds: Set<string> | undefined;
  if (changes.some((c) => c.status === "D")) {
    currentPageIds = new Set<string>();
    for (const relPath of await git.listTrackedFiles("*.md")) {
      const pid = (await readMetaCurrent(deps, relPath, settings.docmostSpaceId))
        ?.pageId;
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
    for (const { path, id } of await git.pageIdsAtRef(DEFAULT_BRANCH)) {
      if (!changedIds.has(id) || !isPageFile(path)) continue;
      pathsById.set(id, [...(pathsById.get(id) ?? []), path]);
    }
    for (const [id, paths] of pathsById) {
      if (paths.length < 2) continue;
      const files: string[] = [];
      for (const path of paths.sort()) {
        const meta = await readMetaCurrent(deps, path, settings.docmostSpaceId);
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

  // 6. DRY-RUN (default): log the full plan and RETURN — build NO client, make
  //    ZERO Docmost calls, advance NO refs. This is the SAFE default.
  logPlan(log, base, pushedCommit, actions, planned, dryRun);
  if (dryRun) {
    return { mode: "dry-run", base, pushedCommit, planned };
  }

  // GROWTH BREAKER (invariants #1/#10). A `~git` file is git's side of a page
  // the pull could not merge, kept as a new page. A burst of them in one cycle
  // is a loop duplicating pages, not editing: fail the space loudly instead.
  const gitCopies = actions.creates.filter((c) => isGitCopyPath(c.path));
  if (gitCopies.length > MAX_GIT_COPY_CREATES) {
    throw new Error(
      `push refused: it would create ${gitCopies.length} '~git' copy pages in ` +
        `one cycle (limit ${MAX_GIT_COPY_CREATES}) — git's side of that many ` +
        `pages could not be merged, which points at pages being duplicated ` +
        `every cycle. Nothing was pushed to Docmost. Delete or merge the '~git' ` +
        `files on main (${gitCopies
          .slice(0, 3)
          .map((c) => c.path)
          .join(", ")}${gitCopies.length > 3 ? ", …" : ""}).`,
    );
  }

  // 7. Apply path: build the REAL client and execute. This is the ONLY write path.
  const client = deps.makeClient(settings);
  // From here until the write-backs are committed (7a), whatever is left
  // uncommitted on `main` is the push's own writing: PUSH_REF tells recovery.
  await git.updateRef(PUSH_REF, DEFAULT_BRANCH);
  const applied = await applyPushActions(
    {
      client,
      // Pass the WHOLE `git` object (it satisfies the applier's
      // `Pick<VaultGit, ...>` deps surface). Passing bare method references
      // (`git.updateRef`, …) would lose their `this` binding, so on a REAL
      // `VaultGit` they would throw `this.runRaw is not a function`. Hand over
      // the object so the methods keep their receiver — exactly as `pull.ts`
      // does for `applyPullActions`.
      git,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      spaceId: settings.docmostSpaceId,
      baseRef: base.sha,
      // Per-space PUSH policy for still-conflicted bodies. Default OFF:
      // a conflicted page is skipped (recorded as a failure) instead of pushed.
      autoMergeConflicts: settings.autoMergeConflicts ?? false,
      signal: deps.signal,
    },
    actions,
    pushedCommit,
  );

  // 7a. Persist freshly-assigned pageIds (creates) back into git. `applyPushActions`
  //     rewrote those files on disk; commit them on `main` with the `local` trailer
  //     so the new pageIds are recorded, then fast-forward `docmost` to the new
  //     commit after a clean push (the write-back commit is part of `main` now,
  //     and Docmost holds it). The push's writes are then committed: PUSH_REF goes.
  // Track a divergent-`docmost` mirror across BOTH ff sites (the applier's main
  // push ff in 7b, and the write-back ff here). A divergent mirror is the same
  // invariant breach in EITHER branch and must escalate identically.
  throwIfAborted(deps.signal, "before committing the push's write-backs");
  let divergentDocmost = false;
  if (applied.writtenBack.length > 0) {
    const recorded = await commitWriteBacks(git);
    if (recorded) {
      const newCommit = await git.revParse(DEFAULT_BRANCH);
      // Only advance when the original push was CLEAN (the applier advanced
      // `docmost` to the pushed commit); a partial push is recorded per page in
      // 7b, after this commit.
      if (newCommit && applied.clean) {
        const ff = await git.fastForwardBranch(DOCMOST_BRANCH, newCommit);
        if (!ff.ok) {
          // SYMMETRIC with the main escalation (7c): a divergent mirror in the
          // write-back branch is the SAME invariant breach and must escalate,
          // not just log a soft warning.
          divergentDocmost = true;
          log(
            `push: WARNING — the 'docmost' mirror branch DIVERGED and was NOT ` +
              `fast-forwarded to the pageId write-back commit ` +
              `(${ff.reason ?? "not-fast-forward"}). The mirror invariant ` +
              `('docmost' mirrors what Docmost contains) is broken: reconcile ` +
              `'docmost' against the live Docmost tree before the next cycle.`,
          );
        }
      }
    }
  }
  await git.deleteRef(PUSH_REF);

  // 7b. A push with failures: advance the base over every page that reached
  //     Docmost, so only the failed pages stay in the next push's diff.
  throwIfAborted(deps.signal, "before recording the pushed pages");
  const pageRecord =
    applied.failures.length > 0
      ? await recordPushedPages(git, applied.failures)
      : null;
  if (pageRecord?.ok) {
    log(
      `push: ${applied.failures.length} failure(s) — recorded what reached ` +
        `Docmost on '${DOCMOST_BRANCH}'; the failed page(s) are retried next cycle.`,
    );
  }

  // 7c. ESCALATE a divergent-`docmost` refusal (the mirror invariant is broken).
  //     The applier and the record refuse to clobber a divergent mirror; make
  //     it LOUD (not silent) so the operator notices, and fold it into the result.
  const refused =
    applied.docmostFastForward && !applied.docmostFastForward.ok
      ? applied.docmostFastForward
      : pageRecord && !pageRecord.ok
        ? pageRecord
        : null;
  if (refused) {
    divergentDocmost = true;
    log(
      `push: WARNING — the 'docmost' mirror branch DIVERGED and was NOT ` +
        `advanced (${refused.reason ?? "not-fast-forward"}). ` +
        `The mirror invariant ('docmost' mirrors what Docmost contains) is ` +
        `broken: reconcile 'docmost' against the live Docmost tree before the ` +
        `next cycle.`,
    );
  }

  // 7d. One-line summary (mirrors pull.ts's summary line).
  log(
    `push complete: ${applied.created} created, ${applied.updated} updated, ` +
      `${applied.deleted} deleted, ${applied.moved} moved, ${applied.renamed} ` +
      `renamed, ${applied.noops.length} no-op(s), ${applied.skipped.length} ` +
      `skipped, ${applied.failures.length} failure(s)` +
      (divergentDocmost ? " [DIVERGENT docmost mirror]" : ""),
  );

  return {
    mode: "apply",
    base,
    pushedCommit,
    planned,
    applied,
    divergentDocmost,
    failures: applied.failures,
  };
}

/**
 * The most `~git` copy pages (`isGitCopyPath`) one push may create. More means
 * the pull kept git's side of that many pages as new files in one cycle — a
 * duplication loop, not an edit — so `runPush` refuses the whole push instead.
 */
export const MAX_GIT_COPY_CREATES = 20;

/** The git surface of `recordPushedPages` / `finishPushRecord`. */
type RecordGit = Pick<
  VaultGit,
  | "revParse"
  | "isAncestor"
  | "treeWithPathsFrom"
  | "commitTree"
  | "updateRef"
  | "fastForwardBranch"
  | "deleteRef"
>;

/**
 * After a push with per-page `failures`, advance the base over every page that
 * DID reach Docmost: commit on `docmost` (a child of its tip) the tree of `main`
 * with only the failed operations' paths kept at their `docmost` version, then
 * merge that record into `main` keeping `main`'s tree (`-s ours`). The merge
 * base then covers every pushed page, and the failed ones stay in the next
 * push's diff, retried on their own. `RECORD_REF` names the record until `main`
 * has it, so a crash in between is finished by `recoverVault`.
 *
 * Returns null when nothing reached Docmost (no record, no new commits), else
 * the `docmost` advance result — refused, like the clean push's fast-forward,
 * when `docmost` is not an ancestor of `main`.
 */
async function recordPushedPages(
  git: RecordGit,
  failures: PushFailure[],
): Promise<{ ok: boolean; reason?: string } | null> {
  const tip = await git.revParse(DOCMOST_BRANCH);
  const main = await git.revParse(DEFAULT_BRANCH);
  if (tip === null || main === null) {
    return { ok: false, reason: `'${DOCMOST_BRANCH}' or '${DEFAULT_BRANCH}' is missing` };
  }
  if (!(await git.isAncestor(tip, main))) {
    return { ok: false, reason: "not-fast-forward" };
  }
  const failedPaths = failures.flatMap((f) =>
    f.oldPath !== undefined ? [f.path, f.oldPath] : [f.path],
  );
  const tree = await git.treeWithPathsFrom(main, tip, failedPaths);
  if (tree === (await git.revParse(`${tip}^{tree}`))) return null;
  const record = await git.commitTree(
    tree,
    [tip],
    `docmost: record pushed pages (${failures.length} failed, kept back)`,
    {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
      trailers: [DOCMOST_SOURCE_TRAILER],
    },
  );
  await git.updateRef(RECORD_REF, record);
  return finishPushRecord(git, record);
}

/**
 * Finish a per-page record (`recordPushedPages`): move `docmost` to it, merge
 * it into `main` with `main`'s own tree (no working-tree change), then drop
 * `RECORD_REF`. Every step is skipped when already done, so `recoverVault`
 * re-runs it after a crash. `HEAD` must not be on `docmost`.
 */
export async function finishPushRecord(
  git: RecordGit,
  record: string,
): Promise<{ ok: boolean; reason?: string }> {
  const ff = await git.fastForwardBranch(DOCMOST_BRANCH, record);
  if (ff.ok) {
    const main = await git.revParse(DEFAULT_BRANCH);
    if (main !== null && !(await git.isAncestor(record, main))) {
      const merged = await git.commitTree(
        `${main}^{tree}`,
        [main, record],
        `Merge the pushed pages record into ${DEFAULT_BRANCH}`,
        {
          authorName: BOT_AUTHOR_NAME,
          authorEmail: BOT_AUTHOR_EMAIL,
          trailers: [DOCMOST_SOURCE_TRAILER],
        },
      );
      await git.updateRef(`refs/heads/${DEFAULT_BRANCH}`, merged, main);
    }
  }
  await git.deleteRef(RECORD_REF);
  return ff;
}

/** Synthetic native meta from the live working tree (`current` side). */
async function readMetaCurrent(
  deps: Pick<PushDeps, "readFile">,
  path: string,
  spaceId: string,
): Promise<DocmostMdMeta | null> {
  let text: string;
  try {
    text = await deps.readFile(path);
  } catch {
    return null; // absent on disk (e.g. a D row's path) -> no current meta.
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
  } catch {
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
      `merge-base(docmost, main) ${base.sha.slice(0, 8)} ` +
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
