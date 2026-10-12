import { Injectable, Logger } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import type { VaultGit } from '@docmost/git-sync';
import { loadGitSync } from '../git-sync.loader';
import { EnvironmentService } from '../../environment/environment.service';

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
   * pull/push paths call it (and the branch/ref setup) as their first step; this
   * only guarantees the parent dir exists so a fresh space does not ENOENT.
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
   * the repo exists (engine `ensureRepo`: `git init -b main` + initial commit +
   * branches; idempotent), then the LOCAL git config a `git http-backend` push
   * needs (`VaultGit.ensureServableConfig`: updateInstead, no force-push, both
   * HTTP services, `core.symlinks=false`, `core.hooksPath` pinned to the
   * vault's own hooks so a host-wide setting cannot disable it) and the
   * pre-receive push guard.
   *
   * Each config key is read first and written only when its local value
   * differs: every `git config` write takes `.git/config.lock`, and this runs
   * on every /git request OUTSIDE the space lock, so unconditional writes
   * collided with a running cycle's own config work (HTTP 500s, failed cycles).
   * Concurrent calls for one space share a single in-flight run; it is
   * forgotten once it settles, so a later request re-verifies (e.g. after a
   * vault re-init). Returns the absolute vault path. Idempotent and safe to
   * call before every request.
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
    const vault = await this.getVault(spaceId);

    // ensureRepo also verifies git is available on its first git call; it does
    // `git init -b main` + an initial commit + the engine branches. Idempotent.
    await vault.ensureRepo();
    await vault.ensureServableConfig();

    // The pre-receive hook that keeps a push racing a cycle from overwriting
    // the working tree under updateInstead (see PUSH_GUARD_HOOK).
    await vault.installPushGuard();

    return this.vaultPath(spaceId);
  }
}
