/**
 * Thin async wrapper over the system `git` binary (SPEC §5: state store = git).
 *
 * IMPORTANT — VAULT-SCOPED: every operation here runs with `cwd = vaultPath`,
 * which is the vault's OWN bare git repository, SEPARATE from the gitmost
 * application repo. This module MUST NEVER run git against the application repo
 * and never touches a git remote. The vault has no working tree: every write is
 * plumbing (`hash-object`, a private index, `commit-tree`, `update-ref`).
 *
 * Implementation notes:
 *   - We shell out via `node:child_process` `execFile` (promisified), passing
 *     ARGS AS AN ARRAY — no shell, so there is no command injection surface even
 *     if a page title / branch name contains shell metacharacters.
 *   - EVERY git invocation funnels through the single `runRaw` primitive, which
 *     ALWAYS prepends `--no-pager -c core.quotepath=false` to the argv (so git
 *     never blocks on a pager and always prints verbatim UTF-8 paths). There is
 *     no exception — even the `git --version` preflight goes through `runRaw`.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parsePageFile } from "@docmost/prosemirror-markdown";
import { MAX_MARKDOWN_BYTES } from "./convert-pool.js";

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
 * git was stopped before it exited (killed by its timeout or a signal, or cut
 * off past the output budget), so it has no answer — not even "absent". A
 * reader that maps its own failures to "absent" must rethrow this one.
 */
export class GitStoppedError extends Error {}

// One `cat-file --batch` call of `readFilesAtRef` takes at most this many paths
// and, unless a single file is bigger, this many bytes of blobs, so its answer
// stays below GIT_OUTPUT_MAX_BYTES however large the space's files are.
const READ_BATCH_PATHS = 1000;
const READ_BATCH_BYTES = GIT_OUTPUT_MAX_BYTES / 2;

/**
 * What one push to the vault may bring, checked by the pre-receive hook
 * (PUSH_GUARD_HOOK) before receive-pack updates any ref. For each pushed ref it
 * counts only the files the ref's new tree ADDS OR CHANGES against the ref's
 * old tip (a new ref: against the current `main`, or its whole tree when there
 * is no `main`). What the vault already holds — the export of a space, which
 * has no page-count limit — is not counted, so a space of any size still takes
 * a one-line edit. Over budget the push is refused with the reason, so the
 * engine never takes in a change it cannot process:
 *   - `files`: the files one push adds or changes, each a page operation of the
 *     cycle that ingests it;
 *   - `fileBytes`: a file is read whole by one git call (`git show`,
 *     `cat-file --batch`), whose output must fit GIT_OUTPUT_MAX_BYTES;
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

/** Bot identity used for engine-authored vault commits (SPEC §7.3). */
export const BOT_AUTHOR_NAME = "Docmost Sync";
export const BOT_AUTHOR_EMAIL = "docmost-sync@local";

/** Default branch the vault repo is initialized on. */
export const DEFAULT_BRANCH = "main";

/**
 * The last export: the commit whose tree holds what Docmost held when the
 * engine last exported it. The user's changes are `diff(last-export, main)`.
 */
export const LAST_EXPORT_REF = "refs/docmost/last-export";

/**
 * The vault's `pre-receive` hook: refuses a push to the engine's own refs,
 * `refs/docmost/*` (the last-export pointer) and the `docmost` branch name. An
 * edit pushed there never reaches Docmost and would move what the engine diffs
 * against. It also refuses a push that brings more than the `budget`
 * (PUSH_BUDGET) — counted over the files each ref update adds or changes, not
 * over the whole tree — naming what is over.
 */
