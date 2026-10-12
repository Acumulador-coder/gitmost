# git-sync engine — design

The engine keeps one Docmost space and one git repository (the *vault*) in
sync, in both directions. This document is the reference the source comments
point to (`DESIGN.md §N`). It describes what the code does today; the code is
the authority when the two disagree, and such a disagreement is a bug in this
file.

## 1. Scope

- `src/engine/` — the engine: the cycle (`cycle.ts`), the pull (`pull.ts`), the
  push (`push.ts`), the git wrapper (`git.ts`), the vault's branches and refs
  (`vault-refs.ts`), the converter worker pool (`convert-pool.ts`), the layout
  and naming (`layout.ts`, `sanitize.ts`, `reconcile.ts`), cancellation
  (`abort.ts`) and the symlink guard (`path-guard.ts`).
- The markdown <-> ProseMirror converter is `@docmost/prosemirror-markdown`;
  the engine only calls it, on worker threads (§9).
- The server (`apps/server/src/integrations/git-sync/`) owns everything around
  the engine: the per-space lock, the cycle schedule and deadline, the Docmost
  client (`GitSyncClient`), the smart-HTTP host and the receive-pack.

## 2. The cycle

`runCycle` is the one entry point. It runs under the server's per-space lock,
with an AbortSignal (§9), in this order:

1. **Recover** (`recoverVault`, §8): repair whatever an interrupted cycle or git
   process left.
2. **Pull — export** (§5): set `PULL_REF`, check out `docmost`, write every
   changed live page as a file, apply moves and absence deletions, commit on
   `docmost`.
3. **Pull — merge** (§6): check out `main`, align `main`'s paths to Docmost's
   layout by page identity (§4), merge `docmost` into `main`, resolve every
   conflict without markers, commit; delete `PULL_REF`.
4. **Push** (§7): commit whatever is uncommitted on `main` as local work, diff
   `main` against merge-base(`docmost`, `main`), apply the diff to Docmost,
   write the ids of created pages back into their files and commit them, then
   advance `docmost` over everything that reached Docmost.
5. **Finish**: record the export keys of the pages exported this cycle (only
   after the whole cycle succeeded), and put `HEAD` back on `main`.

