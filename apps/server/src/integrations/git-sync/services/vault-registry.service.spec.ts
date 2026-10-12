// Unit tests for the per-space vault path resolver + lazy VaultGit cache
// `mkdir` and the git-sync loader are mocked so construction is cheap and
// no real filesystem / git work happens. We assert the path normalization
// (trailing slash), the one-VaultGit-per-space caching contract and the
// ensureServable sequence. The config keys themselves are set by the engine
// (`VaultGit.ensureServableConfig`) and tested against real git there.
//
// The service loads `VaultGit` at runtime via the `loadGitSync()` bridge (the
// ESM `@docmost/git-sync` package cannot be `require()`d under jest), so we
// mock that loader rather than the package.
import { mkdir } from 'node:fs/promises';
import { loadGitSync } from '../git-sync.loader';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
}));

// Cheap VaultGit stub: records the path it was constructed with and the order
// of the servable steps; no shell-out. Declared with a `mock`-prefixed name so
// jest allows referencing it inside the hoisted `jest.mock` factory below.
const mockSteps: string[] = [];
const mockVaultGit = jest
  .fn()
  .mockImplementation((path: string) => ({
    path,
    ensureRepo: jest.fn().mockImplementation(async () => {
      mockSteps.push('ensureRepo');
    }),
    ensureServableConfig: jest.fn().mockImplementation(async () => {
      mockSteps.push('ensureServableConfig');
    }),
    installPushGuard: jest.fn().mockImplementation(async () => {
      mockSteps.push('installPushGuard');
    }),
  }));

jest.mock('../git-sync.loader', () => ({
  loadGitSync: jest.fn(async () => ({
    VaultGit: mockVaultGit,
  })),
}));

import { VaultRegistryService } from './vault-registry.service';

type AnyMock = jest.Mock;

const mkdirMock = mkdir as unknown as AnyMock;
const VaultGitMock = mockVaultGit;
void loadGitSync;

function build(dataDir: string): { service: VaultRegistryService } {
  const env = {
    getGitSyncDataDir: jest.fn(() => dataDir),
  };
  const service = new VaultRegistryService(env as any);
  return { service };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSteps.length = 0;
});

describe('VaultRegistryService', () => {
  describe('vaultPath', () => {
    it('normalizes a trailing slash in the data dir (no double slash)', () => {
      const { service } = build('/vaults/');
      expect(service.vaultPath('space-1')).toBe('/vaults/space-1');
    });

    it('works without a trailing slash too', () => {
      const { service } = build('/vaults');
      expect(service.vaultPath('space-1')).toBe('/vaults/space-1');
    });
  });

  describe('getVault lazy cache', () => {
    it('returns the SAME instance on a second call (one VaultGit per space)', async () => {
      const { service } = build('/vaults');

      const first = await service.getVault('space-1');
      const second = await service.getVault('space-1');

      // Same cached instance, constructed exactly once.
      expect(second).toBe(first);
      expect(VaultGitMock).toHaveBeenCalledTimes(1);
      expect(VaultGitMock).toHaveBeenCalledWith('/vaults/space-1');
      // mkdir is only run on the first (cache-miss) construction.
      expect(mkdirMock).toHaveBeenCalledTimes(1);
      expect(mkdirMock).toHaveBeenCalledWith('/vaults/space-1', {
        recursive: true,
      });
    });
  });

  describe('ensureServable', () => {
    it('ensures the repo, then the servable git config, then the push guard', async () => {
      const { service } = build('/vaults');

      const path = await service.ensureServable('space-1');
      expect(path).toBe('/vaults/space-1');

      // The force-push protection, the HTTP services and the symlink guard
      // are set on the vault itself, after it exists, before the hook.
      expect(mockSteps).toEqual([
        'ensureRepo',
        'ensureServableConfig',
        'installPushGuard',
      ]);
    });

    it('rejects (and touches no git config) when ensureRepo rejects', async () => {
      const { service } = build('/vaults');
      const vault = await service.getVault('space-1');
      (vault as any).ensureRepo.mockRejectedValueOnce(new Error('init failed'));

      await expect(service.ensureServable('space-1')).rejects.toThrow(
        'init failed',
      );

      expect((vault as any).ensureServableConfig).not.toHaveBeenCalled();
      expect((vault as any).installPushGuard).not.toHaveBeenCalled();
    });

    it('rejects with the reason when the servable config cannot be set', async () => {
      const { service } = build('/vaults');
      const vault = await service.getVault('space-1');
      (vault as any).ensureServableConfig.mockRejectedValueOnce(
        new Error('git config core.symlinks false failed: could not lock config file'),
      );

      await expect(service.ensureServable('space-1')).rejects.toThrow(
        'could not lock config file',
      );
      expect((vault as any).installPushGuard).not.toHaveBeenCalled();
    });

    it('parallel calls for one space share one run', async () => {
      const { service } = build('/vaults');
      const vault = await service.getVault('space-1');
      let active = 0;
      let maxActive = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      (vault as any).ensureRepo.mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate;
        active--;
      });

      const calls = [1, 2, 3].map(() => service.ensureServable('space-1'));
      release();
      const paths = await Promise.all(calls);

      expect(paths).toEqual(Array(3).fill('/vaults/space-1'));
      expect((vault as any).ensureRepo).toHaveBeenCalledTimes(1);
      expect((vault as any).ensureServableConfig).toHaveBeenCalledTimes(1);
      expect(maxActive).toBe(1);

      // Settled runs are not cached: a later request verifies again.
      await service.ensureServable('space-1');
      expect((vault as any).ensureRepo).toHaveBeenCalledTimes(2);
      expect((vault as any).ensureServableConfig).toHaveBeenCalledTimes(2);
    });

    it('a rejected run is dropped: the next call retries', async () => {
      const { service } = build('/vaults');
      const vault = await service.getVault('space-1');
      (vault as any).ensureRepo.mockRejectedValueOnce(new Error('init failed'));

      await expect(service.ensureServable('space-1')).rejects.toThrow(
        'init failed',
      );
      await expect(service.ensureServable('space-1')).resolves.toBe(
        '/vaults/space-1',
      );
      expect((vault as any).ensureRepo).toHaveBeenCalledTimes(2);
    });
  });
});
