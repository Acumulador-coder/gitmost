import "./git-env";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VaultGit, vaultGitEnv } from "../src/engine/git";
import {
  GIT_RUNNER_DEADLINE_MARGIN_MS,
  GitRunner,
  GitStoppedError,
  gitRunner,
  runGit,
} from "../src/engine/git-runner";

// The git runner: git runs in a helper process, and its answers come back as
// promisified `execFile` gives them. Driven against the REAL helper and git.

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "git-runner-"));
  dirs.push(dir);
  await execFileAsync("git", ["init", "-q", "--bare", dir]);
  return dir;
}

const opts = (cwd: string) => ({
  cwd,
  env: vaultGitEnv(),
  maxBuffer: 1024 * 1024,
  timeout: 30_000,
});

/** The pid of a runner's live helper process, once it has one. */
async function helperPid(runner: GitRunner): Promise<number> {
  let pid: number | undefined;
  await vi.waitFor(() => {
    pid = (runner as any).helper?.process.pid;
    expect(pid).toBeTypeOf("number");
  });
  return pid!;
}

describe("runGit — git in the helper process", () => {
  let available = false;

  beforeAll(async () => {
    try {
      await execFileAsync("git", ["--version"]);
      available = true;
    } catch {
      available = false;
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("returns git's stdout, and a non-zero exit as execFile reports it", async () => {
    if (!available) return;
    const dir = await repo();

    expect((await runGit(["rev-parse", "--is-bare-repository"], opts(dir))).stdout).toBe(
      "true\n",
    );
    const failed = await runGit(["rev-parse", "--verify", "nope"], opts(dir)).catch(
      (e) => e,
    );
    expect(failed).toMatchObject({ code: 128, killed: false, signal: null, stdout: "" });
    expect(failed.stderr).toContain("fatal: Needed a single revision");
  });

  it("writes the input to git's stdin", async () => {
    if (!available) return;
    const dir = await repo();

    const { stdout } = await runGit(["hash-object", "--stdin"], {
      ...opts(dir),
      input: "hello\n",
    });

    expect(stdout.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("decodes latin1 output one char per byte", async () => {
    if (!available) return;
    const dir = await repo();
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const file = join(dir, "blob.bin");
    await writeFile(file, bytes);
    const sha = (await runGit(["hash-object", "-w", file], opts(dir))).stdout.trim();

    const { stdout } = await runGit(["cat-file", "blob", sha], {
      ...opts(dir),
      encoding: "latin1",
    });

    expect(Buffer.from(stdout, "latin1").equals(bytes)).toBe(true);
  });

  it("output past maxBuffer: VaultGit fails with GitStoppedError", async () => {
    if (!available) return;
    const dir = await repo();
    const run = gitRunner.run.bind(gitRunner);
    vi.spyOn(gitRunner, "run").mockImplementation((args, o) =>
      run(args, { ...o, maxBuffer: 16 }),
    );

    // The vault's absolute path is longer than 16 bytes.
    const read = new VaultGit(dir).gitDir().catch((e) => e);

    expect(await read).toBeInstanceOf(GitStoppedError);
    expect((await read).message).toMatch(
      /^git rev-parse --absolute-git-dir printed more than its \d+-byte output budget/,
    );
  });

  it("a git past its timeout: VaultGit fails with GitStoppedError", async () => {
    if (!available) return;
    const dir = await repo();
    const run = gitRunner.run.bind(gitRunner);
    // Without its input, `cat-file --batch-check` waits on stdin until killed.
    vi.spyOn(gitRunner, "run").mockImplementation((args, o) =>
      run(args, { ...o, timeout: 300, input: undefined }),
    );

    const read = new VaultGit(dir).readFilesAtRef("HEAD", ["A.md"]).catch((e) => e);

    expect(await read).toBeInstanceOf(GitStoppedError);
    expect((await read).message).toMatch(/^git cat-file --batch-check did not finish within/);
  });

  it("a helper killed mid-call fails the call, and the next call gets a fresh helper", async () => {
    if (!available) return;
    const dir = await repo();
    const runner = new GitRunner({ deadlineMarginMs: GIT_RUNNER_DEADLINE_MARGIN_MS });

    const hung = runner.run(["cat-file", "--batch"], opts(dir)).catch((e) => e);
    const pid = await helperPid(runner);
    process.kill(pid, "SIGKILL");

    const err = await hung;
    expect(err).toBeInstanceOf(GitStoppedError);
    expect(err.message).toBe(
      "the git helper process was killed by SIGKILL before git answered",
    );
    expect((await runner.run(["rev-parse", "--is-bare-repository"], opts(dir))).stdout).toBe(
      "true\n",
    );
    expect(await helperPid(runner)).not.toBe(pid);
  });

  it("a helper that does not answer by the deadline is killed and the call fails", async () => {
    if (!available) return;
    const dir = await repo();
    const runner = new GitRunner({ deadlineMarginMs: 200 });

    const hung = runner
      .run(["cat-file", "--batch"], { ...opts(dir), timeout: 300 })
      .catch((e) => e);
    const pid = await helperPid(runner);
    // A stopped helper neither kills git at its timeout nor answers.
    process.kill(pid, "SIGSTOP");

    const err = await hung;
    expect(err).toBeInstanceOf(GitStoppedError);
    expect(err.message).toBe(
      "the git helper process did not answer within 500 ms and was killed",
    );
    expect((await runner.run(["rev-parse", "--is-bare-repository"], opts(dir))).stdout).toBe(
      "true\n",
    );
    expect(await helperPid(runner)).not.toBe(pid);
  });
});
