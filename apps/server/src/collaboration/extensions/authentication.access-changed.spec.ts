/**
 * CO-2 — `AuthenticationExtension.onCollabAccessChanged` re-checks exactly the
 * open connections a committed access change can affect: those of the event's
 * workspace, narrowed by its pageIds, userIds and spaceId. The hocuspocus
 * instance is a stand-in holding documents and connections; the re-check
 * itself is spied, so the test observes which connections it was asked for.
 */
import { AuthenticationExtension } from './authentication.extension';
import { PERMISSION_CACHE_TTL_MS } from '../../common/helpers/cache-keys';
import { SpaceRole } from '../../common/helpers/types/permission';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';

function connection(name: string, userId: string, workspaceId: string) {
  return { name, context: { user: { id: userId, workspaceId } } } as any;
}

describe('AuthenticationExtension.onCollabAccessChanged (CO-2)', () => {
  // Workspace w1: A (u1 on P1), B (u2 on P1), C (u1 on P2).
  // Workspace w2: D (u1 on P3).
  const A = connection('A', 'u1', 'w1');
  const B = connection('B', 'u2', 'w1');
  const C = connection('C', 'u1', 'w1');
  const D = connection('D', 'u1', 'w2');

  let ext: AuthenticationExtension;
  let findManyByIds: jest.Mock;
  let recheck: jest.SpyInstance;
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    // onCollabAccessChanged arms a delayed re-check (PERMISSION_CACHE_TTL_MS +
    // 100); with fake timers it never fires after a test, against the restored
    // spies and these stand-in connections. It has its own test below.
    jest.useFakeTimers();
    const documents = new Map<string, any>();
    for (const [pageId, connections] of [
      [P1, [A, B]],
      [P2, [C]],
      [P3, [D]],
    ] as const) {
      const document = {
        name: `page.${pageId}`,
        getConnections: () => connections,
      };
      for (const c of connections) c.document = document;
      documents.set(document.name, document);
    }
    findManyByIds = jest.fn().mockResolvedValue([
      { id: P1, spaceId: 's1' },
      { id: P2, spaceId: 's2' },
    ]);
    ext = new AuthenticationExtension(
      {} as any,
      {} as any,
      { findManyByIds } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    (ext as any).instance = { documents };
    recheck = jest.spyOn(ext as any, 'recheck').mockResolvedValue(undefined);
    loggerError = jest
      .spyOn(ext['logger'], 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Drops the pending delayed re-check with the fake clock.
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const rechecked = () =>
    recheck.mock.calls.map(([c, request]) => {
      // An access change re-checks the connection's own principal.
      expect(request).toEqual({ token: null });
      return c.name;
    });

  it('the workspace alone: every connection of that workspace', async () => {
    await ext.onCollabAccessChanged({ workspaceId: 'w1' });
    expect(rechecked()).toEqual(['A', 'B', 'C']);
    expect(findManyByIds).not.toHaveBeenCalled();
  });

  it('userIds: only those users’ connections', async () => {
    await ext.onCollabAccessChanged({ workspaceId: 'w1', userIds: ['u1'] });
    expect(rechecked()).toEqual(['A', 'C']);
  });

  it('pageIds: only the connections of those pages', async () => {
    await ext.onCollabAccessChanged({ workspaceId: 'w1', pageIds: [P1] });
    expect(rechecked()).toEqual(['A', 'B']);
  });

  it('spaceId: only the connections on pages of that space', async () => {
    await ext.onCollabAccessChanged({ workspaceId: 'w1', spaceId: 's1' });
    expect(rechecked()).toEqual(['A', 'B']);
    // Only the pages of the workspace's open connections are looked up.
    expect(findManyByIds).toHaveBeenCalledWith([P1, P2]);
  });

  it('spaceId and userIds together narrow to both', async () => {
    await ext.onCollabAccessChanged({
      workspaceId: 'w1',
      spaceId: 's1',
      userIds: ['u1'],
    });
    expect(rechecked()).toEqual(['A']);
  });

  it('a failed space lookup re-checks every candidate connection, ERROR logged', async () => {
    const dbDown = new Error('db down');
    findManyByIds.mockRejectedValueOnce(dbDown);

    await ext.onCollabAccessChanged({
      workspaceId: 'w1',
      spaceId: 's1',
      userIds: ['u1'],
    });

    expect(rechecked()).toEqual(['A', 'C']);
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: dbDown, spaceId: 's1' }),
      expect.any(String),
    );
  });
});

