import { describe, expect, it, vi } from 'vitest';
import { runPush } from '../src/engine/push';
import { GitStoppedError } from '../src/engine/git';
import type { PushDeps } from '../src/engine/push';
import type { Settings } from '../src/engine/settings';
import { serializePageFile } from '@docmost/prosemirror-markdown';

/** A native page file: `gitmost_id` frontmatter + clean body (title = filename). */
function fileFor(pageId: string, body = 'body'): string {
  return serializePageFile(pageId, body);
}

// runPush orchestration (SPEC §6 "ФС → Docmost"), DRY-RUN BY DEFAULT. Driven by
// FAKES only — no live Docmost, git, fs, or network. Asserts the SAFE-BY-DEFAULT
// contract: a dry-run builds NO client and makes ZERO Docmost calls; `--apply`
// is the ONLY path that writes. Also covers the last-export diff base.

/** The last export (the diff base) and the `main` commit the diff ends at. */
const BASE = 'base-sha';
const HEAD = 'head-sha';

/** A minimal valid Settings fixture (only fields runPush reads matter). */
function makeSettings(): Settings {
  return {
    docmostSpaceId: 'space-1',
    vaultPath: '/vault',
  };
}

/**
 * A recording git fake covering exactly the `PushDeps['git']` surface: the
 * diff rows, the tree at BASE (`prevTree`) and the tree at HEAD (`files`).
 */
function makeGit(opts?: {
  /** Diff rows returned by diffNameStatus(BASE, HEAD). */
  changes?: { status: 'A' | 'M' | 'D' | 'R' | 'C'; path: string; oldPath?: string }[];
  /** Tree at BASE (path -> text). */
  prevTree?: Record<string, string>;
  /** Tree at HEAD (path -> text). */
  files?: Record<string, string>;
}) {
  const calls = { diffNameStatus: [] as { from: string; to: string }[] };
  const prevTree = opts?.prevTree ?? {};
  const files = opts?.files ?? {};
  const treeAt = (ref: string) => (ref === BASE ? prevTree : ref === HEAD ? files : {});
  const ids = (tree: Record<string, string>) =>
    Object.entries(tree).flatMap(([path, text]) => {
      const m = text.match(/^gitmost_id: (.+)$/m);
      return m ? [{ path, id: m[1] }] : [];
    });
  const git: PushDeps['git'] = {
    assertGitAvailable: vi.fn(async () => undefined),
    ensureRepo: vi.fn(async () => false),
    diffNameStatus: vi.fn(async (from: string, to: string) => {
      calls.diffNameStatus.push({ from, to });
      return opts?.changes ?? [];
    }),
    showFileAtRef: vi.fn(async (ref: string, path: string) => treeAt(ref)[path] ?? null),
    readFilesAtRef: vi.fn(
      async (ref: string, paths: string[]) =>
        new Map(paths.flatMap((p) => (p in treeAt(ref) ? [[p, treeAt(ref)[p]] as const] : []))),
    ),
    pageIdsAtRef: vi.fn(async (ref: string) => ids(treeAt(ref))),
    commitAddingPath: vi.fn(async () => null),
  };
  return { git, calls };
}

/** A recording client fake; createPage returns a configurable assigned id. */
function makeClientFake(opts?: { createId?: string }) {
  return {
    // Empty live tree by default -> no retry-adopt match, so creates take the
    // normal createPage path (the adopt lookup only fires on a (parent,title) hit).
    listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
    getPageJson: vi.fn(),
    importPageMarkdown: vi.fn(async () => ({ success: true })),
    createPage: vi.fn(async (title: string) => ({
      data: { id: opts?.createId ?? 'assigned-id', title },
      success: true,
    })),
    deletePage: vi.fn(async () => ({ success: true })),
    movePage: vi.fn(async () => ({ success: true })),
    renamePage: vi.fn(async () => ({ success: true })),
  };
}

