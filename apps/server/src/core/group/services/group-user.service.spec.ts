import { GroupUserService } from './group-user.service';
import { EventName } from '../../../common/events/event.contants';
import { executeTx } from '@docmost/db/utils';

// CO-2 — a committed group membership change emits COLLAB_ACCESS_CHANGED for
// the users it affects. Direct instantiation; constructor arg order (9
// positional deps): groupUserRepo, spaceMemberRepo, userRepo, groupService,
// watcherRepo, favoriteRepo, db, auditService, eventEmitter.

const WORKSPACE_ID = 'ws-1';

// A chainable query stub whose execute() resolves `rows`.
const query = (rows: any[]) => {
  const chain: any = new Proxy(function () {}, {
    get: (_t, p) =>
      p === 'then'
        ? undefined
        : p === 'execute'
          ? () => Promise.resolve(rows)
          : () => chain,
  });
  return chain;
};

function buildService(validUsers: any[] = []) {
  // selectFrom('users') resolves the valid users; insertInto(...) is a no-op.
  const queries = {
    selectFrom: jest.fn(() => query(validUsers)),
    insertInto: jest.fn(() => query([])),
  };
  const db = {
    ...queries,
    transaction: jest.fn(() => ({
      execute: jest.fn(async (cb: any) => cb(queries)),
    })),
  };
  const groupService = {
    findAndValidateGroup: jest
      .fn()
      .mockResolvedValue({ id: 'g-1', name: 'G1', isDefault: false }),
  };
  const eventEmitter = { emit: jest.fn() };

  const service = new GroupUserService(
    {
      getGroupUserById: jest.fn().mockResolvedValue({ userId: 'u-1' }),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any, // groupUserRepo
    { getSpaceIdsByGroupId: jest.fn().mockResolvedValue(['s-1']) } as any, // spaceMemberRepo
    {
      findById: jest.fn().mockResolvedValue({ id: 'u-1', name: 'U1' }),
    } as any, // userRepo
    groupService as any, // groupService
    {
      deleteByUsersWithoutSpaceAccess: jest.fn().mockResolvedValue(undefined),
    } as any, // watcherRepo
    {
      deleteByUsersWithoutSpaceAccess: jest.fn().mockResolvedValue(undefined),
    } as any, // favoriteRepo
    db as any, // db
    { log: jest.fn() } as any, // auditService
    eventEmitter as any, // eventEmitter
  );

  return { service, db, eventEmitter };
}

describe('GroupUserService COLLAB_ACCESS_CHANGED (CO-2)', () => {
  it("adding users emits the added users' ids", async () => {
    const { service, eventEmitter } = buildService([
      { id: 'u-1', name: 'U1' },
      { id: 'u-2', name: 'U2' },
    ]);

    await service.addUsersToGroupBatch(['u-1', 'u-2'], 'g-1', WORKSPACE_ID);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EventName.COLLAB_ACCESS_CHANGED,
      { workspaceId: WORKSPACE_ID, userIds: ['u-1', 'u-2'] },
    );
  });

  it("adding users inside a caller's transaction emits after its commit", async () => {
    const { service, db, eventEmitter } = buildService([
      { id: 'u-1', name: 'U1' },
    ]);

    await executeTx(db as any, async (trx) => {
      await service.addUsersToGroupBatch(['u-1'], 'g-1', WORKSPACE_ID, trx);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EventName.COLLAB_ACCESS_CHANGED,
      { workspaceId: WORKSPACE_ID, userIds: ['u-1'] },
    );
  });

  it('removing a user emits that user', async () => {
    const { service, eventEmitter } = buildService();

    await service.removeUserFromGroup('u-1', 'g-1', WORKSPACE_ID);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EventName.COLLAB_ACCESS_CHANGED,
      { workspaceId: WORKSPACE_ID, userIds: ['u-1'] },
    );
  });
});
