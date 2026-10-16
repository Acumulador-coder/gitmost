// Unit tests for the git-sync control plane. The engine's `runCycle`
// (which owns the apply/export choreography) is mocked so we exercise ONLY
// the orchestrator's wiring: gating, the Redis leader lock + in-process mutex
// (via SpaceLockService),
// the remote-template substitution in the settings it hands the engine, the
// external-push ingest, and the idempotent interval lifecycle. The cycle
// mechanics themselves are covered by the engine's own cycle round-trip spec.
//
// The engine mock must be declared before importing the orchestrator so the
// runtime `loadGitSync()` bridge resolves to the mocked `runCycle` (the ESM
// `@docmost/git-sync` package cannot be `require()`d under jest). The `mock`
// prefix lets the hoisted factory reference it.
const mockRunCycle = jest.fn();
const mockPrepareVault = jest.fn();

jest.mock('../git-sync.loader', () => ({
  loadGitSync: jest.fn(async () => ({
    runCycle: mockRunCycle,
    prepareVault: mockPrepareVault,
  })),
}));
// The real registry is a disabled no-op under jest (no METRICS_PORT); spy on the
// git-sync helpers so the orchestrator's metric calls are observable.
jest.mock('../../metrics/metrics.registry', () => ({
  ...jest.requireActual('../../metrics/metrics.registry'),
  incGitSyncCycle: jest.fn(),
  observeGitSyncCycle: jest.fn(),
  setGitSyncFailingSpaces: jest.fn(),
  setGitSyncPushFailingSpaces: jest.fn(),
}));

import { Logger } from '@nestjs/common';
import {
  incGitSyncCycle,
  observeGitSyncCycle,
  setGitSyncFailingSpaces,
  setGitSyncPushFailingSpaces,
} from '../../metrics/metrics.registry';
import {
  Kysely,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  CompiledQuery,
} from 'kysely';
import {
  GIT_SYNC_CYCLE_DEADLINE_MS,
  GitSyncOrchestrator,
  GitSyncLockHeldError,
} from './git-sync.orchestrator';
import { GitSyncDeadlineError, SpaceLockService } from './space-lock.service';
import { GIT_SYNC_LOCK_TTL_MS } from '../git-sync.constants';

type AnyMock = jest.Mock;

const runCycleMock = mockRunCycle as unknown as AnyMock;
const prepareVaultMock = mockPrepareVault as unknown as AnyMock;

/** The default happy-path cycle result the engine returns. */
const OK_CYCLE = {
  ran: true,
  pull: { written: 0, deleted: 0, failures: 0 },
  push: { mode: 'apply', failures: 0 },
};

interface BuildOptions {
  /** Env tunables (only the load-bearing ones are surfaced as overrides). */
  serviceUserId?: string | undefined;
  dataDir?: string;
  pollIntervalMs?: number;
  debounceMs?: number;
  /** A hook applied to the fake vault so a test can override its behaviour. */
  vaultOverrides?: Record<string, unknown>;
  /**
   * The per-space opt-in flag `runOnce` reads via `isSpaceGitSyncEnabled`
   * (`executeTakeFirst` on the `enabled`-aliased query). Default
   * `true` so a build() space passes the per-space gate and the cycle proceeds.
   * Set `false` to model a space that did NOT opt in (skipped:'space-not-enabled').
   */
  spaceEnabled?: boolean;
  /** What the restricted-pages predicate answers (default: no restrictions). */
  restricted?: boolean;
}

interface Built {
  orchestrator: GitSyncOrchestrator;
  env: Record<string, AnyMock>;
  dataSource: { bind: AnyMock };
  client: Record<string, AnyMock>;
  vaultRegistry: { getVault: AnyMock; vaultPath: AnyMock };
  vault: Record<string, AnyMock>;
  scheduler: Record<string, AnyMock>;
  redis: { set: AnyMock; eval: AnyMock };
  redisService: { getOrThrow: AnyMock };
  db: unknown;
  restrictions: { spaceHasRestrictedPages: AnyMock };
}

