import { describe, expect, it } from 'vitest';
import { readExisting } from '../src/engine/pull';
import { serializePageFile } from '@docmost/prosemirror-markdown';

// R-Pull-1 (test-strategy report §5): `readExisting` takes injectable IO
// (`candidates` — the `git grep` hits — and `readFiles`), so its parsing and
// skip rules are unit-testable without a real git repo. These tests pass fakes
// only. Identity is the native `gitmost_id` FRONTMATTER: a grep hit is only a
// candidate.

/** Build a valid native page file with a `gitmost_id` frontmatter. */
function withId(id: string, body = '# Title\nbody\n'): string {
  return serializePageFile(id, body);
}

/** Fakes over an in-memory tree: every listed path is a grep candidate. */
function deps(files: Record<string, string>, candidates = Object.keys(files)) {
  return {
    candidates: async () => candidates.map((path) => ({ path, id: 'grep-hit' })),
    readFiles: async (paths: string[]) =>
      new Map(paths.flatMap((p) => (p in files ? [[p, files[p]] as const] : []))),
  };
}

describe('readExisting (R-Pull-1, injected IO)', () => {
  it('recovers { pageId, relPath } for valid tracked files', async () => {
    const files = {
      'Space/A.md': withId('p1'),
      'Space/Sub/B.md': withId('p2'),
    };
    expect(await readExisting(deps(files))).toEqual([
      { pageId: 'p1', relPath: 'Space/A.md' },
      { pageId: 'p2', relPath: 'Space/Sub/B.md' },
    ]);
  });

  it('SKIPS a candidate whose gitmost_id line is in the body, not the frontmatter', async () => {
    const files = {
      'tracked.md': withId('p1'),
      'stray.md': '# A note\n\ngitmost_id: quoted in the body\n',
    };
    expect(await readExisting(deps(files))).toEqual([{ pageId: 'p1', relPath: 'tracked.md' }]);
  });

  it('SKIPS a file whose frontmatter has no gitmost_id key or an EMPTY value', async () => {
    const files = {
      'has-id.md': withId('keep'),
      'no-id.md': '---\ntags: [note]\ntitle: untitled\n---\n\nbody\n',
      'blank.md': '---\ngitmost_id:\n---\n\nbody\n',
    };
    expect(await readExisting(deps(files))).toEqual([{ pageId: 'keep', relPath: 'has-id.md' }]);
  });

  it('SKIPS a candidate the read did not return', async () => {
    const files = { 'present.md': withId('present') };
    expect(await readExisting(deps(files, ['present.md', 'ghost.md']))).toEqual([
      { pageId: 'present', relPath: 'present.md' },
    ]);
  });

  it('returns an empty list when nothing is tracked', async () => {
    expect(await readExisting(deps({}))).toEqual([]);
  });
});
