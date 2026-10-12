import "./git-env";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_MARKDOWN_BYTES } from "../src/engine/convert-pool";
import { buildPushGuardHook, PUSH_BUDGET, VaultGit } from "../src/engine/git";
import { execFileAsync, git, gitAvailable } from "./cycle-realgit-helpers";

// A push whose ref advertisement predates a cycle's commit on `main` must be
// refused before receive-pack (updateInstead) checks it out into the working
// tree; otherwise the tree holds the rejected push and the next cycle commits
// it over the cycle's work. Driven against a REAL receive-pack.

// A receive-pack whose repo gets a commit on `main` right after the ref
// advertisement went out (the first byte the client sends back), as when a
// cycle commits between a push's GET info/refs and its POST.
const RACING_RECEIVE_PACK = `#!/bin/sh
repo="$1"
fifo="$repo/../rp.fifo"
mkfifo "$fifo"
git receive-pack "$repo" < "$fifo" &
exec 3> "$fifo"
dd bs=1 count=1 of="$repo/../rp.first" 2>/dev/null
(cd "$repo" && echo "docmost edit" > B.md && git add B.md &&
  git -c user.name=t -c user.email=t@t commit -q -m "cycle export")
cat "$repo/../rp.first" >&3
cat >&3
exec 3>&-
wait
`;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("PUSH_GUARD_HOOK — a push racing a cycle", () => {
  let available = false;
  let dir: string | undefined;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A servable vault (as the server configures it) and a clone with one new commit. */
  async function setup() {
    dir = await mkdtemp(join(tmpdir(), "docmost-push-guard-"));
    const srv = join(dir, "srv");
    const cli = join(dir, "cli");
    const vault = new VaultGit(srv);
    await vault.ensureRepo();
    await git(srv, "config", "receive.denyCurrentBranch", "updateInstead");
    await vault.installPushGuard();
    await git(dir, "clone", "-q", srv, cli);
    await writeFile(join(cli, "C.md"), "pushed\n", "utf8");
    await git(cli, "add", "C.md");
    await git(cli, "commit", "-q", "-m", "user push");
    return { root: dir, srv, cli };
  }

  it("refuses the push: the working tree and the cycle's commit stay as they were", async () => {
    if (!available) return;
    const { root, srv, cli } = await setup();
    const wrapper = join(root, "rp.sh");
    await writeFile(wrapper, RACING_RECEIVE_PACK, { mode: 0o755 });

    const push = execFileAsync(
      "git",
      ["push", `--receive-pack=${wrapper}`, "origin", "main"],
      { cwd: cli },
    );

    await expect(push).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "'main' changed on the server since your last fetch",
      ),
    });
    expect(await git(srv, "status", "--porcelain")).toBe("");
    expect(await git(srv, "log", "-1", "--format=%s", "main")).toBe(
      "cycle export",
    );
    expect(await exists(join(srv, "B.md"))).toBe(true);
    expect(await exists(join(srv, "C.md"))).toBe(false);
  });

  it("refuses a push to the engine's own refs: they do not move", async () => {
    if (!available) return;
    const { srv, cli } = await setup();
    const before = await git(srv, "for-each-ref", "refs/heads/docmost", "refs/docmost");

    for (const ref of ["refs/heads/docmost", "refs/docmost/recording"]) {
      await expect(
        execFileAsync("git", ["push", "origin", `HEAD:${ref}`], { cwd: cli }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          `'${ref}' is managed by git-sync and cannot be pushed.`,
        ),
      });
    }

    expect(
      await git(srv, "for-each-ref", "refs/heads/docmost", "refs/docmost"),
    ).toBe(before);
  });

  it("keeps refusing a push to 'docmost' when the host's global config points core.hooksPath elsewhere", async () => {
    if (!available) return;
    const { root, srv, cli } = await setup();
    const globalConfig = join(root, "global.gitconfig");
    await writeFile(
      globalConfig,
      `[core]\n\thooksPath = ${join(root, "no-hooks")}\n`,
      "utf8",
    );
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      // Without the pin the ambient hooksPath switches the guard off.
      await git(cli, "push", "-q", "origin", "HEAD:refs/heads/docmost");
      expect(await git(srv, "rev-parse", "docmost")).toBe(
        await git(cli, "rev-parse", "HEAD"),
      );

      await new VaultGit(srv).ensureServableConfig();
      await writeFile(join(cli, "D.md"), "pushed again\n", "utf8");
      await git(cli, "add", "D.md");
      await git(cli, "commit", "-q", "-m", "second push");
      const before = await git(srv, "rev-parse", "docmost");

      await expect(
        execFileAsync("git", ["push", "origin", "HEAD:refs/heads/docmost"], {
          cwd: cli,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "'refs/heads/docmost' is managed by git-sync and cannot be pushed.",
        ),
      });
      expect(await git(srv, "rev-parse", "docmost")).toBe(before);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved;
    }
  });

  it("lets a push from an up-to-date clone through", async () => {
    if (!available) return;
    const { srv, cli } = await setup();

    await git(cli, "push", "-q", "origin", "main");

    expect(await git(srv, "rev-parse", "main")).toBe(
      await git(cli, "rev-parse", "HEAD"),
    );
    expect(await git(srv, "status", "--porcelain")).toBe("");
    expect(await exists(join(srv, "C.md"))).toBe(true);
  });
});

