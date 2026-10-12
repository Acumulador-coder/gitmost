/**
 * Fixtures for the crash-window and interruption-matrix suites: a STATEFUL fake
 * Docmost (pages it creates stay, bodies go through the real converter, imports
 * merge per block, every write through the client is stamped `git-sync`),
 * crash injection around the three seams a cycle writes through (VaultGit,
 * CycleFs, the Docmost client), and readers of a vault's end state.
 *
 * Crash model: the process dies right before the N-th EFFECT (a git command
 * that changes refs, the index or the working tree; a file write, mkdir or rm;
 * a Docmost write) — that effect and everything after it never happen. A crash
 * before a read is the same as a crash before the next effect, so reads are not
 * crash points; after the crash every call fails, as nothing runs in a dead
 * process. The `truncate` variant writes the N-th file write's first half,
 * then dies (a write cut off part-way).
 */
import "./git-env";
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  parsePageFile,
} from "@docmost/prosemirror-markdown";
import { recoverVault, runCycle, type CycleFs } from "../src/engine/cycle";
import { VaultGit } from "../src/engine/git";
import { git, makeSettings, nodeFs } from "./cycle-realgit-helpers";

/** One page of the stateful fake Docmost. */
export interface StatefulPage {
  id: string;
  slugId: string;
  title: string;
  parentPageId: string | null;
  updatedAt: string;
  /** The body, as ProseMirror JSON. */
  doc: unknown;
  /** Who made the last write: `git-sync` for every write through the client. */
  source: "user" | "git-sync";
}

/** Docmost's markdown export of a body (the converter, in process). */
export function exportOf(doc: unknown): string {
  return convertProseMirrorToMarkdown(doc as any, { strict: true });
}

/** A page's markdown form as the pull writes it: the export's fixpoint. */
export async function markdownForm(doc: unknown): Promise<string> {
  return exportOf(await markdownToProseMirror(exportOf(doc))).trimEnd();
}

/** The fake's whole state: plain data, so a test can `structuredClone` it. */
export interface DocmostState {
  pages: StatefulPage[];
  nextId: number;
  tick: number;
  /** `<op>:<pageId or title>` entries: that call throws once. */
  failOnce: string[];
}

export async function newDocmostState(
  pages: { id: string; title: string; text: string; parentPageId?: string | null }[],
): Promise<DocmostState> {
  const state: DocmostState = { pages: [], nextId: 0x100, tick: 1, failOnce: [] };
  for (const [i, p] of pages.entries()) {
    state.pages.push({
      id: p.id,
      slugId: `s${i}`,
      title: p.title,
      parentPageId: p.parentPageId ?? null,
      updatedAt: stamp(state),
      doc: await markdownToProseMirror(p.text),
      source: "user",
    });
  }
  return state;
}

function stamp(state: DocmostState): string {
  return new Date(Date.UTC(2026, 9, 1, 0, 0, state.tick++)).toISOString();
}

/** A block-level 3-way: a block git changed wins, the others keep the live text. */
function merge3(base: string | null, target: string, live: string): string {
  if (base === null) return target.trim();
  const b = base.trim().split("\n\n");
  const t = target.trim().split("\n\n");
  const l = live.trim().split("\n\n");
  if (b.length !== t.length || t.length !== l.length) return target.trim();
  return t.map((block, i) => (block !== b[i] ? block : l[i])).join("\n\n");
}

/** A person edits a page in Docmost. */
export async function docmostEdit(
  state: DocmostState,
  id: string,
  text: string,
): Promise<void> {
  const p = state.pages.find((x) => x.id === id)!;
  p.doc = await markdownToProseMirror(text);
  p.source = "user";
  p.updatedAt = stamp(state);
}

/** A person creates a page in Docmost. */
export async function docmostCreate(
  state: DocmostState,
  id: string,
  title: string,
  text: string,
): Promise<void> {
  state.pages.push({
    id,
    slugId: `u${state.nextId++}`,
    title,
    parentPageId: null,
    updatedAt: stamp(state),
    doc: await markdownToProseMirror(text),
    source: "user",
  });
}

