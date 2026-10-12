/**
 * Thin async wrapper over the system `git` binary (DESIGN.md §12).
 *
 * IMPORTANT — VAULT-SCOPED: every operation here runs with `cwd = vaultPath`,
 * which is the vault's OWN git repository (default `data/vault`), SEPARATE from
 * the gitmost application repo. This module MUST NEVER run git against the
 * application repo. `data/` is gitignored, so a nested repo under `data/vault`
 * is safe. The pull cycle is READ-ONLY toward Docmost; this module only touches
 * the local vault git, never a git remote.
 *
 * Implementation notes:
 *   - We shell out via `node:child_process` `execFile` (promisified), passing
 *     ARGS AS AN ARRAY — no shell, so there is no command injection surface even
 *     if a page title / branch name contains shell metacharacters.
 *   - EVERY git invocation funnels through the single `runRaw` primitive, which
 *     ALWAYS prepends `--no-pager -c core.quotepath=false` to the argv (so git
 *     never blocks on a pager and always prints verbatim UTF-8 paths). There is
 *     no exception — even the `git --version` preflight goes through `runRaw`.
 *   - "nothing to commit" is treated as a graceful no-op, not an error.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parsePageFile } from "@docmost/prosemirror-markdown";
import { MAX_MARKDOWN_BYTES } from "./convert-pool.js";
import {
  DOCMOST_BRANCH,
  ENGINE_BRANCHES,
  MAIN_BRANCH,
  RETIRED_REFS,
  SERVICE_REF_PREFIX,
  SERVICE_REFS,
} from "./vault-refs.js";

const execFileAsync = promisify(execFile);

// Safety net: kill a hung git subprocess. This engine performs only LOCAL git
// operations (no network pushes), so a legitimate call never approaches this
// bound; it only prevents an indefinitely-stuck subprocess from wedging a sync
// cycle (the same risk the http-backend watchdog guards on the server side).
const GIT_EXEC_TIMEOUT_MS = 120_000;

// A live git op holds a lock for at most GIT_EXEC_TIMEOUT_MS (then it is killed),
// so a lock whose mtime is older than a few multiples of that cannot have a live
// holder — it is a genuine crash-leftover, safe to remove. A fresh lock from a
// concurrently-running replica (mtime within the timeout) is preserved so we never
// delete a lock a live git process still holds.
const STALE_LOCK_MIN_AGE_MS = GIT_EXEC_TIMEOUT_MS * 3; // 6 min, >> max git-op duration

// The most stdout one git invocation may print (`maxBuffer`). Past it Node kills
// git, and the output is unusable: `runRaw` throws instead of returning it.
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * What one push to the vault may bring, checked by the pre-receive hook
 * (PUSH_GUARD_HOOK) before receive-pack touches anything. For each pushed ref
 * it counts only the files the ref's new tree ADDS OR CHANGES against the ref's
 * old tip (a new ref: against the current `main`, or its whole tree when there
 * is no `main`). What the vault already holds — the pull's export of a space,
 * which has no page-count limit — is not counted, so a space of any size still
 * takes a one-line edit. Over budget the push is refused with the reason, so
 * the engine never takes in a change it cannot process:
 *   - `files`: the files one push adds or changes, each a page operation of the
 *     cycle that ingests it;
 *   - `fileBytes`: a file is read whole (`git show`, a 3-way `merge-file` of
 *     three versions), so three of them must fit GIT_OUTPUT_MAX_BYTES;
 *   - `markdownFileBytes`: a `*.md` file is converted whole, so it is held to
 *     the converter's input budget (MAX_MARKDOWN_BYTES): a bigger page would
 *     pass the push and then fail its conversion on every cycle;
 *   - `totalBytes`: bounds what one push brings to disk and to the cycle that
 *     ingests it (the server also cuts a push's request body at it).
 */
export const PUSH_BUDGET = {
  files: 10_000,
  fileBytes: 16 * 1024 * 1024,
  markdownFileBytes: MAX_MARKDOWN_BYTES,
  totalBytes: 256 * 1024 * 1024,
} as const;

/** Bot identity used for engine-authored vault commits (DESIGN.md §11). */
export const BOT_AUTHOR_NAME = "Docmost Sync";
export const BOT_AUTHOR_EMAIL = "docmost-sync@local";

/**
 * The provenance trailer of the bot's commits — the pull's and the push's
 * records of what Docmost holds (DESIGN.md §11); `main`-side work carries
 * `LOCAL_SOURCE_TRAILER` (./push.ts) instead.
 */
export const DOCMOST_SOURCE_TRAILER = "Docmost-Sync-Source: docmost";

/** Default branch the vault repo is initialized on. */
export const DEFAULT_BRANCH = MAIN_BRANCH;

/**
 * The vault's `pre-receive` hook. `receive.denyCurrentBranch=updateInstead`
 * checks a pushed commit out into the working tree BEFORE it compare-and-swaps
 * `main` against the old value the client read from the ref advertisement, and
 * that advertisement is served without the space lock. When a cycle moves
 * `main` in between, the ref update fails but the working tree already holds the
 * pushed commit; the next cycle's dirty-tree recovery then commits it as local
 * work, reverting what had moved `main` (Docmost edits) and landing the rejected
 * push anyway. The hook runs before that checkout and refuses such a push; the
 * receive-pack runs under the space lock, so nothing moves `main` between the
 * hook and the ref update.
 *
 * It also refuses any push to the engine's own refs (the `docmost` mirror and
 * every service ref, ./vault-refs.ts): an edit pushed there never reaches
 * Docmost and is merged into `main` as if Docmost had made it; and a push that
 * brings more than the `budget` (PUSH_BUDGET) — counted over the files each ref
 * update adds or changes, not over the whole tree — naming what is over.
 */
export function buildPushGuardHook(budget: {
  files: number;
  fileBytes: number;
  markdownFileBytes: number;
  totalBytes: number;
}): string {
  return `#!/bin/sh
# Installed by git-sync: refuse a push to the engine's own refs, a push to
# ${DEFAULT_BRANCH} whose old value is not its current tip, and a push that brings
# more than the size budget, before receive-pack touches the working tree.
tip=$(git rev-parse --verify --quiet refs/heads/${DEFAULT_BRANCH})
tab=$(printf '\\t')
# Print "<id> <limit> <kind> <path>" for one file: a *.md file (also as git
# quotes an unusual path: "....md") is converted whole, so it is held to the
# converter's input budget; any other file to the per-file budget.
limited() {
  case "$2" in
    *.md|*'.md"') printf '%s %s md %s\\n' "$1" ${budget.markdownFileBytes} "$2" ;;
    *) printf '%s %s file %s\\n' "$1" ${budget.fileBytes} "$2" ;;
  esac
}
# The files a ref update brings: those its tree adds or changes against $base,
# or every file of its tree when $base is empty.
brought() {
  if [ -n "$base" ]; then
    # ":<old mode> <new mode> <old id> <new id> <status>" TAB "<path>"
    git -c core.quotepath=false diff-tree -r --no-renames --diff-filter=AMT "$base" "$new" |
      while IFS="$tab" read -r meta path; do
        set -- $meta
        limited "$4" "$path"
      done
  else
    # "<mode> <type> <id>" TAB "<path>"
    git -c core.quotepath=false ls-tree -r "$new" |
      while IFS="$tab" read -r meta path; do
        set -- $meta
        limited "$3" "$path"
      done
  fi
}
while read -r old new ref; do
  case "$ref" in
    refs/heads/${DOCMOST_BRANCH}|${SERVICE_REF_PREFIX}*)
      echo "'$ref' is managed by git-sync and cannot be pushed." >&2
      exit 1 ;;
  esac
  if [ "$ref" = refs/heads/${DEFAULT_BRANCH} ] && [ "$old" != "$tip" ]; then
    echo "'${DEFAULT_BRANCH}' changed on the server since your last fetch: pull, then push again." >&2
    exit 1
  fi
  # A deletion (an all-zero new id) brings nothing.
  case "$new" in *[!0]*) ;; *) continue ;; esac
  # Measured against the ref's old tip; a new ref (an all-zero old id) against
  # ${DEFAULT_BRANCH}, or as its whole tree when there is no ${DEFAULT_BRANCH}.
  base=$old
  case "$old" in *[!0]*) ;; *) base=$tip ;; esac
  over=$(brought | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' | {
    files=0
    total=0
    while read -r type size limit kind path; do
      # A submodule entry names a commit, not a file of this repo.
      [ "$type" = blob ] || continue
      if [ "$size" -gt "$limit" ]; then
        if [ "$kind" = md ]; then
          echo "'$path' is $size bytes (limit $limit per .md file)"
        else
          echo "'$path' is $size bytes (limit $limit per file)"
        fi
        exit 0
      fi
      files=$((files + 1))
      total=$((total + size))
      if [ "$files" -gt ${budget.files} ]; then
        echo "$ref would add or change more than ${budget.files} files (the limit per push)"
        exit 0
      fi
      if [ "$total" -gt ${budget.totalBytes} ]; then
        echo "$ref would add or change more than ${budget.totalBytes} bytes of files (the limit per push)"
        exit 0
      fi
    done
  })
  if [ -n "$over" ]; then
    echo "git-sync refused the push: $over." >&2
    exit 1
  fi
done
exit 0
`;
}

