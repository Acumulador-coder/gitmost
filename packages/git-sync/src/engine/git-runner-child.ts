/**
 * The git helper process of `GitRunner` (./git-runner.ts): runs each request's
 * git command with `execFile` and answers over the IPC channel, so the large
 * caller process never spawns git itself. Serves requests concurrently and
 * exits when the channel closes (the caller exited or killed it).
 *
 * Imports only Node built-ins and types: test runners start this file from its
 * TypeScript source, with Node stripping the types, where a relative module
 * import would not resolve.
 */
import { execFile } from "node:child_process";
import type { GitRunReply, GitRunRequest } from "./git-runner.js";

function answer(reply: GitRunReply): void {
  // A closed channel means the caller is gone; `disconnect` ends this process.
  process.send?.(reply, undefined, undefined, () => undefined);
}

function run(request: GitRunRequest): void {
  const { id, args, options } = request;
  try {
    const child = execFile(
      "git",
      args,
      {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: options.env,
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
        encoding: options.encoding ?? "utf8",
      },
      (err, stdout, stderr) => {
        if (err === null) {
          answer({ id, ok: true, stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & {
          code?: number | string | null;
          killed?: boolean;
          signal?: string | null;
        };
        answer({
          id,
          ok: false,
          stdout,
          stderr,
          error: {
            message: e.message,
            code: e.code ?? null,
            killed: e.killed ?? false,
            signal: e.signal ?? null,
          },
        });
      },
    );
    if (options.input !== undefined) {
      // A child that exits early (or never spawned) closes the pipe; the exit
      // status reports that failure, not an EPIPE on the write.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  } catch (err) {
    // `execFile` throws synchronously on arguments it refuses (a NUL byte in
    // an argument); uncaught here it would crash the helper and every call it
    // runs, so answer it as a failed call, as promisified execFile rejects with it.
    const e = err as NodeJS.ErrnoException;
    answer({
      id,
      ok: false,
      stdout: "",
      stderr: "",
      error: { message: e.message, code: e.code ?? null, killed: false, signal: null },
    });
  }
}

if (process.send === undefined) {
  throw new Error("git-runner-child.ts must run as a child process with an IPC channel");
}
process.on("message", (request) => run(request as GitRunRequest));
process.on("disconnect", () => process.exit(0));
