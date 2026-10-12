import { describe, it, expect, vi } from "vitest";
import { runCycle, type RunCycleDeps } from "../src/engine/cycle";
import { serializePageFile } from "@docmost/prosemirror-markdown";

// A fake VaultGit recording the ref and tree calls. An EMPTY vault/tree lets
// the real readExisting/computePullActions/buildExportTree/runPush run
// trivially (no files, no pages) so we can assert runCycle's choreography
// without real git. `main` and the last export start on different trees, so
// the apply step runs.
function fakeVault(overrides: Record<string, any> = {}) {
  const order: string[] = [];
  const rec =
    (name: string, ret?: any) =>
    async (...args: any[]) => {
      order.push(args.length ? `${name}:${args.join(",")}` : name);
      return ret;
    };
  const refs: Record<string, string> = {
    "refs/heads/main": "main0",
    "refs/docmost/last-export": "base0",
    "main0^{tree}": "tree-main",
    "base0^{tree}": "tree-base",
  };
  const vault: any = {
    order,
    assertGitAvailable: rec("assertGitAvailable"),
    ensureRepo: rec("ensureRepo", false),
    clearStaleGitLocks: rec("clearStaleGitLocks", 0),
    // The vault already has the bare layout: the legacy upgrade is a no-op.
    getConfig: vi.fn(async () => "2"),
    ensureMainBranch: rec("ensureMainBranch", false),
    revParse: vi.fn(async (ref: string) => refs[ref] ?? null),
    commitMessage: vi.fn(async () => "a user commit"),
    lsTree: vi.fn(async () => [] as any[]),
    pageIdsAtRef: vi.fn(async () => [] as any[]),
    readFilesAtRef: vi.fn(async () => new Map<string, string>()),
    hashObject: vi.fn(async () => "blob"),
    buildTree: vi.fn(async () => "tree-export"),
    treeWithPathsFrom: vi.fn(async () => "tree-record"),
    commitTree: rec("commitTree", "commit"),
    diffNameStatus: vi.fn(async () => [] as any[]),
    showFileAtRef: vi.fn(async () => ""),
    commitAddingPath: vi.fn(async () => null),
    updateRef: rec("updateRef"),
    ...overrides,
  };
  return vault;
}

function baseDeps(vault: any, over: Partial<RunCycleDeps> = {}): RunCycleDeps {
  return {
    spaceId: "space-1",
    client: {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      // Default: every candidate id is a real page row (historical behavior).
      pageIdsExist: vi.fn(async (ids: string[]) => ids),
      getPageJson: vi.fn(),
      importPageMarkdown: vi.fn(),
      createPage: vi.fn(),
      deletePage: vi.fn(),
      movePage: vi.fn(),
      renamePage: vi.fn(),
      listRecentSince: vi.fn(),
      listTrash: vi.fn(),
      restorePage: vi.fn(),
    } as any,
    vault,
    settings: { vaultPath: "/vault" } as any,
    log: vi.fn(),
    ...over,
  };
}