/** The client seam over `state`; `onWrite` runs before every write. */
export function statefulClient(state: DocmostState, onWrite?: (op: string) => void) {
  const fail = (op: string, key: string) => {
    const i = state.failOnce.indexOf(`${op}:${key}`);
    if (i >= 0) {
      state.failOnce.splice(i, 1);
      throw new Error(`injected ${op} failure for ${key}`);
    }
  };
  const find = (id: string) => state.pages.find((x) => x.id === id);
  return {
    listSpaceTree: async () => ({
      pages: state.pages.map((p) => ({
        id: p.id,
        slugId: p.slugId,
        title: p.title,
        parentPageId: p.parentPageId,
        hasChildren: state.pages.some((c) => c.parentPageId === p.id),
        updatedAt: p.updatedAt,
      })),
      complete: true,
    }),
    pageIdsExist: async (ids: string[]) => ids.filter((id) => find(id) !== undefined),
    getPageJson: async (id: string) => {
      const p = find(id);
      if (!p) throw new Error(`Page ${id} not found`);
      return {
        id: p.id,
        slugId: p.slugId,
        title: p.title,
        parentPageId: p.parentPageId,
        spaceId: "space-1",
        updatedAt: p.updatedAt,
        content: structuredClone(p.doc),
        lastUpdatedSource: p.source,
      };
    },
    importPageMarkdown: async (id: string, md: string, base: string | null) => {
      onWrite?.(`importPageMarkdown ${id}`);
      fail("import", id);
      const p = find(id);
      if (!p) throw new Error(`Page ${id} not found`);
      p.doc = await markdownToProseMirror(merge3(base, md, exportOf(p.doc)));
      p.source = "git-sync";
      p.updatedAt = stamp(state);
      return {};
    },
    createPage: async (
      title: string,
      content: string,
      _spaceId: string,
      parentPageId?: string,
    ) => {
      onWrite?.(`createPage ${title}`);
      fail("create", title);
      const id = `019f2900-0000-7000-8000-000000000${(state.nextId++).toString(16)}`;
      const doc = await markdownToProseMirror(content);
      state.pages.push({
        id,
        slugId: `n${state.nextId}`,
        title,
        parentPageId: parentPageId ?? null,
        updatedAt: stamp(state),
        doc,
        source: "git-sync",
      });
      return { data: { id } };
    },
    deletePage: async (id: string) => {
      onWrite?.(`deletePage ${id}`);
      fail("delete", id);
      const i = state.pages.findIndex((x) => x.id === id);
      if (i >= 0) state.pages.splice(i, 1);
      return {};
    },
    movePage: async (id: string, parentPageId: string | null) => {
      onWrite?.(`movePage ${id}`);
      fail("move", id);
      const p = find(id);
      if (p) {
        p.parentPageId = parentPageId;
        p.source = "git-sync";
      }
      return {};
    },
    renamePage: async (id: string, title: string) => {
      onWrite?.(`renamePage ${id}`);
      fail("rename", id);
      const p = find(id);
      if (p) {
        p.title = title;
        p.source = "git-sync";
        p.updatedAt = stamp(state);
      }
      return {};
    },
    listRecentSince: async () => [],
    listTrash: async () => [],
    restorePage: async () => ({}),
  };
}

/** The process died: thrown by the crashing call and by every call after it. */
export class Crash extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Crash";
  }
}

/**
 * Counts effects and kills the "process" before effect number `at`, or before
 * the first effect whose label `at` accepts.
 */
export class Injector {
  count = 0;
  dead = false;
  /** Every effect seen, in order (`count` of them). */
  readonly labels: string[] = [];
  constructor(
    readonly at: number | ((label: string) => boolean) = Number.POSITIVE_INFINITY,
    readonly truncate = false,
  ) {}

  /** Any call: fails once the process is dead. */
  alive(label: string): void {
    if (this.dead) throw new Crash(`process already dead (${label})`);
  }

  /** An effect: dies right before it when it is effect number `at`. */
  effect(label: string): boolean {
    this.alive(label);
    this.count++;
    this.labels.push(label);
    if (typeof this.at === "function" ? !this.at(label) : this.count !== this.at) {
      return false;
    }
    this.dead = true;
    return true;
  }
}