describe("PUSH_GUARD_HOOK — the push budget", () => {
  let available = false;
  let dir: string | undefined;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** The small budget the hook under test enforces. */
  const BUDGET = { files: 3, fileBytes: 100, markdownFileBytes: 80, totalBytes: 150 };

  /**
   * A space the pull exported far over BUDGET: more files, more bytes and a
   * page bigger than the `.md` limit, already on `main`.
   */
  const BIG_TREE: Record<string, string> = {
    "Exported.md": "e".repeat(90),
    "P1.md": "1".repeat(70),
    "P2.md": "2".repeat(70),
    "P3.md": "3".repeat(70),
    "P4.md": "4".repeat(70),
  };

  /**
   * A servable vault guarded by a hook with BUDGET, holding `existing` (path ->
   * content) on `main` as the pull would have committed it, and a clone that
   * commits `files` on top of it and pushes them to `ref`.
   */
  async function pushFiles(
    files: Record<string, string>,
    opts: { existing?: Record<string, string>; ref?: string } = {},
  ) {
    dir = await mkdtemp(join(tmpdir(), "docmost-push-budget-"));
    const srv = join(dir, "srv");
    const cli = join(dir, "cli");
    const vault = new VaultGit(srv);
    await vault.ensureRepo();
    await git(srv, "config", "receive.denyCurrentBranch", "updateInstead");
    await writeFile(
      join(srv, ".git", "hooks", "pre-receive"),
      buildPushGuardHook(BUDGET),
      { mode: 0o755 },
    );
    if (opts.existing) {
      for (const [path, text] of Object.entries(opts.existing)) {
        await writeFile(join(srv, path), text, "utf8");
      }
      await git(srv, "add", "-A");
      await git(srv, "commit", "-q", "-m", "docmost: sync");
    }
    await git(dir, "clone", "-q", srv, cli);
    for (const [path, text] of Object.entries(files)) {
      await writeFile(join(cli, path), text, "utf8");
    }
    await git(cli, "add", "-A");
    await git(cli, "commit", "-q", "-m", "user push");
    const before = await git(srv, "rev-parse", "main");
    const push = execFileAsync(
      "git",
      ["push", "origin", `HEAD:${opts.ref ?? "refs/heads/main"}`],
      { cwd: cli },
    );
    return { srv, cli, before, push };
  }

  it("refuses a file over the per-file limit, naming it: main does not move", async () => {
    if (!available) return;
    const { srv, before, push } = await pushFiles({
      "Small.md": "ok\n",
      "Big file.bin": "x".repeat(101),
    });

    await expect(push).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "git-sync refused the push: 'Big file.bin' is 101 bytes (limit 100 per file).",
      ),
    });
    expect(await git(srv, "rev-parse", "main")).toBe(before);
    expect(await exists(join(srv, "Small.md"))).toBe(false);
  });

  it("holds a .md file to the .md limit, any other file to the per-file limit", async () => {
    if (!available) return;
    const { srv, before, push } = await pushFiles({
      "Notes.txt": "n".repeat(90),
      "Big page.md": "x".repeat(81),
    });

    await expect(push).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "git-sync refused the push: 'Big page.md' is 81 bytes (limit 80 per .md file).",
      ),
    });
    expect(await git(srv, "rev-parse", "main")).toBe(before);
  });

  it("refuses a push adding more files than the limit", async () => {
    if (!available) return;
    const { srv, before, push } = await pushFiles({
      "A.md": "a\n",
      "B.md": "b\n",
      "C.md": "c\n",
      "D.md": "d\n",
    });

    await expect(push).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "git-sync refused the push: refs/heads/main would add or change more than 3 files (the limit per push).",
      ),
    });
    expect(await git(srv, "rev-parse", "main")).toBe(before);
  });

  it("refuses a push adding more bytes than the limit", async () => {
    if (!available) return;
    const { srv, before, push } = await pushFiles({
      "A.md": "a".repeat(80),
      "B.md": "b".repeat(80),
    });

    await expect(push).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "git-sync refused the push: refs/heads/main would add or change more than 150 bytes of files (the limit per push).",
      ),
    });
    expect(await git(srv, "rev-parse", "main")).toBe(before);
  });

  it("lets a push within every limit through", async () => {
    if (!available) return;
    const { srv, push } = await pushFiles({
      "A.md": "a".repeat(70),
      "B.md": "b".repeat(70),
      "C.md": "c\n",
    });

    await push;
    expect(await exists(join(srv, "A.md"))).toBe(true);
    expect(await git(srv, "status", "--porcelain")).toBe("");
  });

  it("does not count what the vault already holds: a one-line edit to a tree over the budget goes through", async () => {
    if (!available) return;
    const { srv, cli, push } = await pushFiles(
      { "P1.md": "1".repeat(69) + "!", "New.md": "new\n" },
      { existing: BIG_TREE },
    );

    await push;
    expect(await git(srv, "rev-parse", "main")).toBe(
      await git(cli, "rev-parse", "HEAD"),
    );
    expect(await git(srv, "status", "--porcelain")).toBe("");
    expect(await exists(join(srv, "New.md"))).toBe(true);
  });

  it("counts a changed file at its new size: an edit growing a page past the .md limit is refused", async () => {
    if (!available) return;
    const { srv, before, push } = await pushFiles(
      { "P2.md": "2".repeat(81) },
      { existing: BIG_TREE },
    );

    await expect(push).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "git-sync refused the push: 'P2.md' is 81 bytes (limit 80 per .md file).",
      ),
    });
    expect(await git(srv, "rev-parse", "main")).toBe(before);
  });

  it("refuses a push adding over the budget on top of a big tree", async () => {
    if (!available) return;
    const { srv, before, push } = await pushFiles(
      { "N1.md": "a\n", "N2.md": "b\n", "N3.md": "c\n", "N4.md": "d\n" },
      { existing: BIG_TREE },
    );

    await expect(push).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "refs/heads/main would add or change more than 3 files (the limit per push).",
      ),
    });
    expect(await git(srv, "rev-parse", "main")).toBe(before);
  });

  it("measures a new branch against main: a small change on top of a big tree goes through", async () => {
    if (!available) return;
    const { srv, cli, push } = await pushFiles(
      { "Draft.md": "draft\n" },
      { existing: BIG_TREE, ref: "refs/heads/draft" },
    );

    await push;
    expect(await git(srv, "rev-parse", "draft")).toBe(
      await git(cli, "rev-parse", "HEAD"),
    );
  });

  it("measures a new branch against main: one adding over the budget is refused", async () => {
    if (!available) return;
    const { srv, push } = await pushFiles(
      { "Huge.md": "h".repeat(81) },
      { existing: BIG_TREE, ref: "refs/heads/draft" },
    );

    await expect(push).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "git-sync refused the push: 'Huge.md' is 81 bytes (limit 80 per .md file).",
      ),
    });
    await expect(
      git(srv, "rev-parse", "--verify", "--quiet", "refs/heads/draft"),
    ).rejects.toThrow();
  });
});

