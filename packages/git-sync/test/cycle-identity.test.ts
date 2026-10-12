import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupVaults,
  gitAvailable,
  setupVault,
  type FakePage,
} from "./cycle-realgit-helpers";

// Page identity is the gitmost_id, never the path: a git edit at a path
// Docmost has since given to another page still reaches the page it was made
// on, and the export then places each page at its own path. Driven against a
// REAL vault.

const A = "019f2800-0000-7000-8000-00000000000a";
const N1 = "019f2800-0000-7000-8000-0000000000c1";
const N2 = "019f2800-0000-7000-8000-0000000000c2";
const Q = "019f2800-0000-7000-8000-0000000000c3";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

describe("runCycle — identity is the gitmost_id", () => {
  let available = false;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(cleanupVaults);

  it("Docmost renames a page and edits block 3 while git edits block 1 at the old path: both edits land, Docmost's title and path stay", async () => {
    if (!available) return;
    const h = await setupVault([
      { id: A, slugId: "a", title: "Page", parentPageId: null, updatedAt: T0, text: "alpha\n\nmiddle\n\nomega" },
    ]);

    h.pages[0].title = "Renamed";
    h.pages[0].text = "alpha\n\nmiddle\n\nomega DOC";
    h.pages[0].updatedAt = T1;
    await h.human(h.edit("Page.md", "alpha", "alpha GIT"));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.pages[0].text).toBe("alpha GIT\n\nmiddle\n\nomega DOC");
    expect(h.client.renamePage).not.toHaveBeenCalled();
    expect(h.client.movePage).not.toHaveBeenCalled();
    const main = await h.mainFiles();
    expect(Object.keys(main)).toEqual(["Renamed.md"]);
    expect(main["Renamed.md"]).toContain("alpha GIT");
    expect(main["Renamed.md"]).toContain("omega DOC");
  });

  const twoNotes = (one: string, two: string): FakePage[] => [
    { id: N1, slugId: "a1", title: "Notes", parentPageId: null, updatedAt: T0, text: one },
    { id: N2, slugId: "b2", title: "Notes", parentPageId: null, updatedAt: T0, text: two },
  ];

  it.each([
    ["different", "agenda one\n\nalpha\n\nbeta", "agenda two\n\ngamma\n\ndelta", ["agenda one", "agenda one GIT"]],
    ["identical", "same body\n\nline two\n\nline three", "same body\n\nline two\n\nline three", ["line three", "line three GIT"]],
  ])(
    "a git edit of a page whose bare path Docmost gave to its same-title sibling stays with that page (%s bodies)",
    async (_name, one, two, [from, to]) => {
      if (!available) return;
      const h = await setupVault(twoNotes(one, two));
      expect(Object.keys(await h.mainFiles()).sort()).toEqual(["Notes ~b2.md", "Notes.md"]);

      // Docmost retitles N1, so N2 takes the bare Notes.md; git edits Notes.md (N1).
      h.pages[0].title = "Notes 2023";
      h.pages[0].updatedAt = T1;
      await h.human(h.edit("Notes.md", from, to));
      const res = await h.cycle();

      expect(res.push?.failures).toBe(0);
      expect(h.pages[0].text).toBe(one.replace(from, to));
      expect(h.pages[1].text).toBe(two);
      const main = await h.mainFiles();
      expect(Object.keys(main).sort()).toEqual(["Notes 2023.md", "Notes.md"]);
      expect(main["Notes 2023.md"]).toContain(`gitmost_id: ${N1}`);
      expect(main["Notes 2023.md"]).toContain(to);
      expect(main["Notes.md"]).toContain(`gitmost_id: ${N2}`);
      expect(main["Notes.md"]).not.toContain(to);
    },
  );

  it("Docmost removes a page and its same-title sibling takes the bare path while git edits the sibling: the removed page stays removed", async () => {
    if (!available) return;
    const h = await setupVault(twoNotes("agenda one\n\nalpha\n\nbeta", "agenda two\n\ngamma\n\ndelta"));

    h.pages.splice(0, 1); // N1 goes to the trash; N2 takes Notes.md
    await h.human(h.edit("Notes ~b2.md", "agenda two", "agenda two GIT"));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.pages[0].text).toBe("agenda two GIT\n\ngamma\n\ndelta");
    expect(h.calls).toEqual([["import", N2]]);
    const main = await h.mainFiles();
    expect(Object.keys(main)).toEqual(["Notes.md"]);
    expect(main["Notes.md"]).toContain(`gitmost_id: ${N2}`);
  });

  it("Docmost renames a page and creates another under the old title while git edits the old path: each page keeps its own text", async () => {
    if (!available) return;
    const h = await setupVault([
      { id: A, slugId: "a", title: "Old", parentPageId: null, updatedAt: T0, text: "p1\n\np2\n\np3" },
    ]);

    h.pages[0].title = "New";
    h.pages[0].updatedAt = T1;
    h.pages.push({ id: Q, slugId: "q", title: "Old", parentPageId: null, updatedAt: T1, text: "q1\n\nq2\n\nq3" });
    await h.human(h.edit("Old.md", "p1", "p1 GIT"));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.pages[0].text).toBe("p1 GIT\n\np2\n\np3");
    expect(h.pages[1].text).toBe("q1\n\nq2\n\nq3");
    expect(h.calls).toEqual([["import", A]]);
    const main = await h.mainFiles();
    expect(Object.keys(main).sort()).toEqual(["New.md", "Old.md"]);
    expect(main["New.md"]).toContain(`gitmost_id: ${A}`);
    expect(main["New.md"]).toContain("p1 GIT");
    expect(main["Old.md"]).toContain(`gitmost_id: ${Q}`);
  });
});