/** Assemble PushDeps with a recording logger and a makeClient FACTORY spy. */
function makeDeps(git: PushDeps['git'], client?: ReturnType<typeof makeClientFake>) {
  const logs: string[] = [];
  const makeClient = vi.fn(() => (client ?? makeClientFake()) as any);
  const deps: PushDeps = {
    settings: makeSettings(),
    git,
    makeClient,
    baseRef: BASE,
    headRef: HEAD,
    log: (line) => logs.push(line),
  };
  return { deps, logs, makeClient };
}

describe('runPush — dry-run is the DEFAULT (safe)', () => {
  it('logs a plan, builds NO client, makes ZERO Docmost calls', async () => {
    const file = fileFor('p-1', 'edited body');
    const { git, calls } = makeGit({
      changes: [{ status: 'M', path: 'Doc.md' }],
      files: { 'Doc.md': file },
    });
    const { deps, logs, makeClient } = makeDeps(git);

    const res = await runPush(deps, { dryRun: true });

    expect(res.mode).toBe('dry-run');
    expect(res.planned).toEqual({
      creates: 0,
      updates: 1,
      deletes: 0,
      renamesMoves: 0,
      skipped: 0,
    });
    // The client FACTORY was never invoked -> zero Docmost contact.
    expect(makeClient).not.toHaveBeenCalled();
    // A plan WAS logged (counts + the per-item update line).
    expect(logs.join('\n')).toMatch(/DRY-RUN/);
    expect(logs.join('\n')).toMatch(/update: p-1 \(Doc\.md\)/);
    // It still diffs the last export against main.
    expect(calls.diffNameStatus).toEqual([{ from: BASE, to: HEAD }]);
  });

});

describe('runPush — --apply is the ONLY write path', () => {
  it('builds the client, calls applyPushActions and returns the created pages', async () => {
    // A brand-new hand-written file with NO frontmatter (title = filename `New`).
    const { git } = makeGit({
      changes: [{ status: 'A', path: 'New.md' }],
      files: { 'New.md': 'fresh body\n' },
    });
    const client = makeClientFake({ createId: 'page-new' });
    const { deps, makeClient } = makeDeps(git, client);

    const res = await runPush(deps, { dryRun: false });

    expect(res.mode).toBe('apply');
    // The client factory WAS used and createPage ran (the write path).
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(res.applied?.created).toBe(1);
    // The export writes the assigned id into the file.
    expect(res.created).toEqual([{ path: 'New.md', pageId: 'page-new' }]);
    expect(res.failures).toEqual([]);
  });

  it('an update goes through importPageMarkdown (collab path)', async () => {
    const file = fileFor('p-9', 'body');
    const { git } = makeGit({
      changes: [{ status: 'M', path: 'Doc.md' }],
      files: { 'Doc.md': file },
    });
    const client = makeClientFake();
    const { deps } = makeDeps(git, client);

    const res = await runPush(deps, { dryRun: false });

    // The pushed content is the STRIPPED body (no gitmost_id frontmatter).
    expect(client.importPageMarkdown).toHaveBeenCalledWith('p-9', 'body', null);
    expect(res.applied?.updated).toBe(1);
  });

  it("a page whose base path another page took, with a copy of its file: the page's update is 3-way against its base file", async () => {
    // p-a left Page.md (now p-x's file) for two files carrying its id.
    const { git } = makeGit({
      changes: [
        { status: 'M', path: 'Page.md' },
        { status: 'D', path: 'X.md' },
        { status: 'A', path: 'Meeting.md' },
        { status: 'A', path: 'Meeting 1.md' },
      ],
      prevTree: {
        'Page.md': fileFor('p-a', 'base body'),
        'X.md': fileFor('p-x', 'x body'),
      },
      files: {
        'Page.md': fileFor('p-x', 'x body'),
        'Meeting.md': fileFor('p-a', 'git body'),
        'Meeting 1.md': fileFor('p-a', 'copy body'),
      },
    });
    const client = makeClientFake();
    const { deps } = makeDeps(git, client);

    await runPush(deps, { dryRun: false });

    const pageWrites = client.importPageMarkdown.mock.calls.filter(
      ([id]) => id === 'p-a',
    );
    expect(pageWrites).toHaveLength(1);
    expect(pageWrites[0][2]).toBe('base body');
    expect(client.createPage).toHaveBeenCalledTimes(1);
  });
});

