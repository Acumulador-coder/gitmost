import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupVaults, gitAvailable, setupVault } from "./cycle-realgit-helpers";

// A block both sides changed goes to git; every other block keeps Docmost's
// text, in the live page and in the export on `main`. Driven against a REAL
// vault with a block-level fake of the server's 3-way body merge.

const A = "019f2800-0000-7000-8000-00000000000a";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

describe("runCycle — a block both sides changed", () => {
  let available = false;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(cleanupVaults);

  const setup = () =>
    setupVault([
      { id: A, slugId: "a", title: "Page", parentPageId: null, updatedAt: T0, text: "alpha\n\nmiddle\n\nomega" },
    ]);

  it("git wins block 1; Docmost's block 3 edit survives in the live doc and on main", async () => {
    if (!available) return;
    const h = await setup();

    // Docmost edits blocks 1 and 3; git edits block 1 only.
    h.pages[0].text = "alpha DOC\n\nmiddle\n\nomega DOC";
    h.pages[0].updatedAt = T1;
    await h.human(h.edit("Page.md", "alpha", "alpha GIT"));
    const res = await h.cycle();

    expect(res.push?.failures).toBe(0);
    expect(h.pages[0].text).toBe("alpha GIT\n\nmiddle\n\nomega DOC");
    const onMain = (await h.mainFiles())["Page.md"];
    expect(onMain).toContain("alpha GIT");
    expect(onMain).toContain("omega DOC");
    expect(onMain).not.toContain("alpha DOC");
  });

  it.each([
    ["drops the final newline", (t: string) => t.replace(/\n+$/, "")],
    ["adds trailing blank lines", (t: string) => `${t}\n\n`],
  ])(
    "a git commit that %s does not revert Docmost's last-block edit",
    async (_name, retail) => {
      if (!available) return;
      const h = await setup();

      // Docmost edits blocks 1 and 3; git edits block 1 and changes the file's tail.
      h.pages[0].text = "alpha DOC\n\nmiddle\n\nomega DOC";
      h.pages[0].updatedAt = T1;
      await h.human(async (w) => {
        const file = join(w, "Page.md");
        const text = await readFile(file, "utf8");
        await writeFile(file, retail(text.replace("alpha", "alpha GIT")), "utf8");
      });
      const res = await h.cycle();

      expect(res.push?.failures).toBe(0);
      expect(h.pages[0].text).toBe("alpha GIT\n\nmiddle\n\nomega DOC");
      expect((await h.mainFiles())["Page.md"]).toContain("omega DOC");
    },
  );
});
