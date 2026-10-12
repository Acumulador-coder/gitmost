import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { NotFoundException } from '@nestjs/common';
import {
  SHARE_SEARCH_DISABLED_APPROVED,
  SearchService,
} from 'src/core/search/search.service';
import { ShareService } from 'src/core/share/share.service';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { AiEmbeddingNotConfiguredException } from 'src/integrations/ai/ai-embedding-not-configured.exception';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
} from './db';

/**
 * The anonymous share-search scope, on real Postgres:
 *  - SR-1: an approved-mode share publishes only its saved version, while the
 *    index holds the live draft — search there returns nothing, with a reason;
 *  - SR-2: `path` is cut at the share root (no title above the share);
 *  - SR-3: sharing disabled for the space => the same 404 as the share page;
 *  - SR-5: a parentPageId outside the share (or not a uuid) is never looked up.
 */
describe('SearchService anonymous share scope [integration]', () => {
  let db: Kysely<any>;
  let workspaceId: string;
  let spaceId: string;
  let shareService: ShareService;
  let service: SearchService;

  const pagePermissionRepo = {
    hasRestrictedAncestor: async () => false,
    filterAccessiblePageIds: async ({ pageIds }: { pageIds: string[] }) =>
      pageIds,
  };

  const docWith = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  async function insertPage(args: {
    title: string;
    text: string;
    parentPageId?: string | null;
    space?: string;
  }): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('pages')
      .values({
        id,
        slugId: `slug-${id.slice(0, 12)}`,
        title: args.title,
        content: docWith(args.text) as any,
        textContent: args.text,
        parentPageId: args.parentPageId ?? null,
        spaceId: args.space ?? spaceId,
        workspaceId,
      })
      .execute();
    return id;
  }

  async function share(args: {
    pageId: string;
    publishedMode?: 'live' | 'approved';
    includeSubPages?: boolean;
    space?: string;
  }): Promise<string> {
    const created: any = await shareService.createShare({
      authUserId: null as any,
      workspaceId,
      page: { id: args.pageId, spaceId: args.space ?? spaceId } as any,
      createShareDto: {
        pageId: args.pageId,
        includeSubPages: args.includeSubPages ?? false,
        publishedMode: args.publishedMode ?? 'live',
      } as any,
    });
    return created.id;
  }

  const anon = (params: any) =>
    service.searchPage(params, { anonymousShare: true, workspaceId });

  beforeAll(async () => {
    db = getTestDb();
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
    const shareRepo = new ShareRepo(db as any, {} as any);
    const pageRepo = new PageRepo(db as any, {} as any, {} as any);
    shareService = new ShareService(
      shareRepo as any,
      pageRepo as any,
      pagePermissionRepo as any,
      db as any,
      {} as any, // tokenService
      {} as any, // transclusionService
      { findById: async () => ({ settings: {} }) } as any, // workspaceRepo
      new PageHistoryRepo(db as any) as any,
    );
    service = new SearchService(
      db as any,
      pageRepo as any,
      shareRepo as any,
      {} as any, // spaceMemberRepo — never used by the anonymous scope
      pagePermissionRepo as any,
      {} as any, // pageEmbeddingRepo — the vector arm never runs here
      {
        embedQueryForActiveGeneration: async () => {
          throw new AiEmbeddingNotConfiguredException();
        },
      } as any,
      shareService,
    );
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('SR-1: an approved share + a saved version + a live draft with a secret word returns nothing', async () => {
    const pageId = await insertPage({
      title: 'Quarterly notes',
      text: 'public text of the release',
    });
    // Enabling approved mode mints the manual version from the current content.
    const shareId = await share({ pageId, publishedMode: 'approved' });
    const saved = await db
      .selectFrom('pageHistory')
      .select(['id'])
      .where('pageId', '=', pageId)
      .where('kind', '=', 'manual')
      .execute();
    expect(saved).toHaveLength(1);

    // The live draft now carries a secret the share never published.
    await db
      .updateTable('pages')
      .set({
        title: 'Zanzibar merger',
        content: docWith('zanzibar merger draft') as any,
        textContent: 'zanzibar merger draft',
      })
      .where('id', '=', pageId)
      .execute();

    for (const query of ['zanzibar', 'merger', 'public']) {
      const res = await anon({ query, shareId });
      expect(res.items).toEqual([]);
      expect(res.related).toEqual([]);
      expect(res.total).toBe(0);
      expect(res.disabledReason).toBe(SHARE_SEARCH_DISABLED_APPROVED);
      // The response echoes the query back; nothing else may carry the word.
      expect(
        JSON.stringify({ ...res, query: undefined }).toLowerCase(),
      ).not.toContain('zanzibar');
    }

    // Control: the same draft behind a LIVE share is found — the query above
    // would have hit it, so the empty result is the approved-mode rule.
    const liveId = await insertPage({
      title: 'Zanzibar live',
      text: 'zanzibar merger draft',
    });
    const liveShareId = await share({ pageId: liveId });
    const live = await anon({ query: 'zanzibar', shareId: liveShareId });
    expect(live.items.map((i) => i.id)).toEqual([liveId]);
    expect(live.disabledReason).toBeUndefined();
  });

  it('SR-2: path is cut at the share root', async () => {
    const a = await insertPage({ title: 'Layoffs 2027 plan', text: 'top' });
    const b = await insertPage({ title: 'Org B', text: 'mid', parentPageId: a });
    const s = await insertPage({
      title: 'Shared root',
      text: 'quokka root',
      parentPageId: b,
    });
    const c = await insertPage({
      title: 'Child page',
      text: 'quokka child',
      parentPageId: s,
    });
    const shareId = await share({ pageId: s, includeSubPages: true });

    const res = await anon({ query: 'quokka', shareId });
    const pathOf = (id: string) => res.items.find((i) => i.id === id)?.path;
    expect(pathOf(s)).toEqual([]);
    expect(pathOf(c)).toEqual(['Shared root']);
    expect(JSON.stringify(res)).not.toContain('Layoffs 2027 plan');
    expect(JSON.stringify(res)).not.toContain('Org B');
  });

  it('SR-3: sharing disabled for the space => the same 404 as the share page', async () => {
    const otherSpace = (await createSpace(db, workspaceId)).id;
    const pageId = await insertPage({
      title: 'Walrus doc',
      text: 'walrus',
      space: otherSpace,
    });
    const shareId = await share({ pageId, space: otherSpace });
    expect((await anon({ query: 'walrus', shareId })).items).toHaveLength(1);

    await db
      .updateTable('spaces')
      .set({ settings: { sharing: { disabled: true } } as any })
      .where('id', '=', otherSpace)
      .execute();
    await expect(anon({ query: 'walrus', shareId })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('SR-5: a parentPageId outside the share, or not a uuid, is plainly empty', async () => {
    const inShare = await insertPage({ title: 'Ibis', text: 'ibis' });
    const outside = await insertPage({ title: 'Ibis outside', text: 'ibis' });
    const shareId = await share({ pageId: inShare });

    for (const parentPageId of ['x', outside, randomUUID()]) {
      const res = await anon({ query: 'ibis', shareId, parentPageId });
      expect(res.items).toEqual([]);
      expect(res.semantic).toBeUndefined();
    }
    const inside = await anon({ query: 'ibis', shareId, parentPageId: inShare });
    expect(inside.items.map((i) => i.id)).toEqual([inShare]);
    // No workspace-wide semantic counters on the anonymous path.
    expect(inside.semantic).toBeUndefined();
  });
});
