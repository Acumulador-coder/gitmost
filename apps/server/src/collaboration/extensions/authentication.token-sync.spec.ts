/**
 * #709 — integration test for `AuthenticationExtension.onTokenSync`, the access
 * re-check a warm (parked) collab session triggers on return by re-sending its
 * token over the already-authenticated connection.
 *
 * Wire-level, not a unit test of a helper (AGENTS.md invariant 8): a REAL
 * `Hocuspocus` instance with the REAL `AuthenticationExtension` (repos/services
 * mocked) behind a real `ws` server on an ephemeral port, driven by a REAL
 * `@hocuspocus/provider` client calling `sendToken()` exactly as the client
 * does. Assertions are on what the client observes: the server CLOSE message
 * (surfaced by the provider as a `close` event with code 1000 and the server's
 * reason), the socket staying open, and edits still being acked by the server.
 */
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Hocuspocus, onTokenSyncPayload } from '@hocuspocus/server';
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from '@hocuspocus/provider';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import {
  ACCESS_DENIED_REASON,
  AuthenticationExtension,
} from './authentication.extension';
import { SpaceRole } from '../../common/helpers/types/permission';
import { JwtType } from '../../core/auth/dto/jwt-payload';

const PAGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const DOC_NAME = `page.${PAGE_ID}`;
const USER_ID = 'user-1';
const WORKSPACE_ID = 'ws-1';
const SPACE_ID = 'space-1';

