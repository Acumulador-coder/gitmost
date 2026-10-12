import './git-env';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runPush } from '../src/engine/push';
import type { PushDeps } from '../src/engine/push';
import { BOT_AUTHOR_EMAIL, BOT_AUTHOR_NAME, VaultGit } from '../src/engine/git';
import type { Settings } from '../src/engine/settings';
import { serializeDocmostMarkdownBody } from '@docmost/prosemirror-markdown';

const execFileAsync = promisify(execFile);

// runPush `--apply` against a REAL VaultGit in a temp repo (NO Docmost — the
// client is faked). This guards the real-git BINDING contract that the plain-
// object git fakes in run-push.test.ts cannot catch: the applier's git deps
// (`showFileAtRef`/`pageIdsAtRef`/…) call `this.run`/`this.runRaw` internally,
// so they only work when their `this` receiver is preserved. Passing bare
// method references would throw `this.runRaw is not a function` here. Only the
// LOCAL temp git is mutated; nothing is sent to Docmost.

/** True if a usable `git` binary is on PATH (skip the suite otherwise). */
async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** A minimal valid Settings fixture (only fields runPush reads matter). */
function makeSettings(vaultPath: string): Settings {
  return {
    docmostSpaceId: 'space-1',
    vaultPath,
  };
}

/** A recording client fake; createPage returns an assigned id + updatedAt. */
function makeClientFake() {
  return {
    // Empty live tree -> the create takes the normal createPage path (the
    // retry-adopt lookup matches only on a live (parentPageId, title) node).
    listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
    importPageMarkdown: vi.fn(async () => ({
      data: { updatedAt: '2026-06-20T00:00:00.000Z' },
      success: true,
    })),
    createPage: vi.fn(async (title: string) => ({
      data: { id: 'new-id', title, updatedAt: '2026-06-20T00:00:00.000Z' },
      success: true,
    })),
    deletePage: vi.fn(async () => ({ success: true })),
    movePage: vi.fn(async () => ({ success: true })),
    renamePage: vi.fn(async () => ({ success: true })),
  };
}

describe('runPush --apply against a REAL VaultGit (binding contract)', () => {
  let available = false;
  let dir: string;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies through real git: createPage runs and the create is reported, no throw', async () => {
    if (!available) return; // skip gracefully when git is unavailable

    // Temp bare vault under the OS tmpdir; `main` starts at the initial commit,
    // which is the base runPush diffs from.
    dir = await mkdtemp(join(tmpdir(), 'docmost-push-realgit-'));
    const git = new VaultGit(dir);
    await git.ensureRepo();
    const base = (await git.revParse('refs/heads/main'))!;

    // A brand-new file with meta carrying title + spaceId but NO pageId,
    // committed on `main` AHEAD of the base -> computePushActions yields a CREATE.
    const newFile = serializeDocmostMarkdownBody(
      { version: 1, title: 'New', spaceId: 'sp-1' },
      'fresh body',
    );
    const tree = await git.buildTree(base, [
      { path: 'New.md', sha: await git.hashObject(newFile) },
    ]);
    const head = await git.commitTree(tree, [base], 'add New.md', {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });

    const client = makeClientFake();
    const logs: string[] = [];
    const deps: PushDeps = {
      settings: makeSettings(dir),
      // The WHOLE real VaultGit — its methods must keep their `this` binding.
      git,
      makeClient: () => client as any,
      baseRef: base,
      headRef: head,
      log: (line) => logs.push(line),
    };

    const res = await runPush(deps, { dryRun: false });

    expect(res.mode).toBe('apply');
    expect(res.failures).toEqual([]);
    // The FAKE client was actually called (the write path ran).
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(res.applied?.created).toBe(1);
    expect(res.created).toEqual([{ path: 'New.md', pageId: 'new-id' }]);
  });
});