/** The pre-receive hook `installPushGuard` installs (see `buildPushGuardHook`). */
export const PUSH_GUARD_HOOK = buildPushGuardHook(PUSH_BUDGET);

/**
 * The vault's `info/attributes`, the highest-precedence attributes file: every
 * attribute that changes how git stores, checks out, diffs, greps or merges a
 * file is reset to unspecified for every path, so a `.gitattributes` pushed
 * into the vault cannot change what the engine's merges and checkouts (and the
 * smart-HTTP host's) do — e.g. `merge=union` silently merging a page's two
 * sides into one, `conflict-marker-size` hiding conflicts from the push's
 * marker scan, `-diff` hiding page ids from `git grep`, `eol`/`filter`/
 * `working-tree-encoding` rewriting page bytes.
 */
const VAULT_INFO_ATTRIBUTES =
  "# Written by git-sync: .gitattributes files in the vault have no effect.\n" +
  "* !text !eol !crlf !filter !diff !merge !ident !working-tree-encoding " +
  "!conflict-marker-size !whitespace\n";

/**
 * The LOCAL config a `git http-backend` push into the vault needs
 * (`ensureServableConfig`):
 *
 *   - receive.denyCurrentBranch=updateInstead — a push to the checked-out
 *     `main` updates the working tree too (the engine's human-facing branch).
 *     Requires a clean tree, which is guaranteed between cycles / under the
 *     orchestrator lock that wraps an external push.
 *   - receive.denyNonFastForwards=true — block force-push so a client cannot
 *     rewrite the engine's history on `main`.
 *   - http.receivepack=true / http.uploadpack=true — explicitly allow the
 *     receive/upload services over HTTP.
 *   - core.symlinks=false — SECURITY (PR #119 review). A writer could push a
 *     `.md` entry that is a SYMLINK (e.g. `leak.md -> /etc/passwd` or
 *     `-> .env`); with symlinks enabled `updateInstead` would materialize a
 *     real link in the working tree, and the next push cycle would follow it
 *     and PUBLISH the target's contents as a Docmost page (server-file
 *     disclosure), or use a symlinked directory to write OUTSIDE the vault on
 *     pull. With `core.symlinks=false` git checks out such a blob as a PLAIN
 *     FILE containing the link text, never a real link, defusing the primitive
 *     at the git layer. (The engine's per-access lstat/realpath guard is the
 *     second layer — see path-guard.ts.)
 *
 * `ensureServableConfig` also pins `core.hooksPath` to the vault's own hooks
 * directory (its value depends on the vault path, so it is not listed here).
 */
const SERVABLE_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["receive.denyCurrentBranch", "updateInstead"],
  ["receive.denyNonFastForwards", "true"],
  ["http.receivepack", "true"],
  ["http.uploadpack", "true"],
  ["core.symlinks", "false"],
];

/**
 * One row of `git diff --name-status` (the push's diff, DESIGN.md §7). `status` is the
 * single-letter change code (`-M` rename detection on), `path` is the (new) file
 * path; for a rename/copy (`R`/`C`) `oldPath` is the source and `path` is the
 * destination, with `score` carrying git's similarity index (0–100).
 */
export interface DiffEntry {
  status: "A" | "M" | "D" | "R" | "C";
  /** New (destination) path. For A/M/D it is the only path. */
  path: string;
  /** Source path — present only for R/C. */
  oldPath?: string;
  /** Rename/copy similarity score (0–100) — present only for R/C. */
  score?: number;
}

/** Result of a `merge`: whether it succeeded cleanly or left conflict markers. */
export interface MergeResult {
  /** True when the merge applied cleanly (fast-forward or clean 3-way). */
  ok: boolean;
  /** True when the merge stopped on conflicts (markers left in the worktree). */
  conflict: boolean;
  /** Raw combined stdout+stderr, for logging/diagnostics. */
  output: string;
}

/** Options for an engine-authored commit (provenance, DESIGN.md §11). */
export interface CommitOptions {
  authorName: string;
  authorEmail: string;
  /**
   * Trailer lines appended to the commit message body (e.g.
   * `Docmost-Sync-Source: docmost`): machine-readable provenance for people
   * reading the history (DESIGN.md §11); the loop guard keys on a body hash.
   */
  trailers?: string[];
}

/**
 * A git wrapper bound to a single vault path. Construct once per vault; every
 * method runs git with `cwd = vaultPath`.
 */
export class VaultGit {
  constructor(private readonly vaultPath: string) {}

