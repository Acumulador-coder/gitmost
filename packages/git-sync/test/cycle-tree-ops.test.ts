import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupVaults,
  git,
  gitAvailable,
  setupVault,
  type FakePage,
} from "./cycle-realgit-helpers";

// Renames, copies and folders made in git, alone or while Docmost changes the
// same pages. Driven against a REAL vault and a fake Docmost that applies every
// write.

const A = "019f2800-0000-7000-8000-00000000000a";
const C = "019f2800-0000-7000-8000-0000000000c4";
const P = "019f2800-0000-7000-8000-0000000000c5";
const X = "019f2800-0000-7000-8000-0000000000c7";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

const onePage = (): FakePage[] => [
  { id: A, slugId: "a", title: "Page", parentPageId: null, updatedAt: T0, text: "alpha\n\nmiddle\n\nomega" },
];
const parentAndChild = (): FakePage[] => [
  { id: P, slugId: "p", title: "P", parentPageId: null, updatedAt: T0, text: "pa\n\npb" },
  { id: C, slugId: "c", title: "Child", parentPageId: P, updatedAt: T0, text: "ca\n\ncb" },
];

/** Move `from` to `to` in the clone, editing its text on the way. */
const move =
  (from: string, to: string, change: (t: string) => string = (t) => t) =>
  async (w: string) => {
    const text = await readFile(join(w, from), "utf8");
    await rm(join(w, from));
    await mkdir(join(w, to, ".."), { recursive: true });
    await writeFile(join(w, to), change(text), "utf8");
  };

