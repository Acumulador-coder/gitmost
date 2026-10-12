import "./git-env";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultGit } from "../src/engine/git";
import { git, gitAvailable } from "./cycle-realgit-helpers";
import {
  Injector,
  cycleOnce,
  docmostCreate,
  docmostEdit,
  endState,
  newDocmostState,
  recover,
  type DocmostState,
} from "./interruption-helpers";

// The interruption matrix (DESIGN.md §8): every scenario's cycle is cut off
// right before each of its effects in turn — every git command that changes
// refs, the index or the working tree, every file write, mkdir and rm, every
// Docmost write — and, for a file write, also part-way through it. After the
// crash the vault is recovered and two cycles run; the space must then hold
// exactly what the same scenario holds without a crash, with every gitmost_id
// naming one page and one file, no service ref left and `main` holding each
// page's markdown.
//
// The default run cuts each scenario at a few effects spread over its cycle;
// GIT_SYNC_INTERRUPTION_SWEEP=full cuts it at EVERY effect (an on-demand run).

const FULL = process.env.GIT_SYNC_INTERRUPTION_SWEEP === "full";
/** Cut points per scenario in the default run (about one in the pull, one in the push). */
const SAMPLED_CUTS = 2;

const PAGE = "019f2b00-0000-7000-8000-0000000000a1";
const OTHER = "019f2b00-0000-7000-8000-0000000000a2";
const FOLDER = "019f2b00-0000-7000-8000-0000000000a3";
const CHILD = "019f2b00-0000-7000-8000-0000000000a4";
const SAME = "019f2b00-0000-7000-8000-0000000000a5";

// A new page in markdown Docmost exports differently (git's file and the
// page's export differ).
const NEW_MD = "* item one\n* item two\n\n__bold__ text\n";

/** A space: the vault (`srv`), a clone of it (`cli`) and the fake Docmost. */
interface Space {
  root: string;
  srv: string;
  cli: string;
  state: DocmostState;
}

interface Scenario {
  name: string;
  /** What happens before the cycle that is cut off. */
  prepare: (s: Space) => Promise<void>;
  /** What happens between the recovery and the two settling cycles. */
  afterRecovery?: (s: Space) => Promise<void>;
}

async function edit(abs: string, from: string, to: string): Promise<void> {
  const text = await readFile(abs, "utf8");
  if (!text.includes(from)) throw new Error(`${abs} has no ${JSON.stringify(from)}`);
  await writeFile(abs, text.replace(from, to), "utf8");
}

/** A person's commit on the vault's `main`. */
async function commit(srv: string, change: () => Promise<void>): Promise<void> {
  await change();
  await git(srv, "add", "-A");
  await git(srv, "commit", "-q", "-m", "human change");
}

/** A person's push from the clone, rebased on the vault's `main` first. */
async function pushFromClone(s: Space, change: () => Promise<void>): Promise<void> {
  await git(s.cli, "fetch", "-q", "origin");
  await git(s.cli, "rebase", "-q", "origin/main");
  await change();
  await git(s.cli, "add", "-A");
  await git(s.cli, "commit", "-q", "-m", "pushed change");
  await git(s.cli, "push", "-q", "origin", "HEAD:main");
}

const SCENARIOS: Scenario[] = [
  {
    name: "create",
    prepare: async (s) => {
      await commit(s.srv, () => writeFile(join(s.srv, "New.md"), NEW_MD, "utf8"));
      await docmostEdit(s.state, OTHER, "other\n\nedited in Docmost");
    },
  },
  {
    name: "rename",
    prepare: async (s) => {
      await git(s.srv, "mv", "Page.md", "Renamed.md");
      await commit(s.srv, () => edit(join(s.srv, "Renamed.md"), "alpha", "alpha GIT"));
      await docmostEdit(s.state, PAGE, "alpha\n\nbeta DOC");
    },
  },
  {
    name: "move",
    prepare: async (s) => {
      await git(s.srv, "mv", "Page.md", "Folder/Page.md");
      await commit(s.srv, async () => undefined);
      await docmostEdit(s.state, OTHER, "other\n\nedited in Docmost");
    },
  },
  {
    name: "partial failure",
    prepare: async (s) => {
      s.state.failOnce.push(`import:${OTHER}`);
      await commit(s.srv, async () => {
        await edit(join(s.srv, "Page.md"), "alpha", "alpha GIT");
        await edit(join(s.srv, "Other.md"), "other", "other GIT");
        await writeFile(join(s.srv, "New.md"), NEW_MD, "utf8");
      });
    },
  },
  {
    name: "add-add",
    prepare: async (s) => {
      await docmostCreate(s.state, SAME, "Same", "from Docmost");
      await commit(s.srv, () => writeFile(join(s.srv, "Same.md"), "from git\n", "utf8"));
    },
  },
  {
    name: "external push",
    prepare: async (s) => {
      await pushFromClone(s, () => edit(join(s.cli, "Page.md"), "alpha", "alpha PUSHED"));
      await docmostEdit(s.state, PAGE, "alpha\n\nbeta DOC");
    },
    afterRecovery: (s) =>
      pushFromClone(s, () => edit(join(s.cli, "Other.md"), "other", "other PUSHED")),
  },
];