describe('AuthenticationExtension.onTokenSync (#709 warm-return access re-check)', () => {
  let ext: AuthenticationExtension;
  let verifyJwt: jest.Mock;
  let spaceMemberRepo: { getUserSpaceRoles: jest.Mock };
  let pagePermissionRepo: { canUserEditPage: jest.Mock };
  let loggerError: jest.SpyInstance;

  let hocuspocus: Hocuspocus;
  let httpServer: http.Server;
  let wss: WebSocketServer;
  let url: string;

  let socket: HocuspocusProviderWebsocket;
  let provider: HocuspocusProvider;
  let closeEvents: { code: number; reason: string }[];

  beforeEach(async () => {
    spaceMemberRepo = {
      getUserSpaceRoles: jest
        .fn()
        .mockResolvedValue([{ userId: USER_ID, role: SpaceRole.WRITER }]),
    };
    pagePermissionRepo = {
      canUserEditPage: jest.fn().mockResolvedValue({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: true,
      }),
    };

    verifyJwt = jest.fn().mockResolvedValue({
      sub: USER_ID,
      workspaceId: WORKSPACE_ID,
      type: JwtType.COLLAB,
      principal: 'session',
    });
    ext = new AuthenticationExtension(
      { verifyJwt } as any,
      {
        findById: jest.fn().mockResolvedValue({
          id: USER_ID,
          workspaceId: WORKSPACE_ID,
          deactivatedAt: null,
          deletedAt: null,
        }),
      } as any,
      {
        findById: jest.fn().mockResolvedValue({
          id: PAGE_ID,
          spaceId: SPACE_ID,
          workspaceId: WORKSPACE_ID,
          deletedAt: null,
        }),
        findManyByIds: jest
          .fn()
          .mockResolvedValue([{ id: PAGE_ID, spaceId: SPACE_ID }]),
      } as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
      { validate: jest.fn() } as any,
    );
    jest.spyOn(ext['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(ext['logger'], 'debug').mockImplementation(() => undefined);
    loggerError = jest
      .spyOn(ext['logger'], 'error')
      .mockImplementation(() => undefined);
    // hocuspocus console.error()s every rejected hook; keep expected denials quiet.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    hocuspocus = new Hocuspocus({ extensions: [ext] });
    httpServer = http.createServer();
    wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws, req) => hocuspocus.handleConnection(ws, req));
    await new Promise<void>((resolve) =>
      httpServer.listen(0, '127.0.0.1', resolve),
    );
    url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    // Authenticate and sync a real client, as on the first (cold) page open.
    socket = new HocuspocusProviderWebsocket({
      url,
      WebSocketPolyfill: WebSocket,
    });
    provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: DOC_NAME,
      token: 'collab-token',
      document: new Y.Doc(),
    });
    closeEvents = [];
    provider.on('close', ({ event }) =>
      closeEvents.push({ code: event.code, reason: event.reason }),
    );
    const synced = new Promise<void>((resolve) =>
      provider.on('synced', () => resolve()),
    );
    provider.attach();
    await synced;
    expect(provider.isAuthenticated).toBe(true);
    expect(provider.authorizedScope).toBe('read-write');
  });

  afterEach(async () => {
    provider.destroy();
    socket.destroy();
    wss.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    jest.restoreAllMocks();
  });

  // Sends the token-sync like a warm return does and resolves once the server
  // hook has settled. The spy is only a synchronization barrier; the assertions
  // are on what reaches the client.
  async function tokenSync(): Promise<onTokenSyncPayload> {
    const realOnTokenSync = AuthenticationExtension.prototype.onTokenSync;
    let payload: onTokenSyncPayload;
    const settled = new Promise<void>((resolve) => {
      jest
        .spyOn(ext, 'onTokenSync')
        .mockImplementationOnce(async (data: onTokenSyncPayload) => {
          payload = data;
          try {
            return await realOnTokenSync.call(ext, data);
          } finally {
            resolve();
          }
        });
    });
    await provider.sendToken();
    await settled;
    return payload;
  }

  function nextClose(): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) =>
      provider.on('close', ({ event }) =>
        resolve({ code: event.code, reason: event.reason }),
      ),
    );
  }

  // A client edit acked by the server (sync status) proves the document is still
  // established and writable on this connection: after a document close the
  // server would queue the update as pre-auth and never ack it.
  async function editAndAwaitAck(text: string) {
    const acked = new Promise<void>((resolve) => {
      const onUnsynced = ({ number }: { number: number }) => {
        if (number === 0) {
          provider.off('unsyncedChanges', onUnsynced);
          resolve();
        }
      };
      provider.on('unsyncedChanges', onUnsynced);
    });
    provider.document.getText('body').insert(0, text);
    await acked;
    expect(
      hocuspocus.documents.get(DOC_NAME).getText('body').toString(),
    ).toContain(text);
  }

  // The CLOSE is document-level: the socket itself must stay open. A ping/pong
  // round trip on the same socket — had the server closed the socket after the
  // CLOSE message, its close frame would arrive instead of the pong.
  async function expectSocketStillOpen() {
    const ws = socket.webSocket as unknown as WebSocket;
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await new Promise<void>((resolve, reject) => {
      const onClose = (code: number) =>
        reject(new Error(`socket closed by the server: ${code}`));
      ws.once('close', onClose);
      ws.once('pong', () => {
        ws.off('close', onClose);
        resolve();
      });
      ws.ping();
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(socket.status).toBe(WebSocketStatus.Connected);
  }

  it('unchanged rights → the document stays open', async () => {
    await tokenSync();
    await editAndAwaitAck('still-writable');

    expect(closeEvents).toEqual([]);
    expect(provider.isAuthenticated).toBe(true);
  });

  it('downgraded to READER → client gets CLOSE "Unauthorized", socket stays open', async () => {
    spaceMemberRepo.getUserSpaceRoles.mockResolvedValue([
      { userId: USER_ID, role: SpaceRole.READER },
    ]);
    const closed = nextClose();
    await tokenSync();

    // The provider surfaces a server CLOSE message with code 1000 + its reason.
    expect(await closed).toEqual({ code: 1000, reason: 'Unauthorized' });
    await expectSocketStillOpen();
  });

  it('access revoked → client gets CLOSE "Unauthorized", socket stays open', async () => {
    spaceMemberRepo.getUserSpaceRoles.mockResolvedValue([]);
    const closed = nextClose();
    await tokenSync();

    expect(await closed).toEqual({ code: 1000, reason: 'Unauthorized' });
    await expectSocketStillOpen();
  });

  it('non-HttpException during the re-check → fail closed: CLOSE "Access re-check failed", ERROR logged (CO-3)', async () => {
    const dbDown = new Error('db down');
    pagePermissionRepo.canUserEditPage.mockRejectedValueOnce(dbDown);
    const closed = nextClose();
    await tokenSync();

    // Not "Unauthorized": the client must not treat an outage as a revocation.
    expect(await closed).toEqual({
      code: 1000,
      reason: 'Access re-check failed',
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: dbDown, pageId: PAGE_ID }),
      expect.any(String),
    );
    await expectSocketStillOpen();
  });

  it('a re-check with no answer by the deadline → fail closed, ERROR logged (CO-3)', async () => {
    (ext as any).recheckDeadlineMs = 50;
    pagePermissionRepo.canUserEditPage.mockReturnValueOnce(
      new Promise(() => undefined),
    );
    const closed = nextClose();
    await tokenSync();

    expect(await closed).toEqual({
      code: 1000,
      reason: 'Access re-check failed',
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE_ID }),
      expect.any(String),
    );
  });

  it('a token of another principal → CLOSE "Unauthorized", no access lookup (CO-3)', async () => {
    verifyJwt.mockResolvedValueOnce({
      sub: 'user-2',
      workspaceId: WORKSPACE_ID,
      type: JwtType.COLLAB,
      principal: 'session',
    });
    const lookups = spaceMemberRepo.getUserSpaceRoles.mock.calls.length;
    const closed = nextClose();
    await tokenSync();

    expect(await closed).toEqual({ code: 1000, reason: 'Unauthorized' });
    expect(spaceMemberRepo.getUserSpaceRoles.mock.calls.length).toBe(lookups);
  });

  it('a token flood runs ONE re-check at a time, rate-limited, with the latest token (CO-1)', async () => {
    // Long enough that all 500 frames arrive within one interval.
    (ext as any).recheckMinIntervalMs = 1_000;
    const before = verifyJwt.mock.calls.length;
    let inFlight = 0;
    let maxInFlight = 0;
    pagePermissionRepo.canUserEditPage.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return { hasAnyRestriction: false, canAccess: true, canEdit: true };
    });

    // Each frame carries the next token: token-1 … token-500.
    let sent = 0;
    provider.configuration.token = () => `token-${++sent}`;
    for (let i = 0; i < 500; i++) void provider.sendToken();
    const deadline = Date.now() + 5_000;
    while (verifyJwt.mock.calls.length < before + 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // One more interval: nothing else was queued.
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const tokens = verifyJwt.mock.calls.slice(before).map(([token]) => token);
    expect(tokens).toEqual(['token-1', 'token-500']);
    expect(maxInFlight).toBe(1);
    await editAndAwaitAck('still-writable-after-flood');
    expect(closeEvents).toEqual([]);
  });

  it.each([
    [
      'a page event',
      (e: AuthenticationExtension) =>
        e.onPagesAccessChanged({ pageIds: [PAGE_ID] }),
    ],
    ['a space deletion', (e: AuthenticationExtension) => e.onSpaceDeleted()],
    [
      "an access change of the page's space",
      (e: AuthenticationExtension) =>
        e.onCollabAccessChanged({
          workspaceId: WORKSPACE_ID,
          spaceId: SPACE_ID,
          userIds: [USER_ID],
        }),
    ],
  ])(
    'access revoked, then %s → CLOSE "Unauthorized" without any token from the client (CO-2)',
    async (_event, emit) => {
      spaceMemberRepo.getUserSpaceRoles.mockResolvedValue([]);
      const tokenChecks = verifyJwt.mock.calls.length;
      const closed = nextClose();
      await emit(ext);

      expect(await closed).toEqual({ code: 1000, reason: 'Unauthorized' });
      // The connection's own principal was re-checked: no token involved.
      expect(verifyJwt.mock.calls.length).toBe(tokenChecks);
      await expectSocketStillOpen();
    },
  );

  it('a page event for another page leaves the connection alone (CO-2)', async () => {
    spaceMemberRepo.getUserSpaceRoles.mockResolvedValue([]);
    await ext.onPagesAccessChanged({
      pageIds: ['00000000-0000-4000-8000-000000000000'],
    });
    await editAndAwaitAck('untouched');
    expect(closeEvents).toEqual([]);
  });

  // A second client opening the document afresh, as a reconnect does; resolves
  // with the reason the provider surfaces from the server's permission-denied
  // auth message (`authenticationFailed`).
  async function freshConnectionDenialReason(): Promise<string> {
    const freshSocket = new HocuspocusProviderWebsocket({
      url,
      WebSocketPolyfill: WebSocket,
    });
    const fresh = new HocuspocusProvider({
      websocketProvider: freshSocket,
      name: DOC_NAME,
      token: 'collab-token',
      document: new Y.Doc(),
    });
    const failed = new Promise<string>((resolve) =>
      fresh.on('authenticationFailed', ({ reason }) => resolve(reason)),
    );
    fresh.attach();
    try {
      return await failed;
    } finally {
      fresh.destroy();
      freshSocket.destroy();
    }
  }

  it('a fresh connection denied the page → authenticationFailed with reason ACCESS_DENIED_REASON', async () => {
    spaceMemberRepo.getUserSpaceRoles.mockResolvedValue([]);

    expect(await freshConnectionDenialReason()).toBe(ACCESS_DENIED_REASON);
    // The literal the client keys on (page-session-cache.ts).
    expect(ACCESS_DENIED_REASON).toBe('access-denied');
  });

  it('a fresh connection whose access lookup fails → the default reason "permission-denied", not a denial', async () => {
    pagePermissionRepo.canUserEditPage.mockRejectedValueOnce(
      new Error('db down'),
    );

    expect(await freshConnectionDenialReason()).toBe('permission-denied');
  });

  it("does not mutate the live connection's connectionConfig", async () => {
    // The downgrade is the case where the re-check computes readOnly=true; it
    // must land on the copy, never on the object shared with the live connection.
    spaceMemberRepo.getUserSpaceRoles.mockResolvedValue([
      { userId: USER_ID, role: SpaceRole.READER },
    ]);
    const closed = nextClose();
    const payload = await tokenSync();
    await closed;

    expect(payload.connectionConfig).toEqual({
      readOnly: false,
      isAuthenticated: true,
    });
    expect(payload.connection.readOnly).toBe(false);
  });
});