const MUTATING_GIT = new Set([
  "init",
  "checkout",
  "add",
  "commit",
  "merge",
  "reset",
  "clean",
  "rm",
  "update-ref",
  "branch",
]);

/** Whether a VaultGit `runRaw` call changes refs, the index or the working tree. */
function gitEffect(
  args: string[],
  opts?: { env?: Record<string, string> },
): boolean {
  // A private index (GIT_INDEX_FILE) touches only that index and the object store.
  if (opts?.env?.GIT_INDEX_FILE) return false;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += args[i] === "-c" ? 2 : 1;
  const cmd = args[i];
  if (cmd === "config") return !args.includes("--get");
  return MUTATING_GIT.has(cmd);
}

/** `vault` with every git command going through `inj`. */
export function crashingVault(vault: VaultGit, inj: Injector): VaultGit {
  const raw = (vault as any).runRaw as (...a: unknown[]) => Promise<unknown>;
  const w = Object.create(vault) as VaultGit;
  (w as any).runRaw = async function (
    args: string[],
    opts?: { env?: Record<string, string> },
  ) {
    const label = `git ${args.join(" ")}`;
    if (gitEffect(args, opts)) {
      if (inj.effect(label)) throw new Crash(`crash before ${label}`);
    } else {
      inj.alive(label);
    }
    return raw.call(this, args, opts);
  };
  return w;
}

/** `fs` with every call going through `inj`; a truncated write keeps the first half. */
export function crashingFs(fs: CycleFs, inj: Injector): CycleFs {
  return {
    readFile: async (p) => {
      inj.alive(`readFile ${p}`);
      return fs.readFile(p);
    },
    writeFile: async (p, text) => {
      if (inj.effect(`writeFile ${p}`)) {
        if (inj.truncate) await fs.writeFile(p, text.slice(0, Math.floor(text.length / 2)));
        throw new Crash(`crash ${inj.truncate ? "while" : "before"} writing ${p}`);
      }
      return fs.writeFile(p, text);
    },
    mkdir: async (p) => {
      if (inj.effect(`mkdir ${p}`)) throw new Crash(`crash before mkdir ${p}`);
      return fs.mkdir(p);
    },
    rm: async (p) => {
      if (inj.effect(`rm ${p}`)) throw new Crash(`crash before rm ${p}`);
      return fs.rm(p);
    },
    lstat: async (p) => {
      inj.alive(`lstat ${p}`);
      return fs.lstat(p);
    },
    realpath: async (p) => {
      inj.alive(`realpath ${p}`);
      return fs.realpath(p);
    },
  };
}

/** The stateful client with every call going through `inj`. */
export function crashingClient(state: DocmostState, inj: Injector) {
  const client = statefulClient(state, (op) => {
    if (inj.effect(op)) throw new Crash(`crash before ${op}`);
  });
  for (const key of ["listSpaceTree", "pageIdsExist", "getPageJson"] as const) {
    const read = client[key] as (...a: any[]) => Promise<any>;
    (client as any)[key] = async (...a: any[]) => {
      inj.alive(key);
      return read(...a);
    };
  }
  return client;
}

/** One cycle over the vault at `root` (optionally through an injector). */
export function cycleOnce(
  root: string,
  state: DocmostState,
  opts: {
    inj?: Injector;
    signal?: AbortSignal;
    warn?: (line: string) => void;
    /** Replaces the stateful client (and the injector's client wrapping). */
    client?: ReturnType<typeof statefulClient>;
    autoMergeConflicts?: boolean;
  } = {},
) {
  const vault = new VaultGit(root);
  const inj = opts.inj;
  return runCycle({
    spaceId: "space-1",
    client: (opts.client ??
      (inj ? crashingClient(state, inj) : statefulClient(state))) as any,
    vault: inj ? crashingVault(vault, inj) : vault,
    settings: {
      ...makeSettings(root),
      ...(opts.autoMergeConflicts ? { autoMergeConflicts: true } : {}),
    },
    fs: inj ? crashingFs(nodeFs, inj) : nodeFs,
    log: () => undefined,
    warn: opts.warn ?? (() => undefined),
    signal: opts.signal,
  });
}

