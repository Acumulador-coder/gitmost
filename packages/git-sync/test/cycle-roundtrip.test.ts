import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializeDocmostMarkdownBody } from "@docmost/prosemirror-markdown";
import { cleanupVaults, gitAvailable, setupVault } from "./cycle-realgit-helpers";

// runCycle (apply -> export) against a REAL bare VaultGit, with a faked Docmost
// client: a git-originated CREATE reaches the client and the export writes the
// assigned id into the file on `main`. (The full two-way data-loss invariant —
// a local main edit surviving a concurrent Docmost edit — is exercised end to
// end against a live server in the git-sync e2e stand.)

describe("runCycle against a REAL VaultGit (integration)", () => {
  let available = false;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(cleanupVaults);

  it("runs the full apply -> export and delivers a git-originated CREATE to the client", async () => {
    if (!available) return; // skip gracefully when git is unavailable
    const h = await setupVault([]);

    // A human pushed a brand-new file (meta has title + spaceId but NO pageId)
    // -> the apply step must classify it as a CREATE.
    const newFile = serializeDocmostMarkdownBody(
      { version: 1, title: "From Git", spaceId: "space-1" },
      "a body authored in git",
    );
    await h.human((w) => writeFile(join(w, "From Git.md"), newFile, "utf8"));
    const res = await h.cycle();

    expect(res.ran).toBe(true);
    expect(res.push?.failures).toBe(0);
    expect(h.calls).toEqual([["create", "From Git"]]);

    // The export wrote the assigned pageId into the file on `main`.
    const main = await h.mainFiles();
    expect(Object.keys(main)).toEqual(["From Git.md"]);
    expect(main["From Git.md"]).toContain(`gitmost_id: ${h.pages[0].id}`);
    expect(main["From Git.md"]).toContain("a body authored in git");
  });
});
