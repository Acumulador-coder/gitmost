/**
 * The git runner: every git command git-sync runs is started by one small,
 * long-lived helper process (./git-runner-child.ts), never by the caller.
 *
 * Starting a child process is synchronous work on the caller's event loop, and
 * it grows with the caller's size: each `execFile("git")` of the API server
 * (hundreds of MB) blocked HTTP for tens of milliseconds, and a sync cycle runs
 * dozens of them. The helper is a bare Node process, so its spawns are cheap
 * and happen on its own event loop; the caller only moves the request and git's
 * output over the IPC channel.
 *
 *   - The helper starts on the first call and serves calls concurrently, each
 *     with `execFile("git", args, { cwd, env, maxBuffer, timeout, encoding })`.
 *   - `runGit` resolves and rejects as the promisified `execFile` does: a
 *     failure is an Error carrying `code`, `killed`, `signal`, `stdout` and
 *     `stderr`.
 *   - Every call has a deadline here as well, `timeout` plus a margin: a helper
 *     that does not answer by then is killed and the call rejects with a
 *     `GitStoppedError`.
 *   - When the helper exits or crashes, every call it was running rejects with
 *     a `GitStoppedError` naming why, and the next call starts a fresh helper.
 *   - While no call is running the helper is unref'd: it never keeps the
 *     process alive by itself, and it exits when the IPC channel closes.
 */
import { fork, type ChildProcess } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * git was stopped before it exited (killed by its timeout or a signal, cut off
 * past the output budget, or its helper process went down), so it has no
 * answer — not even "absent". A reader that maps its own failures to "absent"
 * must rethrow this one.
 */
export class GitStoppedError extends Error {}

/**
 * How long past a call's own `timeout` the caller waits for the helper's
 * answer. When git hits its timeout the helper kills it and answers at once, so
 * only a helper that is itself stuck reaches this.
 */
export const GIT_RUNNER_DEADLINE_MARGIN_MS = 10_000;

/** Options of one git call; they mean what they mean for `execFile`. */
export interface RunGitOptions {
  /** git's working directory; omitted, the helper's (the caller's at its start). */
  cwd?: string;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  /** Kill git after this many ms (must be positive). */
  timeout: number;
  encoding?: BufferEncoding;
  /** Written to git's stdin, which is then closed. */
  input?: string;
}

/** One request to the helper. */
export interface GitRunRequest {
  id: number;
  args: string[];
  options: RunGitOptions;
}

/** The helper's answer: git's output, and how `execFile` failed when it did. */
export type GitRunReply =
  | { id: number; ok: true; stdout: string; stderr: string }
  | {
      id: number;
      ok: false;
      stdout: string;
      stderr: string;
      error: {
        message: string;
        /** git's exit code, or the error code (`ENOENT`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`). */
        code: number | string | null;
        killed: boolean;
        signal: string | null;
      };
    };

