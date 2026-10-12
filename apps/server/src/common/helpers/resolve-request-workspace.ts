import { Cache } from 'cache-manager';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { withCache } from './with-cache';
import { CacheKey, WORKSPACE_CACHE_TTL_MS } from './cache-keys';

/**
 * The two workspace lookups `resolveRequestWorkspace` needs. `WorkspaceRepo`
 * satisfies it structurally (an uncached loader); request paths pass
 * `cachedWorkspaceLoader(...)` so they all share the #348 workspace cache.
 */
export interface WorkspaceLoader {
  findFirst(): Promise<Workspace | null | undefined>;
  findByHostname(subdomain: string): Promise<Workspace | null | undefined>;
}

// #348 — timestamptz columns on the workspace row. The cache store (Keyv/Redis)
// JSON-serializes values, so a cached workspace comes back with these fields as
// ISO strings. Reviving them to Date keeps the cached path byte-identical to the
// direct DB path (postgres.js returns Date), so nothing downstream can observe a
// cache hit vs miss. Idempotent: `new Date(date)` on an already-Date value is a
// no-op-equivalent. Keep in sync with the workspace timestamptz columns.
const WORKSPACE_DATE_FIELDS: Array<keyof Workspace> = [
  'createdAt',
  'updatedAt',
  'deletedAt',
  'trialEndAt',
];

function reviveWorkspaceDates(workspace: Workspace): Workspace {
  for (const field of WORKSPACE_DATE_FIELDS) {
    const value = workspace[field];
    if (value != null) {
      (workspace as any)[field] = new Date(value as any);
    }
  }
  return workspace;
}

/**
 * The cached `WorkspaceLoader` every request path uses (#348): the self-hosted
 * single-workspace lookup under a constant key, the cloud lookup keyed by
 * subdomain. Both keys are busted by every WorkspaceRepo mutator (see
 * bustWorkspaceCache) and bounded by WORKSPACE_CACHE_TTL_MS. Lookup errors are
 * NOT caught here — they reach the caller of resolveRequestWorkspace.
 */
export function cachedWorkspaceLoader(
  cacheManager: Cache,
  workspaceRepo: WorkspaceRepo,
): WorkspaceLoader {
  return {
    findFirst: async () => {
      const workspace = await withCache(
        cacheManager,
        CacheKey.WORKSPACE_SELF_HOSTED,
        WORKSPACE_CACHE_TTL_MS,
        () => workspaceRepo.findFirst(),
      );
      return workspace ? reviveWorkspaceDates(workspace) : workspace;
    },
    findByHostname: async (subdomain: string) => {
      const workspace = await withCache(
        cacheManager,
        CacheKey.WORKSPACE_BY_HOST(subdomain),
        WORKSPACE_CACHE_TTL_MS,
        () => workspaceRepo.findByHostname(subdomain),
      );
      return workspace ? reviveWorkspaceDates(workspace) : workspace;
    },
  };
}

/**
 * The ONE canonical way to resolve the workspace for an incoming request:
 *   - self-hosted (single workspace) -> the first/default workspace;
 *   - cloud (multi-tenant)           -> resolved by the host-header subdomain.
 * Returns null when none resolves (no workspace configured, or a blank/unknown
 * subdomain on cloud). `isSelfHosted()` is `!isCloud()`, so exactly one branch is
 * always taken.
 *
 * Shared by `DomainMiddleware` (the normal /api request path) and
 * `GitHttpService` (the raw root-mounted /git smart-HTTP host, which Nest
 * middleware does NOT run for), both through `cachedWorkspaceLoader(...)`, so
 * the two cannot drift.
 *
 * This helper does NOT catch lookup errors — callers decide: DomainMiddleware
 * lets a throw bubble; GitHttpService logs it and answers 500. A blank/missing
 * host on cloud resolves to null rather than throwing.
 */
export async function resolveRequestWorkspace(
  environmentService: EnvironmentService,
  loader: WorkspaceLoader,
  hostHeader: string | undefined,
): Promise<Workspace | null> {
  if (environmentService.isSelfHosted()) {
    return (await loader.findFirst()) ?? null;
  }
  // Cloud (isSelfHosted === !isCloud, so this is the only remaining branch).
  const subdomain = hostHeader ? hostHeader.split('.')[0] : '';
  if (!subdomain) return null;
  return (await loader.findByHostname(subdomain)) ?? null;
}
