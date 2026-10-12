import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LAST_EXPORT_REF, VaultGit } from "../src/engine/git";
import {
  cleanupVaults,
  git,
  gitAvailable,
  setupVault,
  ts,
  type FakePage,
} from "./cycle-realgit-helpers";

// A page whose apply fails keeps git's file on `main` and its last-export
// version in the pointer (a record commit off the last export), so the next
// cycle retries that page alone; every page that reached Docmost moves on.
// Driven against a REAL vault and a fake Docmost that applies every write.

const P = "019f2800-0000-7000-8000-0000000000a1";
const BAD = "019f2800-0000-7000-8000-0000000000b1";

const pagesOf = (texts: { id: string; title: string; text: string }[]): FakePage[] =>
  texts.map((t, i) => ({
    id: t.id,
    slugId: `s${i}`,
    title: t.title,
    parentPageId: null,
    updatedAt: ts(),
    text: t.text,
  }));
const two = (page = "pa") =>
  pagesOf([
    { id: P, title: "Page", text: page },
    { id: BAD, title: "Bad", text: "bad" },
  ]);
const files = async (h: { mainFiles: () => Promise<Record<string, string>> }) =>
  Object.keys(await h.mainFiles()).sort();

describe("runCycle — a push with failures", () => {
  let available = false;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(cleanupVaults);

  it("a page that keeps failing does not hold back a pushed page: a later Docmost edit of it is kept, it is not re-imported, and the failing page is retried alone", async () => {
    if (!available) return;
    const h = await setupVault(two("alpha\n\nbeta"));
    h.failing.add(BAD);
    await h.human(async (w) => {
      await h.edit("Bad.md", "bad", "bad GIT")(w);
      await h.edit("Page.md", "beta", "__beta2__")(w);
    });
    await h.cycle();
    await h.cycle();
    const page = h.pages.find((p) => p.id === P)!;
    expect(page.text).toBe("alpha\n\n__beta2__");

    // A Docmost user edits the block git changed.
    page.text = "alpha\n\ngamma (docmost edit)";
    page.updatedAt = ts();
    let settled = "";
    for (let i = 0; i < 4; i++) {
      const res = await h.cycle();
      expect(res.push?.failures).toBe(1);
      // The log names the failed page and the reason.
      expect(h.warnings).toEqual([
        `space space-1: push update of Bad.md failed: injected failure for ${BAD}`,
      ]);
      // Only the failing page is retried, once per cycle; Page is never re-sent.
      expect(h.calls).toEqual([["import", BAD]]);
      if (i === 1) settled = await h.heads();
    }

    expect(page.text).toBe("alpha\n\ngamma (docmost edit)");
    const main = await h.mainFiles();
    expect(main["Bad.md"]).toContain("bad GIT");
    expect(main["Page.md"]).toContain("gamma (docmost edit)");
    // The pointer keeps Bad.md's last-export version.
    expect(await git(h.root, "show", `${LAST_EXPORT_REF}:Bad.md`)).not.toContain("bad GIT");
    // A page that keeps failing adds no commits.
    expect(await h.heads()).toBe(settled);
  });

  it.each([
    ["keeps failing", (h: { failing: Set<string> }) => h.failing.add(BAD)],
    ["fails once", (h: { failOnce: Set<string> }) => h.failOnce.add(`import:${BAD}`)],
  ])("a new page pushed alongside a page that %s is created once", async (name, inject) => {
    if (!available) return;
    const h = await setupVault(two());
    inject(h);
    await h.human(async (w) => {
      await h.edit("Bad.md", "bad", "bad GIT")(w);
      await writeFile(join(w, "New.md"), "* item one\n* item two\n\n__bold__ text\n", "utf8");
    });

    const creates: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await h.cycle();
      creates.push(...h.calls.filter((c) => c[0] === "create"));
    }

    expect(creates).toEqual([["create", "New"]]);
    expect(await files(h)).toEqual(["Bad.md", "New.md", "Page.md"]);
    expect(h.pages.map((p) => p.title).sort()).toEqual(["Bad", "New", "Page"]);
    expect((await h.mainFiles())["Bad.md"]).toContain("bad GIT");
    if (name === "fails once") expect(h.pages.find((p) => p.id === BAD)?.text).toBe("bad GIT");
  });

  it.each([
    ["before 'main' moved", "refs/heads/main"],
    ["between 'main' and the pointer", LAST_EXPORT_REF],
  ])(
    "a cycle with a failed page cut off %s is finished by the next cycle: no loss, no duplicate",
    async (_when, ref) => {
      if (!available) return;
      const h = await setupVault(two());
      h.failOnce.add(`import:${BAD}`);
      await h.human(async (w) => {
        await h.edit("Bad.md", "bad", "bad GIT")(w);
        await writeFile(join(w, "New.md"), "new body\n", "utf8");
      });

      await expect(h.cycle(h.crashingBefore(ref))).rejects.toThrow(/crash before/);
      expect(h.calls.filter((c) => c[0] === "create")).toEqual([["create", "New"]]);

      const creates: string[][] = [];
      for (let i = 0; i < 3; i++) {
        await h.cycle();
        creates.push(...h.calls.filter((c) => c[0] === "create"));
      }

      expect(creates).toEqual([]);
      expect(await files(h)).toEqual(["Bad.md", "New.md", "Page.md"]);
      expect(h.pages.map((p) => p.title).sort()).toEqual(["Bad", "New", "Page"]);
      expect(h.pages.find((p) => p.id === BAD)?.text).toBe("bad GIT");
      expect((await h.mainFiles())["New.md"]).toContain("new body");
      const [main, pointer] = (await h.heads()).split("\n");
      expect(pointer).toBe(main);
    },
  );

  it("a delete that failed is retried, not dropped: git's deletion is not reverted", async () => {
    if (!available) return;
    const h = await setupVault(two("alpha"));
    h.failOnce.add(`delete:${BAD}`);
    await h.human(async (w) => {
      await unlink(join(w, "Bad.md"));
      await h.edit("Page.md", "alpha", "alpha GIT")(w);
    });

    const deletes: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await h.cycle();
      deletes.push(...h.calls.filter((c) => c[0] === "delete"));
    }

    expect(deletes).toEqual([
      ["delete", BAD],
      ["delete", BAD],
    ]);
    expect(h.pages.map((p) => p.title)).toEqual(["Page"]);
    expect(await files(h)).toEqual(["Page.md"]);
    expect(h.pages[0].text).toBe("alpha GIT");
  });

  it("a rename that failed is retried at both paths: no copy of the page", async () => {
    if (!available) return;
    const h = await setupVault(two("alpha"));
    h.failOnce.add(`rename:${BAD}`);
    await h.human(async (w) => {
      await git(w, "mv", "Bad.md", "Renamed.md");
      await h.edit("Page.md", "alpha", "alpha GIT")(w);
    });

    const ops: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await h.cycle();
      ops.push(...h.calls.filter((c) => c[0] !== "import"));
    }

    expect(ops).toEqual([
      ["rename", BAD],
      ["rename", BAD],
    ]);
    expect(h.pages.map((p) => p.title).sort()).toEqual(["Page", "Renamed"]);
    expect(await files(h)).toEqual(["Page.md", "Renamed.md"]);
  });

  it("a renamed page whose body update failed is retried at both paths: no copy of the page", async () => {
    if (!available) return;
    const h = await setupVault(two("alpha"));
    h.failOnce.add(`import:${BAD}`);
    await h.human(async (w) => {
      await git(w, "mv", "Bad.md", "Renamed.md");
      await h.edit("Renamed.md", "bad", "bad GIT")(w);
    });

    const creates: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await h.cycle();
      creates.push(...h.calls.filter((c) => c[0] === "create"));
    }

    expect(creates).toEqual([]);
    expect(h.pages.map((p) => [p.title, p.text]).sort()).toEqual([
      ["Page", "alpha"],
      ["Renamed", "bad GIT"],
    ]);
    expect(await files(h)).toEqual(["Page.md", "Renamed.md"]);
  });

  it("a child whose parent's create failed is not created at the root: both land nested on retry", async () => {
    if (!available) return;
    const h = await setupVault(pagesOf([{ id: P, title: "Page", text: "pa" }]));
    h.failOnce.add("create:Parent");
    await h.human(async (w) => {
      await mkdir(join(w, "Parent"));
      await writeFile(join(w, "Parent", "Parent.md"), "parent body\n", "utf8");
      await writeFile(join(w, "Parent", "Child.md"), "child body\n", "utf8");
    });

    for (let i = 0; i < 3; i++) await h.cycle();

    const parent = h.pages.find((p) => p.title === "Parent")!;
    const child = h.pages.find((p) => p.title === "Child")!;
    expect(child.parentPageId).toBe(parent.id);
    expect(h.pages.map((p) => p.title).sort()).toEqual(["Child", "Page", "Parent"]);
    expect(await files(h)).toEqual(["Page.md", "Parent/Child.md", "Parent/Parent.md"]);
  });

  it("a push into a fresh vault before the space's first cycle reaches Docmost", async () => {
    if (!available) return;
    const h = await setupVault(pagesOf([{ id: P, title: "Page", text: "pa" }]), {
      firstCycle: false,
    });
    // A clone made the vault (ensureServable -> ensureRepo) and the push landed
    // before the space's first cycle.
    await new VaultGit(h.root).ensureRepo();
    await h.human((w) => writeFile(join(w, "Fresh.md"), "fresh body\n", "utf8"));

    await h.cycle();

    expect(h.calls).toEqual([["create", "Fresh"]]);
    expect(h.pages.map((p) => p.title).sort()).toEqual(["Fresh", "Page"]);
    expect(await files(h)).toEqual(["Fresh.md", "Page.md"]);
  });

  it("a failing page next to a git edit the export normalises away: the next cycle sees no cut-off export and re-reads no page", async () => {
    if (!available) return;
    const h = await setupVault(two("alpha"));
    const [, pointer0] = (await h.heads()).split("\n");
    h.failing.add(BAD);
    await h.human(async (w) => {
      await h.edit("Bad.md", "bad", "bad GIT")(w);
      await h.edit("Page.md", "alpha", "alpha\n\n\n")(w);
    });

    await h.cycle();
    // The export put Page.md back in its last-export form and kept Bad.md back:
    // an export commit whose record is the export's own start.
    const [main1, pointer1] = (await h.heads()).split("\n");
    expect(main1).not.toBe(pointer1);
    expect(pointer1).toBe(pointer0);
    expect(await git(h.root, "log", "-1", "--format=%B", "main")).toContain(
      `Docmost-Sync-Last-Export: ${pointer0}`,
    );
    expect(await git(h.root, "show", "main:Page.md")).toBe(
      await git(h.root, "show", `${LAST_EXPORT_REF}:Page.md`),
    );

    h.client.getPageJson.mockClear();
    await h.cycle();
    expect(h.warnings).toEqual([
      `space space-1: push update of Bad.md failed: injected failure for ${BAD}`,
    ]);
    expect(h.client.getPageJson).not.toHaveBeenCalled();
    expect(await h.heads()).toBe(`${main1}\n${pointer1}`);
  });

  it("Docmost renames a page to the name a failing page holds: the page keeps its file until the path is released, then both land", async () => {
    if (!available) return;
    const h = await setupVault(two("alpha"));
    h.failing.add(BAD);
    await h.human(h.edit("Bad.md", "bad", "bad GIT"));
    const page = h.pages.find((p) => p.id === P)!;
    page.title = "Bad";
    page.updatedAt = ts();

    await h.cycle();
    await h.cycle();
    let main = await h.mainFiles();
    expect(Object.keys(main).sort()).toEqual(["Bad.md", "Page.md"]);
    expect(main["Page.md"]).toContain(`gitmost_id: ${P}`);
    expect(await git(h.root, "show", `${LAST_EXPORT_REF}:Page.md`)).toContain(`gitmost_id: ${P}`);

    // Siblings both titled "Bad": the lower slugId (Page's s0) keeps the bare name.
    h.failing.delete(BAD);
    await h.cycle();
    main = await h.mainFiles();
    expect(Object.keys(main).sort()).toEqual(["Bad ~s1.md", "Bad.md"]);
    expect(main["Bad.md"]).toContain(`gitmost_id: ${P}`);
    expect(main["Bad ~s1.md"]).toContain(`gitmost_id: ${BAD}`);
    expect(main["Bad ~s1.md"]).toContain("bad GIT");
  });

  it("a push without failures moves the pointer to 'main': no record commit", async () => {
    if (!available) return;
    const h = await setupVault(pagesOf([{ id: P, title: "Page", text: "alpha" }]));
    await h.human(h.edit("Page.md", "alpha", "alpha GIT"));
    const pushed = await git(h.root, "rev-parse", "main");

    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.calls).toEqual([["import", P]]);
    // The export of the applied page is git's file byte for byte: no new commit.
    expect(await h.heads()).toBe(`${pushed}\n${pushed}`);
  });
});
