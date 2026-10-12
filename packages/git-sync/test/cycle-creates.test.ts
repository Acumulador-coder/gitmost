import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupVaults,
  gitAvailable,
  setupVault,
  type FakePage,
} from "./cycle-realgit-helpers";

// A file git adds without a gitmost_id becomes a page. A same-title page
// Docmost has keeps its text: it is adopted only when it is git-sync's own
// create cut off before its export (not in the last export, last written by
// git-sync, still empty or holding the file's body). Driven against a REAL vault.

const A = "019f2800-0000-7000-8000-00000000000a";
const N = "019f2800-0000-7000-8000-00000000000b";
const S = "019f2800-0000-7000-8000-0000000000c8";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

const page = (text: string): FakePage => ({
  id: A,
  slugId: "a",
  title: "Page",
  parentPageId: null,
  updatedAt: T0,
  text,
});

describe("runCycle — creates", () => {
  let available = false;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(cleanupVaults);

  it("git adds a file at the title of a page Docmost created meanwhile (carrying another page's id): both stay, each its own page", async () => {
    if (!available) return;
    const h = await setupVault([page("C1")]);

    h.pages.push({ id: N, slugId: "n", title: "New", parentPageId: null, updatedAt: T1, text: "docmost text" });
    await h.human((w) =>
      writeFile(join(w, "New.md"), `---\ngitmost_id: ${A}\n---\n\ngit text\n`, "utf8"),
    );
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.calls).toEqual([["create", "New"]]);
    expect(h.client.createPage).toHaveBeenCalledWith("New", "git text", "space-1", undefined);
    const created = h.pages.find((p) => p.title === "New" && p.id !== N)!;
    const main = await h.mainFiles();
    expect(Object.keys(main).sort()).toEqual(["New ~" + created.slugId + ".md", "New.md", "Page.md"]);
    expect(main["New.md"]).toContain(`gitmost_id: ${N}`);
    expect(main["New.md"]).toContain("docmost text");
    expect(main[`New ~${created.slugId}.md`]).toContain(`gitmost_id: ${created.id}`);
    expect(main[`New ~${created.slugId}.md`]).toContain("git text");
    expect(main["Page.md"]).toContain(`gitmost_id: ${A}`);
  });

  it("Docmost renames and edits a page while git edits it at the old path and adds an unrelated file at the new title: both edits land, git's file becomes its own page", async () => {
    if (!available) return;
    const h = await setupVault([{ ...page("p1\n\np2\n\np3"), title: "Old" }]);

    h.pages[0].title = "New";
    h.pages[0].text = "p1\n\np2\n\np3 DOC";
    h.pages[0].updatedAt = T1;
    await h.human(async (w) => {
      await h.edit("Old.md", "p1", "p1 GIT")(w);
      await writeFile(join(w, "New.md"), "an unrelated git page\n", "utf8");
    });
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.pages[0].text).toBe("p1 GIT\n\np2\n\np3 DOC");
    expect(h.client.createPage).toHaveBeenCalledTimes(1);
    expect(h.client.createPage).toHaveBeenCalledWith("New", "an unrelated git page", "space-1", undefined);
    const created = h.pages[1];
    const main = await h.mainFiles();
    expect(Object.keys(main).sort()).toEqual([`New ~${created.slugId}.md`, "New.md"]);
    expect(main["New.md"]).toContain(`gitmost_id: ${A}`);
    expect(main[`New ~${created.slugId}.md`]).toContain("an unrelated git page");
  });

  it.each([
    ["git-sync last wrote it but it holds other text", "git-sync", "valuable docmost content"],
    ["a user made it, empty", "user", null],
  ])(
    "a same-title page that %s is not taken over: git's file becomes its own page",
    async (_name, source, text) => {
      if (!available) return;
      const h = await setupVault([page("alpha")]);

      await h.human((w) => writeFile(join(w, "New.md"), "my brand new notes\n", "utf8"));
      h.pages.push({ id: S, slugId: "s", title: "New", parentPageId: null, updatedAt: T1, text, lastUpdatedSource: source });
      const res = await h.cycle();

      expect(res.push?.failures).toBe(0);
      expect(h.pages.find((p) => p.id === S)?.text).toBe(text);
      expect(h.client.createPage).toHaveBeenCalledWith("New", "my brand new notes", "space-1", undefined);
      const main = await h.mainFiles();
      expect(Object.keys(main).sort()).toEqual(["New ~s.md", "New.md", "Page.md"]);
      expect(main["New.md"]).toContain("my brand new notes");
      expect(main["New ~s.md"]).toContain(`gitmost_id: ${S}`);
    },
  );

  it.each([
    ["before its body write", null, undefined, "brand new content\n"],
    ["after its body write", "brand new content", undefined, "brand new content\n"],
    [
      "holding git's body in canonical form",
      null,
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "bold", marks: [{ type: "bold" }] },
              { type: "text", text: " text" },
            ],
          },
        ],
      },
      "__bold__ text\n",
    ],
  ])(
    "a create cut off %s converges to ONE page with git's content",
    async (_name, text, content, file) => {
      if (!available) return;
      const h = await setupVault([page("alpha")]);

      // git pushed New.md; a cycle created page "New" in Docmost and died before
      // its export recorded the id: a page git-sync made, not in the last export.
      await h.human((w) => writeFile(join(w, "New.md"), file, "utf8"));
      h.pages.push({ id: S, slugId: "s", title: "New", parentPageId: null, updatedAt: T1, text, content, lastUpdatedSource: "git-sync" });

      const res = await h.cycle();

      expect(res.push?.failures).toBe(0);
      expect(h.client.createPage).not.toHaveBeenCalled();
      expect(h.client.importPageMarkdown).toHaveBeenCalledWith(S, file.trim(), null);
      const main = await h.mainFiles();
      expect(Object.keys(main).sort()).toEqual(["New.md", "Page.md"]);
      expect(main["New.md"]).toContain(`gitmost_id: ${S}`);
      await h.cycle();
      expect(Object.keys(await h.mainFiles()).sort()).toEqual(["New.md", "Page.md"]);
      expect(h.client.createPage).not.toHaveBeenCalled();
      expect(h.pages).toHaveLength(2);
    },
  );
});
