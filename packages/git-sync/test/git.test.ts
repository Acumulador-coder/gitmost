import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  VaultGit,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
  LAST_EXPORT_REF,
  PUSH_GUARD_HOOK,
  buildCommitMessage,
  vaultGitEnv,
} from '../src/engine/git';

const execFileAsync = promisify(execFile);

/** True if a usable `git` binary is on PATH (skip the suite otherwise). */
async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

const BOT = { authorName: BOT_AUTHOR_NAME, authorEmail: BOT_AUTHOR_EMAIL };

/** Commit `files` (path -> text, `null` removes) on top of `parent`, with plumbing. */
async function commitFiles(
  git: VaultGit,
  parent: string,
  files: Record<string, string | null>,
  message = 'change',
): Promise<string> {
  const changes = [];
  for (const [path, text] of Object.entries(files)) {
    changes.push({ path, sha: text === null ? null : await git.hashObject(text) });
  }
  return git.commitTree(await git.buildTree(parent, changes), [parent], message, BOT);
}

describe('buildCommitMessage (pure)', () => {
  it('returns the bare subject when there are no trailers', () => {
    expect(buildCommitMessage('subject')).toBe('subject');
    expect(buildCommitMessage('subject', [])).toBe('subject');
  });

  it('appends trailers separated from the subject by a blank line', () => {
    expect(buildCommitMessage('subject', ['Docmost-Sync-Source: docmost'])).toBe(
      'subject\n\nDocmost-Sync-Source: docmost',
    );
  });
});

describe('vaultGitEnv (pure)', () => {
  it('pins locale, pager and prompt, and strips GIT_DIR/GIT_WORK_TREE', () => {
    // Seed inputs that MUST be neutralized/stripped: a redirecting GIT_DIR and
    // GIT_WORK_TREE would defeat the cwd-isolation guarantee (SPEC §12).
    process.env.GIT_DIR = '/somewhere/else/.git';
    process.env.GIT_WORK_TREE = '/somewhere/else';
    try {
      const env = vaultGitEnv();
      // Locale-independent output.
      expect(env.LC_ALL).toBe('C');
      expect(env.LANG).toBe('C');
      // Never page, never block on an interactive prompt.
      expect(env.GIT_PAGER).toBe('cat');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      // The redirecting vars are removed regardless of what process.env held.
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_WORK_TREE).toBeUndefined();
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }
  });

  it('passes through caller extras (e.g. author/committer identity)', () => {
    const env = vaultGitEnv({ GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: 'x@y' });
    expect(env.GIT_AUTHOR_NAME).toBe('X');
    expect(env.GIT_AUTHOR_EMAIL).toBe('x@y');
    // Still strips the redirecting vars even with extras present.
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
  });
});