describe('runPush — the diff base is the last export', () => {
  it('diffs from the last export and reads every pre-image there', async () => {
    const { git, calls } = makeGit({
      changes: [
        { status: 'M', path: 'Doc.md' },
        { status: 'D', path: 'Gone.md' },
      ],
      prevTree: {
        'Doc.md': fileFor('p-1', 'base body'),
        'Gone.md': fileFor('p-gone', 'gone body'),
      },
      files: { 'Doc.md': fileFor('p-1', 'edited body') },
    });
    const client = makeClientFake();
    const { deps } = makeDeps(git, client);

    const res = await runPush(deps, { dryRun: false });

    expect(res.base).toEqual({ sha: BASE });
    expect(calls.diffNameStatus).toEqual([{ from: BASE, to: HEAD }]);
    // The update's 3-way base and the delete's pageId both come from BASE.
    expect(client.importPageMarkdown).toHaveBeenCalledWith(
      'p-1',
      'edited body',
      'base body',
    );
    expect(client.deletePage).toHaveBeenCalledWith('p-gone');
    expect(git.showFileAtRef).toHaveBeenCalledWith(BASE, 'Doc.md');
    expect(git.showFileAtRef).toHaveBeenCalledWith(BASE, 'Gone.md');
  });

  it('a symlink at HEAD is never a page: no create, no update', async () => {
    const { git } = makeGit({
      changes: [{ status: 'A', path: 'leak.md' }],
      files: { 'leak.md': '/etc/passwd' },
    });
    const client = makeClientFake();
    const { deps } = makeDeps(git, client);

    const res = await runPush({ ...deps, symlinks: new Set(['leak.md']) }, { dryRun: false });

    expect(res.planned.creates).toBe(0);
    expect(client.createPage).not.toHaveBeenCalled();
    expect(client.importPageMarkdown).not.toHaveBeenCalled();
  });
});

