import { describe, expect, it, vi } from 'vitest';

// A git process that did not exit has no exit status: killed at its timeout (or
// by any signal), it must fail with that reason. Read as an exit status, a
// killed `git show` would be "the path is absent" and a killed `git grep` "no
// match" — wrong answers the engine would act on. Node's execFile reports such
// a process with `killed`/`signal` set and `code: null`; the git runner hands
// that report on as it is, and this suite feeds it to the wrapper through a
// mocked `runGit`.

const failure = vi.hoisted(() => ({ error: null as unknown }));

vi.mock('../src/engine/git-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/git-runner')>();
  return {
    ...actual,
    runGit: async () => {
      throw failure.error;
    },
  };
});

const { VaultGit } = await import('../src/engine/git');
const { GitStoppedError } = await import('../src/engine/git-runner');

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

  it('a git cut off past its output budget fails with that reason', async () => {
    failure.error = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stdout: 'x'.repeat(16),
      stderr: '',
    });

    await expect(new VaultGit('/vault').showFileAtRef('main', 'A.md')).rejects.toThrow(
      /^git show main:A\.md printed more than its \d+-byte output budget and was stopped$/,
    );
  });

  it('a git lost with its helper process fails with the reason, naming the command', async () => {
    failure.error = new GitStoppedError(
      'the git helper process was killed by SIGKILL before git answered',
    );

    const read = new VaultGit('/vault').showFileAtRef('main', 'A.md');
    await expect(read).rejects.toBeInstanceOf(GitStoppedError);
    await expect(read).rejects.toThrow(
      'git show main:A.md: the git helper process was killed by SIGKILL before git answered',
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