function build(opts: BuildOptions = {}): Built {
  const {
    dataDir = '/vaults',
    pollIntervalMs = 15000,
    debounceMs = 2000,
    vaultOverrides = {},
    spaceEnabled = true,
    restricted = false,
  } = opts;
  // Distinguish "key omitted" (default to a valid id) from "key present but
  // undefined" (an unset service user).
  const serviceUserId = 'serviceUserId' in opts ? opts.serviceUserId : 'svc-user';

  const env: Record<string, AnyMock> = {
    getGitSyncServiceUserId: jest.fn(() => serviceUserId),
    getGitSyncDataDir: jest.fn(() => dataDir),
    getGitSyncPollIntervalMs: jest.fn(() => pollIntervalMs),
    getGitSyncDebounceMs: jest.fn(() => debounceMs),
  };

  // The read-side / write-side client the datasource hands back.
  const client: Record<string, AnyMock> = {
    listSpaceTree: jest.fn(async () => ({ pages: [], complete: true })),
    // Historical behavior: every candidate id is a real page row. Present so the
    // fake does not rely on `listTrackedFiles -> []` to avoid the ghost-guard
    // probe, and won't break if a future test seeds tracked files.
    pageIdsExist: jest.fn(async (ids: string[]) => ids),
    deletePage: jest.fn(async () => undefined),
    createPage: jest.fn(async () => undefined),
    updatePageBody: jest.fn(async () => undefined),
  };
  const dataSource = { bind: jest.fn(() => client) };

  // The fake VaultGit: every method the orchestrator calls is a jest.fn.
  const vault: Record<string, AnyMock> = {
    assertGitAvailable: jest.fn(async () => undefined),
    ensureRepo: jest.fn(async () => undefined),
    ...(vaultOverrides as Record<string, AnyMock>),
  };
  const vaultRegistry = {
    getVault: jest.fn(async () => vault),
    vaultPath: jest.fn((spaceId: string) => `${dataDir}/${spaceId}`),
  };

  const scheduler: Record<string, AnyMock> = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
  };

  const redis = {
    // Default: lock acquired. Tests override per-case.
    set: jest.fn(async () => 'OK'),
    eval: jest.fn(async () => 1),
  };
  const redisService = { getOrThrow: jest.fn(() => redis) };

  // Chainable Kysely stub. The single-row query ends in `executeTakeFirst`:
  //   - `isSpaceGitSyncEnabled` (per-space opt-in gate in `runOnce`, added by
  //     c838fdee): `.select(sql\`...->>'enabled' = 'true'\`.as('enabled'))` ->
  //     the code reads `row?.enabled`. Return `{ enabled: spaceEnabled }`.
  // `enabledSpaces` uses `.select([...strings]).execute()` (no alias, no
  // executeTakeFirst) and is stubbed/replaced in the tests that exercise it.
  const db = (() => {
    let lastAlias: string | undefined;
    const aliasOf = (sel: unknown): string | undefined => {
      try {
        const node = (sel as { toOperationNode?: () => any })?.toOperationNode?.();
        return node?.kind === 'AliasNode' ? node.alias?.name : undefined;
      } catch {
        return undefined;
      }
    };
    const builder: any = {
      select: (sel: unknown) => {
        const alias = aliasOf(sel);
        if (alias) lastAlias = alias;
        return builder;
      },
      where: () => builder,
      executeTakeFirst: async () =>
        lastAlias === 'enabled' ? { enabled: spaceEnabled } : undefined,
      execute: async () => [],
    };
    return { selectFrom: () => builder };
  })();

  // The REAL SpaceLockService, constructed against the mock redis above, so all
  // existing lock assertions (lock-held, in-progress, leader lock, release CAS,
  // heartbeat) still exercise the same `redis.set`/`redis.eval` mock unchanged.
  const spaceLock = new SpaceLockService(redisService as any);
  const restrictions = {
    spaceHasRestrictedPages: jest.fn(async () => restricted),
  };

  const orchestrator = new GitSyncOrchestrator(
    env as any,
    dataSource as any,
    vaultRegistry as any,
    scheduler as any,
    spaceLock as any,
    db as any,
    restrictions as any,
  );

  return {
    orchestrator,
    env,
    dataSource,
    client,
    vaultRegistry,
    vault,
    scheduler,
    redis,
    redisService,
    db,
    restrictions,
  };
}

/** Let queued continuations (and short real timers) run until `cond` holds. */
async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The engine runs a clean cycle by default. */
function primeEngineHappyPath(): void {
  runCycleMock.mockResolvedValue(OK_CYCLE);
  prepareVaultMock.mockResolvedValue(false);
}

beforeEach(() => {
  jest.clearAllMocks();
  primeEngineHappyPath();
});