describe("runCycle (composition)", () => {
  it("runs a SINGLE push planning pass (no dry-run; the delete-cap hook is gone)", async () => {
    const vault = fakeVault();
    const deps = baseDeps(vault);

    const res = await runCycle(deps);
    expect(res.ran).toBe(true);
    // There is exactly one runPush (the apply) — no separate dry-run pass.
    // diffNameStatus is read once per runPush; assert a single planning pass.
    expect(vault.diffNameStatus).toHaveBeenCalledTimes(1);
  });

  it("throws on a PRE-aborted signal BEFORE the apply (first write phase)", async () => {
    const vault = fakeVault();
    const controller = new AbortController();
    controller.abort();
    const deps = baseDeps(vault, { signal: controller.signal });

    await expect(runCycle(deps)).rejects.toThrow();

    // Neither phase advanced: no push diff, no export tree, no ref moved.
    expect(vault.diffNameStatus).not.toHaveBeenCalled();
    expect(vault.buildTree).not.toHaveBeenCalled();
    expect(vault.order.some((o: string) => o.startsWith("updateRef"))).toBe(false);
  });

  it("throws BEFORE the export moves a ref when the signal aborts during the export read", async () => {
    // Abort mid-cycle: the signal fires while listSpaceTree (the export read)
    // runs, so the SECOND checkpoint (before the export) trips and no ref moves.
    const controller = new AbortController();
    const vault = fakeVault();
    const deps = baseDeps(vault, {
      signal: controller.signal,
      client: {
        ...baseDeps(vault).client,
        listSpaceTree: vi.fn(async () => {
          controller.abort();
          return { pages: [], complete: true };
        }),
      } as any,
    });

    await expect(runCycle(deps)).rejects.toThrow();
    // The apply ran; the export never did (aborted at a checkpoint).
    expect(vault.diffNameStatus).toHaveBeenCalledTimes(1);
    expect(vault.buildTree).not.toHaveBeenCalled();
    expect(vault.order.some((o: string) => o.startsWith("updateRef"))).toBe(false);
  });

  // D-P3-1 ghost guard, end-to-end through runCycle: a tracked file whose id is
  // absent from live AND is NOT returned by `pageIdsExist` (a ghost — never a
  // page) must SURVIVE the whole cycle (no rm), while a sibling id that IS
  // returned (a genuinely deleted page row) is absence-deleted. This proves the
  // guard flows from pageIdsExist -> computePullActions -> buildExportTree,
  // not just at the pure `planReconciliation` unit.
  it("GHOST GUARD (e2e): a ghost tracked file SURVIVES runCycle; a real deleted-page file is removed", async () => {
    const ghostId = "019f2500-dead-7000-8000-000000000009"; // never a page
    const deletedId = "019f2500-0000-7000-8000-000000000001"; // a real (deleted) row
    const liveId = "019f2500-0000-7000-8000-0000000000aa"; // keeps empty-live from firing

    // Two tracked files, both ABSENT from the live tree (deletion candidates).
    const texts = new Map([
      ["Ghost.md", serializePageFile(ghostId, "a body authored in git")],
      ["Deleted.md", serializePageFile(deletedId, "a deleted page body")],
    ]);
    const vault = fakeVault({
      pageIdsAtRef: vi.fn(async () => [
        { path: "Ghost.md", id: ghostId },
        { path: "Deleted.md", id: deletedId },
      ]),
      readFilesAtRef: vi.fn(async () => texts),
    });

    // The datasource reports ONLY the deleted page as a real row; the ghost has
    // no row (a PROPER SUBSET of the probed ids, not the identity shim).
    const pageIdsExist = vi.fn(async (ids: string[]) =>
      ids.filter((id) => id === deletedId),
    );
    const deps = baseDeps(vault, {
      client: {
        ...baseDeps(vault).client,
        // A single live page so the empty-live suppression does NOT fire (which
        // would mask the guard by suppressing every delete this cycle).
        listSpaceTree: vi.fn(async () => ({
          pages: [
            {
              id: liveId,
              slugId: "live",
              title: "Live",
              parentPageId: null,
              position: "a0",
              hasChildren: false,
            },
          ],
          complete: true,
        })),
        pageIdsExist,
        getPageJson: vi.fn(async (pageId: string) => ({
          id: pageId,
          slugId: "live",
          title: "Live",
          parentPageId: null,
          spaceId: "space-1",
          updatedAt: "2026-06-20T00:00:00.000Z",
          content: { type: "doc", content: [] },
        })),
      } as any,
    });

    const res = await runCycle(deps);
    expect(res.ran).toBe(true);

    // The guard probed the datasource for EXACTLY the absent candidate ids.
    expect(pageIdsExist).toHaveBeenCalledTimes(1);
    expect(new Set(pageIdsExist.mock.calls[0][0])).toEqual(
      new Set([ghostId, deletedId]),
    );

    // The real deleted-page file is removed; the ghost file is PRESERVED.
    const removed = vault.buildTree.mock.calls[0][1]
      .filter((c: { sha: string | null }) => c.sha === null)
      .map((c: { path: string }) => c.path);
    expect(removed).toEqual(["Deleted.md"]);
    expect(res.pull?.deleted).toBe(1);
  });
});