describe("PUSH_GUARD_HOOK — the installed budget", () => {
  let available = false;
  let dir: string | undefined;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("holds a .md file to the converter's input budget (MAX_MARKDOWN_BYTES)", async () => {
    if (!available) return;
    expect(PUSH_BUDGET.markdownFileBytes).toBe(MAX_MARKDOWN_BYTES);
    dir = await mkdtemp(join(tmpdir(), "docmost-push-md-budget-"));
    const srv = join(dir, "srv");
    const cli = join(dir, "cli");
    const vault = new VaultGit(srv);
    await vault.ensureRepo();
    await git(srv, "config", "receive.denyCurrentBranch", "updateInstead");
    await vault.installPushGuard();
    await git(dir, "clone", "-q", srv, cli);
    // Over the converter's budget, far under the per-file one.
    await writeFile(join(cli, "Big.md"), "x".repeat(MAX_MARKDOWN_BYTES + 1), "utf8");
    await git(cli, "add", "-A");
    await git(cli, "commit", "-q", "-m", "user push");
    const before = await git(srv, "rev-parse", "main");

    await expect(
      execFileAsync("git", ["push", "origin", "main"], { cwd: cli }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `git-sync refused the push: 'Big.md' is ${MAX_MARKDOWN_BYTES + 1} bytes ` +
          `(limit ${MAX_MARKDOWN_BYTES} per .md file).`,
      ),
    });
    expect(await git(srv, "rev-parse", "main")).toBe(before);
    expect(await exists(join(srv, "Big.md"))).toBe(false);
  });
});