describe('GitSyncOrchestrator', () => {
  describe('in-process mutex', () => {
    it("a second runOnce while the first is in-flight returns skipped:'in-progress'", async () => {
      const built = build();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Hang the first cycle inside driveCycle by stalling getVault.
      built.vaultRegistry.getVault.mockImplementationOnce(async () => {
        await gate;
        return built.vault;
      });

      const first = built.orchestrator.runOnce('space-1', 'ws-1');
      // Let the first call enter the running set + acquire the lock.
      await Promise.resolve();
      await Promise.resolve();

      const second = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(second).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'in-progress',
      });

      release();
      await first;
    });
  });

  describe('redis leader lock', () => {
    it("returns skipped:'lock-held' and cleans up the mutex when the lock is not acquired", async () => {
      const built = build();
      // First acquire fails (not 'OK'); a later acquire succeeds.
      built.redis.set
        .mockResolvedValueOnce(null)
        .mockResolvedValue('OK');

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'lock-held',
      });
      // The mutex must be clear: a subsequent call can acquire + run.
      const res2 = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res2.ran).toBe(true);
      expect(res2.skipped).toBeUndefined();
    });
  });

  describe('poisoned-space protection', () => {
    it('releases the lock and clears the mutex when the cycle throws, returning { error }', async () => {
      const built = build();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      runCycleMock.mockRejectedValueOnce(new Error('boom'));

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res.ran).toBe(false);
      expect(res.error).toBe('boom');
      // CAS release was invoked (eval) and the space is no longer "running":
      expect(built.redis.eval).toHaveBeenCalledTimes(1);

      // A subsequent call can re-acquire (mutex cleared after the throw).
      runCycleMock.mockResolvedValue(OK_CYCLE);
      const res2 = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res2.ran).toBe(true);
    });
  });

  describe('cycle wiring', () => {
    it('drives runCycle with the space vault, the bound client, and settings', async () => {
      const built = build();
      await built.orchestrator.runOnce('space-1', 'ws-1');

      expect(runCycleMock).toHaveBeenCalledTimes(1);
      const [deps] = runCycleMock.mock.calls[0];
      expect(deps.spaceId).toBe('space-1');
      expect(deps.vault).toBe(built.vault);
      expect(deps.client).toBe(built.client);
      expect(deps.settings.vaultPath).toBe('/vaults/space-1');
      // The bound datasource identity is the (workspace, service-user) pair,
      // plus the reconciling spaceId used by deletePage's cross-move guard.
      expect(built.dataSource.bind).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        userId: 'svc-user',
        spaceId: 'space-1',
        // The datasource stops at its next call when the lock is lost or the
        // cycle deadline passes.
        signal: deps.signal,
      });
      expect(deps.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('ingestExternalPush', () => {
    it('prepares the vault (legacy upgrade) under the lock BEFORE the receive-pack', async () => {
      const order: string[] = [];
      const built = build();
      built.redis.set.mockImplementation(async () => {
        order.push('lock');
        return 'OK';
      });
      prepareVaultMock.mockImplementation(async (deps: any) => {
        order.push(`prepare:${deps.spaceId}`);
        expect(deps.vault).toBe(built.vault);
        return true;
      });
      runCycleMock.mockImplementation(async () => {
        order.push('cycle');
        return OK_CYCLE;
      });
      const runReceivePack = jest.fn(async () => {
        order.push('receive-pack');
      });

      await built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack);

      expect(order[0]).toBe('lock');
      expect(order.filter((o) => o !== 'lock')).toEqual([
        'prepare:space-1',
        'receive-pack',
        'cycle',
      ]);
    });

    it('streams the receive-pack FIRST, then runs the Docmost cycle', async () => {
      const order: string[] = [];
      const built = build();
      runCycleMock.mockImplementation(async () => {
        order.push('cycle');
        return OK_CYCLE;
      });
      const runReceivePack = jest.fn(async () => {
        order.push('receive-pack');
      });

      await built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack);

      expect(runReceivePack).toHaveBeenCalledTimes(1);
      // The cycle only runs AFTER the push commits land on main.
      expect(order).toEqual(['receive-pack', 'cycle']);
    });

    // Explicit timeout: ingestExternalPush exhausts the full bounded
    // acquire-retry budget (GIT_SYNC_PUSH_LOCK_RETRY_TOTAL_MS = 5_000ms) before it
    // gives up and throws, which races jest's DEFAULT 5_000ms test timeout — flaky
    // on a loaded/slow runner. Give it headroom so it deterministically observes
    // the eventual LockHeldError instead of timing out first.
    it('throws GitSyncLockHeldError and does NOT run the receive-pack when the lock is held', async () => {
      const built = build();
      built.redis.set.mockResolvedValue(null); // acquire fails → lock-held
      const runReceivePack = jest.fn(async () => undefined);

      await expect(
        built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack),
      ).rejects.toBeInstanceOf(GitSyncLockHeldError);

      // We must never move `main` concurrently with a cycle.
      expect(runReceivePack).not.toHaveBeenCalled();
      expect(runCycleMock).not.toHaveBeenCalled();
      // The refused push shows in the space's status.
      const [status] = built.orchestrator.getSpaceStatuses('ws-1');
      expect(status.lastSkipReason).toBe('lock-held');
      expect(status.lockHeldSince).toEqual(expect.any(String));
      expect(status.lastRunAt).toBeNull();
    }, 15_000);

    it('swallows a post-push cycle error (the push is durable; poll retries)', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const built = build();
      // The cycle throws AFTER the receive-pack already succeeded.
      runCycleMock.mockRejectedValueOnce(new Error('cycle boom'));
      const runReceivePack = jest.fn(async () => undefined);

      // Does NOT throw — the durable push must not be reported as failed.
      await expect(
        built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack),
      ).resolves.toBeUndefined();
      expect(runReceivePack).toHaveBeenCalledTimes(1);
      // Lock was still released (CAS eval) despite the cycle error.
      expect(built.redis.eval).toHaveBeenCalled();
    });
  });

  // git-sync cannot enforce page-level restrictions, so a space holding any is
  // refused before anything is exported or written.
  describe('restricted spaces', () => {
    it('refuses the cycle: nothing exported or written, ERROR log and a failed status naming the reason', async () => {
      const built = build({ restricted: true });
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');

      expect(built.restrictions.spaceHasRestrictedPages).toHaveBeenCalledWith(
        'space-1',
        'ws-1',
      );
      expect(runCycleMock).not.toHaveBeenCalled();
      expect(built.dataSource.bind).not.toHaveBeenCalled();
      expect(built.vaultRegistry.getVault).not.toHaveBeenCalled();
      expect(res.ran).toBe(false);
      expect(res.error).toContain('page-level access restrictions');
      const [status] = built.orchestrator.getSpaceStatuses('ws-1');
      expect(status.lastResult).toBe('failed');
      expect(status.lastError).toContain('page-level access restrictions');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('page-level access restrictions'),
        expect.anything(),
      );
    });

    it('does not reconcile a push into such a space into Docmost', async () => {
      const built = build({ restricted: true });
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await built.orchestrator.ingestExternalPush(
        'space-1',
        'ws-1',
        async () => {
          /* receive-pack */
        },
      );

      expect(runCycleMock).not.toHaveBeenCalled();
      expect(built.dataSource.bind).not.toHaveBeenCalled();
      const [status] = built.orchestrator.getSpaceStatuses('ws-1');
      expect(status.lastError).toContain('page-level access restrictions');
    });
  });

  // A cycle that never returns must not hold its space (or the poll) forever.
  describe('cycle deadline', () => {
    it('aborts a hung cycle at the deadline: ERROR, failed status, lease no longer renewed, space busy until the cycle settles', async () => {
      jest.useFakeTimers();
      try {
        const built = build();
        const error = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
        let cycleSignal!: AbortSignal;
        let finishCycle!: () => void;
        runCycleMock.mockImplementationOnce((deps: any) => {
          cycleSignal = deps.signal;
          return new Promise((resolve) => {
            finishCycle = () => resolve(OK_CYCLE);
          });
        });

        const first = built.orchestrator.runOnce('space-1', 'ws-1');
        await jest.advanceTimersByTimeAsync(GIT_SYNC_CYCLE_DEADLINE_MS);
        const res = await first;

        // The caller is released at the deadline with a specific reason.
        expect(res.ran).toBe(false);
        expect(res.error).toContain(
          `exceeded its ${GIT_SYNC_CYCLE_DEADLINE_MS} ms deadline`,
        );
        // The cycle's signal carries the deadline as its abort reason.
        expect(cycleSignal.aborted).toBe(true);
        expect(cycleSignal.reason).toBeInstanceOf(GitSyncDeadlineError);
        const [status] = built.orchestrator.getSpaceStatuses('ws-1');
        expect(status.lastResult).toBe('failed');
        expect(status.lastError).toContain('deadline');
        expect(status.runningSince).toBeNull();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('deadline'));

        // The lease is no longer renewed after the deadline.
        const renewals = () =>
          built.redis.eval.mock.calls.filter(([lua]) =>
            String(lua).includes('pexpire'),
          ).length;
        const renewalsAtDeadline = renewals();
        await jest.advanceTimersByTimeAsync(2 * GIT_SYNC_LOCK_TTL_MS);
        expect(renewals()).toBe(renewalsAtDeadline);

        // The hung cycle still holds the space here: no second writer.
        await expect(
          built.orchestrator.runOnce('space-1', 'ws-1'),
        ).resolves.toEqual({
          spaceId: 'space-1',
          ran: false,
          skipped: 'in-progress',
        });

        // Once it settles the space is free again.
        finishCycle();
        await jest.advanceTimersByTimeAsync(1);
        const again = await built.orchestrator.runOnce('space-1', 'ws-1');
        expect(again.ran).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('a hung space does not stop the poll for the other spaces', async () => {
      const built = build();
      jest.spyOn(built.orchestrator as any, 'enabledSpaces').mockResolvedValue([
        { spaceId: 'space-1', workspaceId: 'ws-1' },
        { spaceId: 'space-2', workspaceId: 'ws-1' },
        { spaceId: 'space-3', workspaceId: 'ws-1' },
      ]);
      let releaseHung!: () => void;
      const hung = new Promise((resolve) => {
        releaseHung = () => resolve(OK_CYCLE);
      });
      runCycleMock.mockImplementation(async (deps: any) =>
        deps.spaceId === 'space-1' ? hung : OK_CYCLE,
      );
      const cyclesOf = (spaceId: string) =>
        runCycleMock.mock.calls.filter(([deps]) => deps.spaceId === spaceId)
          .length;

      const firstTick = (built.orchestrator as any).pollTick();
      // While space-1 hangs, the other slot works through the rest of the list.
      await until(() => cyclesOf('space-2') === 1 && cyclesOf('space-3') === 1);
      // Later ticks keep reconciling the others.
      await (built.orchestrator as any).pollTick();
      await (built.orchestrator as any).pollTick();

      expect(cyclesOf('space-2')).toBe(3);
      expect(cyclesOf('space-3')).toBe(3);
      expect(cyclesOf('space-1')).toBe(1);

      releaseHung();
      await firstTick;
    });

    it('one tick reaches every enabled space, at most two cycles at a time', async () => {
      const built = build();
      jest.spyOn(built.orchestrator as any, 'enabledSpaces').mockResolvedValue([
        { spaceId: 'space-1', workspaceId: 'ws-1' },
        { spaceId: 'space-2', workspaceId: 'ws-1' },
        { spaceId: 'space-3', workspaceId: 'ws-1' },
      ]);
      let running = 0;
      let peak = 0;
      const ran: string[] = [];
      jest
        .spyOn(built.orchestrator, 'runOnce')
        .mockImplementation(async (spaceId: string) => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running--;
          ran.push(spaceId);
          return { spaceId, ran: true };
        });

      await (built.orchestrator as any).pollTick();

      expect(ran.sort()).toEqual(['space-1', 'space-2', 'space-3']);
      expect(peak).toBe(2);
    });

    it('a tick starts no more cycles once the module is destroyed', async () => {
      const built = build();
      jest.spyOn(built.orchestrator as any, 'enabledSpaces').mockResolvedValue([
        { spaceId: 'space-1', workspaceId: 'ws-1' },
        { spaceId: 'space-2', workspaceId: 'ws-1' },
        { spaceId: 'space-3', workspaceId: 'ws-1' },
      ]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runOnce = jest
        .spyOn(built.orchestrator, 'runOnce')
        .mockImplementation(async (spaceId: string) => {
          await gate;
          return { spaceId, ran: true };
        });

      const tick = (built.orchestrator as any).pollTick();
      await until(() => runOnce.mock.calls.length === 2);
      built.orchestrator.onModuleDestroy();
      release();
      await tick;

      expect(runOnce).toHaveBeenCalledTimes(2);
    });
  });

  describe('module lifecycle', () => {
    it('registers exactly one interval on init and tears it down idempotently on destroy', () => {
      const built = build();
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      built.orchestrator.onModuleInit();
      expect(built.scheduler.addInterval).toHaveBeenCalledTimes(1);
      const [name] = built.scheduler.addInterval.mock.calls[0];

      built.orchestrator.onModuleDestroy();
      expect(built.scheduler.deleteInterval).toHaveBeenCalledTimes(1);
      expect(built.scheduler.deleteInterval).toHaveBeenCalledWith(name);

      // A second destroy is a no-op (guard against double-delete).
      built.orchestrator.onModuleDestroy();
      expect(built.scheduler.deleteInterval).toHaveBeenCalledTimes(1);
    });
  });

  // The poll-safety backstop: each tick enumerates the STRICT opt-in spaces and
  // reconciles each one under its own lock. We drive the private `pollTick()`
  // directly and (separately) compile `enabledSpaces()` to assert its opt-in SQL.
  describe('pollTick + enabledSpaces (strict opt-in backstop)', () => {
    it('runs runOnce exactly once per enabled space, with the right (spaceId, workspaceId)', async () => {
      const built = build();
      // Isolate the tick wiring from the cycle machinery: stub the enumeration
      // and count runOnce (it never throws; here we don't exercise its body).
      const runOnce = jest
        .spyOn(built.orchestrator, 'runOnce')
        .mockResolvedValue({ spaceId: 'x', ran: true });
      jest
        .spyOn(built.orchestrator as any, 'enabledSpaces')
        .mockResolvedValue([
          { spaceId: 'space-1', workspaceId: 'ws-1' },
          { spaceId: 'space-2', workspaceId: 'ws-2' },
        ]);

      await (built.orchestrator as any).pollTick();

      expect(runOnce).toHaveBeenCalledTimes(2);
      // Per-space isolation: each space is reconciled with its OWN workspace id.
      expect(runOnce).toHaveBeenNthCalledWith(1, 'space-1', 'ws-1');
      expect(runOnce).toHaveBeenNthCalledWith(2, 'space-2', 'ws-2');
    });

    it('skips an overlapping tick while a previous pass is still in flight (re-entrancy guard)', async () => {
      const built = build();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Stall the first pass inside enabledSpaces so a second tick fires while it
      // is still running.
      const enabledSpy = jest
        .spyOn(built.orchestrator as any, 'enabledSpaces')
        .mockImplementation(async () => {
          await gate;
          return [{ spaceId: 'space-1', workspaceId: 'ws-1' }];
        });
      const runOnce = jest
        .spyOn(built.orchestrator, 'runOnce')
        .mockResolvedValue({ spaceId: 'space-1', ran: true });

      const first = (built.orchestrator as any).pollTick();
      await Promise.resolve(); // let the first pass set polling=true + await gate

      // A second tick during the first must be skipped: it never even enumerates.
      await (built.orchestrator as any).pollTick();
      expect(enabledSpy).toHaveBeenCalledTimes(1);

      release();
      await first;
      expect(runOnce).toHaveBeenCalledTimes(1);

      // After the first pass cleared the flag, a fresh tick runs normally.
      await (built.orchestrator as any).pollTick();
      expect(enabledSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT throw and runs nothing when the enabled-spaces query throws (try/catch backstop)', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const built = build();
      const runOnce = jest.spyOn(built.orchestrator, 'runOnce');
      jest
        .spyOn(built.orchestrator as any, 'enabledSpaces')
        .mockRejectedValue(new Error('db down'));

      // A failed enumeration must never break the interval — pollTick swallows it.
      await expect(
        (built.orchestrator as any).pollTick(),
      ).resolves.toBeUndefined();
      expect(runOnce).not.toHaveBeenCalled();
    });

    it('compiles the STRICT opt-in enumeration SQL (spaces, deletedAt is null, enabled flag)', async () => {
      // Inject a compile-only Kysely (DummyDriver) whose `log` hook captures the
      // exact SQL `enabledSpaces()` runs — no fake builder, the real query is
      // compiled. DummyDriver yields no rows; we only assert the SQL shape.
      const built = build();
      let captured: CompiledQuery | undefined;
      const compileDb = new Kysely<any>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => new DummyDriver(),
          createIntrospector: (d) => new PostgresIntrospector(d),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
        log: (event) => {
          if (event.level === 'query') captured = event.query as CompiledQuery;
        },
      });
      // Swap the orchestrator's injected db for the compile-only instance.
      (built.orchestrator as any).db = compileDb;

      const rows = await (built.orchestrator as any).enabledSpaces();
      // DummyDriver returns no rows -> empty opt-in list (the no-space default).
      expect(rows).toEqual([]);

      expect(captured).toBeDefined();
      const sql = captured!.sql.replace(/\s+/g, ' ');
      expect(sql).toContain('from "spaces"');
      // deletedAt-is-null guard (live spaces only).
      expect(sql).toContain('"deletedAt" is null');
      // STRICT per-space opt-in: the raw jsonb flag predicate, verbatim.
      expect(sql).toContain(`settings->'gitSync'->>'enabled' = 'true'`);
    });
  });

  // A failing space must be visible in /status and the metrics, not only as an
  // ERROR logged on every poll.
  describe('per-space health, transition logging and metrics', () => {
    const incCycle = incGitSyncCycle as unknown as AnyMock;
    const setFailing = setGitSyncFailingSpaces as unknown as AnyMock;

    function spies() {
      return {
        error: jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined),
        log: jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
        debug: jest
          .spyOn(Logger.prototype, 'debug')
          .mockImplementation(() => undefined),
      };
    }

    it('a running cycle shows in /status (runningSince) and the mark clears when it ends', async () => {
      const built = build();
      spies();
      let during: any[] = [];
      runCycleMock.mockImplementationOnce(async () => {
        during = built.orchestrator.getSpaceStatuses('ws-1');
        return OK_CYCLE;
      });
      runCycleMock.mockImplementationOnce(async () => {
        during = built.orchestrator.getSpaceStatuses('ws-1');
        throw new Error('boom');
      });

      // First cycle after a restart: the space was unknown until it started.
      expect(built.orchestrator.getSpaceStatuses('ws-1')).toEqual([]);
      await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(during).toHaveLength(1);
      expect(during[0]).toMatchObject({
        spaceId: 'space-1',
        runningSince: expect.any(String),
        lastRunAt: null,
      });
      expect(built.orchestrator.getSpaceStatuses('ws-1')[0].runningSince).toBeNull();

      // A failing cycle clears it too.
      await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(during[0].runningSince).toEqual(expect.any(String));
      const [after] = built.orchestrator.getSpaceStatuses('ws-1');
      expect(after.lastResult).toBe('failed');
      expect(after.runningSince).toBeNull();
    });

    it('poll ticks record the outcome: ERROR once on healthy -> failing, not on every tick', async () => {
      const built = build();
      const { error, debug } = spies();
      jest
        .spyOn(built.orchestrator as any, 'enabledSpaces')
        .mockResolvedValue([{ spaceId: 'space-1', workspaceId: 'ws-1' }]);
      runCycleMock.mockRejectedValue(new Error('git checkout docmost failed'));

      await (built.orchestrator as any).pollTick();
      await (built.orchestrator as any).pollTick();
      await (built.orchestrator as any).pollTick();

      // One ERROR for the transition (with the space + reason), repeats at DEBUG.
      const failingErrors = error.mock.calls.filter((c) =>
        String(c[0]).includes('space-1'),
      );
      expect(failingErrors).toHaveLength(1);
      expect(String(failingErrors[0][0])).toContain('git checkout docmost failed');
      expect(debug).toHaveBeenCalledTimes(2);

      const [status] = built.orchestrator.getSpaceStatuses('ws-1');
      expect(status).toEqual({
        spaceId: 'space-1',
        lastRunAt: expect.any(String),
        lastResult: 'failed',
        lastError: 'git checkout docmost failed',
        lastSuccessAt: null,
        consecutiveFailures: 3,
        pullFailures: 0,
        firstPullFailure: null,
        pushFailures: 0,
        firstPushFailure: null,
        lastSkippedAt: null,
        lastSkipReason: null,
        lockHeldSince: null,
        runningSince: null,
      });
      // Metrics: three failed cycles, one failing space.
      expect(incCycle.mock.calls).toEqual([['failed'], ['failed'], ['failed']]);
      expect(setFailing).toHaveBeenLastCalledWith(1);
    });

    it('records every cycle duration by outcome, a failed cycle included', async () => {
      const built = build();
      spies();
      const observe = observeGitSyncCycle as unknown as AnyMock;
      observe.mockClear();
      runCycleMock.mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return OK_CYCLE;
      });
      runCycleMock.mockRejectedValueOnce(new Error('boom'));

      await built.orchestrator.runOnce('space-1', 'ws-1');
      await built.orchestrator.runOnce('space-1', 'ws-1');

      expect(observe.mock.calls).toEqual([
        ['ok', expect.any(Number)],
        ['failed', expect.any(Number)],
      ]);
      // Seconds, not milliseconds: the 20 ms cycle reads as ~0.02.
      expect(observe.mock.calls[0][1]).toBeGreaterThanOrEqual(0.015);
      expect(observe.mock.calls[0][1]).toBeLessThan(5);
    });

    it('logs the recovery (INFO) once and resets the failure state', async () => {
      const built = build();
      const { log } = spies();
      runCycleMock.mockRejectedValueOnce(new Error('boom'));
      runCycleMock.mockRejectedValueOnce(new Error('boom'));

      await built.orchestrator.runOnce('space-1', 'ws-1');
      await built.orchestrator.runOnce('space-1', 'ws-1');
      await built.orchestrator.runOnce('space-1', 'ws-1'); // succeeds
      await built.orchestrator.runOnce('space-1', 'ws-1'); // still healthy

      const recoveries = log.mock.calls.filter((c) =>
        String(c[0]).includes('RECOVERED'),
      );
      expect(recoveries).toHaveLength(1);
      expect(String(recoveries[0][0])).toContain('space-1');

      const [status] = built.orchestrator.getSpaceStatuses('ws-1');
      expect(status.lastResult).toBe('ok');
      expect(status.lastError).toBeNull();
      expect(status.consecutiveFailures).toBe(0);
      expect(status.lastSuccessAt).toBe(status.lastRunAt);
      expect(incCycle.mock.calls).toEqual([
        ['failed'],
        ['failed'],
        ['ok'],
        ['ok'],
      ]);
      expect(setFailing).toHaveBeenLastCalledWith(0);
    });

    it('reports per-page push failures of the last cycle with the first failure path + reason', async () => {
      const built = build();
      runCycleMock.mockResolvedValue({
        ...OK_CYCLE,
        push: {
          mode: 'apply',
          failures: 2,
          firstFailure: {
            kind: 'create',
            path: 'Folder/New.md',
            error: 'Parent page not found',
          },
        },
      });

      await built.orchestrator.runOnce('space-1', 'ws-1');

      const [status] = built.orchestrator.getSpaceStatuses('ws-1');
      expect(status.lastResult).toBe('ok');
      expect(status.pushFailures).toBe(2);
      expect(status.firstPushFailure).toEqual({
        path: 'Folder/New.md',
        pageId: null,
        reason: 'Parent page not found',
      });
    });

    it('reports the pages the pull could not write into the vault, with the first page id + reason', async () => {
      const built = build();
      runCycleMock.mockResolvedValueOnce({
        ...OK_CYCLE,
        pull: {
          written: 3,
          deleted: 0,
          failures: 2,
          firstFailure: {
            pageId: 'page-big',
            error:
              'ProseMirror -> markdown export refused: the document is 11000000 ' +
              'bytes of JSON, over the 10485760-byte budget',
          },
        },
      });

      await built.orchestrator.runOnce('space-1', 'ws-1');

      // The cycle itself succeeded, yet the status shows what did not reach git.
      const [status] = built.orchestrator.getSpaceStatuses('ws-1');
      expect(status.lastResult).toBe('ok');
      expect(status.pullFailures).toBe(2);
      expect(status.firstPullFailure).toEqual({
        pageId: 'page-big',
        reason:
          'ProseMirror -> markdown export refused: the document is 11000000 ' +
          'bytes of JSON, over the 10485760-byte budget',
      });
      expect(status.pushFailures).toBe(0);

      // A cycle whose pull wrote every page clears it.
      await built.orchestrator.runOnce('space-1', 'ws-1');
      const [after] = built.orchestrator.getSpaceStatuses('ws-1');
      expect(after.pullFailures).toBe(0);
      expect(after.firstPullFailure).toBeNull();
    });

    it('counts spaces whose last cycle had per-page push failures in their own gauge', async () => {
      const built = build();
      const setPushFailing = setGitSyncPushFailingSpaces as unknown as AnyMock;
      runCycleMock.mockResolvedValueOnce({
        ...OK_CYCLE,
        push: { mode: 'apply', failures: 1 },
      });

      await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(setPushFailing).toHaveBeenLastCalledWith(1);
      // The cycle itself succeeded: not a failing space.
      expect(setFailing).toHaveBeenLastCalledWith(0);

      await built.orchestrator.runOnce('space-1', 'ws-1'); // clean push
      expect(setPushFailing).toHaveBeenLastCalledWith(0);
    });

    it('forgets a failing space once its sync is switched off (event path)', async () => {
      const built = build();
      spies();
      runCycleMock.mockRejectedValueOnce(new Error('boom'));
      await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(setFailing).toHaveBeenLastCalledWith(1);
      const firstKeys = runCycleMock.mock.calls[0][0].exportKeys;

      const gate = jest
        .spyOn(built.orchestrator as any, 'isSpaceGitSyncEnabled')
        .mockResolvedValue(false);
      const res = await built.orchestrator.runOnce('space-1', 'ws-1');

      expect(res.skipped).toBe('space-not-enabled');
      expect(built.orchestrator.getSpaceStatuses('ws-1')).toEqual([]);
      expect(setFailing).toHaveBeenLastCalledWith(0);
      // Re-enabled later: a fresh export-key map (full pass).
      gate.mockResolvedValue(true);
      await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(runCycleMock.mock.calls[1][0].exportKeys).not.toBe(firstKeys);
    });

    it('the poll prunes spaces that are no longer enabled', async () => {
      const built = build();
      spies();
      const enabledSpaces = jest
        .spyOn(built.orchestrator as any, 'enabledSpaces')
        .mockResolvedValue([
          { spaceId: 'space-1', workspaceId: 'ws-1' },
          { spaceId: 'space-2', workspaceId: 'ws-1' },
        ]);
      runCycleMock.mockRejectedValue(new Error('boom'));
      await (built.orchestrator as any).pollTick();
      expect(setFailing).toHaveBeenLastCalledWith(2);

      enabledSpaces.mockResolvedValue([
        { spaceId: 'space-2', workspaceId: 'ws-1' },
      ]);
      await (built.orchestrator as any).pollTick();

      expect(
        built.orchestrator.getSpaceStatuses('ws-1').map((s) => s.spaceId),
      ).toEqual(['space-2']);
      expect(setFailing).toHaveBeenLastCalledWith(1);
      expect((built.orchestrator as any).exportKeysBySpace.has('space-1')).toBe(
        false,
      );
      expect((built.orchestrator as any).idleBySpace.has('space-1')).toBe(
        false,
      );
    });

    it('scopes getSpaceStatuses to the workspace', async () => {
      const built = build();
      await built.orchestrator.runOnce('space-1', 'ws-1');
      await built.orchestrator.runOnce('space-2', 'ws-2');

      expect(
        built.orchestrator.getSpaceStatuses('ws-1').map((s) => s.spaceId),
      ).toEqual(['space-1']);
      expect(
        built.orchestrator.getSpaceStatuses('ws-2').map((s) => s.spaceId),
      ).toEqual(['space-2']);
      expect(built.orchestrator.getSpaceStatuses('ws-other')).toEqual([]);
    });

    it('shows a lock-held skip in the status, since when it is held, until a cycle runs', async () => {
      jest.useFakeTimers();
      try {
        const built = build();
        // The lock is held (e.g. by a process that died): no cycle has run yet.
        jest.setSystemTime(new Date('2026-10-03T10:00:00.000Z'));
        built.redis.set.mockResolvedValueOnce(null);
        await built.orchestrator.runOnce('space-1', 'ws-1');
        jest.setSystemTime(new Date('2026-10-03T10:00:10.000Z'));
        built.redis.set.mockResolvedValueOnce(null);
        await built.orchestrator.runOnce('space-1', 'ws-1');

        expect(built.orchestrator.getSpaceStatuses('ws-1')).toEqual([
          {
            spaceId: 'space-1',
            lastRunAt: null,
            lastResult: null,
            lastError: null,
            lastSuccessAt: null,
            consecutiveFailures: 0,
            pullFailures: 0,
            firstPullFailure: null,
            pushFailures: 0,
            firstPushFailure: null,
            lastSkippedAt: '2026-10-03T10:00:10.000Z',
            lastSkipReason: 'lock-held',
            lockHeldSince: '2026-10-03T10:00:00.000Z',
            runningSince: null,
          },
        ]);

        // The lock is free again: the cycle runs and the held-since mark clears.
        jest.setSystemTime(new Date('2026-10-03T10:00:30.000Z'));
        await built.orchestrator.runOnce('space-1', 'ws-1');
        const [status] = built.orchestrator.getSpaceStatuses('ws-1');
        expect(status.lastResult).toBe('ok');
        expect(status.lastRunAt).toBe('2026-10-03T10:00:30.000Z');
        expect(status.lockHeldSince).toBeNull();
        expect(status.lastSkippedAt).toBe('2026-10-03T10:00:10.000Z');
      } finally {
        jest.useRealTimers();
      }
    });

    it('records the post-push cycle outcome of ingestExternalPush', async () => {
      const built = build();
      spies();
      runCycleMock.mockRejectedValueOnce(new Error('cycle boom'));

      await built.orchestrator.ingestExternalPush('space-1', 'ws-1', async () => {
        /* receive-pack */
      });

      const [status] = built.orchestrator.getSpaceStatuses('ws-1');
      expect(status.lastResult).toBe('failed');
      expect(status.lastError).toBe('cycle boom');
      expect(incCycle).toHaveBeenCalledWith('failed');
    });
  });

  // Change detection: the orchestrator OWNS one export-key map per space, hands
  // the same map to every cycle of that space, and clears it on a failed cycle.
  describe('export-key maps', () => {
    it('passes the same per-space map to every cycle and a different one per space', async () => {
      const built = build();
      await built.orchestrator.runOnce('space-1', 'ws-1');
      await built.orchestrator.runOnce('space-1', 'ws-1');
      await built.orchestrator.runOnce('space-2', 'ws-1');

      const maps = runCycleMock.mock.calls.map(([deps]) => deps.exportKeys);
      expect(maps[0]).toBeInstanceOf(Map);
      expect(maps[1]).toBe(maps[0]);
      expect(maps[2]).not.toBe(maps[0]);
    });

    it('clears the space map when a cycle fails (next cycle is a full pass)', async () => {
      const built = build();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      // First cycle records a key (as the engine does after a successful export).
      runCycleMock.mockImplementationOnce(async (deps) => {
        deps.exportKeys.set('page-1', 'key-1');
        return OK_CYCLE;
      });
      await built.orchestrator.runOnce('space-1', 'ws-1');
      const map = runCycleMock.mock.calls[0][0].exportKeys as Map<string, string>;
      expect(map.size).toBe(1);

      runCycleMock.mockRejectedValueOnce(new Error('boom'));
      await built.orchestrator.runOnce('space-1', 'ws-1');

      expect(map.size).toBe(0);
    });

    it('passes one idle memo per space; a manual trigger (force) clears it', async () => {
      const built = build();
      const seen: Array<string | null> = [];
      // The engine leaves a clean space idle: it sets the memo.
      runCycleMock.mockImplementation(async (deps) => {
        seen.push(deps.idle.fingerprint);
        deps.idle.fingerprint = 'fp';
        return OK_CYCLE;
      });

      await built.orchestrator.runOnce('space-1', 'ws-1');
      await built.orchestrator.runOnce('space-1', 'ws-1');
      await built.orchestrator.runOnce('space-1', 'ws-1', { force: true });

      expect(seen).toEqual([null, 'fp', null]);
    });

    it('clears the idle memo when a cycle fails', async () => {
      const built = build();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      runCycleMock.mockImplementationOnce(async (deps) => {
        deps.idle.fingerprint = 'fp';
        return OK_CYCLE;
      });
      await built.orchestrator.runOnce('space-1', 'ws-1');
      const idle = runCycleMock.mock.calls[0][0].idle;
      expect(idle.fingerprint).toBe('fp');

      runCycleMock.mockRejectedValueOnce(new Error('boom'));
      await built.orchestrator.runOnce('space-1', 'ws-1');

      expect(idle.fingerprint).toBeNull();
    });

    it("clears the idle memo before a push's receive-pack moves main", async () => {
      const built = build();
      runCycleMock.mockImplementationOnce(async (deps) => {
        deps.idle.fingerprint = 'fp';
        return OK_CYCLE;
      });
      await built.orchestrator.runOnce('space-1', 'ws-1');
      const idle = runCycleMock.mock.calls[0][0].idle;

      let atReceivePack: string | null | undefined;
      await built.orchestrator.ingestExternalPush(
        'space-1',
        'ws-1',
        async () => {
          atReceivePack = idle.fingerprint;
        },
      );

      expect(atReceivePack).toBeNull();
      expect(runCycleMock.mock.calls[1][0].idle).toBe(idle);
    });

    it('routes the engine warn channel to a WARN log', async () => {
      const built = build();
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await built.orchestrator.runOnce('space-1', 'ws-1');
      const [deps] = runCycleMock.mock.calls[0];

      deps.warn("space space-1: 'main' had uncommitted changes");

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("space space-1: 'main' had uncommitted changes"),
      );
    });
  });
});