describe("runCycle — renames, copies, folders", () => {
  let available = false;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(cleanupVaults);

  it.each([
    ["untouched in Docmost", "omega"],
    ["edited in Docmost", "omega DOC"],
  ])("a git rename (with an edit) of a page %s renames the page and keeps both edits", async (_name, omega) => {
    if (!available) return;
    const h = await setupVault(onePage());

    h.pages[0].text = `alpha\n\nmiddle\n\n${omega}`;
    h.pages[0].updatedAt = T1;
    await h.human(move("Page.md", "Mine.md", (t) => t.replace("alpha", "alpha GIT")));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.client.renamePage).toHaveBeenCalledWith(A, "Mine");
    expect(h.client.deletePage).not.toHaveBeenCalled();
    expect(h.client.createPage).not.toHaveBeenCalled();
    expect(h.pages[0].text).toBe(`alpha GIT\n\nmiddle\n\n${omega}`);
    expect(Object.keys(await h.mainFiles())).toEqual(["Mine.md"]);

    // It stays that way.
    await h.cycle();
    await h.cycle();
    expect(Object.keys(await h.mainFiles())).toEqual(["Mine.md"]);
    expect(h.client.createPage).not.toHaveBeenCalled();
    expect(h.pages[0].text).toBe(`alpha GIT\n\nmiddle\n\n${omega}`);
  });

  it("a copy of a page file (same gitmost_id) edited in git becomes a new page; the original stays as it was", async () => {
    if (!available) return;
    const h = await setupVault(onePage());

    await h.human(async (w) => {
      const text = await readFile(join(w, "Page.md"), "utf8");
      await writeFile(join(w, "Page copy.md"), text.replace("middle", "middle COPY"), "utf8");
    });
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.calls).toEqual([["create", "Page copy"]]);
    expect(h.client.createPage).toHaveBeenCalledWith("Page copy", "alpha\n\nmiddle COPY\n\nomega", "space-1", undefined);
    expect(h.pages[0].text).toBe("alpha\n\nmiddle\n\nomega");
    const copy = h.pages[1].id;
    const main = await h.mainFiles();
    expect(Object.keys(main).sort()).toEqual(["Page copy.md", "Page.md"]);
    expect(main["Page.md"]).toContain(`gitmost_id: ${A}`);
    expect(main["Page copy.md"]).toContain(`gitmost_id: ${copy}`);

    // Both files survive the next cycles, each its own page.
    await h.cycle();
    await h.cycle();
    expect(Object.keys(await h.mainFiles()).sort()).toEqual(["Page copy.md", "Page.md"]);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["edited in Docmost", "omega DOC"],
    ["untouched in Docmost", "omega"],
  ])(
    "a git rename plus an editor copy of the renamed file, page %s: the renamed file stays the page, the copy becomes a new page",
    async (_name, omega) => {
      if (!available) return;
      const h = await setupVault(onePage());

      h.pages[0].text = `alpha\n\nmiddle\n\n${omega}`;
      h.pages[0].updatedAt = T1;
      // Obsidian names a copy "<name> 1.md", which sorts before "<name>.md".
      await h.human(async (w) => {
        const renamed = (await readFile(join(w, "Page.md"), "utf8")).replace("alpha", "alpha GIT");
        await rm(join(w, "Page.md"));
        await writeFile(join(w, "Meeting.md"), renamed, "utf8");
        await writeFile(join(w, "Meeting 1.md"), renamed.replace("middle", "middle NEXT"), "utf8");
      });
      const res = await h.cycle();

      expect(res.push?.failures).toBe(0);
      expect(h.client.renamePage).toHaveBeenCalledWith(A, "Meeting");
      expect(h.pages[0].text).toBe(`alpha GIT\n\nmiddle\n\n${omega}`);
      for (const [, , base] of h.client.importPageMarkdown.mock.calls) {
        expect(base).not.toBeNull();
      }
      expect(h.client.createPage).toHaveBeenCalledTimes(1);
      expect(h.client.createPage).toHaveBeenCalledWith(
        "Meeting 1",
        "alpha GIT\n\nmiddle NEXT\n\nomega",
        "space-1",
        undefined,
      );
      const main = await h.mainFiles();
      expect(Object.keys(main).sort()).toEqual(["Meeting 1.md", "Meeting.md"]);
      expect(main["Meeting.md"]).toContain(`gitmost_id: ${A}`);
      expect(main["Meeting 1.md"]).toContain(`gitmost_id: ${h.pages[1].id}`);

      await h.cycle();
      expect(Object.keys(await h.mainFiles()).sort()).toEqual(["Meeting 1.md", "Meeting.md"]);
      expect(h.client.createPage).toHaveBeenCalledTimes(1);
    },
  );

  it("Docmost gives a page its first child while git edits the page: both edits survive", async () => {
    if (!available) return;
    const h = await setupVault([parentAndChild()[0]]);

    h.pages.push({ id: C, slugId: "c", title: "Child", parentPageId: P, updatedAt: T1, text: "child" });
    h.pages[0].text = "pa\n\npb DOC";
    h.pages[0].updatedAt = T1;
    await h.human(h.edit("P.md", "pa", "pa GIT"));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.pages[0].text).toBe("pa GIT\n\npb DOC");
    expect(Object.keys(await h.mainFiles()).sort()).toEqual(["P/Child.md", "P/P.md"]);
  });

  it("Docmost renames a folder page while git edits a child in it: both edits survive", async () => {
    if (!available) return;
    const h = await setupVault(parentAndChild());

    h.pages[0].title = "R";
    h.pages[0].updatedAt = T1;
    h.pages[1].text = "ca\n\ncb DOC";
    h.pages[1].updatedAt = T1;
    await h.human(h.edit("P/Child.md", "ca", "ca GIT"));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.pages[1].text).toBe("ca GIT\n\ncb DOC");
    expect(Object.keys(await h.mainFiles()).sort()).toEqual(["R/Child.md", "R/R.md"]);
  });

  it("git adds a child to a folder page Docmost renamed meanwhile: the child is created under the renamed page", async () => {
    if (!available) return;
    const h = await setupVault(parentAndChild());

    h.pages[0].title = "R";
    h.pages[0].updatedAt = T1;
    await h.human((w) => writeFile(join(w, "P", "New.md"), "brand new child\n", "utf8"));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.client.createPage).toHaveBeenCalledWith("New", "brand new child", "space-1", P);
    expect(Object.keys(await h.mainFiles()).sort()).toEqual(["R/Child.md", "R/New.md", "R/R.md"]);
    await h.cycle();
    expect(Object.keys(await h.mainFiles()).sort()).toEqual(["R/Child.md", "R/New.md", "R/R.md"]);
    expect(h.client.createPage).toHaveBeenCalledTimes(1);
  });

  it("git moves a page into a folder page Docmost renamed meanwhile: the page moves under the renamed page", async () => {
    if (!available) return;
    const h = await setupVault([
      ...parentAndChild(),
      { id: X, slugId: "x", title: "X", parentPageId: null, updatedAt: T0, text: "xa" },
    ]);

    h.pages[0].title = "R";
    h.pages[0].updatedAt = T1;
    await h.human(move("X.md", "P/X.md"));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.client.movePage).toHaveBeenCalledWith(X, P);
    expect(Object.keys(await h.mainFiles()).sort()).toEqual(["R/Child.md", "R/R.md", "R/X.md"]);
    await h.cycle();
    expect(Object.keys(await h.mainFiles()).sort()).toEqual(["R/Child.md", "R/R.md", "R/X.md"]);
    expect(h.client.movePage).toHaveBeenCalledTimes(1);
  });

  it("git adds a child to a folder, then deletes the folder page: the child is not placed under the page this push deletes", async () => {
    if (!available) return;
    const h = await setupVault(parentAndChild());

    await h.human((w) => writeFile(join(w, "P", "New.md"), "brand new child\n", "utf8"));
    await h.human((w) => rm(join(w, "P", "P.md")));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.client.deletePage).toHaveBeenCalledWith(P);
    expect(h.client.createPage).toHaveBeenCalledWith("New", "brand new child", "space-1", undefined);
  });

  it("a Docmost folder page titled '.git' exports as '_.git/…': the tree write does not fail the space's export", async () => {
    if (!available) return;
    const h = await setupVault([
      { id: P, slugId: "p", title: ".git", parentPageId: null, updatedAt: T0, text: "pa" },
      { id: C, slugId: "c", title: "Child", parentPageId: P, updatedAt: T0, text: "ca" },
    ]);

    expect(Object.keys(await h.mainFiles()).sort()).toEqual(["_.git/Child.md", "_.git/_.git.md"]);
    await h.cycle();
    expect(h.calls).toEqual([]);
  });

  it("a pushed symlink is never a page: its target is not read into Docmost and the entry stays as pushed", async () => {
    if (!available) return;
    const h = await setupVault(onePage());

    await h.human((w) => symlink("/etc/passwd", join(w, "leak.md")));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.calls).toEqual([]);
    expect(await git(h.root, "ls-tree", "main", "leak.md")).toMatch(/^120000 blob /);
    expect(await git(h.root, "show", "main:leak.md")).toBe("/etc/passwd");
  });
});
