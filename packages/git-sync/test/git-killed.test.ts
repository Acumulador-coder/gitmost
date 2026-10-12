import { describe, expect, it, vi } from 'vitest';

// A git process that did not exit has no exit status: killed at its timeout (or
// by any signal), it must fail with that reason. Read as an exit status, a
// killed `git show` would be "the path is absent" and a killed `git grep` "no
// match" — wrong answers the engine would act on. Node's execFile reports such
// a process with `killed`/`signal` set and `code: null`; this suite feeds that
// report to the wrapper through a mocked execFile.

const failure = vi.hoisted(() => ({ error: null as unknown }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = Object.assign(
    () => {
      throw new Error('the callback form of execFile is not used by VaultGit');
    },
    {
      [Symbol.for('nodejs.util.promisify.custom')]: async () => {
        throw failure.error;
      },
    },
  );
  return { ...actual, execFile };
});

const { VaultGit } = await import('../src/engine/git');

describe('VaultGit — a git process killed before it exited', () => {
  it('a git killed by its timeout fails with that reason, not as "path absent"', async () => {
    failure.error = Object.assign(new Error('Command failed: git show main:A.md'), {
      killed: true,
      signal: 'SIGTERM',
      code: null,
      stdout: '',
      stderr: '',
    });

    await expect(new VaultGit('/vault').showFileAtRef('main', 'A.md')).rejects.toThrow(
      /^git show main:A\.md did not finish within \d+ ms and was killed$/,
    );
  });

  it('a git killed by a signal from outside fails with the signal', async () => {
    failure.error = Object.assign(new Error('Command failed: git show main:A.md'), {
      killed: false,
      signal: 'SIGKILL',
      code: null,
      stdout: '',
      stderr: '',
    });

    await expect(new VaultGit('/vault').showFileAtRef('main', 'A.md')).rejects.toThrow(
      'git show main:A.md was killed by SIGKILL',
    );
  });

  it('a git that exited non-zero is still an exit status', async () => {
    failure.error = Object.assign(new Error('Command failed: git show main:A.md'), {
      killed: false,
      signal: null,
      code: 128,
      stdout: '',
      stderr: "fatal: path 'A.md' does not exist in 'main'",
    });

    expect(await new VaultGit('/vault').showFileAtRef('main', 'A.md')).toBeNull();
  });
});