/**
 * The space-role read behind a re-check is cached for PERMISSION_CACHE_TTL_MS,
 * so the re-check right after an access change can still see the old grant;
 * onCollabAccessChanged re-checks the same connections once more after the
 * cache has expired. The real re-check runs here (repos mocked); the space-role
 * read models that cache: the old grant until PERMISSION_CACHE_TTL_MS after the
 * change, then the revocation.
 */
describe('AuthenticationExtension.onCollabAccessChanged — the delayed re-check (CO-2)', () => {
  const DELAY_MS = PERMISSION_CACHE_TTL_MS + 100;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('the first re-check sees the cached grant and keeps the connection; the delayed one closes it; a connection closed by then is skipped', async () => {
    const cacheExpiresAt = Date.now() + PERMISSION_CACHE_TTL_MS;
    const getUserSpaceRoles = jest.fn(async () =>
      Date.now() < cacheExpiresAt ? [{ role: SpaceRole.WRITER }] : [],
    );
    const userRepo = {
      findById: jest.fn(async (id: string) => ({
        id,
        deactivatedAt: null,
        deletedAt: null,
      })),
    };
    const ext = new AuthenticationExtension(
      {} as any,
      userRepo as any,
      {
        findById: jest.fn(async () => ({
          id: P1,
          spaceId: 's1',
          deletedAt: null,
        })),
      } as any,
      { getUserSpaceRoles } as any,
      {
        canUserEditPage: jest.fn(async () => ({ hasAnyRestriction: false })),
      } as any,
      {} as any,
    );
    jest.spyOn(ext['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(ext['logger'], 'debug').mockImplementation(() => undefined);

    // Two writers on P1: `kept` stays open, `left` is closed (its client left)
    // before the delayed re-check.
    const open = new Set<any>();
    const document = {
      name: `page.${P1}`,
      getConnections: () => [...open],
      hasConnection: (c: any) => open.has(c),
    };
    const writer = (userId: string) => {
      const c: any = {
        document,
        readOnly: false,
        context: { user: { id: userId, workspaceId: 'w1' } },
        close: jest.fn(() => open.delete(c)),
      };
      open.add(c);
      return c;
    };
    const kept = writer('u1');
    const left = writer('u2');
    (ext as any).instance = { documents: new Map([[document.name, document]]) };
    // Each sweep's promise, so the test awaits the delayed one it fires.
    const sweeps: Promise<void>[] = [];
    const realSweep = (ext as any).recheckConnections.bind(ext);
    jest
      .spyOn(ext as any, 'recheckConnections')
      .mockImplementation((connections) => {
        const sweep = realSweep(connections);
        sweeps.push(sweep);
        return sweep;
      });

    await ext.onCollabAccessChanged({ workspaceId: 'w1' });
    // The re-check saw the cached grant: both connections kept.
    expect(getUserSpaceRoles).toHaveBeenCalledTimes(2);
    expect(kept.close).not.toHaveBeenCalled();
    expect(left.close).not.toHaveBeenCalled();

    open.delete(left);
    jest.advanceTimersByTime(DELAY_MS - 1);
    expect(sweeps).toHaveLength(1);

    jest.advanceTimersByTime(1);
    expect(sweeps).toHaveLength(2);
    await sweeps[1];

    // The cache has expired: the revocation closes the open connection...
    expect(kept.close).toHaveBeenCalledWith({
      code: 4401,
      reason: 'Unauthorized',
    });
    // ...and the closed one was skipped without an access lookup.
    expect(getUserSpaceRoles).toHaveBeenCalledTimes(3);
    expect(
      userRepo.findById.mock.calls.filter(([id]) => id === 'u2'),
    ).toHaveLength(1);
    expect(left.close).not.toHaveBeenCalled();
  });
});
