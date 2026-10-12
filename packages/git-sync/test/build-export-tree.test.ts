import { describe, expect, it, vi } from 'vitest';
import {
  buildExportTree,
  logDeletionDecision,
  type ExportTreePlan,
} from '../src/engine/pull';

// `buildExportTree` turns an export plan into one tree with plumbing only. A
// fake git records the blobs and the tree changes; the client fake fails the
// pages it is told to.

function makeClient(failFor = new Set<string>()) {
  return {
    getPageJson: vi.fn(async (pageId: string) => {
      if (failFor.has(pageId)) throw new Error(`fetch failed for ${pageId}`);
      return {
        id: pageId,
        slugId: `slug-${pageId}`,
        title: `Title ${pageId}`,
        spaceId: 'space',
        parentPageId: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: pageId }] }],
        },
      };
    }),
  };
}

function makeGit() {
  const blobs = new Map<string, string>();
  const git = {
    hashObject: vi.fn(async (text: string) => {
      const sha = `blob${blobs.size}`;
      blobs.set(sha, text);
      return sha;
    }),
    buildTree: vi.fn(
      async (_base: string | null, _changes: { path: string; sha: string | null }[]) =>
        'tree-1',
    ),
  };
  /** The changes the single buildTree call applied, as path -> text | null. */
  const changes = () => {
    expect(git.buildTree).toHaveBeenCalledTimes(1);
    const [base, list] = git.buildTree.mock.calls[0];
    expect(base).toBe('start');
    return Object.fromEntries(
      list.map((c) => [c.path, c.sha === null ? null : (blobs.get(c.sha) ?? c.sha)]),
    );
  };
  return { git, changes };
}

function plan(partial: Partial<ExportTreePlan>): ExportTreePlan {
  return { start: 'start', pages: [], removeIfWritten: [], remove: [], ...partial };
}

describe('buildExportTree', () => {
  it('writes each fetched page as a gitmost_id file and applies the removals', async () => {
    const client = makeClient();
    const g = makeGit();
    const log = vi.fn();

    const res = await buildExportTree(
      { client, git: g.git, log },
      plan({
        pages: [
          { pageId: 'p1', relPath: 'A.md' },
          { pageId: 'p2', relPath: 'Sub/B.md' },
        ],
        removeIfWritten: [{ pageId: 'p2', path: 'Old/B.md' }],
        remove: ['Dead.md'],
      }),
    );

    expect(res).toEqual({
      tree: 'tree-1',
      written: 2,
      movedApplied: 1,
      deleted: 1,
      failedPageIds: [],
      failed: 0,
    });
    const c = g.changes();
    expect(c['A.md']).toBe('---\ngitmost_id: p1\n---\n\np1\n');
    expect(c['Sub/B.md']).toBe('---\ngitmost_id: p2\n---\n\np2\n');
    expect(c['Old/B.md']).toBeNull();
    expect(c['Dead.md']).toBeNull();
  });

  it('⭐ a page whose fetch fails keeps the paths tied to it; other pages still move', async () => {
    const client = makeClient(new Set(['bad']));
    const g = makeGit();
    const log = vi.fn();

    const res = await buildExportTree(
      { client, git: g.git, log },
      plan({
        pages: [
          { pageId: 'ok', relPath: 'NewOk/Ok.md' },
          { pageId: 'bad', relPath: 'NewBad/Bad.md' },
        ],
        removeIfWritten: [
          { pageId: 'ok', path: 'OldOk/Ok.md' },
          { pageId: 'bad', path: 'OldBad/Bad.md' },
        ],
      }),
    );

    expect(res.written).toBe(1);
    expect(res.movedApplied).toBe(1);
    expect(res.failedPageIds).toEqual(['bad']);
    expect(Object.keys(g.changes()).sort()).toEqual(['NewOk/Ok.md', 'OldOk/Ok.md']);
    expect(log.mock.calls.flat().join('\n')).toMatch(/failed page bad: fetch failed/);
    expect(log.mock.calls.flat().join('\n')).toMatch(/keeping OldBad\/Bad\.md/);
  });

  it('places a given blob without fetching and never touches a pinned path: a page whose layout path is pinned is not placed and keeps its files', async () => {
    const client = makeClient();
    const g = makeGit();

    const res = await buildExportTree(
      { client, git: g.git, log: vi.fn() },
      plan({
        pages: [
          { pageId: 'kept', relPath: 'Kept.md', blob: 'old-blob' },
          { pageId: 'p', relPath: 'Pinned.md' },
          { pageId: 'q', relPath: 'Q.md' },
        ],
        remove: ['Pinned old.md', 'Gone.md'],
        removeIfWritten: [
          { pageId: 'p', path: 'P.md' },
          // A placed page's pinned path stays too.
          { pageId: 'q', path: 'Pinned old.md' },
        ],
        pinned: new Set(['Pinned.md', 'Pinned old.md']),
      }),
    );

    expect(client.getPageJson.mock.calls).toEqual([['q']]);
    expect(g.changes()).toEqual({
      'Kept.md': 'old-blob',
      'Gone.md': null,
      'Q.md': '---\ngitmost_id: q\n---\n\nq\n',
    });
    expect(res.deleted).toBe(1);
    expect(res.movedApplied).toBe(0);
    expect(res.failedPageIds).toEqual(['p']);
  });

  it('a page file at a removed path wins over the removal', async () => {
    const g = makeGit();

    await buildExportTree(
      { client: makeClient(), git: g.git, log: vi.fn() },
      plan({
        pages: [{ pageId: 'n2', relPath: 'Notes.md' }],
        removeIfWritten: [{ pageId: 'n2', path: 'Notes ~b2.md' }],
        remove: ['Notes.md'],
      }),
    );

    const c = g.changes();
    expect(c['Notes.md']).toContain('gitmost_id: n2');
    expect(c['Notes ~b2.md']).toBeNull();
  });
});

describe('logDeletionDecision (SPEC §8)', () => {
  it.each([
    ['incomplete-fetch', /tree fetch incomplete — deletions suppressed/],
    ['empty-live', /live fetch returned 0 pages but 4 file\(s\) are tracked — deletions suppressed/],
    ['mass-delete', /plan would delete 3 of 4 tracked file\(s\) \(mass-delete guard\) — deletions suppressed/],
  ] as const)('logs the %s suppression', (reason, message) => {
    const log = vi.fn();
    logDeletionDecision(log, {
      deletionDecision: { apply: false, reason },
      plannedDeleteCount: 3,
      existingCount: 4,
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(message));
  });

  it('logs nothing when deletions apply', () => {
    const log = vi.fn();
    logDeletionDecision(log, {
      deletionDecision: { apply: true },
      plannedDeleteCount: 1,
      existingCount: 4,
    });
    expect(log).not.toHaveBeenCalled();
  });
});