export function buildPushGuardHook(budget: {
  files: number;
  fileBytes: number;
  markdownFileBytes: number;
  totalBytes: number;
}): string {
  return `#!/bin/sh
# Installed by git-sync: refuse a push to the engine's own refs, and a push that
# brings more than the size budget, before receive-pack updates any ref.
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
    refs/heads/docmost|refs/docmost/*)
      echo "'$ref' is managed by git-sync and cannot be pushed." >&2
      exit 1 ;;
  esac
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

/** The lock files the engine's own git operations can leave behind. */
const ENGINE_LOCKS = [
  "HEAD.lock",
  "config.lock",
  "packed-refs.lock",
  "ORIG_HEAD.lock",
  `refs/heads/${DEFAULT_BRANCH}.lock`,
  `${LAST_EXPORT_REF}.lock`,
];

/**
 * One row of `git diff --name-status` (SPEC §6 "FS -> Docmost"). `status` is the
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

/** One file of a tree listing (`git ls-tree -r`). */
export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

/** Options for an engine-authored commit (provenance, SPEC §7.3). */
export interface CommitOptions {
  authorName: string;
  authorEmail: string;
  /**
   * Trailer lines appended to the commit message body (e.g.
   * `Docmost-Sync-Source: docmost`). These are the machine-readable provenance
   * the loop-guard keys on (SPEC §12, "commit-attribution").
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
    opts?: { cwd?: string | null; env?: Record<string, string>; input?: string },
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
   * non-zero exit as either an error (`run`) or a meaningful state (e.g. a grep
   * with no match). It throws when git has no exit status to report: killed by
   * its timeout or a signal, or stopped because its output overran
   * GIT_OUTPUT_MAX_BYTES.
   *
   *   - argv: ALWAYS prepends `--no-pager -c core.quotepath=false`, so git never
   *     blocks on a pager and always prints verbatim UTF-8 paths (no octal
   *     escaping/quoting). `quotepath=false` is the baseline for ALL path-
   *     printing commands (ls-files, diff --name-only, …).
   *   - cwd: `opts.cwd === null` -> do NOT set cwd (the preflight, where the
   *     vault dir may not exist); otherwise `opts.cwd ?? this.vaultPath`.
   *   - env: `vaultGitEnv(opts?.env)` (cwd-isolation + caller extras).
   *   - input: written to git's stdin, which is then closed (`hash-object
   *     --stdin`, `update-index --index-info`, `cat-file --batch`).
   *   - encoding: how stdout/stderr are decoded (`latin1` keeps one char per
   *     byte, for output framed by byte counts).
   *   - On a spawn/exec error we capture the error `message` too, so a failure
   *     before git could write to stderr (e.g. ENOENT) is NOT lost.
   */
  private async runRaw(
    args: string[],
    opts?: {
      cwd?: string | null;
      env?: Record<string, string>;
      input?: string;
      encoding?: BufferEncoding;
    },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const cwd = opts?.cwd === null ? undefined : (opts?.cwd ?? this.vaultPath);
    try {
      const pending = execFileAsync(
        "git",
        ["--no-pager", "-c", "core.quotepath=false", ...args],
        {
          // Generous buffer: file listings / porcelain output on a large vault
          // can be sizable. Past it the call fails with the reason (below),
          // never with a cut-off answer; PUSH_BUDGET keeps one file's read
          // (`fileBytes`) inside it.
          ...(cwd !== undefined ? { cwd } : {}),
          maxBuffer: GIT_OUTPUT_MAX_BYTES,
          timeout: GIT_EXEC_TIMEOUT_MS,
          env: vaultGitEnv(opts?.env),
          encoding: opts?.encoding ?? "utf8",
        },
      );
      if (opts?.input !== undefined) {
        // A child that exits early (or never spawned) closes the pipe; the
        // exit status reports that failure, not an EPIPE on the write.
        pending.child.stdin?.on("error", () => undefined);
        pending.child.stdin?.end(opts.input);
      }
      const { stdout, stderr } = await pending;
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
        throw new GitStoppedError(
          `git ${args.join(" ")} printed more than its ` +
            `${GIT_OUTPUT_MAX_BYTES}-byte output budget and was stopped`,
          { cause: err },
        );
      }
      // Killed by its timeout (or by any signal): git did not exit, so there is
      // no exit status either — the same wrong answer if read as one.
      if (e.killed || (typeof e.signal === "string" && e.signal.length > 0)) {
        throw new GitStoppedError(
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
   * Ensure the vault directory exists and is an initialized BARE git repo whose
   * `main` and last-export pointer start at one initial (empty) commit.
   * Idempotent: safe to call on every run. Sets a LOCAL bot identity for the
   * vault repo if none is set (so engine commits never fall back to a
   * global/unset identity).
   *
   * Returns `true` when the vault was NOT a repo and had to be (re)initialized
   * with `git init` (a fresh or wiped vault), `false` for an existing repo.
   */
  async ensureRepo(): Promise<boolean> {
    await mkdir(this.vaultPath, { recursive: true });

    let initialized = false;
    if (!(await this.isRepo())) {
      await this.run(["init", "--bare", "-b", DEFAULT_BRANCH]);
      await this.run(["config", "gitsync.layout", "2"]);
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
    // a user's GLOBAL/system config cannot change what the engine stores. Each
    // key is read first and written only when it differs (`setConfig`).
    //   - core.autocrlf=false / core.safecrlf=false — CRITICAL (SPEC §11): git
    //     stores verbatim bytes, so the deterministic markdown stays byte-stable.
    //   - commit.gpgsign=false — the headless daemon must never try to GPG-sign
    //     a commit (would fail/hang; we already set GIT_TERMINAL_PROMPT=0).
    //   - core.attributesFile=/dev/null — a global clean/smudge filter cannot
    //     rewrite a stored blob (POSIX path; the daemon runs on Linux / macOS).
    // They stay PERSISTED local config so a human running git by hand in the
    // vault inherits the same behavior.
    try {
      await this.setConfig("core.autocrlf", "false");
      await this.setConfig("core.safecrlf", "false");
      await this.setConfig("commit.gpgsign", "false");
      await this.setConfig("core.attributesFile", "/dev/null");
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `failed to pin vault git config (SPEC §11) — ensure the git config of ` +
          `${this.vaultPath} is writable and not locked (e.g. stale config.lock): ` +
          detail,
      );
    }

    // A vault without commits gets one empty commit on `main`, and the
    // last-export pointer starts there too: a clone can take a push before the
    // space's first cycle, and those files are then the user's changes.
    if (!(await this.hasAnyCommit())) {
      const init = await this.commitTree(await this.buildTree(null, []), [], "init vault", {
        authorName: BOT_AUTHOR_NAME,
        authorEmail: BOT_AUTHOR_EMAIL,
      });
      await this.updateRef(`refs/heads/${DEFAULT_BRANCH}`, init);
      await this.updateRef(LAST_EXPORT_REF, init);
    }
    return initialized;
  }

  /**
   * True if `cwd` is a git repository. `--git-dir` resolves for a bare and a
   * non-bare repo alike (`--is-inside-work-tree` prints `false` in a bare one).
   */
  private async isRepo(): Promise<boolean> {
    return (await this.runRaw(["rev-parse", "--git-dir"])).code === 0;
  }

  /** The repository's absolute git directory (the vault itself when bare). */
  async gitDir(): Promise<string> {
    return this.run(["rev-parse", "--absolute-git-dir"]);
  }

  /**
   * Set a LOCAL config key only when its local value differs. Every `git config`
   * write takes `config.lock`, and `ensureRepo` also runs for every smart-HTTP
   * request outside the space lock, so an unconditional write collides with a
   * concurrent one ("could not lock config file"). Reading first keeps the
   * steady state write-free.
   */
  async setConfig(key: string, value: string): Promise<void> {
    if ((await this.getConfig(key)) === value) return;
    await this.run(["config", key, value]);
  }

  /** A LOCAL config value, or `null` when unset. */
  async getConfig(key: string): Promise<string | null> {
    const r = await this.runRaw(["config", "--local", "--get", key]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** Remove a LOCAL config key; an unset key is a no-op. */
  async unsetConfig(key: string): Promise<void> {
    if ((await this.getConfig(key)) === null) return;
    await this.run(["config", "--unset", key]);
  }

  /** Point `HEAD` at `refs/heads/<branch>`. */
  async setHead(branch: string): Promise<void> {
    await this.run(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  }

  /** True if a LOCAL git config key is set in the vault repo. */
  private async hasLocalConfig(key: string): Promise<boolean> {
    return ((await this.getConfig(key)) ?? "").length > 0;
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
   * Re-create a MISSING `main` branch (bug D3-N1) from the last-export pointer.
   * Ref-store damage (a deleted `refs/heads/main`, a bad ref update) can leave
   * an existing repo without `main`, and every cycle would then fail. Returns
   * `true` when `main` was missing and has been re-created.
   */
  async ensureMainBranch(): Promise<boolean> {
    if (await this.branchExists(DEFAULT_BRANCH)) return false;
    const pointer = await this.revParse(LAST_EXPORT_REF);
    if (pointer === null) return false;
    await this.updateRef(`refs/heads/${DEFAULT_BRANCH}`, pointer);
    return true;
  }

  /**
   * Remove STALE git lock files left by an INTERRUPTED git operation (a hard
   * crash / OOM-kill / abrupt container stop leaves `*.lock` files). Git then
   * refuses every later operation on that ref or file, which WEDGES the space's
   * sync loop. We target a fixed list (`ENGINE_LOCKS` unless one is
   * given, NOT a `*.lock` glob) and remove a lock ONLY when it is provably stale
   * by mtime: a lock older than STALE_LOCK_MIN_AGE_MS cannot have a live holder
   * (a live git op is killed after GIT_EXEC_TIMEOUT_MS). A FRESH lock — e.g. one
   * a concurrently-running replica still holds — is PRESERVED. Missing files
   * are a no-op. Returns the number of stale locks removed.
   */
  async clearStaleGitLocks(locks: readonly string[] = ENGINE_LOCKS): Promise<number> {
    const gitDir = await this.gitDir();
    let removed = 0;
    await Promise.all(
      locks.map(async (rel) => {
        const path = `${gitDir}/${rel}`;
        try {
          const stats = await stat(path);
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
   * half-written hook. The temp name is unique per call: two installs running
   * at once (smart-HTTP requests outside the space lock) never write or rename
   * the same temp file.
   */
  async installPushGuard(): Promise<void> {
    const hooks = `${await this.gitDir()}/hooks`;
    const path = `${hooks}/pre-receive`;
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === PUSH_GUARD_HOOK) return;
    await mkdir(hooks, { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, PUSH_GUARD_HOOK, { mode: 0o755 });
    await rename(tmp, path);
  }

  /**
   * Every file of the tree at `ref` (recursive, NUL-delimited, verbatim UTF-8
   * paths). `mode` is git's octal file mode (`100644`, `120000` for a symlink).
   */
  async lsTree(ref: string): Promise<TreeEntry[]> {
    const r = await this.runRaw(["ls-tree", "-r", "-z", "--full-tree", ref]);
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || "").trim();
      throw new Error(`git ls-tree ${ref} failed: ${detail}`);
    }
    const out: TreeEntry[] = [];
    for (const record of r.stdout.split("\0")) {
      const m = record.match(/^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/);
      if (m) out.push({ mode: m[1], type: m[2], sha: m[3], path: m[4] });
    }
    return out;
  }

  /** Store `text` as a blob (no filters, no attributes) and return its id. */
  async hashObject(text: string): Promise<string> {
    return this.run(["hash-object", "-w", "--stdin"], { input: text });
  }

  /**
   * The tree of `base` (a tree-ish, or `null` for the empty tree) with each
   * change applied: a file whose blob is `sha` (a regular file unless `mode`
   * says otherwise), or the path removed when `sha` is null. Built in a private
   * index with `update-index --index-info`, which needs no working tree; returns
   * the new tree id.
   */
  async buildTree(
    base: string | null,
    changes: { path: string; sha: string | null; mode?: string }[],
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "git-sync-index-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      await this.run(base === null ? ["read-tree", "--empty"] : ["read-tree", base], {
        env,
      });
      if (changes.length > 0) {
        const input = changes
          .map((c) =>
            c.sha === null
              ? `0 ${"0".repeat(40)}\t${c.path}\0`
              : `${c.mode ?? "100644"} ${c.sha}\t${c.path}\0`,
          )
          .join("");
        await this.run(["update-index", "-z", "--index-info"], { env, input });
      }
      return await this.run(["write-tree"], { env });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * The text of each of `paths` at `ref`; a path absent there (or not a file)
   * is left out. The blob sizes come first (`cat-file --batch-check`), then the
   * blobs are read by `cat-file --batch` in batches of at most READ_BATCH_PATHS
   * paths and READ_BATCH_BYTES bytes, so no answer outgrows the output budget
   * (a single file bigger than READ_BATCH_BYTES is read alone). Paths come back
   * verbatim (one per line, so a path containing a newline is not supported).
   */
  async readFilesAtRef(ref: string, paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let batch: string[] = [];
    let bytes = 0;
    for (let i = 0; i < paths.length; i += READ_BATCH_PATHS) {
      const sizes = await this.blobSizesAtRef(ref, paths.slice(i, i + READ_BATCH_PATHS));
      for (const [path, size] of sizes) {
        if (
          batch.length > 0 &&
          (batch.length >= READ_BATCH_PATHS || bytes + size > READ_BATCH_BYTES)
        ) {
          await this.readBatchAtRef(ref, batch, out);
          batch = [];
          bytes = 0;
        }
        batch.push(path);
        bytes += size;
      }
    }
    if (batch.length > 0) await this.readBatchAtRef(ref, batch, out);
    return out;
  }

  /** The size of each of `paths` that is a file at `ref` (`cat-file --batch-check`). */
  private async blobSizesAtRef(
    ref: string,
    paths: string[],
  ): Promise<Map<string, number>> {
    const r = await this.runRaw(["cat-file", "--batch-check"], {
      input: paths.map((p) => `${ref}:${p}\n`).join(""),
    });
    if (r.code !== 0) {
      throw new Error(`git cat-file --batch-check at ${ref} failed: ${r.stderr.trim()}`);
    }
    // One line per path: `<oid> <type> <size>`, or `<name> missing`.
    const lines = r.stdout.split("\n");
    const sizes = new Map<string, number>();
    paths.forEach((path, i) => {
      const m = (lines[i] ?? "").match(/^[0-9a-f]+ (\w+) (\d+)$/);
      if (m && m[1] === "blob") sizes.set(path, Number(m[2]));
    });
    return sizes;
  }

  /** One `cat-file --batch` over `paths` at `ref`, its blobs added to `out`. */
  private async readBatchAtRef(
    ref: string,
    paths: string[],
    out: Map<string, string>,
  ): Promise<void> {
    const r = await this.runRaw(["cat-file", "--batch"], {
      input: paths.map((p) => `${ref}:${p}\n`).join(""),
      encoding: "latin1",
    });
    if (r.code !== 0) {
      throw new Error(`git cat-file --batch at ${ref} failed: ${r.stderr.trim()}`);
    }
    // Each answer is `<oid> <type> <size>\n<size bytes>\n`, or `<name> missing\n`.
    let at = 0;
    for (const path of paths) {
      const eol = r.stdout.indexOf("\n", at);
      if (eol < 0) break;
      const m = r.stdout.slice(at, eol).match(/^[0-9a-f]+ (\w+) (\d+)$/);
      at = eol + 1;
      if (!m) continue;
      const size = Number(m[2]);
      if (m[1] === "blob") {
        out.set(path, Buffer.from(r.stdout.slice(at, at + size), "latin1").toString("utf8"));
      }
      at += size + 1;
    }
  }

  /** The full message of commit `sha`. */
  async commitMessage(sha: string): Promise<string> {
    return this.run(["log", "-1", "--format=%B", sha]);
  }

  /**
   * Diff two refs with `--name-status -M -z` and parse the NUL-delimited output
   * (SPEC §6: the user's changes are `main` diffed against the last export). Rename detection is ON (`-M`), so a moved/renamed
   * file is reported as a single `R` row with both its old and new path instead
   * of a delete+add pair — that distinction is what lets the push planner tell a
   * move from a delete+create (SPEC §8 "Move vs delete").
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

  /** Read a ref to its SHA, or `null` if unset. Thin alias over `revParse`. */
  async readRef(ref: string): Promise<string | null> {
    return this.revParse(ref);
  }

  /**
   * The best common ancestor of two commit-ishes (`git merge-base <a> <b>`), or
   * `null` when they share no history or either side does not resolve.
   */
  async mergeBase(a: string, b: string): Promise<string | null> {
    const r = await this.runRaw(["merge-base", a, b]);
    if (r.code !== 0) return null;
    const sha = r.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  /**
   * Point `ref` at `target` (`git update-ref <ref> <target>`). With `expected`,
   * the update is a compare-and-swap: it fails unless `ref` still points there.
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
   * out where `fromRef` has no such path), built in a private index. Returns
   * the tree id.
   */
  async treeWithPathsFrom(
    ref: string,
    fromRef: string,
    paths: string[],
  ): Promise<string> {
    const changes: { path: string; sha: string | null; mode?: string }[] = [];
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
      changes.push(m ? { path, sha: m[2], mode: m[1] } : { path, sha: null });
    }
    return this.buildTree(ref, changes);
  }

  /**
   * Create a commit of `tree` (any tree-ish) with `parents`, without touching
   * a ref. Returns the commit id.
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
   * Read a file's content at a specific ref (`git show <ref>:<path>`), or `null`
   * if the path does not exist there (a non-zero exit maps to `null`).
   */
  async showFileAtRef(ref: string, path: string): Promise<string | null> {
    // `git show <ref>:<path>` takes the path relative to the repo root,
    // verbatim (forward-slash, as in the diff output).
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
      // one implementation of the id syntax, and linear time (a regex with a
      // lazy capture before `\s*$` is quadratic on a long whitespace run).
      const id = parsePageFile(`---\n${record.slice(nul + 1)}\n---\n`).id ?? "";
      if (seen.has(path) || id === "") continue;
      seen.add(path);
      out.push({ path, id });
    }
    return out;
  }
}

/**
 * Build the environment for a vault git invocation (SPEC §12 cwd-isolation).
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
    // prose, but pinning the locale keeps any git message we do key on
    // untranslated regardless of an inherited LC_ALL/LANG.
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
 * Build a commit message body with trailer lines appended (SPEC §7.3). The
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
