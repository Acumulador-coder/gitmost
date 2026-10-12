import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BOT_AUTHOR_EMAIL, BOT_AUTHOR_NAME, VaultGit } from "../src/engine/git";
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
    const exported = await vault.commitTree(tree, [main0], "docmost: export", {
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