interface Call {
  resolve: (out: { stdout: string; stderr: string }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Helper {
  process: ChildProcess;
  /** The calls this helper runs, by request id. */
  calls: Map<number, Call>;
  retired: boolean;
}

/** Runs git through one helper process (see the module comment). */
export class GitRunner {
  private helper: Helper | null = null;
  private nextId = 1;
  private entry: URL | null = null;

  constructor(private readonly options: { deadlineMarginMs: number }) {}

  async run(
    args: string[],
    options: RunGitOptions,
  ): Promise<{ stdout: string; stderr: string }> {
    this.entry ??= await helperEntry();
    const helper = this.helper ?? this.spawn();
    const id = this.nextId++;
    const deadlineMs = options.timeout + this.options.deadlineMarginMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.expire(helper, id, deadlineMs), deadlineMs);
      helper.calls.set(id, { resolve, reject, timer });
      helper.process.ref();
      helper.process.channel?.ref();
      const request: GitRunRequest = { id, args, options };
      helper.process.send(request, (err) => {
        if (err) this.retire(helper, `could not take a request (${err.message})`);
      });
    });
  }

  private spawn(): Helper {
    const entry = this.entry!;
    const child = fork(fileURLToPath(entry), [], {
      // The TypeScript source (test runs): Node versions before 22.18 strip
      // types only behind this flag, later ones accept it as a no-op. The
      // caller's own flags (heap size, inspector) are not passed on.
      execArgv: extname(entry.pathname) === ".ts" ? ["--experimental-strip-types"] : [],
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const helper: Helper = { process: child, calls: new Map(), retired: false };
    child.on("message", (reply) => this.onReply(helper, reply as GitRunReply));
    child.on("error", (err: Error) => this.retire(helper, `failed (${err.message})`));
    child.on("exit", (code: number | null, signal: string | null) =>
      this.retire(
        helper,
        signal !== null ? `was killed by ${signal}` : `exited with code ${code}`,
      ),
    );
    this.helper = helper;
    return helper;
  }

  private onReply(helper: Helper, reply: GitRunReply): void {
    const call = helper.calls.get(reply.id);
    if (call === undefined) return;
    this.settle(helper, reply.id, call);
    if (reply.ok) {
      call.resolve({ stdout: reply.stdout, stderr: reply.stderr });
      return;
    }
    call.reject(
      Object.assign(new Error(reply.error.message), {
        code: reply.error.code,
        killed: reply.error.killed,
        signal: reply.error.signal,
        stdout: reply.stdout,
        stderr: reply.stderr,
      }),
    );
  }

  /** Forget a call that settles; an idle helper stops holding the process. */
  private settle(helper: Helper, id: number, call: Call): void {
    clearTimeout(call.timer);
    helper.calls.delete(id);
    if (helper.calls.size === 0) {
      helper.process.unref();
      helper.process.channel?.unref();
    }
  }

  /** Call `id` got no answer within its deadline: kill its helper. */
  private expire(helper: Helper, id: number, deadlineMs: number): void {
    const call = helper.calls.get(id);
    if (call === undefined) return;
    this.settle(helper, id, call);
    call.reject(
      new GitStoppedError(
        `the git helper process did not answer within ${deadlineMs} ms and was killed`,
      ),
    );
    this.retire(helper, "was killed after a git call missed its deadline");
  }

  /**
   * Take `helper` out of service: the next call starts a fresh one, every call
   * it still runs rejects with `why`, and the process is killed (a no-op once
   * it has exited).
   */
  private retire(helper: Helper, why: string): void {
    if (helper.retired) return;
    helper.retired = true;
    if (this.helper === helper) this.helper = null;
    for (const [id, call] of [...helper.calls]) {
      this.settle(helper, id, call);
      call.reject(new GitStoppedError(`the git helper process ${why} before git answered`));
    }
    helper.process.kill("SIGKILL");
  }
}

/**
 * The helper script next to this module: `git-runner-child.js` in the build,
 * `git-runner-child.ts` when a test runner executes the TypeScript sources.
 * Resolved as `workerEntry` in ./convert-pool.ts resolves the converter worker
 * (see there for `__filename` and ./module-url.ts).
 */
async function helperEntry(): Promise<URL> {
  const self =
    typeof __filename === "string"
      ? pathToFileURL(__filename)
      : new URL((await import("./module-url.js")).moduleUrl);
  const ext = extname(self.pathname) === ".ts" ? ".ts" : ".js";
  return new URL(`./git-runner-child${ext}`, self);
}

/** The runner git-sync's git calls go through. */
export const gitRunner = new GitRunner({
  deadlineMarginMs: GIT_RUNNER_DEADLINE_MARGIN_MS,
});

/**
 * `execFile("git", args, options)`, promisified, run by the helper process:
 * resolves `{ stdout, stderr }` on exit code 0, otherwise rejects with the
 * Error `execFile` reports (`code`, `killed`, `signal`, `stdout`, `stderr`), or
 * with a `GitStoppedError` when the helper went down or missed its deadline.
 */
export function runGit(
  args: string[],
  options: RunGitOptions,
): Promise<{ stdout: string; stderr: string }> {
  return gitRunner.run(args, options);
}