// Coverage for two narrow, otherwise-untested branches in `applyPushActions`
// (driven end-to-end via `runPush --apply`, the only write path):
//   1. `errMessage` (push.ts line 762-763) NON-Error branch — `String(err)`.
//   2. `createPage` partial-meta fallbacks (push.ts line 583-584) — `?? ''`.
describe('runPush --apply — applyPushActions edge branches', () => {
  it('records a thrown NON-Error (a string) via String(err), not "undefined"', async () => {
    // One UPDATE (file carries a pageId), whose collab write throws the raw
    // STRING 'boom'. Every other failure test throws an Error, so the
    // `String(err)` fallback in errMessage (push.ts:763) is otherwise uncovered.
    const file = fileFor('p-7', 'body');
    const { git } = makeGit({
      changes: [{ status: 'M', path: 'Doc.md' }],
      files: { 'Doc.md': file },
    });
    const client = makeClientFake();
    // Throw a bare string (NON-Error) from the update path.
    (client.importPageMarkdown as any).mockImplementation(async () => {
      throw 'boom';
    });
    const { deps } = makeDeps(git, client);

    // runPush must COMPLETE (the failure is isolated), not reject.
    const res = await runPush(deps, { dryRun: false });

    expect(res.mode).toBe('apply');
    expect(res.applied?.updated).toBe(0);
    expect(res.failures).toHaveLength(1);
    const failure = res.failures![0];
    expect(failure.kind).toBe('update');
    expect(failure.pageId).toBe('p-7');
    expect(failure.path).toBe('Doc.md');
    // String(err) of the thrown string 'boom' — NOT 'undefined' and NOT
    // '[object Object]'. This is the load-bearing assertion for line 763.
    expect(failure.error).toBe('boom');
  });

  it('records a thrown NON-Error OBJECT via String(err) too (no implicit message)', async () => {
    // A thrown object literal -> String({}) === '[object Object]'. Pins down that
    // errMessage stringifies (not reads a .message) for non-Error throwables.
    const file = fileFor('p-8', 'body');
    const { git } = makeGit({
      changes: [{ status: 'M', path: 'Doc.md' }],
      files: { 'Doc.md': file },
    });
    const client = makeClientFake();
    (client.importPageMarkdown as any).mockImplementation(async () => {
      throw { code: 500 };
    });
    const { deps } = makeDeps(git, client);

    const res = await runPush(deps, { dryRun: false });

    expect(res.failures).toHaveLength(1);
    // String({ code: 500 }) — the object's default stringification.
    expect(res.failures![0].error).toBe('[object Object]');
  });

  it('createPage derives title from the FILENAME, space from the run, parent from path', async () => {
    // A brand-new hand-written file at the space ROOT (no enclosing folder). In
    // the native-Obsidian format nothing is stored in the file: title comes from
    // the FILENAME (`New`), spaceId from the RUN (the vault's space `space-1`),
    // and parentPageId from the PATH (root -> undefined).
    const { git } = makeGit({
      changes: [{ status: 'A', path: 'New.md' }],
      files: { 'New.md': 'fresh body\n' },
    });
    const client = makeClientFake({ createId: 'page-new' });
    const { deps } = makeDeps(git, client);

    const res = await runPush(deps, { dryRun: false });

    expect(res.mode).toBe('apply');
    expect(res.applied?.created).toBe(1);
    expect(client.createPage).toHaveBeenCalledTimes(1);
    const [title, content, spaceId, parentPageId] = (client.createPage as any).mock
      .calls[0];
    expect(title).toBe('New'); // from the filename
    expect(content).toBe('fresh body'); // the stripped body
    expect(spaceId).toBe('space-1'); // from the run (makeSettings)
    expect(parentPageId).toBe(undefined); // root path -> no parent
  });

  it('an added file with NO frontmatter is CREATED (space from the run), never skipped', async () => {
    // Native: every file in the vault belongs to the vault's space, supplied by
    // the RUN — so a brand-new hand-written file (no gitmost_id) is always a
    // CREATE, never skipped for a "missing spaceId" (that legacy skip is gone).
    const { git } = makeGit({
      changes: [{ status: 'A', path: 'Orphan.md' }],
      files: { 'Orphan.md': 'just some text\n' },
    });
    const client = makeClientFake({ createId: 'orphan-id' });
    const { deps } = makeDeps(git, client);

    const res = await runPush(deps, { dryRun: false });

    expect(res.planned).toEqual({
      creates: 1,
      updates: 0,
      deletes: 0,
      renamesMoves: 0,
      skipped: 0,
    });
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect((client.createPage as any).mock.calls[0][0]).toBe('Orphan'); // title=filename
    expect(res.applied?.created).toBe(1);
  });
});

describe('runPush — a stopped git is not an absent file', () => {
  it('fails instead of reading a killed `git show` of a deleted file as "absent"', async () => {
    const { git } = makeGit({
      changes: [{ status: 'D', path: 'Doc.md' }],
      prevTree: { 'Doc.md': fileFor('p-1') },
    });
    // The file is gone from HEAD (a real absence); reading its pre-image at the
    // base is what gets killed.
    git.showFileAtRef = vi.fn(async (ref: string) => {
      if (ref === BASE) throw new GitStoppedError('git show was killed');
      return null;
    });
    const { deps } = makeDeps(git);

    await expect(runPush(deps, { dryRun: true })).rejects.toBeInstanceOf(GitStoppedError);
  });
});
