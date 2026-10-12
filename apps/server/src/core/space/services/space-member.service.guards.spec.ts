import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SpaceMemberService } from './space-member.service';
import { SpaceRole } from '../../../common/helpers/types/permission';
import { EventName } from '../../../common/events/event.contants';

// Direct-instantiation unit tests for SpaceMemberService.validateLastAdmin,
// exercised through its two real call sites: removeMemberFromSpace and
// updateSpaceMemberRole. The guard is what prevents a space from being orphaned
// with no admin (full-access) member. Tests assert both the thrown exception
// type AND that no destructive repo write fired on a rejection.
//
// Constructor arg order (8 positional deps) is pinned: spaceMemberRepo,
// groupUserRepo, spaceRepo, watcherRepo, favoriteRepo, db, auditService,
// eventEmitter.

const WORKSPACE_ID = 'ws-1';
const SPACE_ID = 'space-1';

function buildService(opts?: {
  space?: any;
  member?: any;
  adminCount?: number;
  groupUserIds?: string[];
  validUsers?: any[];
  validGroups?: any[];
}) {
  const spaceRepo = {
    // Default: a real space so the NotFound(space) guard is not what fires.
    findById: jest
      .fn()
      .mockResolvedValue(
        opts?.space === undefined ? { id: SPACE_ID, name: 'Space 1' } : opts.space,
      ),
  };

  const spaceMemberRepo = {
    getSpaceMemberByTypeId: jest
      .fn()
      .mockResolvedValue(opts?.member ?? null),
    roleCountBySpaceId: jest.fn().mockResolvedValue(opts?.adminCount ?? 2),
    removeSpaceMemberById: jest.fn().mockResolvedValue(undefined),
    updateSpaceMember: jest.fn().mockResolvedValue(undefined),
    insertSpaceMember: jest.fn().mockResolvedValue(undefined),
  };

  const groupUserRepo = {
    getUserIdsByGroupId: jest.fn().mockResolvedValue(opts?.groupUserIds ?? []),
  };
  const watcherRepo = {
    deleteByUsersWithoutSpaceAccess: jest.fn().mockResolvedValue(undefined),
  };
  const favoriteRepo = {
    deleteByUsersWithoutSpaceAccess: jest.fn().mockResolvedValue(undefined),
  };

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

  // db.transaction().execute(cb) just runs the callback with a noop trx;
  // selectFrom('users' | 'groups') resolves the batch-add's valid members.
  const db = {
    transaction: jest.fn().mockReturnValue({
      execute: jest.fn(async (cb: any) => cb({} as any)),
    }),
    selectFrom: jest.fn((table: string) =>
      query((table === 'users' ? opts?.validUsers : opts?.validGroups) ?? []),
    ),
  };

  const auditService = { log: jest.fn() };
  const eventEmitter = { emit: jest.fn() };

  const service = new SpaceMemberService(
    spaceMemberRepo as any, // spaceMemberRepo
    groupUserRepo as any, // groupUserRepo
    spaceRepo as any, // spaceRepo
    watcherRepo as any, // watcherRepo
    favoriteRepo as any, // favoriteRepo
    db as any, // db
    auditService as any, // auditService
    eventEmitter as any, // eventEmitter
  );

  return { service, spaceMemberRepo, spaceRepo, auditService, eventEmitter };
}

