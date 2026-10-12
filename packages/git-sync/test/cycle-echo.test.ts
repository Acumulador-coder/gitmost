import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupVaults,
  gitAvailable,
  setupVault,
  type FakePage,
} from "./cycle-realgit-helpers";

// An export never travels back to Docmost: the apply step carries only the
// user's commits since the last export, merged against the last export's body.
// Driven against a REAL vault so the observable property is the set of
// `importPageMarkdown` calls across real cycles.

const A = "019f2800-0000-7000-8000-00000000000a";
const N = "019f2800-0000-7000-8000-00000000000b";
const L = "019f2800-0000-7000-8000-0000000000ca";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

const onePage = (text: string): FakePage[] => [
  { id: A, slugId: "a", title: "Page", parentPageId: null, updatedAt: T0, text },
];

describe("runCycle — the apply never echoes an export", () => {
  let available = false;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(cleanupVaults);

  it("a Docmost edit exported in cycle 2 is not written back to Docmost", async () => {
    if (!available) return;
    const h = await setupVault(onePage("C1"));
    expect(h.client.importPageMarkdown).not.toHaveBeenCalled();

    h.pages[0].text = "C2";
    h.pages[0].updatedAt = T1;
    const res = await h.cycle();
    await h.cycle();

    expect((await h.mainFiles())["Page.md"]).toContain("C2");
    expect(res.push?.failures).toBe(0);
    expect(h.client.importPageMarkdown).not.toHaveBeenCalled();
  });

  it("a new Docmost page with null content is exported but never written back", async () => {
    if (!available) return;
    const h = await setupVault(onePage("C1"));

    h.pages.push({ id: N, slugId: "n", title: "Empty", parentPageId: null, updatedAt: T1, text: null });
    await h.cycle();
    await h.cycle();

    expect(Object.keys(await h.mainFiles()).sort()).toEqual(["Empty.md", "Page.md"]);
    expect(h.client.importPageMarkdown).not.toHaveBeenCalled();
  });

  it("a git edit is applied with the last export's body as its 3-way base", async () => {
    if (!available) return;
    const h = await setupVault(onePage("C1"));

    // Both sides change the one block: git wins it.
    h.pages[0].text = "C2";
    h.pages[0].updatedAt = T1;
    await h.human(h.edit("Page.md", "C1", "git edit"));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.client.importPageMarkdown).toHaveBeenCalledTimes(1);
    expect(h.client.importPageMarkdown).toHaveBeenCalledWith(A, "git edit", "C1");
    expect(h.pages[0].text).toBe("git edit");
    expect((await h.mainFiles())["Page.md"]).toContain("git edit");
  });

  it("a git edit and a concurrent Docmost edit of another block both survive", async () => {
    if (!available) return;
    const h = await setupVault(onePage("alpha\n\nmiddle\n\nomega"));

    h.pages[0].text = "alpha\n\nmiddle\n\nomega DOCMOST";
    h.pages[0].updatedAt = T1;
    await h.human(h.edit("Page.md", "alpha", "alpha GIT"));
    // The Docmost user keeps typing in that block while the export reads it.
    const read = h.client.getPageJson.getMockImplementation()!;
    h.client.getPageJson.mockImplementation(async (pageId: string) => {
      const page = await read(pageId);
      h.pages[0].text = "alpha GIT\n\nmiddle\n\nomega DOCMOST more";
      return page;
    });
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.client.importPageMarkdown).toHaveBeenCalledTimes(1);
    expect(h.pages[0].text).toBe("alpha GIT\n\nmiddle\n\nomega DOCMOST more");
    expect((await h.mainFiles())["Page.md"]).toContain("omega DOCMOST");
  });

  it("a git-written page stored with the editor's trailing paragraph exports to git's bytes: idle cycles change nothing", async () => {
    if (!available) return;
    const h = await setupVault(onePage("alpha"));

    // git adds a page ending in a list; Docmost stores it the way the editor
    // leaves it: a trailing empty paragraph after the list, block ids on every
    // paragraph.
    const item = (t: string) => ({
      type: "listItem",
      content: [{ type: "paragraph", attrs: { id: `id-${t}` }, content: [{ type: "text", text: t }] }],
    });
    h.client.createPage.mockImplementationOnce(async (title: string) => {
      h.pages.push({
        id: L,
        slugId: "l",
        title,
        parentPageId: null,
        updatedAt: T1,
        text: null,
        lastUpdatedSource: "git-sync",
        content: {
          type: "doc",
          content: [
            { type: "bulletList", content: [item("one"), item("two")] },
            { type: "paragraph", attrs: { id: "id-trailing" } },
          ],
        },
      });
      return { data: { id: L } };
    });
    await h.human((w) => writeFile(join(w, "List.md"), "- one\n- two\n", "utf8"));
    await h.cycle();
    const written = await h.mainFiles();
    expect(written["List.md"]).toBe(`---\ngitmost_id: ${L}\n---\n\n- one\n- two`);
    const heads = await h.heads();

    // Idle cycles, one re-exporting the page after a store touched it.
    h.pages[1].updatedAt = "2026-10-03T00:00:00.000Z";
    await h.cycle();
    await h.cycle();

    expect(await h.heads()).toBe(heads);
    expect(await h.mainFiles()).toEqual(written);
    expect(h.client.createPage).toHaveBeenCalledTimes(1);
    expect(h.client.importPageMarkdown).not.toHaveBeenCalled();
    expect(h.client.renamePage).not.toHaveBeenCalled();
    expect(h.client.movePage).not.toHaveBeenCalled();
    expect(h.client.deletePage).not.toHaveBeenCalled();
  });
});
