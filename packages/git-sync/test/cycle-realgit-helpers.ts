/**
 * Shared fixtures for the runCycle tests that drive a REAL bare VaultGit in a
 * temp dir: the engine `Settings`, a git-availability probe, a mutable fake
 * Docmost client, small git shell helpers, and `setupVault` — a vault plus a
 * clone where a "human" commits and pushes, as a user of the /git host does.
 */
import "./git-env";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import { runCycle } from "../src/engine/cycle";
import { LAST_EXPORT_REF, VaultGit } from "../src/engine/git";
import type { Settings } from "../src/engine/settings";

export const execFileAsync = promisify(execFile);

export async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Run git in `cwd` with a fixed identity; returns trimmed stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=Human", "-c", "user.email=human@local", ...args],
    { cwd },
  );
  return stdout.trim();
}

export function makeSettings(vaultPath: string): Settings {
  return {
    docmostSpaceId: "space-1",
    vaultPath,
  } as Settings;
}

/** One page of the fake Docmost space. Tests mutate these in place. */
export interface FakePage {
  id: string;
  slugId: string;
  title: string;
  parentPageId: string | null;
  updatedAt: string;
  /** The page body: one paragraph per "\n\n"-separated chunk; `null` = no content. */
  text: string | null;
  /** The raw ProseMirror content, when set: returned instead of `text`'s paragraphs. */
  content?: unknown;
  /** Who made the page's last write (`'git-sync'` for git-sync's own). */
  lastUpdatedSource?: string;
}

/**
 * A fake Docmost client over a MUTABLE page list: `listSpaceTree` and
 * `getPageJson` always reflect the current `pages` array, writes are recorded
 * no-ops (`createPage` returns the next id from `createdIds`).
 */
export function makeClient(pages: FakePage[], createdIds: string[] = []) {
  const doc = (text: string | null) =>
    text === null
      ? null
      : {
          type: "doc",
          content: text.split("\n\n").map((t) => ({
            type: "paragraph",
            content: [{ type: "text", text: t }],
          })),
        };
  return {
    listSpaceTree: vi.fn(async () => ({
      pages: pages.map((p) => ({
        id: p.id,
        slugId: p.slugId,
        title: p.title,
        parentPageId: p.parentPageId,
        hasChildren: pages.some((c) => c.parentPageId === p.id),
        updatedAt: p.updatedAt,
      })),
      complete: true,
    })),
    pageIdsExist: vi.fn(async (ids: string[]) => ids),
    getPageJson: vi.fn(async (pageId: string) => {
      const p = pages.find((x) => x.id === pageId);
      if (!p) throw new Error(`Page ${pageId} not found`);
      return {
        id: p.id,
        slugId: p.slugId,
        title: p.title,
        parentPageId: p.parentPageId,
        spaceId: "space-1",
        updatedAt: p.updatedAt,
        content: p.content !== undefined ? p.content : doc(p.text),
        lastUpdatedSource: p.lastUpdatedSource ?? "user",
      };
    }),
    importPageMarkdown: vi.fn(async () => ({})),
    createPage: vi.fn(async () => ({
      data: { id: createdIds.shift() ?? "00000000-0000-4000-8000-0000000000ff" },
    })),
    deletePage: vi.fn(async () => ({})),
    movePage: vi.fn(async () => ({})),
    renamePage: vi.fn(async () => ({})),
    listRecentSince: vi.fn(async () => []),
    listTrash: vi.fn(async () => []),
    restorePage: vi.fn(async () => ({})),
  };
}

/**
 * A block-level stand-in for the server's 3-way body merge: a block git
 * changed (target differs from base) wins, every other block keeps the live
 * text. No base, or block counts that differ, means the target replaces the page.
 */
export function merge3(base: string | null, target: string, live: string): string {
  if (base === null) return target.trim();
  const b = base.trim().split("\n\n");
  const t = target.trim().split("\n\n");
  const l = live.trim().split("\n\n");
  if (b.length !== t.length || t.length !== l.length) return target.trim();
  return t.map((block, i) => (block !== b[i] ? block : l[i])).join("\n\n");
}

let tick = 1;
/** A fresh, increasing timestamp (a store's new `updatedAt`). */
export const ts = () => new Date(Date.UTC(2026, 9, 5, 0, 0, tick++)).toISOString();

const dirs: string[] = [];

/** Remove every temp dir `setupVault` made (call from `afterEach`). */
export async function cleanupVaults(): Promise<void> {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
}

/**
 * A bare vault mirrored from `pages` by a first cycle (unless `firstCycle` is
 * false), and a fake Docmost that applies every write: an import merges with
 * `merge3` and stores, a create adds the page, a delete trashes it, a move or
 * rename changes it. Every write is recorded in `calls`; `failing` (import of a
 * page id) and `failOnce` (`<op>:<pageId|title>`) inject failures.
 */