/** What the server does after a crash and before the next push or cycle. */
export function recover(root: string, warn: (line: string) => void = () => undefined) {
  return recoverVault({
    spaceId: "space-1",
    vault: new VaultGit(root),
    log: () => undefined,
    warn,
  });
}

/** Every page file on `main`: path, gitmost_id and body. */
export async function mainFiles(
  root: string,
): Promise<{ path: string; id: string | null; body: string }[]> {
  const paths = (await git(root, "ls-tree", "-r", "--name-only", "main"))
    .split("\n")
    .filter((p) => p.endsWith(".md"));
  const out: { path: string; id: string | null; body: string }[] = [];
  for (const path of paths) {
    const parsed = parsePageFile(await git(root, "show", `main:${path}`));
    out.push({ path, id: parsed.id, body: parsed.body.trimEnd() });
  }
  return out;
}

/** The vault's service refs (`refs/docmost/*`), one per line. */
export function serviceRefs(root: string): Promise<string> {
  return git(root, "for-each-ref", "--format=%(refname)", "refs/docmost/");
}

/** A page's place in the tree: its ancestors' titles and its own, joined by "/". */
export function titlePath(state: DocmostState, id: string): string {
  const parts: string[] = [];
  for (let p = state.pages.find((x) => x.id === id); p; ) {
    parts.unshift(p.title);
    const parent = p.parentPageId;
    p = parent === null ? undefined : state.pages.find((x) => x.id === parent);
  }
  return parts.join("/");
}

/**
 * The end state of a space with page ids left out — what a crashed run must
 * reach like an uncrashed one — after asserting the invariants every end state
 * must hold: every gitmost_id on `main` names exactly one page and every page
 * has exactly one file, the file's body is the page's markdown, no service ref
 * is left, the tree is clean and on `main`, and `docmost` is part of `main`.
 * Returns the failures instead of throwing so a sweep can report them all.
 */
export async function endState(
  root: string,
  state: DocmostState,
): Promise<{ problems: string[]; pages: string[]; files: string[] }> {
  const problems: string[] = [];
  const files = await mainFiles(root);
  const byId = new Map<string, string[]>();
  for (const f of files) {
    if (f.id === null) problems.push(`${f.path} has no gitmost_id`);
    else byId.set(f.id, [...(byId.get(f.id) ?? []), f.path]);
  }
  for (const [id, paths] of byId) {
    if (paths.length > 1) problems.push(`gitmost_id ${id} is in ${paths.length} files: ${paths.join(", ")}`);
    if (!state.pages.some((p) => p.id === id)) problems.push(`${paths[0]} names no page (${id})`);
  }
  const pages: string[] = [];
  for (const p of state.pages) {
    const paths = byId.get(p.id) ?? [];
    if (paths.length === 0) problems.push(`page "${titlePath(state, p.id)}" has no file`);
    const text = await markdownForm(p.doc);
    pages.push(`${titlePath(state, p.id)}: ${text}`);
    const file = files.find((f) => f.id === p.id);
    if (file && file.body !== text) {
      problems.push(
        `${file.path}: body ${JSON.stringify(file.body)} != page ${JSON.stringify(text)}`,
      );
    }
  }
  const refs = await serviceRefs(root);
  if (refs !== "") problems.push(`service refs left: ${refs.replace(/\n/g, ", ")}`);
  const status = await git(root, "status", "--porcelain");
  if (status !== "") problems.push(`dirty tree: ${status.replace(/\n/g, ", ")}`);
  const head = await git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (head !== "main") problems.push(`HEAD is on ${head}`);
  try {
    await git(root, "merge-base", "--is-ancestor", "docmost", "main");
  } catch {
    problems.push("'docmost' is not part of 'main'");
  }
  return {
    problems,
    pages: pages.sort(),
    files: files.map((f) => `${f.path}: ${f.body}`).sort(),
  };
}
