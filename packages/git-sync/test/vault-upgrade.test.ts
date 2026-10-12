import { access, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareVault, runCycle } from "../src/engine/cycle";
import { LAST_EXPORT_REF, VaultGit } from "../src/engine/git";
import { git, gitAvailable, makeClient, makeSettings } from "./cycle-realgit-helpers";

// A vault written by the two-merge engine (a non-bare repo with a working tree,
// a `docmost` branch, `refs/docmost/last-pushed`, and whatever a crash left) is
// upgraded in place under the lock to the bare layout; a fresh vault is bare
// from the start and stays bare.

const A = "019f2800-0000-7000-8000-00000000000a";
const T0 = "2026-10-01T00:00:00.000Z";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("upgradeLegacyVault (via prepareVault)", () => {
  let available = false;
  let dir: string | undefined;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /**
   * A two-merge vault: `docmost` at the last export, `main` one user commit
   * ahead, `last-pushed` at the export, and the given crash leftovers.
   */
  async function legacyVault(opts: { recording?: boolean; noDocmost?: boolean } = {}) {
    dir = await mkdtemp(join(tmpdir(), "docmost-legacy-"));
    const root = dir;
    await git(root, "init", "-q", "-b", "main");
    await writeFile(join(root, "Page.md"), `---\ngitmost_id: ${A}\n---\n\nalpha\n`, "utf8");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "docmost: export");
    const exported = await git(root, "rev-parse", "HEAD");
    if (!opts.noDocmost) await git(root, "branch", "docmost");
    await git(root, "update-ref", "refs/docmost/last-pushed", exported);
    await writeFile(join(root, "Page.md"), `---\ngitmost_id: ${A}\n---\n\nalpha GIT\n`, "utf8");
    await git(root, "commit", "-q", "-am", "user edit");
    if (opts.recording) await git(root, "update-ref", "refs/docmost/recording", "HEAD");
    await git(root, "config", "receive.denyCurrentBranch", "updateInstead");
    await git(root, "config", "merge.conflictStyle", "merge");
    // A crash left HEAD on `docmost`, a half-done merge and a stale index lock.
    if (!opts.noDocmost) await git(root, "symbolic-ref", "HEAD", "refs/heads/docmost");
    await writeFile(join(root, ".git", "MERGE_HEAD"), `${exported}\n`, "utf8");
    await writeFile(join(root, ".git", "MERGE_MSG"), "merge\n", "utf8");
    const lock = join(root, ".git", "index.lock");
    await writeFile(lock, "");
    const anHourAgo = Date.now() / 1000 - 3600;
    await utimes(lock, anHourAgo, anHourAgo);
    return { root, exported, userEdit: await git(root, "rev-parse", "main") };
  }

  const prepare = (root: string, warn = vi.fn()) =>
    prepareVault({ spaceId: "space-1", vault: new VaultGit(root), log: () => undefined, warn });

  it("upgrades a two-merge vault left mid-cycle: bare, HEAD on main, the pointer at the last shared commit, legacy state gone", async () => {
    if (!available) return;
    const { root, exported, userEdit } = await legacyVault();
    const warn = vi.fn();

    expect(await prepare(root, warn)).toBe(true);

    expect(await git(root, "config", "core.bare")).toBe("true");
    expect(await git(root, "config", "gitsync.layout")).toBe("2");
    await expect(git(root, "config", "receive.denyCurrentBranch")).rejects.toThrow();
    await expect(git(root, "config", "merge.conflictStyle")).rejects.toThrow();
    expect(await git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(await git(root, "rev-parse", "main", LAST_EXPORT_REF)).toBe(`${userEdit}\n${exported}`);
    expect(await git(root, "for-each-ref", "refs/heads/docmost", "refs/docmost/last-pushed")).toBe("");
    expect(await exists(join(root, ".git", "MERGE_HEAD"))).toBe(false);
    expect(await exists(join(root, ".git", "MERGE_MSG"))).toBe(false);
    expect(await exists(join(root, ".git", "index.lock"))).toBe(false);
    expect(warn).toHaveBeenCalledWith("space space-1: upgraded the vault to the bare layout.");

    // Idempotent: a second run leaves it alone.
    expect(await prepare(root)).toBe(false);

    // The first cycle applies the user's commit since the last export.
    const pages = [{ id: A, slugId: "a", title: "Page", parentPageId: null, updatedAt: T0, text: "alpha" }];
    const client = makeClient(pages);
    const res = await runCycle({
      spaceId: "space-1",
      client: client as any,
      vault: new VaultGit(root),
      settings: makeSettings(root),
      log: () => undefined,
    });
    expect(res.push?.failures).toBe(0);
    expect(client.importPageMarkdown).toHaveBeenCalledWith(A, "alpha GIT", "alpha");
  });

  it("a cut-off push record is where the pointer starts", async () => {
    if (!available) return;
    const { root, userEdit } = await legacyVault({ recording: true });

    await prepare(root);

    expect(await git(root, "rev-parse", LAST_EXPORT_REF)).toBe(userEdit);
    expect(await git(root, "for-each-ref", "refs/docmost/recording")).toBe("");
  });

  it("without a 'docmost' branch the pointer starts at 'main', with a warning", async () => {
    if (!available) return;
    const { root, userEdit } = await legacyVault({ noDocmost: true });
    const warn = vi.fn();

    await prepare(root, warn);

    expect(await git(root, "rev-parse", LAST_EXPORT_REF)).toBe(userEdit);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the last export starts at 'main'/));
  });

  it("a fresh vault is bare from the start; ensureRepo on it keeps core.bare=true and never re-initializes", async () => {
    if (!available) return;
    dir = await mkdtemp(join(tmpdir(), "docmost-fresh-"));
    const vault = new VaultGit(dir);

    expect(await vault.ensureRepo()).toBe(true);
    const main = await vault.revParse("refs/heads/main");
    expect(await vault.revParse(LAST_EXPORT_REF)).toBe(main);
    expect(await git(dir, "config", "core.bare")).toBe("true");

    expect(await vault.ensureRepo()).toBe(false);
    expect(await git(dir, "config", "core.bare")).toBe("true");
    expect(await vault.revParse("refs/heads/main")).toBe(main);
    expect(await prepare(dir)).toBe(false);
  });
});
