import { NotFoundException } from '@nestjs/common';
import {
  SHARE_SEARCH_DISABLED_APPROVED,
  SearchService,
} from './search.service';

/**
 * Unit coverage for SearchService.searchPage SCOPE-SECURITY early returns — the
 * branches that must yield an empty result WITHOUT ever touching the DB, so they
 * can leak nothing. The happy-path scope SQL (explicit space / member spaces /
 * share id set) is covered against the real schema in the integration spec.
 *
 * Every case here returns BEFORE the raw-SQL candidate query runs, so a bare `db`
 * stub (never called) is enough — a call to it would itself be a failure signal.
 */
describe('SearchService.searchPage — scope-security early returns', () => {
  function makeService(opts?: {
    share?: any;
    isRestricted?: boolean;
    memberSpaceIds?: string[];
    sharingAllowed?: boolean;
  }) {
    // A db that THROWS if touched — these branches must not reach SQL.
    const db: any = new Proxy(
      {},
      {
        get() {
          throw new Error('db must not be touched on an empty-scope branch');
        },
      },
    );

    const pageRepo = {
      getPageAndDescendantsExcludingRestricted: jest.fn(),
      getPageAndDescendants: jest.fn(),
    };
    const shareRepo = {
      findById: jest.fn().mockResolvedValue(opts?.share ?? null),
    };
    const spaceMemberRepo = {
      getUserSpaceIds: jest.fn().mockResolvedValue(opts?.memberSpaceIds ?? []),
    };
    const pagePermissionRepo = {
      hasRestrictedAncestor: jest
        .fn()
        .mockResolvedValue(opts?.isRestricted ?? false),
      filterAccessiblePageIds: jest.fn(),
    };
    const shareService = {
      isSharingAllowed: jest
        .fn()
        .mockResolvedValue(opts?.sharingAllowed ?? true),
    };

    const service = new SearchService(
      db as any,
      pageRepo as any,
      shareRepo as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
      { vectorCandidateArm: jest.fn() } as any,
      // #530/#599 semantic path off for these query-mode unit tests: the query-embed
      // funnel throws, so the service degrades to the byte-identical lexical path.
      {
        embedQueryForActiveGeneration: jest
          .fn()
          .mockRejectedValue(new Error('no embed')),
      } as any,
      shareService as any,
    );
    return {
      service,
      pageRepo,
      shareRepo,
      spaceMemberRepo,
      pagePermissionRepo,
      shareService,
    };
  }

  it('returns total:0 for a blank query WITHOUT touching the DB or any repo', async () => {
    const { service, shareRepo, spaceMemberRepo } = makeService();
    const result = await service.searchPage(
      { query: '' } as any,
      { userId: 'user-1', workspaceId: 'ws-1' },
    );
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(shareRepo.findById).not.toHaveBeenCalled();
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });

  it('only-negation short-circuits with reason "only-negation", never scanning', async () => {
    const { service, spaceMemberRepo } = makeService();
    const result = await service.searchPage(
      { query: '-архив' } as any,
      { userId: 'user-1', workspaceId: 'ws-1' },
    );
    expect(result.total).toBe(0);
    expect(result.query.parsed.reason).toBe('only-negation');
    // Never resolves scope (returns before) — no expensive NOT-only scan.
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });

  it('404s when the share belongs to a DIFFERENT workspace (no leak)', async () => {
    const { service, shareRepo, pagePermissionRepo } = makeService({
      share: { id: 's1', pageId: 'p1', workspaceId: 'OTHER', includeSubPages: false },
    });
    await expect(
      service.searchPage(
        { query: 'plan', shareId: 's1' } as any,
        { anonymousShare: true, workspaceId: 'ws-1' },
      ),
    ).rejects.toThrow(NotFoundException);
    expect(shareRepo.findById).toHaveBeenCalledWith('s1');
    // Workspace mismatch short-circuits before restricted-ancestor / enumeration.
    expect(pagePermissionRepo.hasRestrictedAncestor).not.toHaveBeenCalled();
  });

  // SR-3: the same gate as the share page itself.
  it('404s when sharing is disabled for the share\'s workspace/space', async () => {
    const { service, shareService, pagePermissionRepo, pageRepo } = makeService({
      share: { id: 's1', pageId: 'p1', spaceId: 'sp1', workspaceId: 'ws-1', includeSubPages: true },
      sharingAllowed: false,
    });
    await expect(
      service.searchPage(
        { query: 'plan', shareId: 's1' } as any,
        { anonymousShare: true, workspaceId: 'ws-1' },
      ),
    ).rejects.toThrow(NotFoundException);
    expect(shareService.isSharingAllowed).toHaveBeenCalledWith('ws-1', 'sp1');
    expect(pagePermissionRepo.hasRestrictedAncestor).not.toHaveBeenCalled();
    expect(
      pageRepo.getPageAndDescendantsExcludingRestricted,
    ).not.toHaveBeenCalled();
  });

  // SR-1: an approved share publishes only saved versions; the index holds the
  // live draft, so search is off there, with an explicit reason.
  it('an approved-mode share returns an empty result with the disabled reason', async () => {
    const { service, pageRepo } = makeService({
      share: {
        id: 's1',
        pageId: 'p1',
        spaceId: 'sp1',
        workspaceId: 'ws-1',
        includeSubPages: false,
        publishedMode: 'approved',
      },
    });
    const disabled = await service.searchPage(
      { query: 'secret', shareId: 's1' } as any,
      { anonymousShare: true, workspaceId: 'ws-1' },
    );
    expect(disabled.items).toEqual([]);
    expect(disabled.related).toEqual([]);
    expect(disabled.total).toBe(0);
    expect(disabled.disabledReason).toBe(SHARE_SEARCH_DISABLED_APPROVED);
    expect(
      pageRepo.getPageAndDescendantsExcludingRestricted,
    ).not.toHaveBeenCalled();
  });

  // SR-5: a parentPageId outside the share is never looked up (an existence
  // oracle, and a 22P02 on a non-uuid) — the result is plainly empty.
  it('a parentPageId outside the share is never looked up', async () => {
    const { service, pageRepo } = makeService({
      share: { id: 's1', pageId: 'p1', spaceId: 'sp1', workspaceId: 'ws-1', includeSubPages: false },
    });
    for (const parentPageId of ['x', 'some-other-page-id']) {
      const result = await service.searchPage(
        { query: 'plan', shareId: 's1', parentPageId } as any,
        { anonymousShare: true, workspaceId: 'ws-1' },
      );
      expect(result.items).toEqual([]);
      expect(result.semantic).toBeUndefined();
    }
    expect(pageRepo.getPageAndDescendants).not.toHaveBeenCalled();
  });

  it('returns empty when the shared page has a restricted ancestor', async () => {
    const { service, pagePermissionRepo, pageRepo } = makeService({
      share: { id: 's1', pageId: 'p1', workspaceId: 'ws-1', includeSubPages: true },
      isRestricted: true,
    });
    const result = await service.searchPage(
      { query: 'plan', shareId: 's1' } as any,
      { anonymousShare: true, workspaceId: 'ws-1' },
    );
    expect(pagePermissionRepo.hasRestrictedAncestor).toHaveBeenCalledWith('p1');
    expect(result.items).toEqual([]);
    expect(
      pageRepo.getPageAndDescendantsExcludingRestricted,
    ).not.toHaveBeenCalled();
  });

  it('an anonymous caller without a shareId gets nothing (spaceId is ignored)', async () => {
    const { service, shareRepo, spaceMemberRepo } = makeService();
    const result = await service.searchPage(
      { query: 'plan', spaceId: 'space-1' } as any,
      { anonymousShare: true, workspaceId: 'ws-1' },
    );
    expect(result.items).toEqual([]);
    expect(shareRepo.findById).not.toHaveBeenCalled();
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });

  // SR-4: a non-anonymous search without a user would run with no membership
  // scope and no permission filter — it is refused, never run.
  it('refuses a non-anonymous search without a userId (fail closed)', async () => {
    const { service, spaceMemberRepo } = makeService();
    await expect(
      service.searchPage(
        { query: 'plan', spaceId: 'space-1' } as any,
        { userId: undefined, workspaceId: 'ws-1' } as any,
      ),
    ).rejects.toThrow(/requires a userId/);
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });

  it('an authenticated user with NO member spaces gets an empty result', async () => {
    const { service, spaceMemberRepo } = makeService({ memberSpaceIds: [] });
    const result = await service.searchPage(
      { query: 'plan' } as any,
      { userId: 'user-1', workspaceId: 'ws-1' },
    );
    expect(spaceMemberRepo.getUserSpaceIds).toHaveBeenCalledWith('user-1');
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});

/**
 * The per-item shape of a search that FINDS a page: an anonymous share reader
 * never gets the page's `space` or `creatorId`; an authenticated caller does.
 * The ranked-id query and the ancestor-path walk are stubbed; the detail fetch
 * runs over a chainable query-builder stub returning one row.
 */
describe('SearchService.searchPage — result item shape', () => {
  const row = {
    id: 'p1',
    slugId: 'slug1',
    title: 'Plan',
    icon: null,
    creatorId: 'user-9',
    spaceId: 'sp1',
    space: { id: 'sp1', name: 'Secret space', slug: 'secret' },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    rank: 0.5,
    highlight: null,
    snippet: 'plan',
    titleMatch: true,
    textMatch: false,
    tmatch0: true,
  };

  function makeService() {
    const db: any = {
      selectFrom: jest.fn(() => db),
      select: jest.fn(() => db),
      where: jest.fn(() => db),
      execute: jest.fn(async () => [row]),
    };
    const service = new SearchService(
      db,
      { withSpace: jest.fn() } as any,
      {
        findById: jest.fn().mockResolvedValue({
          id: 's1',
          pageId: 'p1',
          spaceId: 'sp1',
          workspaceId: 'ws-1',
          includeSubPages: false,
        }),
      } as any,
      { getUserSpaceIds: jest.fn().mockResolvedValue(['sp1']) } as any,
      {
        hasRestrictedAncestor: jest.fn().mockResolvedValue(false),
        filterAccessiblePageIds: jest.fn(async ({ pageIds }) => pageIds),
      } as any,
      { vectorCandidateArm: jest.fn() } as any,
      {
        embedQueryForActiveGeneration: jest
          .fn()
          .mockRejectedValue(new Error('no embed')),
      } as any,
      { isSharingAllowed: jest.fn().mockResolvedValue(true) } as any,
    );
    jest
      .spyOn(service as any, 'runRankedQuery')
      .mockResolvedValue([{ id: 'p1', lexical: true }]);
    jest
      .spyOn(service as any, 'buildAncestorPaths')
      .mockResolvedValue(new Map());
    return service;
  }

  it('an anonymous share search omits space and creatorId from every item', async () => {
    const result = await makeService().searchPage(
      { query: 'plan', shareId: 's1' } as any,
      { anonymousShare: true, workspaceId: 'ws-1' },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('p1');
    expect(result.items[0]).not.toHaveProperty('space');
    expect(result.items[0]).not.toHaveProperty('creatorId');
  });

  it('an authenticated search keeps space and creatorId', async () => {
    const result = await makeService().searchPage(
      { query: 'plan' } as any,
      { userId: 'user-1', workspaceId: 'ws-1' },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].space).toEqual(row.space);
    expect(result.items[0].creatorId).toBe('user-9');
  });
});
