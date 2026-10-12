/**
 * One-shot upgrade of a vault written by the two-merge engine (a non-bare repo
 * with a working tree, a `docmost` branch and `refs/docmost/last-pushed`) to the
 * bare layout the cycle runs on: `main` plus the last-export pointer.
 *
 * Runs under the space lock (from `prepareVault`), never from a request that
 * does not hold it. Idempotent; the layout marker is written last, so an upgrade
 * cut off midway runs again from the start.
 */
import { unlink } from "node:fs/promises";
import { DEFAULT_BRANCH, LAST_EXPORT_REF, type VaultGit } from "./git.js";

/** Marks a vault that has the bare layout (written by `ensureRepo` on init). */
const LAYOUT_KEY = "gitsync.layout";
const LAYOUT_VERSION = "2";

/** Refs of the two-merge engine. */
const LEGACY_DOCMOST_BRANCH = "refs/heads/docmost";
const LEGACY_RECORDING_REF = "refs/docmost/recording";
const LEGACY_REFS = [
  LEGACY_DOCMOST_BRANCH,
  "refs/docmost/last-pushed",
  "refs/docmost/pulling",
  LEGACY_RECORDING_REF,
];

/** The lock files the two-merge engine's git operations could leave behind. */
const LEGACY_LOCKS = [
  "index.lock",
  "HEAD.lock",
  "config.lock",
  "packed-refs.lock",
  "MERGE_HEAD.lock",
  "ORIG_HEAD.lock",
  `refs/heads/${DEFAULT_BRANCH}.lock`,
  "refs/heads/docmost.lock",
  "refs/docmost/last-pushed.lock",
  "refs/docmost/pulling.lock",
  "refs/docmost/recording.lock",
];

/** The state files of a merge the two-merge engine left half done. */
const MERGE_STATE_FILES = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"];

export interface UpgradeVaultDeps {
  spaceId: string;
  vault: VaultGit;
  log: (line: string) => void;
  /** Channel for the events an operator must notice; defaults to `log`. */
  warn?: (line: string) => void;
}

/**
 * Upgrade a two-merge vault in place; returns true when it did. The pointer
 * starts at the cut-off push record when there is one, else at the last commit
 * `docmost` and `main` share (what Docmost held at the last merge), else at
 * `main`. Uncommitted working-tree state is ignored and the working-tree files
 * stay on disk (removing them is an operator step).
 */
export async function upgradeLegacyVault(deps: UpgradeVaultDeps): Promise<boolean> {
  const { spaceId, vault } = deps;
  const warn = deps.warn ?? deps.log;
  if ((await vault.getConfig(LAYOUT_KEY)) === LAYOUT_VERSION) return false;

  await vault.clearStaleGitLocks(LEGACY_LOCKS);

  if ((await vault.revParse(LAST_EXPORT_REF)) === null) {
    const main = `refs/heads/${DEFAULT_BRANCH}`;
    let start = await vault.revParse(LEGACY_RECORDING_REF);
    if (start === null) start = await vault.mergeBase(LEGACY_DOCMOST_BRANCH, main);
    if (start === null) {
      start = await vault.revParse(main);
      warn(
        `space ${spaceId}: the vault has no '${LEGACY_RECORDING_REF}' and no commit ` +
          `shared by 'docmost' and '${DEFAULT_BRANCH}' — the last export starts at ` +
          `'${DEFAULT_BRANCH}'.`,
      );
    }
    if (start !== null) await vault.updateRef(LAST_EXPORT_REF, start);
  }

  await vault.setHead(DEFAULT_BRANCH);
  for (const ref of LEGACY_REFS) await vault.deleteRef(ref);
  const gitDir = await vault.gitDir();
  for (const file of MERGE_STATE_FILES) {
    await unlink(`${gitDir}/${file}`).catch(() => undefined);
  }

  await vault.setConfig("core.bare", "true");
  await vault.unsetConfig("receive.denyCurrentBranch");
  await vault.unsetConfig("merge.conflictStyle");
  await vault.setConfig(LAYOUT_KEY, LAYOUT_VERSION);
  warn(`space ${spaceId}: upgraded the vault to the bare layout.`);
  return true;
}