  /**
   * Preflight: verify a runnable `git` binary is on PATH. The daemon shells out
   * to system `git` for every vault operation, so a missing binary (e.g. a slim
   * container image without git) must fail fast with an actionable message
   * rather than a cryptic ENOENT deep inside the first real git call. Presence
   * check only — we do NOT gate on a specific version. Runs `git --version`
   * with NO `cwd` (the vault dir may not exist yet at preflight time).
   */
  async assertGitAvailable(): Promise<void> {
    // Goes through the single `runRaw` primitive like every other invocation.
    // `cwd: null` means "do not set a cwd" — the vault dir may not exist yet at
    // preflight time, so we must not point git at a missing directory.
    const r = await this.runRaw(["--version"], { cwd: null });
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || "").trim();
      throw new Error(
        "git binary not found or not runnable — install git (the vault state " +
          `store requires it). Underlying error: ${detail}`,
      );
    }
  }

  /**
   * Run a git command in the vault and return trimmed stdout. THIN wrapper over
   * the single `runRaw` primitive: throws a clear, unified Error (including
   * stderr/stdout) on a non-zero exit.
   */
  private async run(
    args: string[],
    opts?: { cwd?: string | null; env?: Record<string, string> },
  ): Promise<string> {
    const r = await this.runRaw(args, opts);
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || "").trim();
      throw new Error(`git ${args.join(" ")} failed: ${detail}`);
    }
    return r.stdout.trim();
  }

  /**
   * The ONE primitive every git invocation in this module flows through. Builds
   * the full argv (`--no-pager -c core.quotepath=false <args>`), env, cwd, and
   * maxBuffer, runs git, and returns the exit info so callers can treat a
   * non-zero exit as either an error (`run`) or a meaningful state (e.g. a merge
   * conflict, a porcelain diff that "fails" deliberately). It throws only when
   * git's output overran GIT_OUTPUT_MAX_BYTES (no exit status to report then).
   *
   *   - argv: ALWAYS prepends `--no-pager -c core.quotepath=false`, so git never
   *     blocks on a pager and always prints verbatim UTF-8 paths (no octal
   *     escaping/quoting). `quotepath=false` is the baseline for ALL path-
   *     printing commands (ls-files, diff --name-only, …).
   *   - cwd: `opts.cwd === null` -> do NOT set cwd (the preflight, where the
   *     vault dir may not exist); otherwise `opts.cwd ?? this.vaultPath`.
   *   - env: `vaultGitEnv(opts?.env)` (cwd-isolation + caller extras).
   *   - On a spawn/exec error we capture the error `message` too, so a failure
   *     before git could write to stderr (e.g. ENOENT) is NOT lost.
   */
  private async runRaw(
    args: string[],
    opts?: { cwd?: string | null; env?: Record<string, string> },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const cwd = opts?.cwd === null ? undefined : (opts?.cwd ?? this.vaultPath);
    try {
      const { stdout, stderr } = await execFileAsync(
        "git",
        ["--no-pager", "-c", "core.quotepath=false", ...args],
        {
          // Generous buffer: file listings / porcelain output on a large vault
          // can be sizable. Past it the call fails with the reason (below),
          // never with a cut-off answer; PUSH_BUDGET keeps one file's reads
          // (`fileBytes`, three versions at once) inside it.
          ...(cwd !== undefined ? { cwd } : {}),
          maxBuffer: GIT_OUTPUT_MAX_BYTES,
          timeout: GIT_EXEC_TIMEOUT_MS,
          env: vaultGitEnv(opts?.env),
        },
      );
      return { code: 0, stdout, stderr };
    } catch (err: unknown) {
      const e = err as {
        code?: number | string | null;
        killed?: boolean;
        signal?: string | null;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      // Output past the buffer is cut off and git is killed: no exit status to
      // report, and a caller reading it as one (a grep "no match", a show
      // "path absent") would act on a wrong answer. Fail with the reason.
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new Error(
          `git ${args.join(" ")} printed more than its ` +
            `${GIT_OUTPUT_MAX_BYTES}-byte output budget and was stopped`,
          { cause: err },
        );
      }
      // Killed by its timeout (or by any signal): git did not exit, so there is
      // no exit status either — the same wrong answer if read as one.
      if (e.killed || (typeof e.signal === "string" && e.signal.length > 0)) {
        throw new Error(
          e.killed
            ? `git ${args.join(" ")} did not finish within ` +
                `${GIT_EXEC_TIMEOUT_MS} ms and was killed`
            : `git ${args.join(" ")} was killed by ${e.signal}`,
          { cause: err },
        );
      }
      return {
        code: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        // Preserve the error message when there is no stderr (e.g. a spawn
        // failure like ENOENT, where promisified execFile sets stderr to an
        // EMPTY STRING — so `||`, not `??`, to fall through to `message`).
        stderr: e.stderr || e.message || "",
      };
    }
  }

  /**
   * Ensure the vault directory exists and is an initialized git repo on `main`
   * with an initial (empty) commit so branches exist. Idempotent: safe to call
   * on every run. Sets a LOCAL bot identity for the vault repo if none is set
   * (so engine commits never fall back to a global/unset identity).
   *
   * Returns `true` when the vault was NOT a repo and had to be (re)initialized
   * with `git init` (a fresh or wiped vault), `false` for an existing repo.
   */
  async ensureRepo(): Promise<boolean> {
    await mkdir(this.vaultPath, { recursive: true });

    let initialized = false;
    if (!(await this.isRepo())) {
      // `git init -b main` sets the initial branch on modern git; we still
      // guard the branch name below for safety on older binaries.
      await this.run(["init", "-b", DEFAULT_BRANCH]);
      initialized = true;
    }

    // Set a local identity for the vault repo if unset, so engine commits have
    // a deterministic committer even on a machine with no global git config.
    if (!(await this.hasLocalConfig("user.name"))) {
      await this.run(["config", "user.name", BOT_AUTHOR_NAME]);
    }
    if (!(await this.hasLocalConfig("user.email"))) {
      await this.run(["config", "user.email", BOT_AUTHOR_EMAIL]);
    }

    // Neutralize correctness-affecting git config in the vault's LOCAL config so
    // a user's GLOBAL/system config cannot change porcelain BEHAVIOR (not just
    // output) and corrupt the vault. The vault is OUR dedicated repo, so LOCAL
    // values (which override global/system) are the right scope. Each key is
    // read first and written only when it differs (`ensureLocalConfig`); `git
    // config <key>` writes to `--local` by default inside the repo. These MUST
    // be in place before any add/commit/checkout that could be affected, hence
    // they run before the initial-commit block below.
    //   - core.autocrlf=false — CRITICAL (DESIGN.md §11): a global core.autocrlf=true
    //     would rewrite LF<->CRLF on add/checkout, making our deterministic,
    //     byte-stable markdown churn and breaking the round-trip invariant.
    //     `false` guarantees git stores/checks out verbatim bytes.
    //   - core.safecrlf=false — avoid CRLF-related warnings/aborts on add.
    //   - commit.gpgsign=false — the headless daemon must never try to GPG-sign
    //     a commit (would fail/hang; we already set GIT_TERMINAL_PROMPT=0).
    //   - core.attributesFile=/dev/null — neutralize the user's GLOBAL
    //     gitattributes so a global clean/smudge filter (filter.<name>.clean)
    //     cannot rewrite the STORED blob and break the byte-stability of DESIGN.md §11 (a config
    //     that core.autocrlf=false does not cover). POSIX-only path, which is
    //     fine: the daemon runs on Linux (Docker) / macOS. A system
    //     /etc/gitattributes remains the host admin's domain (out of scope).
    //   - merge.conflictStyle=merge — CRITICAL (conflict-marker leak, DESIGN.md §6):
    //     a global `merge.conflictStyle=diff3`/`zdiff3` makes a conflicting merge
    //     emit an EXTRA `|||||||` base-marker section. The conflict-marker
    //     scrub on the push side (`stripConflictMarkers`) handles `|||||||` too,
    //     but pinning the classic `merge` style keeps the markers the engine
    //     produces to the canonical three (`<<<<<<<`/`=======`/`>>>>>>>`) so
    //     behavior is deterministic regardless of the operator's global config.
    // NOTE: these stay PERSISTED LOCAL config (not `-c` flags) on purpose — a
    // human running git by hand in the vault must inherit the same neutralized
    // behavior; a transient `-c` would not persist. (core.quotepath, by
    // contrast, only affects OUR parsing of output and so is baked into the
    // `runRaw` argv baseline instead.)
    try {
      await this.ensureLocalConfig("core.autocrlf", "false");
      await this.ensureLocalConfig("core.safecrlf", "false");
      await this.ensureLocalConfig("commit.gpgsign", "false");
      await this.ensureLocalConfig("core.attributesFile", "/dev/null");
      await this.ensureLocalConfig("merge.conflictStyle", "merge");
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `failed to pin vault git config — ensure ${this.vaultPath}` +
          "/.git/config is writable and not locked (e.g. stale config.lock): " +
          detail,
      );
    }
    // core.attributesFile covers only the GLOBAL attributes; the vault's own
    // `.gitattributes` files are neutralized by `info/attributes`.
    await writeIfDifferent(
      `${this.vaultPath}/.git/info/attributes`,
      VAULT_INFO_ATTRIBUTES,
      0o644,
    );

    // Create the initial empty commit on `main` if the repo has no commits yet,
    // so both `main` and (later) `docmost` branches have a common base.
    if (!(await this.hasAnyCommit())) {
      // Make sure we are on the default branch before the first commit (covers
      // the older-git case where `init -b` was not honored).
      await this.run(["checkout", "-B", DEFAULT_BRANCH]);
      await this.commitRaw("init vault", {
        authorName: BOT_AUTHOR_NAME,
        authorEmail: BOT_AUTHOR_EMAIL,
        allowEmpty: true,
      });
      // Start the `docmost` mirror here too: a vault made by a clone can take
      // a push before the space's first cycle, and a mirror branched from
      // that `main` would count the pushed files as already in Docmost.
      await this.ensureBranch(DOCMOST_BRANCH, DEFAULT_BRANCH);
    }
    return initialized;
  }

  /** True if `cwd` is inside a git work-tree (the vault is initialized). */
  private async isRepo(): Promise<boolean> {
    const r = await this.runRaw(["rev-parse", "--is-inside-work-tree"]);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  /**
   * Set a LOCAL config key only when its local value differs. Every `git config`
   * write takes `.git/config.lock`, and `ensureRepo` also runs for every smart-
   * HTTP request outside the space lock, so an unconditional write collides with
   * a concurrent one ("could not lock config file"). Reading first keeps the
   * steady state write-free.
   */
  private async ensureLocalConfig(key: string, value: string): Promise<void> {
    const r = await this.runRaw(["config", "--local", "--get", key]);
    if (r.code === 0 && r.stdout.trim() === value) return;
    await this.run(["config", key, value]);
  }

  /**
   * Set the LOCAL config that serving the vault over smart-HTTP needs
   * (SERVABLE_CONFIG), each key written only when it differs. Runs on every
   * /git request, outside the space lock.
   *
   * `core.hooksPath` is pinned to the vault's own `.git/hooks`, where
   * `installPushGuard` writes the pre-receive hook: a `core.hooksPath` in the
   * host's global or system config would otherwise point receive-pack at
   * another directory and silently switch the push guard (engine refs, a stale
   * `main`, the push budget) off. Absolute, because a relative value is read
   * against a directory that differs between push hooks and the others.
   */
  async ensureServableConfig(): Promise<void> {
    for (const [key, value] of SERVABLE_CONFIG) {
      await this.ensureLocalConfig(key, value);
    }
    await this.ensureLocalConfig(
      "core.hooksPath",
      resolve(this.vaultPath, ".git", "hooks"),
    );
  }

  /** True if a LOCAL git config key is set in the vault repo. */
  private async hasLocalConfig(key: string): Promise<boolean> {
    const r = await this.runRaw(["config", "--local", "--get", key]);
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  /** True if the repo has at least one commit (HEAD resolves). */
  private async hasAnyCommit(): Promise<boolean> {
    const r = await this.runRaw(["rev-parse", "--verify", "HEAD"]);
    return r.code === 0;
  }

  /** True if a branch with the given name exists. */
  async branchExists(name: string): Promise<boolean> {
    const r = await this.runRaw([
      "rev-parse",
      "--verify",
      `refs/heads/${name}`,
    ]);
    return r.code === 0;
  }

  /**
   * Create `name` from `fromBranch` if it does not already exist. No-op (and no
   * checkout) when the branch is already present.
   */
  async ensureBranch(name: string, fromBranch: string): Promise<void> {
    if (await this.branchExists(name)) return;
    await this.run(["branch", name, fromBranch]);
  }

  /**
   * Re-create a MISSING `main` branch (bug D3-N1). Ref-store damage (a deleted
   * `refs/heads/main`, a bad ref update) can leave an existing repo without
   * `main`. Every cycle then throws (`ensureBranch("docmost","main")` /
   * `checkout main` -> "pathspec 'main' did not match"), wedging the space
   * FOREVER with no self-heal — `ensureRepo` only creates branches on a FRESH
   * `git init`. Restore `main` in the preflight from the best available source:
   * the `docmost` mirror branch if present (they track each other), else the
   * current `HEAD` commit. If the repo has no commit at all, ensureRepo's
   * fresh-init path owns it — nothing to do here.
   *
   * Returns `true` when `main` was missing and has been re-created.
   */
  async ensureMainBranch(): Promise<boolean> {
    if (await this.branchExists(DEFAULT_BRANCH)) return false;
    if (await this.branchExists(DOCMOST_BRANCH)) {
      await this.run(["branch", DEFAULT_BRANCH, DOCMOST_BRANCH]);
      return true;
    }
    const head = await this.runRaw(["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.code === 0 && head.stdout.trim().length > 0) {
      await this.run(["branch", DEFAULT_BRANCH, head.stdout.trim()]);
      return true;
    }
    return false;
  }

  /** Name of the currently checked-out branch. */
  async currentBranch(): Promise<string> {
    return this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  /** Check out an existing branch. */
  async checkout(name: string): Promise<void> {
    await this.run(["checkout", name]);
  }

  /** Stage everything (adds, modifications, deletions). */
  async stageAll(): Promise<void> {
    await this.run(["add", "-A"]);
  }

  /**
   * True if the vault is mid-merge (an unresolved merge from a previous run,
   * DESIGN.md §8). Detected via a `MERGE_HEAD` ref OR any unmerged
   * (conflicted) index entries (`git ls-files -u`). The pull cycle checks this
   * BEFORE any checkout so a left-over merge produces a clear, actionable
   * message instead of a raw "you need to resolve your current index first"
   * failure deep inside `checkout`. This is what makes re-runs converge
   * (resumability, DESIGN.md §8).
   */
  async isMergeInProgress(): Promise<boolean> {
    // MERGE_HEAD exists exactly while a merge is in progress.
    const mergeHead = await this.runRaw([
      "rev-parse",
      "--verify",
      "--quiet",
      "MERGE_HEAD",
    ]);
    if (mergeHead.code === 0 && mergeHead.stdout.trim().length > 0) return true;
    // Fallback / belt-and-suspenders: any unmerged index entries also mean the
    // working tree is mid-conflict and a checkout would refuse.
    const unmerged = await this.runRaw(["ls-files", "-u"]);
    return unmerged.code === 0 && unmerged.stdout.trim().length > 0;
  }

  /**
   * Remove STALE git lock files left by an INTERRUPTED git operation (a hard
   * crash / OOM-kill / abrupt container stop mid `git add`/`commit`/`checkout`
   * leaves `.git/index.lock`; interrupted ref updates leave `*.lock` files). Git
   * then refuses EVERY subsequent operation ("Unable to create '…/index.lock':
   * File exists"), which WEDGES the space's sync loop indefinitely with no
   * self-heal (bug D3-N3). We target the known/fixed set of index + ref lock
   * files this engine itself writes (git's own files plus every branch and
   * service ref of ./vault-refs.ts — retired ones too, whose leftover ref
   * recovery deletes — NOT a `*.lock` glob), and
   * remove a lock ONLY when it is provably stale by mtime: a lock older than
   * STALE_LOCK_MIN_AGE_MS cannot have a live holder (a live git op is killed
   * after GIT_EXEC_TIMEOUT_MS), so it is a genuine crash-leftover. A FRESH lock —
   * e.g. one a concurrently-running replica still holds during the documented
   * multi-replica TTL-lapse window — is PRESERVED, so we never delete a lock a
   * live git process is still using (which would corrupt the index/refs). Clear
   * them best-effort in the cycle preflight, alongside the mid-merge recovery.
   * Missing files are a no-op. Returns the number of stale locks removed.
   */
  async clearStaleGitLocks(): Promise<number> {
    const gitDir = `${this.vaultPath}/.git`;
    const locks = [
      "index.lock",
      "HEAD.lock",
      "config.lock",
      "packed-refs.lock",
      "MERGE_HEAD.lock",
      "ORIG_HEAD.lock",
      ...ENGINE_BRANCHES.map((branch) => `refs/heads/${branch}.lock`),
      ...[...SERVICE_REFS, ...RETIRED_REFS].map((ref) => `${ref}.lock`),
    ];
    let removed = 0;
    await Promise.all(
      locks.map(async (rel) => {
        const path = `${gitDir}/${rel}`;
        try {
          const stats = await stat(path);
          // Only remove a lock old enough that no live git process can hold it.
          // A fresh lock (mtime within the staleness window) is left in place.
          if (Date.now() - stats.mtimeMs >= STALE_LOCK_MIN_AGE_MS) {
            await rm(path, { force: true });
            removed++;
          }
        } catch {
          // Missing lock (ENOENT) or unreadable — nothing to clear.
        }
      }),
    );
    return removed;
  }

  /**
   * Install PUSH_GUARD_HOOK as the vault's `pre-receive` hook. Written only when
   * it differs, through a rename, so a concurrent receive-pack never runs a
   * half-written hook.
   */
  async installPushGuard(): Promise<void> {
    await writeIfDifferent(
      `${this.vaultPath}/.git/hooks/pre-receive`,
      PUSH_GUARD_HOOK,
      0o755,
    );
  }

  /**
   * Commit the currently STAGED changes with an explicit author/committer
   * identity and the given trailers appended to the message body (provenance,
   * DESIGN.md §11). Returns `true` if a commit was made, `false` if there was
   * nothing to commit (graceful no-op). The caller is expected to have staged
   * its changes first (e.g. via `stageAll`).
   */
  async commit(message: string, opts: CommitOptions): Promise<boolean> {
    // Nothing staged -> nothing to commit. Treat as a no-op (DESIGN.md §11: a
    // deterministic re-pull of unchanged pages produces identical bytes, so
    // git sees no diff and we must not error).
    const staged = await this.runRaw([
      "diff",
      "--cached",
      "--quiet",
    ]);
    // `diff --cached --quiet` exits 0 when the index matches HEAD (nothing
    // staged), 1 when there are staged changes.
    if (staged.code === 0) return false;

    await this.commitRaw(message, opts);
    return true;
  }

  /**
   * Low-level commit used by both `commit` and `ensureRepo`'s initial commit.
   * Builds the full message with appended trailers and sets author + committer
   * identity via env vars (so the committer matches the author, not the repo
   * default).
   */
  private async commitRaw(
    message: string,
    opts: CommitOptions & { allowEmpty?: boolean },
  ): Promise<void> {
    const fullMessage = buildCommitMessage(message, opts.trailers);
    // `--no-verify` skips pre-commit/commit-msg hooks: a global core.hooksPath
    // (or any injected hook) must never interfere with engine commits in our
    // dedicated vault repo.
    const args = ["commit", "--no-verify", "-m", fullMessage];
    if (opts.allowEmpty) args.push("--allow-empty");

    // Route through the single `runRaw` primitive; set author + committer
    // identity via env vars (so the committer matches the author, not the repo
    // default). Throw via the same unified message on a non-zero exit.
    const r = await this.runRaw(args, {
      env: {
        GIT_AUTHOR_NAME: opts.authorName,
        GIT_AUTHOR_EMAIL: opts.authorEmail,
        GIT_COMMITTER_NAME: opts.authorName,
        GIT_COMMITTER_EMAIL: opts.authorEmail,
      },
    });
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || "").trim();
      throw new Error(`git ${args.join(" ")} failed: ${detail}`);
    }
  }

  /**
   * Merge `fromBranch` into the current branch (`git merge --no-edit`).
   * Fast-forwards when possible; performs a real 3-way merge otherwise. Conflict
   * state is SURFACED (returned), NOT auto-resolved here (the pull resolves it, DESIGN.md §6): the conflict
   * markers are left in the worktree for manual resolution by a later increment,
   * and — critically — nothing is pushed to Docmost (we never write to Docmost
   * anyway).
   *
   * The merge is PATH-based (`-s resolve`, no rename detection): a page's
   * identity is its `gitmost_id`, which the pull reconciles itself, while rename
   * detection pairs files by content and can pair one page's old path with
   * ANOTHER page's file (a path reused after a rename), merging one page's
   * edits into the other. The default `ort` strategy always detects exact
   * renames, even with `-X no-renames`.
   *
   * A non-fast-forward merge stops BEFORE committing (`--no-commit`); the caller
   * completes it with `commitMerge`, so the merge and the engine writes that
   * finish it land on `main` as ONE commit, never a merge commit without them.
   */
  async merge(fromBranch: string): Promise<MergeResult> {
    const r = await this.runRaw([
      "merge",
      "--no-edit",
      "--no-commit",
      "-s",
      "resolve",
      fromBranch,
    ]);
    const output = `${r.stdout}\n${r.stderr}`.trim();
    if (r.code === 0) {
      return { ok: true, conflict: false, output };
    }
    // A non-zero exit on merge most commonly means a conflict. Confirm by
    // checking for unmerged paths (porcelain "U" status) so we don't mislabel
    // an unrelated failure as a conflict.
    const conflict = await this.hasUnmergedPaths();
    return { ok: false, conflict, output };
  }

  /** True if the index has any unmerged (conflicted) paths. */
  private async hasUnmergedPaths(): Promise<boolean> {
    const r = await this.runRaw(["diff", "--name-only", "--diff-filter=U"]);
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  /**
   * The vault-relative (forward-slash) paths with UNMERGED (conflicted) index
   * entries after a conflicting merge. NUL-delimited + `core.quotepath=false`
   * (the `runRaw` baseline) so Cyrillic/space paths come back verbatim. Used by
   * the pull cycle to LOG and ISOLATE the conflicted page(s) when it commits a
   * conflicted merge instead of leaving the whole vault wedged (DESIGN.md
   * §8). Returns `[]` on any error (best-effort diagnostics).
   */
  async listUnmergedPaths(): Promise<string[]> {
    const r = await this.runRaw([
      "diff",
      "--name-only",
      "--diff-filter=U",
      "-z",
    ]);
    if (r.code !== 0) return [];
    return r.stdout.split("\0").filter((p) => p.length > 0);
  }

  /**
   * Commit an IN-PROGRESS (conflicted) merge AS-IS so the vault is NOT left
   * wedged mid-merge (DESIGN.md §8). A `git merge` that conflicts leaves
   * `MERGE_HEAD` + unmerged index entries; the next cycle's `isMergeInProgress`
   * check would then skip the ENTIRE space forever (the reported wedge). Instead
   * we stage everything — including the conflicted file(s), whose conflict
   * markers are PRESERVED in the committed tree — and record the two-parent merge
   * commit. The cleanly-merged pages land normally; the conflicted page carries
   * its markers on `main`, where the push side isolates it (a per-page push
   * failure when `autoMergeConflicts` is off; the markers never reach Docmost)
   * while every other page keeps syncing. Recovery: resolve the markers in git
   * and the next push sends the clean body.
   *
   * `--allow-empty` guards the degenerate case where the staged conflict
   * resolution nets to no tree change; while `MERGE_HEAD` exists `git commit`
   * still records the merge commit so the half-merge is cleared.
   */
  async commitMerge(message: string, opts: CommitOptions): Promise<void> {
    await this.run(["add", "-A"]);
    await this.commitRaw(message, { ...opts, allowEmpty: true });
  }

  /**
   * Abort an in-progress merge (`git merge --abort`), restoring the pre-merge
   * working tree + index. Best-effort: a non-zero exit (e.g. no MERGE_HEAD) is
   * swallowed. Used by the cycle's RECOVERY path to unwedge a vault that a
   * PRIOR (pre-fix) cycle left mid-merge, so the fresh pull can re-run instead of
   * skipping the space forever (DESIGN.md §8).
   */
  async abortMerge(): Promise<void> {
    await this.runRaw(["merge", "--abort"]);
  }

  /** Hard-reset the working tree + index to HEAD (drops a stray half-merge that
   * `merge --abort` could not clear — no MERGE_HEAD but lingering unmerged
   * entries). Best-effort recovery primitive (DESIGN.md §8). */
  async resetHardToHead(): Promise<void> {
    await this.runRaw(["reset", "--hard", "HEAD"]);
  }

  /**
   * True when the working tree or the index differs from HEAD — a modified,
   * staged, deleted OR untracked (non-ignored) file. A process killed between an
   * engine file write and its commit leaves exactly this state behind.
   */
  async isWorkingTreeDirty(): Promise<boolean> {
    return (await this.run(["status", "--porcelain"])).length > 0;
  }

  /**
   * Throw away every uncommitted change on the current branch: `reset --hard
   * HEAD` (tracked files + index) and `clean -fd` (untracked files and
   * directories; ignored files are kept). Unlike `resetHardToHead` this is NOT
   * best-effort — a failure throws, so a recovery that did not happen is never
   * reported as done.
   */
  async discardWorkingTreeChanges(): Promise<void> {
    await this.run(["reset", "--hard", "HEAD"]);
    await this.run(["clean", "-fd"]);
  }

  /**
   * Every path whose working-tree or index state differs from HEAD — modified,
   * staged, deleted or untracked (each untracked file listed by itself) —
   * vault-relative and verbatim (`status -z`).
   */
  async listDirtyPaths(): Promise<string[]> {
    const r = await this.runRaw([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || "").trim();
      throw new Error(`git status failed: ${detail}`);
    }
    const tokens = r.stdout.split("\0");
    const paths: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (entry.length < 4) continue;
      paths.push(entry.slice(3));
      // A rename or copy names its source in the next token.
      if (/[RC]/.test(entry.slice(0, 2))) paths.push(tokens[++i]);
    }
    return paths;
  }

  /**
   * The working-tree text of a vault-relative path, or `null` when it is absent
   * or not a regular file (a symlink is never followed).
   */
  async readWorkingFile(path: string): Promise<string | null> {
    const abs = join(this.vaultPath, ...path.split("/"));
    try {
      if (!(await lstat(abs)).isFile()) return null;
      return await readFile(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Put one path back to its HEAD state, in the index and the working tree: its
   * HEAD version when HEAD has it, else it is removed.
   */
  async restorePathFromHead(path: string): Promise<void> {
    if ((await this.showFileAtRef("HEAD", path)) !== null) {
      await this.run(["--literal-pathspecs", "checkout", "HEAD", "--", path]);
      return;
    }
    await this.run([
      "--literal-pathspecs",
      "rm",
      "-q",
      "--cached",
      "--ignore-unmatch",
      "--",
      path,
    ]);
    await rm(join(this.vaultPath, ...path.split("/")), { force: true });
  }

  /**
   * List tracked files on the current branch (paths relative to the vault
   * root, forward-slash separated). An optional glob (a git pathspec) narrows
   * the listing, e.g. `"*.md"`.
   *
   * The target wiki is RUSSIAN, so vault file names routinely contain Cyrillic
   * (e.g. `Column.md` in Cyrillic). With git's DEFAULT `core.quotepath=true`, `ls-files`
   * returns non-ASCII paths octal-escaped and double-quoted (`"\320\232..."`),
   * which `src/pull.ts` `readExisting` would then parse as garbage paths,
   * breaking move/duplicate detection. We defeat that two ways at once:
   *   - `core.quotepath=false` disables the octal-escape/quoting. It is now the
   *     `runRaw` argv baseline (prepended to EVERY invocation), so we no longer
   *     pass it inline here.
   *   - `-z` emits NUL-delimited RAW UTF-8 paths (no quoting, no newline
   *     ambiguity), which we split on `\0`.
   * We read the RAW stdout (NOT the trimming `run()` helper, which would mangle
   * the NUL-delimited bytes) and split on `\0`, dropping empty entries. Paths
   * are returned verbatim — git already emits forward slashes.
   */
  async listTrackedFiles(glob?: string): Promise<string[]> {
    const r = await this.runRaw(["ls-files", "-z", ...(glob ? [glob] : [])]);
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || "").trim();
      throw new Error(`git ls-files failed: ${detail}`);
    }
    return r.stdout.split("\0").filter((p) => p.length > 0);
  }

  /**
   * Diff two refs with `--name-status -M -z` and parse the NUL-delimited output
   * (the push diffs `main` against merge-base(`docmost`, `main`), DESIGN.md
   * §7). Rename detection is ON (`-M`), so a moved/renamed file is reported as
   * a single `R` row with both its old and new path instead of a delete+add
   * pair — that distinction is what lets the push planner tell a move from a
   * delete+create.
   *
   * `-z` makes git emit NUL-delimited RAW UTF-8 records (the Russian wiki has
   * Cyrillic file names) with NO quoting/escaping. The record shape differs by
   * status:
   *   - A/M/D:  `status\0path\0`
   *   - R/C:    `Rnnn\0oldPath\0newPath\0`  (nnn = similarity score, e.g. `R100`)
   * We read the RAW stdout (not the trimming `run()` helper, which would mangle
   * the NUL bytes), split on `\0`, drop the trailing empty entry, and walk the
   * tokens pulling 1 or 2 path tokens per status. Paths are returned verbatim.
   */
  async diffNameStatus(
    fromRef: string,
    toRef: string,
  ): Promise<DiffEntry[]> {
    const r = await this.runRaw([
      "diff",
      "--name-status",
      "-M",
      "-z",
      fromRef,
      toRef,
    ]);
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || "").trim();
      throw new Error(`git diff --name-status failed: ${detail}`);
    }
    // Tokens alternate: <status> <path...> <status> <path...> ... With `-z`,
    // each token (status code AND each path) is its own NUL-delimited field.
    const tokens = r.stdout.split("\0").filter((t) => t.length > 0);
    const entries: DiffEntry[] = [];
    let i = 0;
    while (i < tokens.length) {
      const raw = tokens[i++];
      // The status token is e.g. `A`, `M`, `D`, or `R100` / `C075`. The leading
      // letter is the change kind; any trailing digits are the similarity score.
      const letter = raw[0] as DiffEntry["status"];
      if (letter === "R" || letter === "C") {
        const score = Number.parseInt(raw.slice(1), 10);
        const oldPath = tokens[i++];
        const path = tokens[i++];
        if (oldPath === undefined || path === undefined) break; // malformed tail
        entries.push({
          status: letter,
          path,
          oldPath,
          ...(Number.isFinite(score) ? { score } : {}),
        });
      } else if (letter === "A" || letter === "M" || letter === "D") {
        const path = tokens[i++];
        if (path === undefined) break; // malformed tail
        entries.push({ status: letter, path });
      } else {
        // Unknown/other status (e.g. T type-change, U unmerged) — consume one
        // path token defensively so the walk stays aligned, but do not emit it
        // (the push planner only handles A/M/D/R/C).
        i++;
      }
    }
    return entries;
  }

  /**
   * Resolve a ref/commit-ish to its full SHA, or `null` if it does not exist.
   * `rev-parse --verify --quiet` exits non-zero (and prints nothing) for an
   * unknown ref, so a non-zero exit maps cleanly to `null`.
   */
  async revParse(ref: string): Promise<string | null> {
    const r = await this.runRaw(["rev-parse", "--verify", "--quiet", ref]);
    if (r.code !== 0) return null;
    const sha = r.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  /**
   * Read a ref to its SHA, or `null` if unset. Thin alias over `revParse`,
   * named for the engine's service refs (./vault-refs.ts), which are set only
   * while an operation they mark is under way.
   */
  async readRef(ref: string): Promise<string | null> {
    return this.revParse(ref);
  }

  /**
   * The best common ancestor of two commit-ishes (`git merge-base <a> <b>`), or
   * `null` when they share no history or either side does not resolve. The push
   * direction diffs `main` from merge-base(`docmost`, `main`) — the newest commit
   * whose content Docmost already holds.
   */
  async mergeBase(a: string, b: string): Promise<string | null> {
    const r = await this.runRaw(["merge-base", a, b]);
    if (r.code !== 0) return null;
    const sha = r.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  /**
   * Point `ref` at `target` (`git update-ref <ref> <target>`): a service ref,
   * or a branch the engine moves without a checkout. `target` may be a SHA or
   * any commit-ish git accepts. With `expected`, the update fails unless `ref`
   * still points there.
   */
  async updateRef(ref: string, target: string, expected?: string): Promise<void> {
    await this.run(["update-ref", ref, target, ...(expected ? [expected] : [])]);
  }

  /** True when commit `a` is an ancestor of (or equal to) commit `b`. */
  async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.runRaw(["merge-base", "--is-ancestor", a, b])).code === 0;
  }

  /**
   * The tree of `ref` with each of `paths` as it is at `fromRef` instead (left
   * out where `fromRef` has no such path), built in a private index so neither
   * the working tree nor the real index is touched. Returns the tree id.
   */
  async treeWithPathsFrom(
    ref: string,
    fromRef: string,
    paths: string[],
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "git-sync-index-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      await this.run(["read-tree", ref], { env });
      for (const path of paths) {
        const entry = await this.run([
          "--literal-pathspecs",
          "ls-tree",
          "-z",
          fromRef,
          "--",
          path,
        ]);
        const m = entry.match(/^(\d+) blob ([0-9a-f]+)\t/);
        await this.run(
          m
            ? ["update-index", "--add", "--cacheinfo", `${m[1]},${m[2]},${path}`]
            : ["update-index", "--force-remove", "--", path],
          { env },
        );
      }
      return await this.run(["write-tree"], { env });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Create a commit of `tree` (any tree-ish) with `parents`, without touching
   * a branch, the index or the working tree. Returns the commit id.
   */
  async commitTree(
    tree: string,
    parents: string[],
    message: string,
    opts: CommitOptions,
  ): Promise<string> {
    return this.run(
      [
        "commit-tree",
        tree,
        ...parents.flatMap((p) => ["-p", p]),
        "-m",
        buildCommitMessage(message, opts.trailers),
      ],
      {
        env: {
          GIT_AUTHOR_NAME: opts.authorName,
          GIT_AUTHOR_EMAIL: opts.authorEmail,
          GIT_COMMITTER_NAME: opts.authorName,
          GIT_COMMITTER_EMAIL: opts.authorEmail,
        },
      },
    );
  }

  /** Delete `ref` (`git update-ref -d`); a missing ref is a no-op. */
  async deleteRef(ref: string): Promise<void> {
    if ((await this.revParse(ref)) === null) return;
    await this.run(["update-ref", "-d", ref]);
  }

  /**
   * Fast-forward `branch` to `toCommit` — but ONLY if it is a TRUE fast-forward,
   * i.e. the current `branch` tip is an ancestor of `toCommit` (verified via
   * `git merge-base --is-ancestor <branch> <toCommit>`). Used to advance the
   * `docmost` mirror branch after a clean push (DESIGN.md §7): once a push
   * succeeds, Docmost already contains the pushed `main` content, so the mirror
   * must reflect it — otherwise the NEXT pull would diff our own write back and
   * re-pull it.
   *
   * SAFETY — never force, never clobber divergent history:
   *   - If `branch` IS an ancestor of `toCommit`, advance it with
   *     `git update-ref refs/heads/<branch> <toCommit>`. The `docmost` branch is
   *     NOT checked out during a push (push works on `main`), so updating the ref
   *     directly is safe and avoids any working-tree touch.
   *   - If `branch` is NOT an ancestor (divergent / would-be non-fast-forward),
   *     do NOT move it — return `{ ok: false, reason: 'not-fast-forward' }` and
   *     let the caller log it. We must never overwrite a `docmost` history that
   *     has commits the push base does not contain.
   *
   * Returns `{ ok: true }` when the branch was advanced (or already at
   * `toCommit`, a degenerate fast-forward), `{ ok: false, reason }` otherwise.
   * A missing `branch` or `toCommit` also yields `{ ok: false }` with a reason.
   */
  async fastForwardBranch(
    branch: string,
    toCommit: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const branchRef = `refs/heads/${branch}`;
    // Resolve both endpoints first so a missing ref is a clean refusal, not a
    // confusing `merge-base` failure.
    const branchSha = await this.revParse(branchRef);
    if (branchSha === null) {
      return { ok: false, reason: `branch ${branch} does not exist` };
    }
    const targetSha = await this.revParse(toCommit);
    if (targetSha === null) {
      return { ok: false, reason: `target ${toCommit} does not resolve` };
    }
    // Already at the target -> a no-op fast-forward (still ok).
    if (branchSha === targetSha) return { ok: true };

    // `merge-base --is-ancestor A B` exits 0 iff A is an ancestor of B. Only a
    // true ancestor is a fast-forward; anything else is divergent and refused.
    const ancestor = await this.runRaw([
      "merge-base",
      "--is-ancestor",
      branchSha,
      targetSha,
    ]);
    if (ancestor.code !== 0) {
      return { ok: false, reason: "not-fast-forward" };
    }

    // Safe to advance: the branch is not checked out during push, so a direct
    // ref update avoids a checkout/working-tree touch.
    await this.updateRef(branchRef, targetSha);
    return { ok: true };
  }

  /**
   * Read a file's content at a specific ref (`git show <ref>:<path>`), or `null`
   * if the path does not exist there. Used by the push direction to read the
   * PRE-IMAGE of a DELETED file (at the push's diff base) so its `gitmost_id` —
   * and therefore its page — can be recovered to translate the deletion into a
   * `delete_page` (only files that had a page id are deleted in Docmost). A
   * non-zero exit (path absent at that ref) maps to `null` rather than throwing.
   */
  async showFileAtRef(ref: string, path: string): Promise<string | null> {
    // `git show <ref>:<path>` requires the path relative to the repo root; pass
    // it verbatim (forward-slash, matching `listTrackedFiles` / diff output).
    const r = await this.runRaw(["show", `${ref}:${path}`]);
    if (r.code !== 0) return null;
    return r.stdout;
  }

  /**
   * The newest commit reachable from `ref` that added `path` (a rename counts as
   * an add of its new path), or `null` when none did.
   */
  async commitAddingPath(ref: string, path: string): Promise<string | null> {
    const sha = await this.run([
      // Titles may keep `[`/`]`; match the path literally, not as a glob.
      "--literal-pathspecs",
      "log",
      "-1",
      "--format=%H",
      "--no-renames",
      "--diff-filter=A",
      ref,
      "--",
      path,
    ]);
    return sha.length > 0 ? sha : null;
  }

  /**
   * The `gitmost_id` of every `*.md` file at `ref` that has one, in ONE
   * `git grep` (no per-file reads): the value of the file's FIRST line starting
   * with `gitmost_id:`. For an engine-written file that is its frontmatter id; a
   * hand-written file can carry such a line in its body, so a caller confirms a
   * hit with `parsePageFile` where identity is load-bearing.
   */
  async pageIdsAtRef(ref: string): Promise<{ path: string; id: string }[]> {
    const r = await this.runRaw([
      "grep",
      "-z",
      "-E",
      "-e",
      "^gitmost_id:",
      ref,
      "--",
      "*.md",
    ]);
    if (r.code === 1) return []; // no match
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || "").trim();
      throw new Error(`git grep at ${ref} failed: ${detail}`);
    }
    // One `<ref>:<path>\0<line>` record per matching line.
    const prefix = `${ref}:`;
    const out: { path: string; id: string }[] = [];
    const seen = new Set<string>();
    for (const record of r.stdout.split("\n")) {
      const nul = record.indexOf("\0");
      if (nul < 0 || !record.startsWith(prefix)) continue;
      const path = record.slice(prefix.length, nul);
      // The line goes through the page-file parser as a one-line frontmatter:
      // one implementation of the id syntax, and linear time (the regex this
      // replaced was quadratic on a long whitespace run inside the value).
      const id = parsePageFile(`---\n${record.slice(nul + 1)}\n---\n`).id ?? "";
      if (seen.has(path) || id === "") continue;
      seen.add(path);
      out.push({ path, id });
    }
    return out;
  }

  /**
   * Read ONE side of a conflicted file from the merge index (`git show :N:path`),
   * where the stage `N` is the standard 3-way merge slot:
   *   1 = merge BASE (common ancestor), 2 = OURS (the current branch = `main`),
   *   3 = THEIRS (the merged-in branch = `docmost`).
   * Returns the blob text, or `null` when that stage is absent (e.g. an add/add
   * conflict has no base, a modify/delete conflict has only one content side).
   *
   * Used by the pull cycle (DESIGN.md §6) to RESOLVE a conflicted docmost->main merge
   * deterministically instead of committing raw conflict markers onto the
   * published `main`: a conflict whose two sides differ ONLY in trailing/empty
   * lines is SPURIOUS (normalize -> identical -> clean), and a genuine conflict is
   * resolved to a clean side (no `<<<<<<<`/`>>>>>>>` markers ever reach `main`).
   */
  async showStage(stage: 1 | 2 | 3, path: string): Promise<string | null> {
    const r = await this.runRaw(["show", `:${stage}:${path}`]);
    if (r.code !== 0) return null;
    return r.stdout;
  }

  /**
   * Three-way merge of one file's texts (`git merge-file -p --ours`): a hunk only
   * one side changed is taken from that side, and only the hunks BOTH sides
   * changed resolve to `ours`. The pull uses it to resolve a conflicted
   * docmost -> main merge per hunk (DESIGN.md §6), so git wins only where it actually
   * conflicts and Docmost's other changes in the same file survive. The texts go
   * through a private temp dir (merge-file reads files) removed afterwards.
   * `conflicts` counts the hunks both sides changed (0: a clean merge).
   */
  async mergeFileOurs(
    base: string,
    ours: string,
    theirs: string,
  ): Promise<{ text: string; conflicts: number }> {
    const dir = await mkdtemp(join(tmpdir(), "git-sync-merge-"));
    try {
      const oursPath = join(dir, "ours");
      const basePath = join(dir, "base");
      const theirsPath = join(dir, "theirs");
      await writeFile(oursPath, ours, "utf8");
      await writeFile(basePath, base, "utf8");
      await writeFile(theirsPath, theirs, "utf8");
      const run = (favor: string[]) =>
        this.runRaw(["merge-file", "-p", ...favor, oursPath, basePath, theirsPath]);
      // Without a favor option the exit code is the number of conflicts
      // (capped at 127); anything above that is an error.
      const plain = await run([]);
      if (plain.code < 0 || plain.code > 127) {
        throw new Error(
          `git merge-file failed (exit ${plain.code}): ${(plain.stderr || plain.stdout).trim()}`,
        );
      }
      if (plain.code === 0) return { text: plain.stdout, conflicts: 0 };
      const r = await run(["--ours"]);
      if (r.code !== 0) {
        throw new Error(
          `git merge-file failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
        );
      }
      return { text: r.stdout, conflicts: plain.code };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Put `HEAD` back on `main`. The smart-HTTP host advertises whatever `HEAD`
   * resolves to as the clone's default branch, so a clone after a cycle cut off
   * mid-pull (left on the read-only `docmost` mirror) would otherwise default to
   * `docmost`. Pinning HEAD back to the canonical writable branch makes the
   * advertised symref deterministic.
   *
   * Off `main` this is a real checkout, so the index and working tree follow
   * HEAD; a bare symref move would leave `docmost`'s tree in the index, which the
   * next cycle would commit on `main` as user work. A dirty tree is left alone
   * for the next cycle's recovery. Callers serialize this with the engine via the
   * lock.
   *
   * Returns `false` when it skipped (HEAD stays off `main`).
   */
  async pinHeadToMain(): Promise<boolean> {
    if ((await this.currentBranch()) === DEFAULT_BRANCH) return true;
    if (await this.isWorkingTreeDirty()) return false;
    await this.checkout(DEFAULT_BRANCH);
    return true;
  }
}

/**
 * Write `text` to `path` only when it differs, through a rename (with a unique
 * temp name), so a concurrent reader — a receive-pack running the hook, git
 * reading the attributes — never sees a half-written file. Creates the parent
 * directory.
 */
async function writeIfDifferent(
  path: string,
  text: string,
  mode: number,
): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === text) return;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { mode });
  await rename(tmp, path);
}

/**
 * Build the environment for a vault git invocation (cwd-isolation, DESIGN.md §12).
 * Used by the single `runRaw` primitive every git command flows through, so
 * these pins apply uniformly (including the `git --version` preflight).
 *
 * cwd-isolation is this module's central safety guarantee: every git command
 * MUST operate on the vault repo at `cwd: vaultPath` and nothing else. An
 * inherited `GIT_DIR` / `GIT_WORK_TREE` in `process.env` would silently
 * redirect the operation away from `cwd` (e.g. to the source repo or another
 * checkout), defeating that guarantee. So we always strip them, regardless of
 * whatever else the caller adds (author/committer identity, etc.).
 *
 * Exported for unit testing.
 */
export function vaultGitEnv(
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Locale-independent output (defense in depth). We never parse localized
    // prose, but pinning the locale prevents a future regression where some
    // git message we DO key on is translated by an inherited LC_ALL/LANG.
    LC_ALL: "C",
    LANG: "C",
    // Never page (we already pass --no-pager, but a stray GIT_PAGER could still
    // bite) and never block on an interactive prompt (e.g. credentials) — the
    // daemon runs unattended and must not hang.
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/**
 * Build a commit message body with trailer lines appended (DESIGN.md §11). The
 * trailers are separated from the subject by a blank line so `git interpret-
 * trailers` / `git log --format=%(trailers)` parse them as trailers.
 * Exported for unit testing.
 */
export function buildCommitMessage(
  subject: string,
  trailers?: string[],
): string {
  if (!trailers || trailers.length === 0) return subject;
  return `${subject}\n\n${trailers.join("\n")}`;
}
