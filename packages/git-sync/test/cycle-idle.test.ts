import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanupVaults,
  git,
  gitAvailable,
  setupVault,
  type FakePage,
} from "./cycle-realgit-helpers";
import { gitRunner } from "../src/engine/git-runner";

// The idle memo: a cycle over a space whose Docmost tree is unchanged since the
// last clean cycle runs no git at all. Driven against a REAL vault; git
// commands are counted where every one of them starts, at the git runner.

const A = "019f2a00-0000-7000-8000-00000000000a";
const B = "019f2a00-0000-7000-8000-00000000000b";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

function fixturePages(): FakePage[] {
  return [
    { id: A, slugId: "a", title: "Alpha", parentPageId: null, updatedAt: T0, text: "alpha body" },
    { id: B, slugId: "b", title: "Beta", parentPageId: null, updatedAt: T0, text: "beta body" },
  ];
}

/** How many git commands `run` starts. */
async function gitCommands(run: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(gitRunner, "run");
  try {
    await run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe("runCycle — an idle space runs no git", () => {
  let available = false;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(cleanupVaults);

  it("a second cycle over an unchanged space runs zero git commands", async () => {
    if (!available) return;
    const h = await setupVault(fixturePages(), { idle: true });
    expect(h.idle!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    h.client.listSpaceTree.mockClear();

    let result: unknown;
    const commands = await gitCommands(async () => {
      result = await h.cycle();
    });

    expect(commands).toBe(0);
    expect(result).toEqual({
      ran: true,
      pull: { written: 0, deleted: 0, failures: 0 },
      push: { mode: "apply", failures: 0 },
    });
    expect(h.client.listSpaceTree).toHaveBeenCalledTimes(1);
  });

  it("a page whose updatedAt changed gets a full cycle", async () => {
    if (!available) return;
    const h = await setupVault(fixturePages(), { idle: true });

    const a = h.pages.find((p) => p.id === A)!;
    a.updatedAt = T1;
    a.text = "alpha edited";

    expect(await gitCommands(() => h.cycle())).toBeGreaterThan(0);
    expect(await git(h.root, "show", "main:Alpha.md")).toContain("alpha edited");
    // Clean again: the next cycle is idle.
    expect(await gitCommands(() => h.cycle())).toBe(0);
  });

  it("a cycle with a push failure stores no memo, so the next one is full", async () => {
    if (!available) return;
    const h = await setupVault(fixturePages(), { idle: true });

    await h.human(h.edit("Alpha.md", "alpha body", "alpha from git"));
    h.failing.add(A);
    await h.cycle();

    expect(h.calls).toContainEqual(["import", A]);
    expect(h.idle!.fingerprint).toBeNull();
    expect(await gitCommands(() => h.cycle())).toBeGreaterThan(0);
  });

  it("a cycle whose export failed for a page stores no memo, so the page is retried", async () => {
    if (!available) return;
    const h = await setupVault(fixturePages(), { idle: true });

    const a = h.pages.find((p) => p.id === A)!;
    a.updatedAt = T1;
    a.text = "alpha edited";
    h.client.getPageJson.mockRejectedValueOnce(new Error("boom"));
    const result = (await h.cycle()) as { pull: { failures: number } };

    expect(result.pull.failures).toBe(1);
    expect(h.idle!.fingerprint).toBeNull();
    expect(await gitCommands(() => h.cycle())).toBeGreaterThan(0);
    expect(await git(h.root, "show", "main:Alpha.md")).toContain("alpha edited");
  });
});
