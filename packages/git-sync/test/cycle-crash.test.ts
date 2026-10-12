import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LAST_EXPORT_REF } from "../src/engine/git";
import { cleanupVaults, gitAvailable, setupVault } from "./cycle-realgit-helpers";

// A cycle cut off at any point leaves the vault in a state the next cycle
// finishes: before `main` moves nothing moved (the apply is re-run and is
// idempotent); between `main` and the pointer, `prepareVault` moves the pointer
// from the export commit's trailers. Driven against a REAL vault.

const A = "019f2800-0000-7000-8000-00000000000a";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

describe("runCycle — a cycle cut off", () => {
  let available = false;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(cleanupVaults);

  const setup = () =>
    setupVault([
      { id: A, slugId: "a", title: "Page", parentPageId: null, updatedAt: T0, text: "alpha\n\nmiddle\n\nomega" },
    ]);

  it("an export cut off before 'main' moves leaves both refs unchanged; the next cycle exports it", async () => {
    if (!available) return;
    const h = await setup();
    const heads = await h.heads();

    h.pages[0].text = "alpha DOC1\n\nmiddle\n\nomega";
    h.pages[0].updatedAt = T1;
    await expect(h.cycle(h.crashingBefore("refs/heads/main"))).rejects.toThrow(/crash before/);
    expect(await h.heads()).toBe(heads);

    h.pages[0].text = "alpha DOC2\n\nmiddle\n\nomega";
    h.pages[0].updatedAt = "2026-10-03T00:00:00.000Z";
    await h.cycle();

    expect(h.client.importPageMarkdown).not.toHaveBeenCalled();
    expect((await h.mainFiles())["Page.md"]).toContain("alpha DOC2");
  });

  it("a cycle cut off after its apply re-applies the git edit idempotently", async () => {
    if (!available) return;
    const h = await setup();

    h.pages[0].text = "alpha\n\nmiddle\n\nomega DOC";
    h.pages[0].updatedAt = T1;
    await h.human(h.edit("Page.md", "alpha", "alpha GIT"));
    await expect(h.cycle(h.crashingBefore("refs/heads/main"))).rejects.toThrow(/crash before/);
    expect(h.pages[0].text).toBe("alpha GIT\n\nmiddle\n\nomega DOC");

    await h.cycle();

    expect(h.calls).toEqual([["import", A]]);
    expect(h.pages[0].text).toBe("alpha GIT\n\nmiddle\n\nomega DOC");
    const onMain = (await h.mainFiles())["Page.md"];
    expect(onMain).toContain("alpha GIT");
    expect(onMain).toContain("omega DOC");
  });

  it("a cycle cut off between 'main' and the pointer is repaired from the trailers: the export is never applied back", async () => {
    if (!available) return;
    const h = await setup();
    const [, pointer0] = (await h.heads()).split("\n");

    h.pages[0].text = "alpha\n\nmiddle\n\nomega DOC";
    h.pages[0].updatedAt = T1;
    await h.human(h.edit("Page.md", "alpha", "alpha GIT"));
    await expect(h.cycle(h.crashingBefore(LAST_EXPORT_REF))).rejects.toThrow(/crash before/);
    const [main1, pointer1] = (await h.heads()).split("\n");
    expect(pointer1).toBe(pointer0);
    expect(main1).not.toBe(pointer0);

    await h.cycle();

    expect(await h.heads()).toBe(`${main1}\n${main1}`);
    expect(h.calls).toEqual([]);
    expect(h.warnings).toEqual([
      expect.stringMatching(/was cut off before the last-export pointer moved/),
    ]);
    expect(h.pages[0].text).toBe("alpha GIT\n\nmiddle\n\nomega DOC");
  });

  it("an abort between the apply's page operations stops the cycle with a CycleAbortedError; the next cycle converges", async () => {
    if (!available) return;
    const h = await setup();
    await h.human(async (w) => {
      await writeFile(join(w, "One.md"), "one\n", "utf8");
      await writeFile(join(w, "Two.md"), "two\n", "utf8");
    });
    const heads = await h.heads();
    const controller = new AbortController();
    const create = h.client.createPage.getMockImplementation()!;
    h.client.createPage.mockImplementationOnce(async (...args: Parameters<typeof create>) => {
      const res = await create(...args);
      controller.abort(new Error("the space lock was lost"));
      return res;
    });

    await expect(h.cycle(h.vault, controller.signal)).rejects.toMatchObject({
      name: "CycleAbortedError",
      message: expect.stringMatching(/^git-sync stopped .*: the space lock was lost$/),
    });
    // Stopped after the first create: the second page was never sent, no ref moved.
    expect(h.pages.map((p) => p.title).sort()).toEqual(["One", "Page"]);
    expect(await h.heads()).toBe(heads);

    await h.cycle();

    // The first create is adopted, not made twice.
    expect(h.pages.map((p) => p.title).sort()).toEqual(["One", "Page", "Two"]);
    expect(Object.keys(await h.mainFiles()).sort()).toEqual(["One.md", "Page.md", "Two.md"]);
  });

  it("an abort during the export's conversions stops the cycle with a CycleAbortedError before any ref moves", async () => {
    if (!available) return;
    const h = await setup();
    const heads = await h.heads();
    h.pages[0].text = "alpha DOC\n\nmiddle\n\nomega";
    h.pages[0].updatedAt = T1;
    const controller = new AbortController();
    const get = h.client.getPageJson.getMockImplementation()!;
    h.client.getPageJson.mockImplementationOnce(async (id: string) => {
      controller.abort(new Error("the cycle deadline passed"));
      return get(id);
    });

    await expect(h.cycle(h.vault, controller.signal)).rejects.toMatchObject({
      name: "CycleAbortedError",
    });
    expect(await h.heads()).toBe(heads);

    await h.cycle();

    expect((await h.mainFiles())["Page.md"]).toContain("alpha DOC");
  });

  it("both sides rename the page and git edits it: git's title and one file", async () => {
    if (!available) return;
    const h = await setup();

    h.pages[0].title = "New";
    h.pages[0].text = "alpha\n\nmiddle\n\nomega DOC";
    h.pages[0].updatedAt = T1;
    await h.human(async (w) => {
      const text = await readFile(join(w, "Page.md"), "utf8");
      await rm(join(w, "Page.md"));
      await writeFile(join(w, "Mine.md"), text.replace("alpha", "alpha GIT"), "utf8");
    });
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.client.renamePage).toHaveBeenCalledWith(A, "Mine");
    expect(h.client.createPage).not.toHaveBeenCalled();
    expect(h.pages[0].text).toBe("alpha GIT\n\nmiddle\n\nomega DOC");
    expect(Object.keys(await h.mainFiles())).toEqual(["Mine.md"]);
  });
});