describe('VaultGit (integration; temp bare vault)', () => {
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

  /** A fresh vault for one test (under the OS tmpdir, NOT the repo). */
  async function freshVault(): Promise<{ vault: string; git: VaultGit; init: string }> {
    dir = await mkdtemp(join(tmpdir(), 'docmost-vault-'));
    const git = new VaultGit(dir);
    await git.ensureRepo();
    return { vault: dir, git, init: (await git.revParse('refs/heads/main'))! };
  }

  const localConfig = async (vault: string, key: string): Promise<string> => {
    const { stdout } = await execFileAsync('git', ['config', '--local', '--get', key], {
      cwd: vault,
    });
    return stdout.trim();
  };

  it('ensureRepo creates a bare repo with main and the pointer at one initial commit, idempotently', async () => {
    if (!available) return; // skip gracefully when git is unavailable
    const { vault, git, init } = await freshVault();

    const { stdout: bare } = await execFileAsync('git', ['rev-parse', '--is-bare-repository'], {
      cwd: vault,
    });
    expect(bare.trim()).toBe('true');
    expect(await git.commitMessage(init)).toBe('init vault');
    expect(await git.revParse(LAST_EXPORT_REF)).toBe(init);
    expect(await git.lsTree(init)).toEqual([]);

    // Idempotent: calling again does not create a second commit.
    expect(await git.ensureRepo()).toBe(false);
    expect(await git.revParse('refs/heads/main')).toBe(init);
  });

  it('clearStaleGitLocks removes a leftover ref lock so the ref moves again (bug D3-N3)', async () => {
    if (!available) return;
    const { vault, git, init } = await freshVault();
    const next = await commitFiles(git, init, { 'a.md': 'a\n' });

    // Simulate an interrupted ref update: a stale main.lock left behind.
    const lockPath = join(vault, 'refs', 'heads', 'main.lock');
    await writeFile(lockPath, '');
    // Backdate the lock beyond the staleness threshold so it is treated as a
    // genuine crash-leftover; a live/fresh lock is preserved (below).
    const anHourAgo = Date.now() / 1000 - 3600;
    await utimes(lockPath, anHourAgo, anHourAgo);
    await expect(git.updateRef('refs/heads/main', next, init)).rejects.toThrow(/main\.lock/);

    await expect(git.clearStaleGitLocks()).resolves.toBe(1);
    await git.updateRef('refs/heads/main', next, init);
    expect(await git.revParse('refs/heads/main')).toBe(next);
    // Idempotent / safe when no lock exists: nothing removed.
    await expect(git.clearStaleGitLocks()).resolves.toBe(0);
  });

  it('clearStaleGitLocks PRESERVES a fresh lock (a concurrent replica may hold it) (bug D3-N3 / F1)', async () => {
    if (!available) return;
    const { vault, git } = await freshVault();
    const lockPath = join(vault, 'HEAD.lock');
    await writeFile(lockPath, '');

    await expect(git.clearStaleGitLocks()).resolves.toBe(0);
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it('ensureMainBranch restores a deleted main from the last-export pointer (bug D3-N1)', async () => {
    if (!available) return;
    const { vault, git, init } = await freshVault();
    await execFileAsync('git', ['update-ref', '-d', 'refs/heads/main'], { cwd: vault });
    expect(await git.branchExists('main')).toBe(false);

    await expect(git.ensureMainBranch()).resolves.toBe(true);
    expect(await git.revParse('refs/heads/main')).toBe(init);
    // Idempotent when main already exists (no recovery performed).
    await expect(git.ensureMainBranch()).resolves.toBe(false);
  });

  it('ensureMainBranch is a no-op without a pointer to restore from (bug D3-N1)', async () => {
    if (!available) return;
    dir = await mkdtemp(join(tmpdir(), 'docmost-vault-'));
    await execFileAsync('git', ['init', '--bare'], { cwd: dir });
    const git = new VaultGit(dir);

    await expect(git.ensureMainBranch()).resolves.toBe(false);
    expect(await git.branchExists('main')).toBe(false);
  });

  it('ensureRepo neutralizes correctness-affecting LOCAL config, restores drift, and leaves a configured vault untouched', async () => {
    if (!available) return;
    const { vault, git } = await freshVault();

    // These LOCAL values neutralize a hostile GLOBAL/system config (SPEC §11
    // for core.autocrlf; gpgsign/safecrlf for the headless daemon).
    expect(await localConfig(vault, 'core.autocrlf')).toBe('false');
    expect(await localConfig(vault, 'commit.gpgsign')).toBe('false');
    expect(await localConfig(vault, 'core.safecrlf')).toBe('false');
    expect(await localConfig(vault, 'core.attributesFile')).toBe('/dev/null');

    // A configured vault: no config write (a write replaces the file via
    // config.lock + rename, a new inode).
    const configPath = join(vault, 'config');
    const before = await stat(configPath);
    await Promise.all([git.ensureRepo(), git.ensureRepo(), git.ensureRepo()]);
    const after = await stat(configPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    // A pinned value that drifted is restored.
    await execFileAsync('git', ['config', 'core.autocrlf', 'true'], { cwd: vault });
    await git.ensureRepo();
    expect(await localConfig(vault, 'core.autocrlf')).toBe('false');
  });

  it('stores blobs verbatim (LF bytes, SPEC §11) and reads them back by path in one batch', async () => {
    if (!available) return;
    const { vault, git, init } = await freshVault();
    // A hostile global autocrlf would turn LF into CRLF in a filtered write.
    await execFileAsync('git', ['config', 'core.autocrlf', 'true'], { cwd: vault });

    const files = {
      'lf.md': 'line1\nline2\nline3\n',
      'Раздел/Подстраница.md': 'тело — с многобайтными символами\n',
      'empty.md': '',
    };
    const head = await commitFiles(git, init, files);

    const read = await git.readFilesAtRef(head, [...Object.keys(files), 'missing.md']);
    expect(Object.fromEntries(read)).toEqual(files);
    const { stdout } = await execFileAsync('git', ['--no-pager', 'show', `${head}:lf.md`], {
      cwd: vault,
      encoding: 'buffer',
    });
    expect((stdout as unknown as Buffer).includes(Buffer.from('\r\n'))).toBe(false);
  });

  it('reads a large path list in chunks of 1000 paths per cat-file call', async () => {
    if (!available) return;
    const { git, init } = await freshVault();
    const head = await commitFiles(git, init, { 'a.md': 'first\n', 'z.md': 'last\n' });
    const runRaw = vi.spyOn(git as any, 'runRaw');

    const paths = ['a.md', ...Array.from({ length: 999 }, (_, i) => `gone/${i}.md`), 'z.md'];
    const read = await git.readFilesAtRef(head, paths);

    expect(Object.fromEntries(read)).toEqual({ 'a.md': 'first\n', 'z.md': 'last\n' });
    expect(runRaw).toHaveBeenCalledTimes(2);
  });

  it('lsTree lists every file with its mode and RAW UTF-8 path; buildTree applies changes, removals and modes', async () => {
    if (!available) return;
    const { git, init } = await freshVault();
    const base = await commitFiles(git, init, {
      'keep.md': 'k\n',
      'Раздел/Колонка.md': 'c\n',
      'gone.md': 'g\n',
    });

    const tree = await git.buildTree(base, [
      { path: 'gone.md', sha: null },
      { path: 'link.md', sha: await git.hashObject('/etc/passwd'), mode: '120000' },
    ]);
    const entries = await git.lsTree(tree);

    expect(entries.map((e) => [e.path, e.mode, e.type])).toEqual([
      ['keep.md', '100644', 'blob'],
      ['link.md', '120000', 'blob'],
      ['Раздел/Колонка.md', '100644', 'blob'],
    ]);
    // The same changes on the same base give the same tree.
    expect(
      await git.buildTree(base, [
        { path: 'link.md', sha: entries[1].sha, mode: '120000' },
        { path: 'gone.md', sha: null },
      ]),
    ).toBe(tree);
  });

  it('treeWithPathsFrom takes each path from the other ref, removing it where that ref has none', async () => {
    if (!available) return;
    const { git, init } = await freshVault();
    const base = await commitFiles(git, init, { 'a.md': 'a1\n', 'b.md': 'b1\n' });
    const head = await commitFiles(git, base, { 'a.md': 'a2\n', 'b.md': null, 'c.md': 'c\n' });

    const mixed = await git.treeWithPathsFrom(head, base, ['a.md', 'b.md', 'c.md']);

    expect(await git.readFilesAtRef(mixed, ['a.md', 'b.md', 'c.md'])).toEqual(
      new Map([
        ['a.md', 'a1\n'],
        ['b.md', 'b1\n'],
      ]),
    );
  });

  it('commitTree writes the trailers and the identity; commitMessage reads them back', async () => {
    if (!available) return;
    const { vault, git, init } = await freshVault();
    const sha = await git.commitTree(`${init}^{tree}`, [init], 'docmost: export 1 page(s)', {
      ...BOT,
      trailers: ['Docmost-Sync-Source: docmost'],
    });

    expect(await git.commitMessage(sha)).toBe(
      'docmost: export 1 page(s)\n\nDocmost-Sync-Source: docmost',
    );
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%an <%ae>', sha], {
      cwd: vault,
    });
    expect(stdout.trim()).toBe(`${BOT_AUTHOR_NAME} <${BOT_AUTHOR_EMAIL}>`);
    expect(await git.revParse('refs/heads/main')).toBe(init);
  });

  it('assertGitAvailable resolves when git is present', async () => {
    if (!available) return;
    dir = await mkdtemp(join(tmpdir(), 'docmost-vault-'));
    // No repo needed: it only probes `git --version`.
    await expect(new VaultGit(join(dir, 'not-yet')).assertGitAvailable()).resolves.toBeUndefined();
  });

  it('diffNameStatus parses A / M / D and a real rename (R), with RAW UTF-8 paths', async () => {
    if (!available) return;
    const { git, init } = await freshVault();
    const body = 'line a\nline b\nline c\nline d\n';
    const base = await commitFiles(git, init, {
      'keep.md': 'v1\n',
      'gone.md': 'old\n',
      'old-name.md': body,
    });
    const head = await commitFiles(git, base, {
      'keep.md': 'v2\n',
      'Статья.md': 'тело\n',
      'gone.md': null,
      'old-name.md': null,
      'new-name.md': body,
    });

    const entries = await git.diffNameStatus(base, head);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get('keep.md')).toEqual({ status: 'M', path: 'keep.md' });
    expect(byPath.get('Статья.md')).toEqual({ status: 'A', path: 'Статья.md' });
    expect(byPath.get('gone.md')).toEqual({ status: 'D', path: 'gone.md' });
    expect(byPath.get('new-name.md')).toEqual({
      status: 'R',
      path: 'new-name.md',
      oldPath: 'old-name.md',
      score: 100,
    });
    expect(entries.length).toBe(4);
  });

  it('revParse / updateRef: null for a missing ref, a compare-and-swap round-trip, deleteRef', async () => {
    if (!available) return;
    const { git, init } = await freshVault();
    const next = await commitFiles(git, init, { 'a.md': 'a\n' });

    expect(await git.revParse('refs/docmost/nope')).toBeNull();
    expect(await git.readRef('refs/docmost/nope')).toBeNull();
    await git.updateRef('refs/docmost/x', init);
    await git.updateRef('refs/docmost/x', next, init);
    expect(await git.readRef('refs/docmost/x')).toBe(next);
    await expect(git.updateRef('refs/docmost/x', init, init)).rejects.toThrow();
    await git.deleteRef('refs/docmost/x');
    await git.deleteRef('refs/docmost/x');
    expect(await git.revParse('refs/docmost/x')).toBeNull();
  });

  it('showFileAtRef reads a file at a ref, a DELETED file at an earlier one, and null when absent', async () => {
    if (!available) return;
    const { git, init } = await freshVault();
    const content = '---\ngitmost_id: page-123\n---\n\nbody\n';
    const before = await commitFiles(git, init, { 'tracked.md': content });
    const after = await commitFiles(git, before, { 'tracked.md': null });

    expect(await git.showFileAtRef(before, 'tracked.md')).toBe(content);
    expect(await git.showFileAtRef(after, 'tracked.md')).toBeNull();
    expect(await git.showFileAtRef(after, 'nope.md')).toBeNull();
  });

  it('pageIdsAtRef lists each .md file first gitmost_id line; commitAddingPath finds the commit that added a path', async () => {
    if (!available) return;
    const { git, init } = await freshVault();
    const added = await commitFiles(git, init, {
      'A.md': '---\ngitmost_id: p-a\n---\n\nbody\n',
      'Dir [x]/B.md': '---\ngitmost_id: "p-b"\n---\n\ngitmost_id: later\n',
      'plain.md': 'no id\n',
      'note.txt': 'gitmost_id: not-md\n',
    });
    const head = await commitFiles(git, added, { 'A.md': '---\ngitmost_id: p-a\n---\n\nedited\n' });

    expect(await git.pageIdsAtRef(head)).toEqual([
      { path: 'A.md', id: 'p-a' },
      { path: 'Dir [x]/B.md', id: 'p-b' },
    ]);
    expect(await git.commitAddingPath(head, 'Dir [x]/B.md')).toBe(added);
    expect(await git.commitAddingPath(head, 'never.md')).toBeNull();
  });

  it('installPushGuard writes the pre-receive hook once, executable', async () => {
    if (!available) return;
    const { vault, git } = await freshVault();
    await git.installPushGuard();
    const path = join(vault, 'hooks', 'pre-receive');
    const first = await stat(path);

    await git.installPushGuard();

    expect(await readFile(path, 'utf8')).toBe(PUSH_GUARD_HOOK);
    expect((await stat(path)).ino).toBe(first.ino);
    expect(first.mode & 0o111).not.toBe(0);
  });
});
