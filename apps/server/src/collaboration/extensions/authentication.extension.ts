import {
  Connection,
  Extension,
  Hocuspocus,
  onAuthenticatePayload,
  onConfigurePayload,
  onTokenSyncPayload,
} from '@hocuspocus/server';
import {
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { CollabAccessChangedEvent } from '../../common/events/collab-access-changed';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';
import { SpaceRole } from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { getPageId, isCanonicalPageDocumentName } from '../collaboration.util';
import {
  JwtApiKeyPayload,
  JwtCollabPayload,
  JwtType,
} from '../../core/auth/dto/jwt-payload';
import { resolveProvenance } from '../../common/decorators/auth-provenance.decorator';
import { PERMISSION_CACHE_TTL_MS } from '../../common/helpers/cache-keys';
import { observeCollabAuth } from '../../integrations/metrics/metrics.registry';
import { ApiKeyService } from '../../core/api-key/api-key.service';

// Max lifetime of a collab token (generateCollabToken uses expiresIn '24h'). Used
// as the rollout grace window below: once this long has elapsed since this
// process started serving the #501 code, every STILL-VALID collab token was
// necessarily minted post-rollout and MUST carry the `principal` discriminator,
// so a claimless one is a bug and is rejected (fail-closed) rather than trusted.
const COLLAB_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

// CO-1 — hocuspocus calls onTokenSync for every token frame, without awaiting
// it. Per connection, at most one access re-check runs at a time and a new one
// starts at most once per RECHECK_MIN_INTERVAL_MS; the requests in between
// collapse into ONE queued re-check, which uses the latest token.
const RECHECK_MIN_INTERVAL_MS = 2_000;
// CO-3 — a re-check with no answer after this long closes the document.
const RECHECK_DEADLINE_MS = 10_000;
// The close of a re-check that DENIED access (or changed readOnly). The client
// keys on the reason "Unauthorized" (page-session-cache drops a parked session
// with its local copy); authentication.token-sync.spec asserts it end to end.
const ACCESS_DENIED_CLOSE = { code: 4401, reason: 'Unauthorized' };
// The close of a re-check that could not FINISH (an infra error, the
// deadline): fail closed, but not as a denial, so the client authenticates
// afresh on its next connect instead of discarding its local copy.
const RECHECK_FAILED_CLOSE = { code: 4500, reason: 'Access re-check failed' };

/**
 * The reason of the permission-denied auth message for a GENUINE denial of the
 * page on connect: no space or page access, a disabled or missing user, no
 * such page. Hocuspocus answers ANY error thrown while authenticating (or
 * loading the document after it) with permission-denied, carrying the error's
 * `reason` or else the default "permission-denied" (ClientConnection,
 * `error.reason ?? "permission-denied"`), so an outage keeps the default. The
 * client drops a parked session with its local copy only on this reason
 * (page-session-cache.ts); authentication.token-sync.spec pins it on the wire.
 */
export const ACCESS_DENIED_REASON = 'access-denied';

/**
 * A queued re-check: `token` is the latest token the client re-sent, or null
 * to re-check the connection's own principal (a permission change, CO-2).
 */
type RecheckRequest = { token: string | null };

interface RecheckState {
  running: boolean;
  timer: NodeJS.Timeout | null;
  lastStartedAt: number;
  queued: RecheckRequest | null;
}

@Injectable()
export class AuthenticationExtension implements Extension {
  private readonly logger = new Logger(AuthenticationExtension.name);

  // Reference instant for the claimless-rejection grace window. Overridable so a
  // unit test can drive the pre-/post-grace boundary without wall-clock waits.
  protected rolloutAt = Date.now();
  // The re-check rate limit and deadline (CO-1, CO-3); overridable for the same
  // reason, so a spec need not wait them out.
  protected recheckMinIntervalMs = RECHECK_MIN_INTERVAL_MS;
  protected recheckDeadlineMs = RECHECK_DEADLINE_MS;

  private instance: Hocuspocus | null = null;
  // Per-connection re-check state (CO-1); dropped with the connection.
  private readonly rechecks = new WeakMap<Connection, RecheckState>();

  constructor(
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  async onAuthenticate(data: onAuthenticatePayload) {
    // #402 — time the whole auth (verify + user/page/permission lookups) into
    // collab_auth_duration_seconds. finally so failed auths are timed too.
    // No-op when METRICS_PORT is unset. Behavior unchanged.
    const start = performance.now();
    try {
      return await this.doAuthenticate(data);
    } finally {
      observeCollabAuth((performance.now() - start) / 1000);
    }
  }

  async onConfigure({ instance }: onConfigurePayload) {
    this.instance = instance;
  }

  // #709 — re-check access on an already-authenticated connection. A warm
  // (parked) client session never reconnects, so on a warm return the client
  // re-sends its token and hocuspocus routes it here. The re-check is queued
  // per connection (CO-1) and closes the document itself when access is gone;
  // it never touches the connection's context or connectionConfig.
  async onTokenSync(data: onTokenSyncPayload) {
    await this.requestRecheck(data.connection, { token: data.token });
    return undefined;
  }

  // CO-2 — events that change who may open a page re-check the open
  // connections of the pages they name.
  @OnEvent(EventName.PAGE_SOFT_DELETED)
  @OnEvent(EventName.PAGE_RESTORED)
  @OnEvent(EventName.PAGE_DELETED)
  async onPagesAccessChanged(event: { pageIds?: string[] }) {
    const documents = (event?.pageIds ?? [])
      .map((pageId) => this.instance?.documents.get(`page.${pageId}`))
      .filter((document) => document != null);
    await this.recheckConnections(
      documents.flatMap((document) => document.getConnections()),
    );
  }

  // The event names no pages: every open connection is re-checked.
  @OnEvent(EventName.SPACE_DELETED)
  async onSpaceDeleted() {
    const documents = Array.from(this.instance?.documents.values() ?? []);
    await this.recheckConnections(
      documents.flatMap((document) => document.getConnections()),
    );
  }

  // In the separate collab process the events above arrive relayed from the
  // API process under one name (collab-access-relay.ts).
  @OnEvent(EventName.COLLAB_ACCESS_RELAYED)
  async onAccessEventRelayed(relayed: {
    event: string;
    payload: CollabAccessChangedEvent;
  }) {
    switch (relayed.event) {
      case EventName.COLLAB_ACCESS_CHANGED:
        return this.onCollabAccessChanged(relayed.payload);
      case EventName.SPACE_DELETED:
        return this.onSpaceDeleted();
      default:
        return this.onPagesAccessChanged(relayed.payload);
    }
  }

  // A space membership, group membership, user status or page-to-space change:
  // the open connections of the event's workspace, narrowed by each of its
  // pageIds, userIds and spaceId present.
  @OnEvent(EventName.COLLAB_ACCESS_CHANGED)
  async onCollabAccessChanged(event: CollabAccessChangedEvent) {
    const pageIds = event.pageIds ? new Set(event.pageIds) : null;
    const userIds = event.userIds ? new Set(event.userIds) : null;
    const connections = Array.from(this.instance?.documents.values() ?? [])
      .filter((document) => !pageIds || pageIds.has(getPageId(document.name)))
      .flatMap((document) => document.getConnections())
      .filter(
        (connection) =>
          connection.context?.user?.workspaceId === event.workspaceId &&
          (!userIds || userIds.has(connection.context?.user?.id)),
      );
    const selected = event.spaceId
      ? await this.connectionsInSpace(connections, event.spaceId)
      : connections;
    await this.recheckConnections(selected);
    // The space-role and page-permission reads behind a re-check are cached
    // for PERMISSION_CACHE_TTL_MS and nothing busts them on these changes, so
    // the re-check above can still see the old answer: re-check once more
    // after the cache has expired. A connection closed by then is skipped.
    if (selected.length === 0) return;
    const timer = setTimeout(() => {
      this.recheckConnections(selected).catch((err) =>
        this.logger.error(
          { err, workspaceId: event.workspaceId },
          'Delayed access re-check of open documents failed',
        ),
      );
    }, PERMISSION_CACHE_TTL_MS + 100);
    timer.unref();
  }

  /**
   * The `connections` whose page is in space `spaceId`. When the lookup fails
   * or has no answer by the deadline the space cannot narrow them: all of them.
   */
  private async connectionsInSpace(
    connections: Connection[],
    spaceId: string,
  ): Promise<Connection[]> {
    if (connections.length === 0) return connections;
    const pageIds = [
      ...new Set(connections.map((c) => getPageId(c.document.name))),
    ];
    let deadline: NodeJS.Timeout | undefined;
    try {
      const pages = await Promise.race([
        this.pageRepo.findManyByIds(pageIds),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error(`no answer within ${this.recheckDeadlineMs} ms`),
              ),
            this.recheckDeadlineMs,
          );
        }),
      ]);
      const inSpace = new Set(
        pages.filter((page) => page.spaceId === spaceId).map((page) => page.id),
      );
      return connections.filter((c) => inSpace.has(getPageId(c.document.name)));
    } catch (err) {
      this.logger.error(
        { err, spaceId },
        'Space lookup of open documents failed; re-checking all their connections',
      );
      return connections;
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Re-check `connections` one at a time, so a sweep cannot flood the DB. */
  private async recheckConnections(connections: Connection[]) {
    for (const connection of connections) {
      await this.requestRecheck(connection, { token: null });
    }
  }

  /**
   * Queue an access re-check of `connection` (CO-1). It starts now if none is
   * running and the interval allows; otherwise it replaces the queued one and
   * starts when the running one ends or the interval elapses. A queued token
   * survives a later principal re-check: checking the token re-checks access
   * too. Resolves when the re-check this call started, if any, has finished.
   */
  private requestRecheck(
    connection: Connection,
    request: RecheckRequest,
  ): Promise<void> {
    let state = this.rechecks.get(connection);
    if (!state) {
      state = { running: false, timer: null, lastStartedAt: 0, queued: null };
      this.rechecks.set(connection, state);
    }
    state.queued = { token: request.token ?? state.queued?.token ?? null };
    return this.startQueuedRecheck(connection, state);
  }

  private startQueuedRecheck(
    connection: Connection,
    state: RecheckState,
  ): Promise<void> {
    if (state.running || state.timer || !state.queued) return Promise.resolve();
    const wait = state.lastStartedAt + this.recheckMinIntervalMs - Date.now();
    if (wait > 0) {
      state.timer = setTimeout(() => {
        state.timer = null;
        void this.startQueuedRecheck(connection, state);
      }, wait);
      state.timer.unref();
      return Promise.resolve();
    }
    const request = state.queued;
    state.queued = null;
    state.running = true;
    state.lastStartedAt = Date.now();
    return this.recheck(connection, request).finally(() => {
      state.running = false;
      void this.startQueuedRecheck(connection, state);
    });
  }

  /**
   * Re-check an open connection's access and close its document when access
   * is gone or its readOnly changed, or when the check fails or has no answer
   * by the deadline (CO-3: fail closed). Never rejects.
   */
  private async recheck(
    connection: Connection,
    request: RecheckRequest,
  ): Promise<void> {
    if (!connection.document.hasConnection(connection)) return;
    const documentName = connection.document.name;
    const pageId = getPageId(documentName);
    const userId = connection.context?.user?.id;
    let deadline: NodeJS.Timeout | undefined;
    let readOnly: boolean;
    try {
      readOnly = await Promise.race([
        this.recheckAccess(documentName, connection.context, request.token),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error(`no answer within ${this.recheckDeadlineMs} ms`),
              ),
            this.recheckDeadlineMs,
          );
        }),
      ]);
    } catch (err) {
      if (err instanceof HttpException) {
        this.logger.warn(
          `Access re-check denied user ${userId} on page ${pageId}: ${err.message}; closing the document`,
        );
        connection.close(ACCESS_DENIED_CLOSE);
        return;
      }
      this.logger.error(
        { err, userId, pageId },
        'Access re-check failed; closing the document (fail closed)',
      );
      connection.close(RECHECK_FAILED_CLOSE);
      return;
    } finally {
      clearTimeout(deadline);
    }

    if (readOnly !== connection.readOnly) {
      this.logger.warn(
        `Access re-check changed user ${userId} on page ${pageId} from readOnly=${connection.readOnly} to readOnly=${readOnly}; closing the document`,
      );
      connection.close(ACCESS_DENIED_CLOSE);
    }
  }

  /**
   * The readOnly an open connection's principal now gets on `documentName`;
   * throws an HttpException when it gets no access. A re-sent `token` must be
   * the connection's own principal (CO-3): the re-check vouches for the
   * connection, which keeps acting as the principal it authenticated.
   */
  private async recheckAccess(
    documentName: string,
    context: any,
    token: string | null,
  ): Promise<boolean> {
    const userId = context?.user?.id;
    const workspaceId = context?.user?.workspaceId;
    const apiKeyId = context?.apiKeyId ?? null;
    if (token !== null) {
      const jwtPayload = await this.verifyToken(token);
      if (
        jwtPayload.sub !== userId ||
        jwtPayload.workspaceId !== workspaceId ||
        (jwtPayload.apiKeyId ?? null) !== apiKeyId
      ) {
        throw new UnauthorizedException(
          'The re-sent collab token belongs to another principal',
        );
      }
    } else if (apiKeyId) {
      await this.validateApiKey(userId, workspaceId, apiKeyId);
    }
    const connectionConfig = { readOnly: false };
    await this.authorize(userId, workspaceId, documentName, connectionConfig);
    return connectionConfig.readOnly;
  }

  private async doAuthenticate(data: {
    documentName: string;
    token: string;
    connectionConfig: { readOnly: boolean };
  }) {
    const { documentName, token } = data;
    // CO-7 — a page has ONE document, `page.<uuid>`. Hocuspocus would open an
    // alias (`page.<slugId>`, an upper-case uuid, another prefix) as a SEPARATE
    // Y.Doc of the same page, whose debounced store then overwrites what the
    // canonical one (and git-sync's merge into it) stored.
    if (!isCanonicalPageDocumentName(documentName)) {
      this.logger.warn(
        `Refusing collab document ${documentName}: not the canonical page.<uuid> name of a page`,
      );
      throw new UnauthorizedException(
        'Collab document name is not the canonical page.<uuid>',
      );
    }

    const jwtPayload = await this.verifyToken(token);
    const user = await this.authorize(
      jwtPayload.sub,
      jwtPayload.workspaceId,
      documentName,
      data.connectionConfig,
    ).catch((err) => {
      // An HttpException from authorize() is a genuine denial: mark it so the
      // client tells it apart from an infra failure, which keeps hocuspocus's
      // default reason and is rethrown as is.
      if (err instanceof HttpException) {
        Object.assign(err, { reason: ACCESS_DENIED_REASON });
      }
      throw err;
    });

    // Carry the agent-edit provenance into the hocuspocus connection context
    // (§6.6 / §15 C2), derived via the SAME resolver as the REST seam so the two
    // can't drift. An is_agent service account (e.g. the MCP bot) is attributed
    // 'agent' here too, so its page-content edits over collab persist as
    // lastUpdatedSource='agent' (#143 review Arch A) — not just its REST writes.
    // #559 — a collab token minted by an api-key principal (an EXTERNAL MCP agent)
    // carries principal='api_key' + apiKeyId (verified above) but no actor claim;
    // threading `jwtPayload.apiKeyId` makes resolveProvenance stamp actor='agent'
    // (even for an ordinary user's personal key) and carries the key id into the
    // context so persistence.extension can persist last_updated_api_key_id and
    // the page shows the "External MCP" persona named after the key.
    // The human collab path carries no claim and is not flagged → actor='user'.
    const provenance = resolveProvenance(user, jwtPayload, jwtPayload.apiKeyId);
    return {
      user,
      actor: provenance.actor,
      aiChatId: provenance.aiChatId,
      apiKeyId: provenance.apiKeyId,
    };
  }

  /** Verify a collab token and its principal; throws Unauthorized if invalid. */
  private async verifyToken(token: string): Promise<JwtCollabPayload> {
    let jwtPayload: JwtCollabPayload;

    try {
      jwtPayload = await this.tokenService.verifyJwt(token, JwtType.COLLAB);
    } catch (error) {
      throw new UnauthorizedException('Invalid collab token');
    }

    // #501 — fail-closed api-key laundering guard. A collab token minted by an
    // api-key principal carries principal='api_key' + apiKeyId; re-check the key
    // on connect so a REVOKED key gets NO new collab connections (a collab token
    // outlives its 24h, but a revoked key can no longer open fresh ones). An
    // api-key token missing its apiKeyId is malformed → reject. A claimless token
    // (no recognized principal) is trusted only DURING the rollout grace window
    // (a legacy pre-rollout session token, which api keys could never mint);
    // once the grace has elapsed every valid token must carry the discriminator,
    // so a claimless one is a bug and is rejected (not silently trusted for 24h).
    const principal = jwtPayload.principal;
    if (principal === 'api_key') {
      if (!jwtPayload.apiKeyId) {
        throw new UnauthorizedException();
      }
      // Row-check via the SHARED validator: throws Unauthorized on a revoked/
      // expired/disabled key; an infra error propagates (not masked). No new
      // connection for a dead key.
      await this.validateApiKey(
        jwtPayload.sub,
        jwtPayload.workspaceId,
        jwtPayload.apiKeyId,
      );
    } else if (principal !== 'session') {
      // Unrecognized/absent discriminator: reject once past the grace window.
      if (Date.now() - this.rolloutAt >= COLLAB_TOKEN_GRACE_MS) {
        throw new UnauthorizedException();
      }
    }
    return jwtPayload;
  }

  private async validateApiKey(
    userId: string,
    workspaceId: string,
    apiKeyId: string,
  ) {
    await this.apiKeyService.validate({
      sub: userId,
      workspaceId,
      apiKeyId,
      type: JwtType.API_KEY,
    } as JwtApiKeyPayload);
  }

  /**
   * The access of user `userId` to the page of `documentName`: returns the
   * user and sets `connectionConfig.readOnly`; throws an HttpException when the
   * user may not open the page at all.
   */
  private async authorize(
    userId: string,
    workspaceId: string,
    documentName: string,
    connectionConfig: { readOnly: boolean },
  ) {
    const pageId = getPageId(documentName);
    const user = await this.userRepo.findById(userId, workspaceId, {
      includeIsAgent: true,
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    if (isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    const page = await this.pageRepo.findById(pageId);
    if (!page) {
      this.logger.debug(`Page not found: ${pageId}`);
      throw new NotFoundException('Page not found');
    }

    const userSpaceRoles = await this.spaceMemberRepo.getUserSpaceRoles(
      user.id,
      page.spaceId,
    );

    const userSpaceRole = findHighestUserSpaceRole(userSpaceRoles);

    if (!userSpaceRole) {
      this.logger.warn(`User not authorized to access page: ${pageId}`);
      throw new UnauthorizedException();
    }

    // Check page-level permissions
    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction) {
      if (!canAccess) {
        this.logger.warn(
          `User ${user.id} denied page-level access to page: ${pageId}`,
        );
        throw new UnauthorizedException();
      }

      if (!canEdit) {
        connectionConfig.readOnly = true;
        this.logger.debug(
          `User ${user.id} granted readonly access to restricted page: ${pageId}`,
        );
      }
    } else {
      // No restrictions - use space-level permissions
      if (userSpaceRole === SpaceRole.READER) {
        connectionConfig.readOnly = true;
        this.logger.debug(`User granted readonly access to page: ${pageId}`);
      }
    }

    if (page.deletedAt) {
      connectionConfig.readOnly = true;
    }

    this.logger.debug(`Authenticated user ${user.id} on page ${pageId}`);
    return user;
  }
}
