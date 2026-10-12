import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import {
  cachedWorkspaceLoader,
  resolveRequestWorkspace,
  WorkspaceLoader,
} from '../helpers/resolve-request-workspace';

@Injectable()
export class DomainMiddleware implements NestMiddleware {
  // #348 — the cached self-hosted / per-subdomain workspace lookups, shared with
  // the /git host through resolveRequestWorkspace (one implementation).
  private readonly workspaceLoader: WorkspaceLoader;

  constructor(
    private workspaceRepo: WorkspaceRepo,
    private environmentService: EnvironmentService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {
    this.workspaceLoader = cachedWorkspaceLoader(
      this.cacheManager,
      this.workspaceRepo,
    );
  }
  async use(
    req: FastifyRequest['raw'],
    res: FastifyReply['raw'],
    next: () => void,
  ) {
    // A lookup error is deliberately NOT caught here: it bubbles as before.
    const workspace = await resolveRequestWorkspace(
      this.environmentService,
      this.workspaceLoader,
      req.headers.host,
    );
    if (!workspace) {
      (req as any).workspaceId = null;
      return next();
    }

    // TODO: unify
    (req as any).workspaceId = workspace.id;
    (req as any).workspace = workspace;

    next();
  }
}
