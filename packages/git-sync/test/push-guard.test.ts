import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_MARKDOWN_BYTES } from "../src/engine/convert-pool";
import {
  BOT_AUTHOR_EMAIL,
  BOT_AUTHOR_NAME,
  PUSH_BUDGET,
  VaultGit,
  buildPushGuardHook,
} from "../src/engine/git";
import { execFileAsync, git, gitAvailable } from "./cycle-realgit-helpers";

// Pushes into a bare vault set up as the server serves it: a push based on an
// older `main` is refused (pull first), a push to the engine's own refs is
// refused by the pre-receive hook, an up-to-date push lands. Driven against a
// REAL receive-pack.

describe("pushes into the vault", () => {
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
    await vault.installPushGuard();
    await git(dir, "clone", "-q", srv, cli);
    await writeFile(join(cli, "C.md"), "pushed\n", "utf8");
    await git(cli, "add", "C.md");
    await git(cli, "commit", "-q", "-m", "user push");
    return { srv, cli, vault };
  }

  it("refuses a push based on an older main (an export landed since): main keeps the export", async () => {
    if (!available) return;
    const { srv, cli, vault } = await setup();
    // An export commit lands on `main` after the clone was made.
    const main0 = (await vault.revParse("refs/heads/main"))!;
    const tree = await vault.buildTree(main0, [
      { path: "B.md", sha: await vault.hashObject("docmost edit\n") },
    ]);
    const exported = await vault.commitTree(tree, [main0], "docmost: edit 1 page(s)", {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });
    await vault.updateRef("refs/heads/main", exported, main0);

    await expect(
      execFileAsync("git", ["push", "origin", "main"], { cwd: cli }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("rejected") });
    expect(await vault.revParse("refs/heads/main")).toBe(exported);
  });

  it("refuses a push to the engine's own refs: they do not move", async () => {
    if (!available) return;
    const { srv, cli } = await setup();
    const before = await git(srv, "for-each-ref", "refs/heads/docmost", "refs/docmost");

    for (const ref of ["refs/heads/docmost", "refs/docmost/last-export"]) {
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

  it("lets a push from an up-to-date clone through", async () => {
    if (!available) return;
    const { srv, cli } = await setup();

    await git(cli, "push", "-q", "origin", "main");

    expect(await git(srv, "rev-parse", "main")).toBe(
      await git(cli, "rev-parse", "HEAD"),
    );
    expect(await git(srv, "show", "main:C.md")).toBe("pushed");
  });
});

/** Commit `files` (path -> text) on the vault's `main` with plumbing, as an export does. */
async function commitOnMain(vault: VaultGit, files: Record<string, string>): Promise<void> {
  const main0 = (await vault.revParse("refs/heads/main"))!;
  const changes = [];
  for (const [path, text] of Object.entries(files)) {
    changes.push({ path, sha: await vault.hashObject(text) });
  }
  const commit = await vault.commitTree(
    await vault.buildTree(main0, changes),
    [main0],
    `docmost: edit ${changes.length} page(s)`,
    { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL },
  );
  await vault.updateRef("refs/heads/main", commit, main0);
}

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
   * A space exported far over BUDGET: more files, more bytes and a page bigger
   * than the `.md` limit, already on `main`.
   */
  const BIG_TREE: Record<string, string> = {
    "Exported.md": "e".repeat(90),
    "P1.md": "1".repeat(70),
    "P2.md": "2".repeat(70),
    "P3.md": "3".repeat(70),
    "P4.md": "4".repeat(70),
  };

  /**
   * A vault guarded by a hook with BUDGET, holding `existing` (path -> content)
   * on `main` as an export would have committed it, and a clone that commits
   * `files` on top of it and pushes them to `ref`.
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
    const hooks = join(await vault.gitDir(), "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "pre-receive"), buildPushGuardHook(BUDGET), { mode: 0o755 });
    if (opts.existing) await commitOnMain(vault, opts.existing);
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
    expect(await git(srv, "show", "main:A.md")).toBe("a".repeat(70));
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
    expect(await git(srv, "show", "main:New.md")).toBe("new");
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
  });
});