An external push (a person's `git push`) runs as: recover, receive-pack into
`main` (`receive.denyCurrentBranch=updateInstead`) under `RECEIVE_REF`, kept
when it leaves `main` dirty (§8), then a cycle — all under the same lock.

## 3. Branches and refs

Every name is declared once, in `vault-refs.ts`; the stale-lock sweep and the
pre-receive hook's refusal pattern are derived from it.

| Ref | Owner (who writes it) | Meaning |
| --- | --- | --- |
| `main` | People (pushes); the engine's pull merge, alignment, local-work, write-back and record-merge commits | The human-facing branch: what a clone checks out and a push writes. |
| `docmost` | The engine only: the pull's export commit, the fast-forward after a clean push, the per-page record of a push with failures | A mirror of what Docmost holds. A push to it is refused by the hook. |
| `refs/docmost/pulling` (`PULL_REF`) | The pull | Set from before the pull checks out `docmost` until it has committed on `main`. |
| `refs/docmost/pushing` (`PUSH_REF`) | The push | Set from before the push's first write on `main` until those writes are committed. |
| `refs/docmost/recording` (`RECORD_REF`) | The push | Names a per-page record until `main` has merged it. |
| `refs/docmost/receiving` (`RECEIVE_REF`) | The server (`ingestExternalPush`) | Set from before an external push's receive-pack until it returned with `main` clean; kept when it was cut off (a dirty `main`, a rejection, a crash). |

**The mirror invariant**: `docmost` holds exactly what Docmost holds, as of its
tip. Hence merge-base(`docmost`, `main`) is the newest commit whose content
Docmost already has — it is both the push's diff base and the pull's merge
base. No other ref records a sync point. A `docmost` that is not an ancestor of
`main` when the push wants to move it is a broken invariant: the move is
refused, logged as a WARNING and returned as `divergentDocmost`.

A finished cycle leaves no service ref. An interrupted one may leave
`PULL_REF`, `PUSH_REF`, `RECORD_REF` or (a cut-off receive-pack) `RECEIVE_REF`
until the next recovery (§8). `refs/docmost/last-pushed`, which older
builds wrote on every push and nothing read, is retired: recovery deletes it.

## 4. Page identity

- A page file is `<title>.md` with a minimal frontmatter holding only
  `gitmost_id` (the page id). The id is the page's identity; the path is its
  position: the title comes from the file name, the parent from the enclosing
  folder's folder-note (`<dir>.md`), the space from the vault.
- Docmost's layout (`buildVaultLayout`): a page with children is
  `<path>/<Title>.md` with its children under `<path>/<Title>/`; titles are
  sanitized into file names, and siblings that collide get a ` ~<slugId>`
  suffix.
- **The merge identity rule.** Before the path-based merge of `docmost` into
  `main`, the pull builds the id -> path maps of the merge base, `docmost` and
  `main`, and moves on `main`:
  - the file of every page Docmost moved since the merge base, where `main`
    still has it at the merge-base path;
  - the file of every page **both sides added since the merge base** (an id in
    `docmost` and `main` but not in the base) to its Docmost path.

  Then each path holds the same page on both sides. At a conflicted path:
  - the same id with a merge-base version: one page, merged per hunk (§6);
  - the same id with **no** merge-base version: one page, the **Docmost side**
    is kept, no copy;
  - a git file without an id meeting a page new since the merge base that is
    git-sync's own unfinished create of it (`isOwnUnfinishedCreate`): one page,
    git's content under that page's id;
  - anything else (two pages, an add/add): the Docmost side stays at the path,
    git's version becomes `<name> ~git.md` without an id, a new page.
- Pages git moved keep git's path (`relocateGitMovedPages`).
- On the push, two files carrying one id (a copy) are one page — the file at
  the id's merge-base path, else the one git paired with it as a rename — and
  copies become new pages.
- **Retry-adopt.** A file without an id is created as a page, unless a page at
  the same (parent, title) — unique there — is provably git-sync's own create
  of it that was cut off before the id reached the file: its last write was
  git-sync's (`lastUpdatedSource = 'git-sync'`) and it is still empty or holds
  this file's body (`isOwnUnfinishedCreate`, shared by the pull and the push).
  Any other page with that title is never written over.

## 5. Pull (Docmost -> vault)

- Lists the live tree, plans writes (pages whose export key changed), moves
  and absence deletions (`computePullActions`).
- Absence deletions are suppressed on an incomplete tree fetch, on an empty
  live tree and behind the mass-delete guard (more than `MASS_DELETE_FRACTION`
  of at least `MASS_DELETE_MIN_EXISTING` tracked files); a tracked id that was
  never a page (a hand-written id) is never absence-deleted.
- A move removes the old path only after the new path's write succeeded.
- Each page is written in its normalize-on-write fixpoint (§11). One bad page is
  a per-page failure, never the whole pull.

## 6. Merge (`docmost` -> `main`)

- Path-based (`-s resolve`, no rename detection), after the alignment of §4.
- A conflict never leaves markers on `main` and never wedges the space:
  - spurious (only trailing whitespace differs): the normalized text;
  - one page changed on both sides: per hunk, git wins only the hunks both
    sides changed;
  - the identity cases of §4;
  - modify/delete: the remaining content.
- The resolved merge is committed as one commit with the engine's provenance.

## 7. Push (vault -> Docmost)

- Diff base: merge-base(`docmost`, `main`) (§3), so the diff carries only what
  `main` has and Docmost lacks — never the pull's own export.
- Rows become Docmost operations by page id: `A` create, `M` update, `D`
  soft-delete (Trash), `R` rename and/or move (the parent from the path).
  An update is a 3-way merge in the collaboration layer, its base the page's
  file at the diff base.
- Conflict markers never reach Docmost: with `autoMergeConflicts` off a
  conflicted page is a per-page failure; on, the marker lines are stripped, both
  sides are pushed and the clean body is written back to the file.
- More than `MAX_GIT_COPY_CREATES` `~git` creates in one push refuses the push.
- Write-backs (an assigned id; a cleaned conflicted body) are written on `main`
  under `PUSH_REF` and committed as `local: record created pageIds`.
- A clean push fast-forwards `docmost` to the pushed commit and then to the
  write-back commit. A push with per-page failures instead commits on
  `docmost` a **record** — `main`'s tree with the failed operations' paths kept
  at their `docmost` version — and merges it into `main` with `main`'s tree
  (`RECORD_REF` names it until then); only the failed pages stay in the next
  diff.

## 8. Recovery

`recoverVault` runs before every cycle and before every receive-pack, and is
idempotent (a recovery cut off is redone by the next one):

1. git missing -> error; no repo or no `main` -> created.
2. git lock files older than 3 x the git timeout -> removed (a fresh lock may
   belong to a live process and is kept).
3. a half-done merge -> `merge --abort`, else `reset --hard HEAD`.
4. a dirty working tree:
   - on `main` with `RECEIVE_REF`: discarded — a receive-pack cut off before
     it moved `main`; the client never saw the push accepted and pushes again;
   - on `main` with `PULL_REF`: discarded — the pull redoes it;
   - on `main` with `PUSH_REF`: every complete write-back is committed, every
     other path (a write cut off part-way: an empty or truncated file) is put
     back to `HEAD` (`finishPushWrites`) — an interrupted engine write is never
     taken for content;
   - on `main` otherwise: committed as `local: working-tree changes`;
   - on `docmost`: discarded — the pull regenerates it.
5. `PULL_REF`, `PUSH_REF`, `RECEIVE_REF` and retired refs are deleted.
6. `RECORD_REF` -> the record is finished (`finishPushRecord`).

What a cut-off cycle leaves, by phase, and how the next cycle converges:

| Cut off in | Left behind | Converges because |
| --- | --- | --- |
| recovery | part of a repair | every step is idempotent |
| pull export | dirty `docmost`, `PULL_REF` | discarded; the export is redone |
| pull merge / alignment | dirty `main` and/or an alignment commit, `PULL_REF` | uncommitted work discarded; a committed alignment leaves pages at Docmost's paths, which the next alignment and merge accept |
| push, before a Docmost write | nothing | the diff is unchanged |
| push, between Docmost writes | some pages written; `docmost` not moved | re-sent: updates are 3-way and idempotent; a create whose id never reached `main` is taken over (§4) |
| push write-backs | dirty `main`, `PUSH_REF` | complete write-backs committed, cut ones restored |
| after the write-back commit, before `docmost` moved | ids on `main` that `docmost` lacks | the same id on both sides with no base is one page (§4) |
| per-page record | `RECORD_REF` | the record is finished |
| external push's receive-pack, before `main` moved (killed — its whole process group, waited for — or the process died) | dirty `main` (a possibly partial checkout), `RECEIVE_REF` | discarded; the push was never accepted, so the client pushes again |

The interruption matrix (`test/cycle-interruption-matrix.test.ts`) cuts each
scenario's cycle before its effects and checks the end state matches the uncut
run. The default run samples a few cuts per scenario;
`GIT_SYNC_INTERRUPTION_SWEEP=full` cuts before every effect (run on demand, it
takes minutes).

## 9. Cancellation and deadlines

- The server aborts the cycle's AbortSignal when the space lock cannot be
  confirmed or the cycle's deadline passes. The engine checks it before the
  pull and the push apply, before each page operation of both, before the
  pull's commit and merge and before the push's write-back commit and record,
  and hands it to every conversion. An abort ends the cycle with a
  `CycleAbortedError` naming where it stopped and why; whatever it left is a
  state of §8.
- Conversions run on the converter worker pool: each call has a wall-clock
  deadline (`CONVERT_DEADLINE_MS`); a call aborted or past its deadline is
  dropped from the queue or its worker is terminated.
- Every git command has a timeout (`GIT_EXEC_TIMEOUT_MS`); a git process killed
  by it (or any signal) is an error naming that, never read as an exit status.

## 10. Size budgets

| What | Budget | Enforced by |
| --- | --- | --- |
| What one push adds or changes, per ref (a new ref: against `main`) | `PUSH_BUDGET`: 10,000 files, 2 MiB per `.md` file (`MAX_MARKDOWN_BYTES`), 16 MiB per other file, 256 MiB in all | the pre-receive hook |
| One git command's output | 64 MiB (`GIT_OUTPUT_MAX_BYTES`) | `runRaw`, an error past it |
| One markdown -> ProseMirror conversion | 2 MiB of markdown (`MAX_MARKDOWN_BYTES`) | the converter pool, before any work |
| One page export | 10 MiB of ProseMirror JSON (`MAX_DOC_JSON_BYTES`) | the converter pool, before any work |
| Converter threads | at most 2 | the pool |
| Concurrent page exports | 6 | the pull |
| `~git` creates per push | 20 (`MAX_GIT_COPY_CREATES`) | the push |
| Named push failures per cycle log | 20 | the cycle |
| Export keys | one per live page | rebuilt each successful cycle |
| A file name | 120 characters of sanitized title | `sanitizeTitle` |

## 11. Provenance and the loop guard

- Engine commits carry a trailer: `Docmost-Sync-Source: docmost` (the bot
  identity) for pull and record commits, `Docmost-Sync-Source: local` for
  commits of `main`-side work.
- Docmost writes made by the engine are stamped `lastUpdatedSource = 'git-sync'`
  by the server.
- Normalize-on-write: a page is written as the fixpoint of one export -> import
  -> export pass, so re-exporting an unchanged page yields identical bytes and
  git sees no change.
- The push diffs from merge-base(`docmost`, `main`), so the pull's own export
  is never sent back; a pushed page carries a body hash and `updatedAt` record.

## 12. The git wrapper and the served repository

- Every git command goes through `runRaw`: `cwd` is the vault, `GIT_DIR` /
  `GIT_WORK_TREE` are stripped, paths are printed verbatim
  (`core.quotepath=false`), output and time are bounded (§9, §10).
- The vault's local config pins what would change git's behaviour on it:
  `core.autocrlf=false`, `core.safecrlf=false`, `commit.gpgsign=false`,
  `core.attributesFile=/dev/null`, `merge.conflictStyle=merge`, and
  `.git/info/attributes` resets every attribute a pushed `.gitattributes` could
  set.
- Serving it (`ensureServableConfig`): `receive.denyCurrentBranch=updateInstead`,
  `receive.denyNonFastForwards=true`, `http.receivepack` / `http.uploadpack`,
  `core.symlinks=false`, and `core.hooksPath` pinned to the vault's own hooks
  directory so a host-wide `core.hooksPath` cannot switch the guard off.
- The pre-receive hook refuses a push to `docmost` or `refs/docmost/*`, a push
  to `main` whose old value is not its current tip, and a push over the budget.
- Every engine file access is screened by the symlink guard (`path-guard.ts`).