export async function setupVault(pages: FakePage[], opts: { firstCycle?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "docmost-vault-"));
  dirs.push(dir);
  const root = join(dir, "vault");
  const work = join(dir, "work");
  const vault = new VaultGit(root);
  const client = makeClient(pages);
  const calls: string[][] = [];
  const warnings: string[] = [];
  const failing = new Set<string>();
  const failOnce = new Set<string>();
  const exportKeys = new Map<string, string>();
  const fail = (op: string, key: string) => {
    if (failOnce.delete(`${op}:${key}`)) {
      throw new Error(`injected ${op} failure for ${key}`);
    }
  };
  const find = (id: string) => pages.find((p) => p.id === id);
  let nextId = 0x100;

  client.importPageMarkdown.mockImplementation(
    async (id: string, markdown: string, base: string | null) => {
      calls.push(["import", id]);
      if (failing.has(id)) throw new Error(`injected failure for ${id}`);
      fail("import", id);
      const p = find(id);
      if (p) {
        p.text = merge3(base, markdown, p.text ?? "");
        p.content = undefined;
        p.updatedAt = ts();
        p.lastUpdatedSource = "git-sync";
      }
      return {};
    },
  );
  client.createPage.mockImplementation(
    async (title: string, content: string, _space: string, parentPageId?: string) => {
      calls.push(["create", title]);
      fail("create", title);
      const id = `019f2900-0000-7000-8000-000000000${(nextId++).toString(16)}`;
      pages.push({
        id,
        slugId: `n${nextId}`,
        title,
        parentPageId: parentPageId ?? null,
        updatedAt: ts(),
        text: content.trim(),
        lastUpdatedSource: "git-sync",
      });
      return { data: { id } };
    },
  );
  client.deletePage.mockImplementation(async (id: string) => {
    calls.push(["delete", id]);
    fail("delete", id);
    const i = pages.findIndex((p) => p.id === id);
    if (i >= 0) pages.splice(i, 1);
    return {};
  });
  client.movePage.mockImplementation(async (id: string, parentPageId: string | null) => {
    calls.push(["move", id]);
    fail("move", id);
    const p = find(id);
    if (p) p.parentPageId = parentPageId ?? null;
    return {};
  });
  client.renamePage.mockImplementation(async (id: string, title: string) => {
    calls.push(["rename", id]);
    fail("rename", id);
    const p = find(id);
    if (p) {
      p.title = title;
      p.updatedAt = ts();
    }
    return {};
  });

  const cycle = (v: VaultGit = vault, signal?: AbortSignal) => {
    calls.length = 0;
    warnings.length = 0;
    return runCycle({
      spaceId: "space-1",
      client: client as any,
      vault: v,
      settings: makeSettings(root),
      signal,
      log: () => undefined,
      warn: (line: string) => warnings.push(line),
      exportKeys,
    });
  };

  let cloned = false;
  /** In the clone: catch up with the vault, change files, commit, push. */
  const human = async (change: (work: string) => Promise<void>) => {
    if (!cloned) {
      await git(dir, "clone", "-q", root, work);
      cloned = true;
    } else {
      await git(work, "fetch", "-q", "origin");
      await git(work, "reset", "-q", "--hard", "origin/main");
    }
    await change(work);
    await git(work, "add", "-A");
    await git(work, "commit", "-q", "-m", "human change");
    await git(work, "push", "-q", "origin", "HEAD:main");
  };
  /** A change replacing `from` with `to` in `file`. */
  const edit = (file: string, from: string, to: string) => async (w: string) => {
    const abs = join(w, file);
    const text = await readFile(abs, "utf8");
    if (!text.includes(from)) throw new Error(`${file} has no '${from}'`);
    await writeFile(abs, text.replace(from, to), "utf8");
  };
  /** The `main` tree as path -> content. */
  const mainFiles = async () => {
    const out: Record<string, string> = {};
    for (const f of (await git(root, "ls-tree", "-r", "--name-only", "main"))
      .split("\n")
      .filter(Boolean)) {
      out[f] = await git(root, "show", `main:${f}`);
    }
    return out;
  };
  const heads = () => git(root, "rev-parse", "main", LAST_EXPORT_REF);
  /** `vault`, except that updating `ref` throws: a crash right before it. */
  const crashingBefore = (ref: string): VaultGit => {
    const v = Object.create(vault) as VaultGit;
    v.updateRef = async (r: string, target: string, expected?: string) => {
      if (r === ref) throw new Error(`crash before updating ${r}`);
      return vault.updateRef(r, target, expected);
    };
    return v;
  };

  if (opts.firstCycle !== false) await cycle();
  return {
    root,
    vault,
    pages,
    client,
    calls,
    warnings,
    failing,
    failOnce,
    exportKeys,
    cycle,
    human,
    edit,
    mainFiles,
    heads,
    crashingBefore,
  };
}

export type VaultHarness = Awaited<ReturnType<typeof setupVault>>;
