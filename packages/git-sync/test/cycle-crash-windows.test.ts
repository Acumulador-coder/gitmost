import "./git-env";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parsePageFile, serializePageFile } from "@docmost/prosemirror-markdown";
import { VaultGit } from "../src/engine/git";
import { git, gitAvailable } from "./cycle-realgit-helpers";
import {
  Crash,
  Injector,
  cycleOnce,
  docmostEdit,
  endState,
  exportOf,
  mainFiles,
  newDocmostState,
  recover,
  serviceRefs,
  statefulClient,
  type DocmostState,
} from "./interruption-helpers";

// The windows a crash (or the cycle's AbortSignal) can cut a push or a pull at,
// each driven against a REAL vault and a stateful fake Docmost: whatever is cut
// off, the next cycles end with one page per gitmost_id and one file per page,
// and nothing the push half-wrote is taken for content.

const P = "019f2a00-0000-7000-8000-0000000000a1";
const BAD = "019f2a00-0000-7000-8000-0000000000b1";

// A new page in markdown Docmost exports differently, so git's file and the
// page's export differ and meet as a real add/add.
const NEW_MD = "* item one\n* item two\n\n__bold__ text\n";

describe("runCycle — crash windows of a push and a pull", () => {
  let available = false;
  let dir: string | undefined;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A vault synced with Docmost by one clean cycle. */
  async function setup(): Promise<{ root: string; state: DocmostState }> {
    dir = await mkdtemp(join(tmpdir(), "docmost-crash-window-"));
    const state = await newDocmostState([
      { id: P, title: "Page", text: "alpha" },
      { id: BAD, title: "Bad", text: "bad" },
    ]);
    await new VaultGit(dir).ensureRepo();
    await cycleOnce(dir, state);
    return { root: dir, state };
  }

  /** Change `main` and commit it, as a person pushing would. */
  async function human(root: string, change: () => Promise<void>): Promise<void> {
    await change();
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "human change");
  }

  /** A crash right before the vault sets `ref`. */
  function crashBeforeRef(ref: string): Injector {
    return new Injector((label) => label.startsWith(`git update-ref ${ref} `));
  }

  /** A crash in the push's write of `abs`, cut off part-way (`truncate`). */
  function crashInPushWrite(abs: string, truncate: boolean): Injector {
    let pushing = false;
    return new Injector((label) => {
      if (label.startsWith("git update-ref refs/docmost/pushing ")) pushing = true;
      return pushing && label === `writeFile ${abs}`;
    }, truncate);
  }

  async function settle(root: string, state: DocmostState): Promise<void> {
    await recover(root);
    await cycleOnce(root, state);
    await cycleOnce(root, state);
  }

  it.each([
    ["at the same path", "New.md", "New", ["Bad.md", "New.md", "Page.md"]],
    ["at another path (its title sanitizes to another name)", "What?.md", "What?", ["Bad.md", "Page.md", "What-.md"]],
  ])(
    "a page created by a push cut off after its id reached main, before 'docmost' recorded it, is ONE page %s",
    async (_where, file, title, files) => {
      if (!available) return;
      const { root, state } = await setup();
      state.failOnce.push(`import:${BAD}`);
      await human(root, async () => {
        const bad = join(root, "Bad.md");
        await writeFile(bad, (await readFile(bad, "utf8")).replace("bad", "bad GIT"), "utf8");
        await writeFile(join(root, file), NEW_MD, "utf8");
      });

      await expect(
        cycleOnce(root, state, { inj: crashBeforeRef("refs/docmost/recording") }),
      ).rejects.toBeInstanceOf(Crash);
      // The id write-back reached main; 'docmost' does not have the page.
      expect(parsePageFile(await git(root, "show", `main:${file}`)).id).not.toBeNull();
      // A person edits the new page before the next cycle: it is no longer
      // git-sync's own untouched create, so only identity can keep it one page.
      const created = state.pages.find((p) => p.title === title)!;
      await docmostEdit(state, created.id, "edited in Docmost");

      await settle(root, state);

      const end = await endState(root, state);
      expect(end.problems).toEqual([]);
      expect(state.pages.map((p) => p.title).sort()).toEqual(["Bad", "Page", title].sort());
      expect((await mainFiles(root)).map((f) => f.path).sort()).toEqual(files);
      expect(exportOf(state.pages.find((p) => p.id === BAD)!.doc).trim()).toBe("bad GIT");
      expect(exportOf(created.doc).trim()).toBe("edited in Docmost");
    },
  );

  it("a create write-back cut off part-way is put back, not committed: one page, no '~git' copy", async () => {
    if (!available) return;
    const { root, state } = await setup();
    await human(root, () => writeFile(join(root, "New.md"), NEW_MD, "utf8"));

    await expect(
      cycleOnce(root, state, {
        inj: crashInPushWrite(`${root}/New.md`, true),
      }),
    ).rejects.toBeInstanceOf(Crash);
    const cut = await readFile(join(root, "New.md"), "utf8");
    expect(cut.length).toBeGreaterThan(0);
    expect(parsePageFile(cut).body).not.toBe(parsePageFile(NEW_MD).body);

    const warnings: string[] = [];
    expect(await recover(root, (l) => warnings.push(l))).toBe(true);
    expect(warnings.join("\n")).toMatch(/put 1 cut-off one\(s\) back/);
    expect(await readFile(join(root, "New.md"), "utf8")).toBe(NEW_MD);
    expect(await git(root, "status", "--porcelain")).toBe("");

    await cycleOnce(root, state);
    await cycleOnce(root, state);

    const end = await endState(root, state);
    expect(end.problems).toEqual([]);
    expect(state.pages.map((p) => p.title).sort()).toEqual(["Bad", "New", "Page"]);
    expect((await mainFiles(root)).map((f) => f.path).sort()).toEqual([
      "Bad.md",
      "New.md",
      "Page.md",
    ]);
  });

  it("a complete create write-back left uncommitted is committed by recovery: the file keeps the page's id", async () => {
    if (!available) return;
    const { root, state } = await setup();
    await human(root, () => writeFile(join(root, "New.md"), NEW_MD, "utf8"));

    await expect(
      cycleOnce(root, state, {
        inj: new Injector(
          (label) => label.startsWith("git commit") && label.includes("record created pageIds"),
        ),
      }),
    ).rejects.toBeInstanceOf(Crash);
    const created = state.pages.find((p) => p.title === "New")!;

    const warnings: string[] = [];
    await recover(root, (l) => warnings.push(l));
    expect(warnings.join("\n")).toMatch(/committed 1 complete one\(s\) \(New\.md\)/);
    expect(parsePageFile(await git(root, "show", "main:New.md")).id).toBe(created.id);

    await cycleOnce(root, state);
    await cycleOnce(root, state);

    expect((await endState(root, state)).problems).toEqual([]);
    expect(state.pages.filter((p) => p.title === "New")).toHaveLength(1);
  });

  it("a clean write-back of a conflicted page cut off part-way never clears the page (autoMergeConflicts on)", async () => {
    if (!available) return;
    const { root, state } = await setup();
    const conflicted = "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n";
    await human(root, () =>
      writeFile(join(root, "Page.md"), serializePageFile(P, conflicted), "utf8"),
    );

    await expect(
      cycleOnce(root, state, {
        autoMergeConflicts: true,
        inj: crashInPushWrite(`${root}/Page.md`, true),
      }),
    ).rejects.toBeInstanceOf(Crash);

    await recover(root);
    expect(await readFile(join(root, "Page.md"), "utf8")).toBe(
      serializePageFile(P, conflicted),
    );
    await cycleOnce(root, state, { autoMergeConflicts: true });
    await cycleOnce(root, state, { autoMergeConflicts: true });

    expect((await endState(root, state)).problems).toEqual([]);
    const page = exportOf(state.pages.find((p) => p.id === P)!.doc);
    expect(page).toContain("mine");
    expect(page).toContain("theirs");
    expect(page).not.toMatch(/<<<<<<<|>>>>>>>/);
  });

  it("an abort between the push's page operations stops the cycle with a CycleAbortedError; the next cycles converge", async () => {
    if (!available) return;
    const { root, state } = await setup();
    await human(root, async () => {
      await writeFile(join(root, "One.md"), "one\n", "utf8");
      await writeFile(join(root, "Two.md"), "two\n", "utf8");
    });
    const controller = new AbortController();
    const client = statefulClient(state, (op) => {
      if (op.startsWith("createPage")) controller.abort(new Error("the space lock was lost"));
    });

    await expect(
      cycleOnce(root, state, { client, signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "CycleAbortedError",
      message: expect.stringMatching(/^git-sync stopped .*: the space lock was lost$/),
    });
    // Stopped after the first create: the second page was never sent.
    expect(state.pages.map((p) => p.title).sort()).toEqual(["Bad", "One", "Page"]);

    await settle(root, state);

    expect((await endState(root, state)).problems).toEqual([]);
    expect(state.pages.map((p) => p.title).sort()).toEqual(["Bad", "One", "Page", "Two"]);
  });

  it("an abort during the pull's conversions stops the cycle with a CycleAbortedError; the vault recovers", async () => {
    if (!available) return;
    const { root, state } = await setup();
    const controller = new AbortController();
    const base = statefulClient(state);
    const client = {
      ...base,
      getPageJson: async (id: string) => {
        controller.abort(new Error("the cycle deadline passed"));
        return base.getPageJson(id);
      },
    };

    await expect(
      cycleOnce(root, state, { client, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "CycleAbortedError" });

    await settle(root, state);
    expect((await endState(root, state)).problems).toEqual([]);
  });

  it("recovery deletes the retired refs/docmost/last-pushed", async () => {
    if (!available) return;
    const { root } = await setup();
    await git(root, "update-ref", "refs/docmost/last-pushed", "main");

    await recover(root);

    expect(await serviceRefs(root)).toBe("");
  });
});
