import { Injectable, Logger } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VaultGit } from '@docmost/git-sync';
import { loadGitSync } from '../git-sync.loader';
import { EnvironmentService } from '../../environment/environment.service';

const execFileAsync = promisify(execFile);

/**
 * Resolves the on-disk vault location per space and owns the (lazily created,
 * cached) `VaultGit` instance for each one.
 *
 * Topology: one git repo per enabled space, rooted at
 * `<GIT_SYNC_DATA_DIR>/<spaceId>`. A `VaultGit` is constructed at most once per
 * space and reused across cycles — it is a thin, stateless shell-out wrapper, so
 * caching it just avoids re-resolving the path and re-running `mkdir`.
 */
@Injectable()
export class VaultRegistryService {
  private readonly logger = new Logger(VaultRegistryService.name);
  private readonly vaults = new Map<string, VaultGit>();
  /** The in-flight `ensureServable` run per space (single-flight). */
  private readonly servableRuns = new Map<string, Promise<string>>();

  constructor(private readonly environmentService: EnvironmentService) {}

  /** Absolute vault path for a space: `<GIT_SYNC_DATA_DIR>/<spaceId>`. */
  vaultPath(spaceId: string): string {
    const root = this.environmentService.getGitSyncDataDir().replace(/\/+$/, '');
    return `${root}/${spaceId}`;
  }

  /**
   * Get (or lazily construct + cache) the `VaultGit` for a space, ensuring its
   * directory exists. `VaultGit.ensureRepo()` is NOT called here — the engine's
   * cycle calls it (and the ref setup) as its first step; this only guarantees
   * the parent dir exists so a fresh space does not ENOENT.
   */
  async getVault(spaceId: string): Promise<VaultGit> {
    const cached = this.vaults.get(spaceId);
    if (cached) return cached;

    const path = this.vaultPath(spaceId);
    await mkdir(path, { recursive: true });
    const { VaultGit } = await loadGitSync();
    const vault = new VaultGit(path);
    this.vaults.set(spaceId, vault);
    return vault;
  }

  /**
   * Make a space's vault repo servable over smart-HTTP (the /git host). Ensures
   * the repo exists (engine `ensureRepo`: `git init --bare -b main` + initial
   * commit + the last-export pointer; idempotent), then sets the LOCAL git config
   * a `git http-backend` push needs. It never upgrades a legacy vault: that runs
   * under the space lock (`prepareVault`), and this runs outside it.
   *
   *   - receive.denyNonFastForwards=true — block force-push so a client cannot
   *     rewrite the engine's history on `main`.
   *   - http.receivepack=true / http.uploadpack=true — explicitly allow the
   *     receive/upload services over HTTP.
   *   - core.symlinks=false — SECURITY (PR #119 review). A writer could push a
   *     `.md` entry that is a SYMLINK (e.g. `leak.md -> /etc/passwd`); the vault
   *     is bare and the engine reads only blobs, and it never treats a mode-120000
   *     tree entry as a page. This keeps any checkout of the vault from
   *     materializing such an entry as a real link.
   *
   * Each key is read first and written only when its local value differs:
   * every `git config` write takes `config.lock`, and this runs on every
   * /git request OUTSIDE the space lock, so unconditional writes collided with
   * a running cycle's own config work (HTTP 500s, failed cycles). Concurrent
   * calls for one space share a single in-flight run; it is forgotten once it
   * settles, so a later request re-verifies (e.g. after a vault re-init).
   * Returns the absolute vault path. Idempotent and safe to call before every
   * request.
   */
  async ensureServable(spaceId: string): Promise<string> {
    const inFlight = this.servableRuns.get(spaceId);
    if (inFlight) return inFlight;
    const run = this.makeServable(spaceId).finally(() => {
      this.servableRuns.delete(spaceId);
    });
    this.servableRuns.set(spaceId, run);
    return run;
  }

  private async makeServable(spaceId: string): Promise<string> {
    const { vaultGitEnv } = await loadGitSync();
    const vault = await this.getVault(spaceId);
    const path = this.vaultPath(spaceId);

    // ensureRepo also verifies git is available on its first git call; it does
    // `git init --bare -b main` + an initial commit + the last-export pointer.
    // Idempotent.
    await vault.ensureRepo();

    const configs: Array<[string, string]> = [
      ['receive.denyNonFastForwards', 'true'],
      ['http.receivepack', 'true'],
      ['http.uploadpack', 'true'],
      ['core.symlinks', 'false'],
    ];
    // Bound each `git config` (review suggestion): this runs in the request path
    // BEFORE the watchdog, so a wedged git (a stale `config.lock`) would
    // otherwise hang the request indefinitely. Mirror the engine's GIT_EXEC
    // bound via the configured backend timeout.
    const timeout = this.environmentService.getGitSyncBackendTimeoutMs();
    const opts = {
      cwd: path,
      // Use the engine's cwd-isolated env (strips GIT_DIR / GIT_WORK_TREE) so
      // the config is read from / written to THIS vault's local config only.
      env: vaultGitEnv(),
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    };
    for (const [key, value] of configs) {
      const current = await execFileAsync(
        'git',
        ['config', '--local', '--get', key],
        opts,
      ).then(
        (r) => String(r.stdout).trim(),
        (err) => {
          // Exit 1 = the key is unset; anything else is a real failure.
          if (err?.code === 1) return null;
          throw err;
        },
      );
      if (current === value) continue;
      await execFileAsync('git', ['config', key, value], opts);
    }

    // The pre-receive hook that refuses a push to the engine's own refs (see
    // PUSH_GUARD_HOOK).
    await vault.installPushGuard();

    return path;
  }
}