/** The cut points of a cycle with `count` effects. */
function cutPoints(count: number): number[] {
  if (FULL) return Array.from({ length: count }, (_, i) => i + 1);
  const cuts = new Set<number>();
  for (let i = 1; i <= SAMPLED_CUTS; i++) {
    cuts.add(Math.max(1, Math.round((i * count) / (SAMPLED_CUTS + 1))));
  }
  return [...cuts];
}

describe("runCycle — the interruption matrix", () => {
  let available = false;
  let tmp: string;

  beforeAll(async () => {
    available = await gitAvailable();
    tmp = await mkdtemp(join(tmpdir(), "docmost-interruption-"));
  });

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  /** A synced, servable vault with a clone, then the scenario's preparation. */
  async function prepared(scenario: Scenario, root: string): Promise<Space> {
    const srv = join(root, "srv");
    const cli = join(root, "cli");
    await mkdir(srv, { recursive: true });
    const state = await newDocmostState([
      { id: PAGE, title: "Page", text: "alpha\n\nbeta" },
      { id: OTHER, title: "Other", text: "other" },
      { id: FOLDER, title: "Folder", text: "folder" },
      { id: CHILD, title: "Child", text: "child", parentPageId: FOLDER },
    ]);
    const vault = new VaultGit(srv);
    await vault.ensureRepo();
    await vault.ensureServableConfig();
    await vault.installPushGuard();
    await cycleOnce(srv, state);
    await git(root, "clone", "-q", srv, cli);
    const space = { root, srv, cli, state };
    await scenario.prepare(space);
    return space;
  }

  /** A copy of the prepared space to cut one cycle of. */
  async function copyOf(snapshot: Space, name: string): Promise<Space> {
    const root = join(tmp, name);
    await cp(snapshot.root, root, { recursive: true });
    const space = {
      root,
      srv: join(root, "srv"),
      cli: join(root, "cli"),
      state: structuredClone(snapshot.state),
    };
    await git(space.cli, "remote", "set-url", "origin", space.srv);
    await new VaultGit(space.srv).ensureServableConfig();
    return space;
  }

  /** Run the cycle through `inj`, then recover and settle; the end state. */
  async function run(scenario: Scenario, space: Space, inj: Injector) {
    let crash: unknown = null;
    try {
      await cycleOnce(space.srv, space.state, { inj });
    } catch (err) {
      crash = err;
    }
    await recover(space.srv);
    await scenario.afterRecovery?.(space);
    await cycleOnce(space.srv, space.state);
    await cycleOnce(space.srv, space.state);
    return { crash, end: await endState(space.srv, space.state) };
  }

  for (const scenario of SCENARIOS) {
    it(
      `${scenario.name}: a cycle cut off at any effect ends like an uncut one`,
      async () => {
        if (!available) return;
        const slug = scenario.name.replace(/\W+/g, "-");
        const snapshot = await prepared(scenario, join(tmp, `${slug}-snapshot`));

        // The uncut run: how many effects the cycle has, and the end state
        // every cut run must reach.
        const counter = new Injector();
        const uncut = await run(scenario, await copyOf(snapshot, `${slug}-uncut`), counter);
        expect(uncut.crash).toBeNull();
        expect(uncut.end.problems).toEqual([]);
        expect(counter.count).toBeGreaterThan(0);

        const failures: string[] = [];
        for (const at of cutPoints(counter.count)) {
          const label = counter.labels[at - 1];
          const variants = label.startsWith("writeFile ") ? [false, true] : [false];
          for (const truncate of variants) {
            const name = `${slug}-${at}${truncate ? "-t" : ""}`;
            const space = await copyOf(snapshot, name);
            const inj = new Injector(at, truncate);
            let outcome: Awaited<ReturnType<typeof run>>;
            try {
              outcome = await run(scenario, space, inj);
            } catch (err) {
              failures.push(
                `cut ${truncate ? "in" : "before"} #${at} (${inj.labels[at - 1] ?? label}): ` +
                  `recovery or a settling cycle threw: ${
                    err instanceof Error ? (err.stack ?? err.message) : String(err)
                  }`,
              );
              await rm(space.root, { recursive: true, force: true });
              continue;
            }
            const where = `cut ${truncate ? "in" : "before"} #${at} (${inj.labels[at - 1] ?? label})`;
            for (const p of outcome.end.problems) failures.push(`${where}: ${p}`);
            if (JSON.stringify(outcome.end.pages) !== JSON.stringify(uncut.end.pages)) {
              failures.push(
                `${where}: pages ${JSON.stringify(outcome.end.pages)} != ` +
                  `uncut ${JSON.stringify(uncut.end.pages)}`,
              );
            }
            if (JSON.stringify(outcome.end.files) !== JSON.stringify(uncut.end.files)) {
              failures.push(
                `${where}: files ${JSON.stringify(outcome.end.files)} != ` +
                  `uncut ${JSON.stringify(uncut.end.files)}`,
              );
            }
            await rm(space.root, { recursive: true, force: true });
          }
        }
        expect(failures).toEqual([]);
      },
      FULL ? 3_600_000 : 300_000,
    );
  }
});