describe('SpaceMemberService.removeMemberFromSpace last-admin guard', () => {
  it('rejects removing the only ADMIN member with BadRequest (no removal)', async () => {
    const { service, spaceMemberRepo } = buildService({
      member: { id: 'sm-1', role: SpaceRole.ADMIN, userId: 'u-1' },
      adminCount: 1,
    });

    await expect(
      service.removeMemberFromSpace(
        { spaceId: SPACE_ID, userId: 'u-1' } as any,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(spaceMemberRepo.removeSpaceMemberById).not.toHaveBeenCalled();
  });

  it('removes an ADMIN member when more than one admin exists', async () => {
    const { service, spaceMemberRepo } = buildService({
      member: { id: 'sm-1', role: SpaceRole.ADMIN, userId: 'u-1' },
      adminCount: 2,
    });

    await service.removeMemberFromSpace(
      { spaceId: SPACE_ID, userId: 'u-1' } as any,
      WORKSPACE_ID,
    );

    expect(spaceMemberRepo.removeSpaceMemberById).toHaveBeenCalledTimes(1);
  });

  it('removing a non-admin member skips the last-admin check entirely', async () => {
    const { service, spaceMemberRepo } = buildService({
      member: { id: 'sm-2', role: SpaceRole.WRITER, userId: 'u-2' },
      adminCount: 1, // even at 1 admin, the check must not run for a non-admin
    });

    await service.removeMemberFromSpace(
      { spaceId: SPACE_ID, userId: 'u-2' } as any,
      WORKSPACE_ID,
    );

    expect(spaceMemberRepo.roleCountBySpaceId).not.toHaveBeenCalled();
    expect(spaceMemberRepo.removeSpaceMemberById).toHaveBeenCalledTimes(1);
  });

  it('rejects with BadRequest when neither userId nor groupId is provided', async () => {
    const { service, spaceMemberRepo } = buildService();

    await expect(
      service.removeMemberFromSpace(
        { spaceId: SPACE_ID } as any,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(spaceMemberRepo.getSpaceMemberByTypeId).not.toHaveBeenCalled();
    expect(spaceMemberRepo.removeSpaceMemberById).not.toHaveBeenCalled();
  });

  it('rejects with NotFound when the membership does not exist', async () => {
    const { service, spaceMemberRepo } = buildService({ member: null });

    await expect(
      service.removeMemberFromSpace(
        { spaceId: SPACE_ID, userId: 'u-missing' } as any,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(spaceMemberRepo.removeSpaceMemberById).not.toHaveBeenCalled();
  });
});

describe('SpaceMemberService.updateSpaceMemberRole last-admin guard', () => {
  it('rejects demoting the only ADMIN with BadRequest (no update)', async () => {
    const { service, spaceMemberRepo } = buildService({
      member: { id: 'sm-1', role: SpaceRole.ADMIN, userId: 'u-1' },
      adminCount: 1,
    });

    await expect(
      service.updateSpaceMemberRole(
        { spaceId: SPACE_ID, userId: 'u-1', role: SpaceRole.WRITER } as any,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(spaceMemberRepo.updateSpaceMember).not.toHaveBeenCalled();
  });

  it('allows demoting an ADMIN when more than one admin exists', async () => {
    const { service, spaceMemberRepo } = buildService({
      member: { id: 'sm-1', role: SpaceRole.ADMIN, userId: 'u-1' },
      adminCount: 2,
    });

    await service.updateSpaceMemberRole(
      { spaceId: SPACE_ID, userId: 'u-1', role: SpaceRole.WRITER } as any,
      WORKSPACE_ID,
    );

    expect(spaceMemberRepo.updateSpaceMember).toHaveBeenCalledTimes(1);
  });

  it('returns early when the role is unchanged (no admin check, no update)', async () => {
    const { service, spaceMemberRepo, auditService } = buildService({
      member: { id: 'sm-1', role: SpaceRole.ADMIN, userId: 'u-1' },
      adminCount: 1, // would otherwise trip the guard, but the no-op returns first
    });

    await service.updateSpaceMemberRole(
      { spaceId: SPACE_ID, userId: 'u-1', role: SpaceRole.ADMIN } as any,
      WORKSPACE_ID,
    );

    expect(spaceMemberRepo.roleCountBySpaceId).not.toHaveBeenCalled();
    expect(spaceMemberRepo.updateSpaceMember).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('promoting a non-admin (WRITER->ADMIN) skips the last-admin check', async () => {
    const { service, spaceMemberRepo } = buildService({
      member: { id: 'sm-2', role: SpaceRole.WRITER, userId: 'u-2' },
      adminCount: 1,
    });

    await service.updateSpaceMemberRole(
      { spaceId: SPACE_ID, userId: 'u-2', role: SpaceRole.ADMIN } as any,
      WORKSPACE_ID,
    );

    expect(spaceMemberRepo.roleCountBySpaceId).not.toHaveBeenCalled();
    expect(spaceMemberRepo.updateSpaceMember).toHaveBeenCalledTimes(1);
  });

  it('rejects with NotFound when the membership does not exist', async () => {
    const { service, spaceMemberRepo } = buildService({ member: null });

    await expect(
      service.updateSpaceMemberRole(
        { spaceId: SPACE_ID, userId: 'u-missing', role: SpaceRole.WRITER } as any,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(spaceMemberRepo.updateSpaceMember).not.toHaveBeenCalled();
  });
});

describe('SpaceMemberService COLLAB_ACCESS_CHANGED (CO-2)', () => {
  it('adding members emits the space', async () => {
    const { service, eventEmitter } = buildService({
      validUsers: [{ id: 'u-1', name: 'U1' }],
      validGroups: [{ id: 'g-1', name: 'G1' }],
    });

    await service.addMembersToSpaceBatch(
      {
        spaceId: SPACE_ID,
        userIds: ['u-1'],
        groupIds: ['g-1'],
        role: SpaceRole.WRITER,
      } as any,
      { id: 'auth-1' } as any,
      WORKSPACE_ID,
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EventName.COLLAB_ACCESS_CHANGED,
      { workspaceId: WORKSPACE_ID, spaceId: SPACE_ID },
    );
  });

  it("removing a group emits the space and the group's users", async () => {
    const { service, eventEmitter } = buildService({
      member: { id: 'sm-3', role: SpaceRole.WRITER, groupId: 'g-1' },
      groupUserIds: ['u-1', 'u-2'],
    });

    await service.removeMemberFromSpace(
      { spaceId: SPACE_ID, groupId: 'g-1' } as any,
      WORKSPACE_ID,
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EventName.COLLAB_ACCESS_CHANGED,
      { workspaceId: WORKSPACE_ID, spaceId: SPACE_ID, userIds: ['u-1', 'u-2'] },
    );
  });

  it("a user's role change emits the space and the user", async () => {
    const { service, eventEmitter } = buildService({
      member: { id: 'sm-2', role: SpaceRole.WRITER, userId: 'u-2' },
    });

    await service.updateSpaceMemberRole(
      { spaceId: SPACE_ID, userId: 'u-2', role: SpaceRole.READER } as any,
      WORKSPACE_ID,
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EventName.COLLAB_ACCESS_CHANGED,
      { workspaceId: WORKSPACE_ID, spaceId: SPACE_ID, userIds: ['u-2'] },
    );
  });

  it("a group's role change emits the space only", async () => {
    const { service, eventEmitter } = buildService({
      member: { id: 'sm-3', role: SpaceRole.WRITER, groupId: 'g-1' },
    });

    await service.updateSpaceMemberRole(
      { spaceId: SPACE_ID, groupId: 'g-1', role: SpaceRole.READER } as any,
      WORKSPACE_ID,
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EventName.COLLAB_ACCESS_CHANGED,
      { workspaceId: WORKSPACE_ID, spaceId: SPACE_ID },
    );
  });
});
