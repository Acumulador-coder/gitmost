// Stub the collab util so importing the service does not drag in the
// editor-ext -> @tiptap/react -> react-dom graph (unloadable under jest's node
// env, same coupling noted in mcp.service.spec.ts). The captured transact
// callback is never executed in these unit tests, so the stub extensions array
// is sufficient; the real collab write path is exercised by integration tests.
jest.mock('../../../collaboration/collaboration.util', () => ({
  tiptapExtensions: [],
  getPageId: (name: string) => name.replace(/^page\./, ''),
}));
// writeBody now builds the replacement Yjs state eagerly (before clearing the
// live doc), so TiptapTransformer.toYdoc runs in these unit tests. Real Tiptap
// extensions are stubbed to [] above (they drag in the React graph), which can't
// build a schema — so stub the transformer to return a small non-empty Y.Doc.
// The real conversion is exercised by the @docmost/git-sync converter tests and
// the integration tests.
jest.mock('@hocuspocus/transformer', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Yjs = require('yjs');
  return {
    TiptapTransformer: {
      toYdoc: jest.fn(() => {
        const d = new Yjs.Doc();
        d.getXmlFragment('default').insert(0, [new Yjs.XmlElement('paragraph')]);
        return d;
      }),
    },
  };
});
// PageService is only ever a mocked dependency here; stub the editor-ext entry
// it imports so loading its module does not pull in the React graph either.
jest.mock('@docmost/editor-ext', () => ({
  markdownToHtml: jest.fn(),
  // The converter maps this list when its schema module loads.
  documentExtensions: [],
}));
// The service loads `parseDocmostMarkdown` / `markdownToProseMirror` at runtime
// via the `loadGitSync()` bridge (the ESM `@docmost/git-sync` package cannot be
// `require()`d under jest). Stub the loader: the real conversion is exercised by
// the @docmost/git-sync converter tests and the converter gate; here the mocked
// TiptapTransformer.toYdoc ignores the converted doc anyway, so a passthrough
// body + a minimal ProseMirror doc is sufficient (an empty body converts to the
// empty doc, like the real converter).
jest.mock('../git-sync.loader', () => ({
  loadGitSync: jest.fn(async () => ({
    parseDocmostMarkdown: (md: string) => ({ meta: {}, body: md }),
    markdownToProseMirror: async (md: string) => ({
      type: 'doc',
      content: md
        ? [{ type: 'paragraph', content: [{ type: 'text', text: md }] }]
        : [{ type: 'paragraph' }],
    }),
    // renamePage funnels the current title through sanitizeTitle to detect the
    // sanitized-stem echo; identity is the correct default here (none of the
    // rename fixtures use filename-hostile chars, so the sanitized form equals
    // the input and the guard never fires).
    sanitizeTitle: (title: string) => title,
  })),
}));

import {
  GIT_SYNC_BODY_WRITE_TIMEOUT_MS,
  GitmostDataSourceService,
} from './gitmost-datasource.service';

// Focused unit/contract test for the native GitSyncClient adapter.
// No DB, no real collab server: the repos/services/gateway are mocked and we
// assert the mapping logic + the provenance/soft-delete/position contracts.

type AnyMock = jest.Mock;

interface Mocks {
  pageRepo: {
    findById: AnyMock;
    getSpaceDescendants: AnyMock;
    restorePage: AnyMock;
  };
  spaceRepo: { findById: AnyMock };
  pageService: {
    create: AnyMock;
    update: AnyMock;
    movePage: AnyMock;
    removePage: AnyMock;
  };
  collabGateway: { writePageBody: AnyMock };
  // Minimal Kysely-ish chainable mock for the direct-query paths.
  db: any;
}

function makeQueryBuilder(rows: any[]) {
  const qb: any = {};
  for (const m of ['select', 'where', 'orderBy', 'limit']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.execute = jest.fn(async () => rows);
  qb.executeTakeFirst = jest.fn(async () => rows[0]);
  return qb;
}

function build(rows: any[] = []): {
  service: GitmostDataSourceService;
  mocks: Mocks;
} {
  const mocks: Mocks = {
    pageRepo: {
      findById: jest.fn(),
      getSpaceDescendants: jest.fn(),
      restorePage: jest.fn(async () => undefined),
    },
    spaceRepo: { findById: jest.fn(async () => ({ id: 'space-1' })) },
    pageService: {
      create: jest.fn(),
      update: jest.fn(async () => undefined),
      movePage: jest.fn(async () => undefined),
      removePage: jest.fn(async () => undefined),
    },
    collabGateway: {
      writePageBody: jest.fn(async () => undefined),
    },
    db: {
      selectFrom: jest.fn(() => makeQueryBuilder(rows)),
    },
  };

  const service = new GitmostDataSourceService(
    mocks.pageRepo as any,
    mocks.spaceRepo as any,
    mocks.pageService as any,
    mocks.collabGateway as any,
    mocks.db as any,
  );

  return { service, mocks };
}

const CTX = { workspaceId: 'ws-1', userId: 'svc-user', spaceId: 'space-1' };
// The same bound context; kept as a separate name where a test is about the
// reconciling space (the cross-space guards compare against it).
const CTX_SPACE = CTX;
// The fields every id-scoped write checks: a page of the reconciling
// space in the reconciling workspace.
const IN_SPACE = { workspaceId: 'ws-1', spaceId: 'space-1' };
// A syntactically VALID parent uuid. createPage/movePage now coerce a malformed
// (non-UUID) parentPageId to root (F1), so tests exercising the normal
// pass-through parent path must use a real uuid, not an arbitrary token.
const PARENT_UUID = '11111111-1111-4111-8111-111111111111';

describe('GitmostDataSourceService', () => {
  describe('listSpaceTree', () => {
    it('maps descendants to PageNode and is always complete:true', async () => {
      const { service, mocks } = build();
      mocks.spaceRepo.findById.mockResolvedValue({ id: 'space-1' });
      mocks.pageRepo.getSpaceDescendants.mockResolvedValue([
        {
          id: 'p1',
          slugId: 's1',
          title: 'Root',
          parentPageId: null,
          position: 'a0',
          updatedAt: new Date('2026-10-01T10:00:00.000Z'),
        },
        {
          id: 'p2',
          slugId: 's2',
          title: 'Child',
          parentPageId: 'p1',
          position: 'a1',
          updatedAt: new Date('2026-10-02T11:00:00.000Z'),
        },
      ]);

      const client = service.bind(CTX);
      const res = await client.listSpaceTree('space-1');

      expect(res.complete).toBe(true);
      expect(mocks.pageRepo.getSpaceDescendants).toHaveBeenCalledWith(
        'space-1',
        { includeContent: false },
      );
      expect(res.pages).toEqual([
        {
          id: 'p1',
          slugId: 's1',
          title: 'Root',
          parentPageId: null,
          hasChildren: true, // p2's parent is p1
          position: 'a0',
          // ISO updatedAt from the same query feeds the pull's export key.
          updatedAt: '2026-10-01T10:00:00.000Z',
        },
        {
          id: 'p2',
          slugId: 's2',
          title: 'Child',
          parentPageId: 'p1',
          hasChildren: false,
          position: 'a1',
          updatedAt: '2026-10-02T11:00:00.000Z',
        },
      ]);
    });

    it('throws when the space is not found', async () => {
      const { service, mocks } = build();
      mocks.spaceRepo.findById.mockResolvedValue(undefined);
      await expect(service.bind(CTX).listSpaceTree('nope')).rejects.toThrow();
    });
  });

  // D-P3-1 ghost guard: the pull reconciler asks which candidate-delete ids are
  // REAL page rows before deleting a tracked vault file. Only rows returned here
  // may be absence-deleted; a ghost id (never a page) is preserved.
  describe('pageIdsExist (D-P3-1 ghost guard)', () => {
    const UUID_A = '11111111-1111-4111-8111-111111111111';
    const UUID_B = '22222222-2222-4222-8222-222222222222';

    it('returns the subset that are real page rows, workspace-scoped (any space/state)', async () => {
      // The DB reports only UUID_A exists as a row.
      const { service, mocks } = build([{ id: UUID_A }]);
      const res = await service.bind(CTX).pageIdsExist([UUID_A, UUID_B]);
      expect(res).toEqual([UUID_A]);
      // The query is workspace-scoped and restricted to the candidate ids.
      // Crucially there is NO deletedAt / spaceId filter: a trashed page or a
      // page moved to another space still counts as "exists" (its file is
      // cleaned up), while a ghost has no row (its file is preserved).
      expect(mocks.db.selectFrom).toHaveBeenCalledWith('pages');
      const qb = mocks.db.selectFrom.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('workspaceId', '=', 'ws-1');
      expect(qb.where).toHaveBeenCalledWith('id', 'in', [UUID_A, UUID_B]);
      const filterCols = qb.where.mock.calls.map((c: any[]) => c[0]);
      expect(filterCols).not.toContain('deletedAt');
      expect(filterCols).not.toContain('spaceId');
    });

    it('filters malformed non-UUID ids BEFORE the predicate (and skips the query when none remain)', async () => {
      // A mix of one valid uuid + malformed tokens: only the valid uuid reaches
      // the predicate, so a bad `gitmost_id` cannot trigger a 22P02 that would
      // reject the whole existence probe.
      const { service, mocks } = build([]);
      const res = await service
        .bind(CTX)
        .pageIdsExist([UUID_A, 'not-a-uuid', '[unclosed']);
      const qb = mocks.db.selectFrom.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('id', 'in', [UUID_A]);
      expect(res).toEqual([]);

      // When EVERY candidate is malformed, the query is skipped entirely.
      const { service: s2, mocks: m2 } = build([]);
      const res2 = await s2.bind(CTX).pageIdsExist(['not-a-uuid', '[unclosed']);
      expect(res2).toEqual([]);
      expect(m2.db.selectFrom).not.toHaveBeenCalled();
    });
  });

  describe('getPageJson', () => {
    it('returns the engine page shape with ISO updatedAt + content', async () => {
      const { service, mocks } = build();
      const updatedAt = new Date('2026-06-20T10:00:00.000Z');
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        slugId: 's1',
        title: 'Doc',
        parentPageId: null,
        spaceId: 'space-1',
        updatedAt,
        content: { type: 'doc', content: [] },
        lastUpdatedSource: 'git-sync',
      });

      const res = await service.bind(CTX).getPageJson('p1');
      expect(mocks.pageRepo.findById).toHaveBeenCalledWith('p1', {
        includeContent: true,
      });
      expect(res).toEqual({
        id: 'p1',
        slugId: 's1',
        title: 'Doc',
        parentPageId: null,
        spaceId: 'space-1',
        updatedAt: '2026-06-20T10:00:00.000Z',
        content: { type: 'doc', content: [] },
        lastUpdatedSource: 'git-sync',
      });
    });

    it('throws NotFound when the page does not exist', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue(undefined);
      await expect(service.bind(CTX).getPageJson('gone')).rejects.toThrow(
        /not found/i,
      );
    });
  });

  describe('importPageMarkdown', () => {
    it('parses md, converts to ProseMirror, and routes the body write to the owning instance', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        ...IN_SPACE,
        updatedAt: new Date('2026-06-20T11:00:00.000Z'),
      });

      const res = await service
        .bind(CTX)
        .importPageMarkdown('p1', '# Hello\n\nworld');

      // writeBody routes through writePageBody (NOT openDirectConnection): the
      // merge must run on the instance that owns the live doc so a connected
      // editor converges instead of silently reverting the change. The service
      // user rides on the payload as the responsible author.
      expect(mocks.collabGateway.writePageBody).toHaveBeenCalledTimes(1);
      const [docName, payload] = mocks.collabGateway.writePageBody.mock.calls[0];
      expect(docName).toBe('page.p1');
      expect(payload.userId).toBe('svc-user');
      // A converted ProseMirror doc was passed; no base on a plain import.
      expect(payload.prosemirrorJson).toEqual(
        expect.objectContaining({ type: 'doc' }),
      );
      expect(payload.baseProsemirrorJson).toBeUndefined();

      expect(res.updatedAt).toBe('2026-06-20T11:00:00.000Z');
    });

    it('returns updatedAt:undefined when the page row is gone after the write (stale-read branch)', async () => {
      // The page EXISTS at import time (so the unknown-page guard N1-D1 does not
      // fire), writeBody succeeds, but the POST-write findById returns nothing (e.g.
      // the page was concurrently hard-deleted) -> the optional updatedAt is omitted.
      const { service, mocks } = build();
      mocks.pageRepo.findById
        .mockResolvedValueOnce({
          id: 'p1',
          ...IN_SPACE,
          updatedAt: new Date('2026-06-20T11:00:00.000Z'),
        }) // currentPage (import-time read) exists
        .mockResolvedValue(undefined); // post-write read: page is gone

      const res = await service
        .bind(CTX)
        .importPageMarkdown('p1', '# Hello\n\nworld');

      expect(mocks.collabGateway.writePageBody).toHaveBeenCalledTimes(1);
      expect(res.updatedAt).toBeUndefined();
    });

    it('skips (no writeBody) when the gitmost_id is a valid UUID matching NO page (bug N1-D1)', async () => {
      // A well-formed but stale/foreign id (restore-from-backup, copied file) must
      // NOT fall through to writeBody on a non-existent page (which throws "Page not
      // found" and wedges the space's sync loop). It is skipped as an inert no-op.
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue(undefined);

      const res = await service
        .bind(CTX)
        .importPageMarkdown('019f2500-face-7000-8000-000000000002', '# orphan');

      expect(res).toEqual({});
      expect(mocks.collabGateway.writePageBody).not.toHaveBeenCalled();
    });

    it('a non-empty body over NULL page content is still written', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        ...IN_SPACE,
        updatedAt: new Date('2026-06-20T11:00:00.000Z'),
        content: null,
      });

      await service.bind(CTX).importPageMarkdown('p1', 'first words');

      expect(mocks.collabGateway.writePageBody).toHaveBeenCalledTimes(1);
    });

    // The 2-way path (no base) is covered above; this exercises the THREE-WAY
    // branch that only fires when a `baseMarkdown` is supplied (review #5). The
    // merge dispatch itself now lives in the collab handler (gitSyncWriteBody);
    // here we assert the datasource forwards the base so the owning instance can
    // run the 3-way reconcile.
    describe('with a baseMarkdown (three-way merge)', () => {
      it('forwards the parsed base body so the owning instance can three-way merge', async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          ...IN_SPACE,
          updatedAt: new Date('2026-06-20T11:00:00.000Z'),
        });

        await service
          .bind(CTX)
          .importPageMarkdown('p1', '# Full\n\ngit', '# Base\n\nbase');

        expect(mocks.collabGateway.writePageBody).toHaveBeenCalledTimes(1);
        const [, payload] = mocks.collabGateway.writePageBody.mock.calls[0];
        // Both the incoming body AND the last-synced base were converted and
        // forwarded — proof the 3-way common-ancestor is plumbed through.
        expect(payload.prosemirrorJson).toEqual(
          expect.objectContaining({ type: 'doc' }),
        );
        expect(payload.baseProsemirrorJson).toEqual(
          expect.objectContaining({ type: 'doc' }),
        );
      });
    });

    // The cross-space confused-deputy guard (review S2) fires only when
    // ctx.spaceId is bound. A vault file in space A can carry space B's pageId;
    // without this check the reconciling space could overwrite B's page body — a
    // write it has no authority over. When the resolved page already lives in a
    // DIFFERENT space, the import is SKIPPED (writePageBody not called) and the
    // page's own updatedAt is returned unchanged.
    describe('cross-space guard (ctx.spaceId bound, review S2)', () => {
      it('does NOT call writePageBody when the target page lives in another space', async () => {
        const { service, mocks } = build();
        // The resolved page is in space-2, but the reconciling context is space-1.
        // NON-VACUITY: without the S2 guard the flow would reach writeBody and
        // writePageBody WOULD be called.
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          deletedAt: null,
          workspaceId: 'ws-1',
          spaceId: 'space-2',
          updatedAt: new Date('2026-06-21T09:00:00.000Z'),
          content: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'B body' }] },
            ],
          },
        });

        const res = await service
          .bind(CTX_SPACE)
          .importPageMarkdown('p1', '# Hello\n\nworld');

        // The cross-space page is preserved: no body write happened.
        expect(mocks.collabGateway.writePageBody).not.toHaveBeenCalled();
        // Early-return shape: only the page's own updatedAt is surfaced.
        expect(res).toEqual({ updatedAt: '2026-06-21T09:00:00.000Z' });
      });
    });
  });

  // Bug C9-D1: a vault file with a malformed (non-UUID) `gitmost_id` frontmatter
  // makes the id reach a Postgres `uuid` predicate, which throws error code
  // '22P02'. Left unhandled the push apply records it as a per-cycle failure that
  // never clears -> the whole space's sync loops forever. The bind() seam wraps the
  // id-scoped writes so exactly that error is swallowed as an inert no-op.
  describe('malformed-id guard (bug C9-D1: non-UUID gitmost_id must not wedge sync)', () => {
    const pgInvalidUuid = Object.assign(
      new Error('invalid input syntax for type uuid: "not-a-uuid"'),
      { code: '22P02' },
    );

    it('importPageMarkdown swallows a 22P02 and does NOT write the body', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockRejectedValue(pgInvalidUuid);
      const res = await service
        .bind(CTX)
        .importPageMarkdown('not-a-uuid', '# x');
      expect(res).toEqual({}); // inert no-op, no throw
      expect(mocks.collabGateway.writePageBody).not.toHaveBeenCalled();
    });

    it('deletePage swallows the 22P02 thrown by the uuid predicate (no wedge)', async () => {
      const { service, mocks } = build();
      // The malformed id reaches removePage's `uuid` predicate, which throws 22P02.
      mocks.pageService.removePage.mockRejectedValue(pgInvalidUuid);
      await expect(
        service.bind(CTX).deletePage('not-a-uuid'),
      ).resolves.toBeUndefined();
    });

    it('re-throws a NON-22P02 error (does not mask real failures)', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockRejectedValue(new Error('db down'));
      await expect(
        service.bind(CTX).importPageMarkdown('not-a-uuid', '# x'),
      ).rejects.toThrow('db down');
    });
  });

  describe('createPage', () => {
    // findById that knows a LIVE parent row in space-1 (PARENT_UUID) and returns
    // the freshly created page for any other id (the post-create re-read).
    const findByIdWithLiveParent = async (id: string) =>
      id === PARENT_UUID
        ? { id: PARENT_UUID, spaceId: 'space-1', deletedAt: null }
        : { id: 'new-id', updatedAt: new Date('2026-06-20T12:00:00.000Z') };

    it('creates the shell with git-sync provenance, writes body, returns id', async () => {
      const { service, mocks } = build();
      mocks.pageService.create.mockResolvedValue({ id: 'new-id' });
      mocks.pageRepo.findById.mockImplementation(findByIdWithLiveParent);

      const res = await service
        .bind(CTX)
        .createPage('Title', 'body md', 'space-1', PARENT_UUID);

      expect(mocks.pageService.create).toHaveBeenCalledWith(
        'svc-user',
        'ws-1',
        { spaceId: 'space-1', title: 'Title', parentPageId: PARENT_UUID },
        { actor: 'git-sync', aiChatId: null },
      );
      expect(mocks.collabGateway.writePageBody).toHaveBeenCalledWith(
        'page.new-id',
        expect.objectContaining({ userId: 'svc-user' }),
        expect.any(AbortSignal),
      );
      expect(res).toEqual({
        data: { id: 'new-id' },
        updatedAt: '2026-06-20T12:00:00.000Z',
      });
    });

    it('folder-note scenario: an EMPTY folder note gets its (empty) body write, and its child lands under it', async () => {
      // git: Folder/Folder.md (empty) + Folder/Child.md. The empty folder note's
      // body is written too (the write stores the editor's shape, so opening the
      // page is not an edit); a fresh shell accepts an empty no-base write.
      const { service, mocks } = build();
      const FOLDER_ID = '22222222-2222-4222-8222-222222222222';
      mocks.pageService.create
        .mockResolvedValueOnce({ id: FOLDER_ID })
        .mockResolvedValueOnce({ id: 'child-id' });
      mocks.pageRepo.findById.mockImplementation(async (id: string) =>
        id === FOLDER_ID
          ? {
              id: FOLDER_ID,
              spaceId: 'space-1',
              deletedAt: null,
              updatedAt: new Date('2026-06-20T12:00:00.000Z'),
            }
          : { id, updatedAt: new Date('2026-06-20T12:00:00.000Z') },
      );
      const folder = await service
        .bind(CTX)
        .createPage('Folder', '', 'space-1');
      const child = await service
        .bind(CTX)
        .createPage('Child', 'child body', 'space-1', folder.data.id);

      expect(folder.data.id).toBe(FOLDER_ID);
      expect(child.data.id).toBe('child-id');
      expect(mocks.pageService.create).toHaveBeenNthCalledWith(
        2,
        'svc-user',
        'ws-1',
        { spaceId: 'space-1', title: 'Child', parentPageId: FOLDER_ID },
        { actor: 'git-sync', aiChatId: null },
      );
      // Both bodies were written, the folder's empty one first.
      expect(
        mocks.collabGateway.writePageBody.mock.calls.map((c: any[]) => c[0]),
      ).toEqual([`page.${FOLDER_ID}`, 'page.child-id']);
    });

    it('returns updatedAt:undefined when the fresh page row is missing after create', async () => {
      const { service, mocks } = build();
      mocks.pageService.create.mockResolvedValue({ id: 'new-id' });
      // The post-create findById returns nothing -> the optional updatedAt is
      // omitted (the id is still returned from create()).
      mocks.pageRepo.findById.mockResolvedValue(undefined);

      const res = await service
        .bind(CTX)
        .createPage('Title', 'body md', 'space-1');

      expect(res).toEqual({ data: { id: 'new-id' }, updatedAt: undefined });
    });

    // A parent folder-note carrying a broken non-UUID `gitmost_id` makes the push
    // planner hand createPage a malformed parentPageId. Passed through, it would
    // reach pageService.create -> findById (slugId fallback -> no row) ->
    // NotFoundException, a throw that never clears the push `failures` set and
    // wedges the WHOLE space. createPage COERCES the malformed parent to root
    // (undefined), asserted on the mocked pageService.create below.
    it('coerces a malformed (non-UUID) parentPageId to root and does NOT wedge (F1)', async () => {
      const { service, mocks } = build();
      mocks.pageService.create.mockResolvedValue({ id: 'new-id' });
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'new-id',
        updatedAt: new Date('2026-06-20T12:00:00.000Z'),
      });

      const res = await service
        .bind(CTX)
        .createPage('Title', 'body md', 'space-1', '[unclosed-broken-id');

      // No throw propagated to `failures`; create ran with the parent coerced to
      // root (undefined), NOT the malformed string — so create's findById /
      // nextPagePosition never see a non-uuid and cannot 22P02 / NotFound.
      expect(mocks.pageService.create).toHaveBeenCalledWith(
        'svc-user',
        'ws-1',
        { spaceId: 'space-1', title: 'Title', parentPageId: undefined },
        { actor: 'git-sync', aiChatId: null },
      );
      expect(res).toEqual({
        data: { id: 'new-id' },
        updatedAt: '2026-06-20T12:00:00.000Z',
      });
    });

    it('leaves a VALID uuid parentPageId unchanged (only a malformed parent is coerced)', async () => {
      const { service, mocks } = build();
      mocks.pageService.create.mockResolvedValue({ id: 'new-id' });
      mocks.pageRepo.findById.mockImplementation(findByIdWithLiveParent);

      await service
        .bind(CTX)
        .createPage('Title', 'body md', 'space-1', PARENT_UUID);

      // A real uuid of a live parent in the space is forwarded untouched.
      expect(mocks.pageService.create).toHaveBeenCalledWith(
        'svc-user',
        'ws-1',
        { spaceId: 'space-1', title: 'Title', parentPageId: PARENT_UUID },
        { actor: 'git-sync', aiChatId: null },
      );
    });

    // Well-formed variant of F1: a VALID uuid parent that is not a live page of
    // the target space made pageService.create throw NotFound("Parent page not
    // found") on every cycle — a per-page push failure that never cleared. The
    // fix coerces it to root (with a WARN). NON-VACUITY: against the unfixed
    // createPage, create would be called with parentPageId: PARENT_UUID.
    it.each([
      ['does not exist', undefined],
      [
        'is trashed',
        { id: PARENT_UUID, spaceId: 'space-1', deletedAt: new Date() },
      ],
      [
        'lives in another space',
        { id: PARENT_UUID, spaceId: 'space-2', deletedAt: null },
      ],
    ])(
      'coerces a valid-uuid parentPageId that %s to root, with a WARN',
      async (_case, parentRow) => {
        const { service, mocks } = build();
        const warn = jest
          .spyOn((service as any).logger, 'warn')
          .mockImplementation(() => undefined);
        mocks.pageService.create.mockResolvedValue({ id: 'new-id' });
        mocks.pageRepo.findById.mockImplementation(async (id: string) =>
          id === PARENT_UUID
            ? parentRow
            : { id: 'new-id', updatedAt: new Date('2026-06-20T12:00:00.000Z') },
        );

        const res = await service
          .bind(CTX_SPACE)
          .createPage('Title', 'body md', 'space-1', PARENT_UUID);

        expect(mocks.pageRepo.findById).toHaveBeenCalledWith(PARENT_UUID);
        expect(mocks.pageService.create).toHaveBeenCalledWith(
          'svc-user',
          'ws-1',
          { spaceId: 'space-1', title: 'Title', parentPageId: undefined },
          { actor: 'git-sync', aiChatId: null },
        );
        expect(res.data.id).toBe('new-id');
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`parentPageId '${PARENT_UUID}'`),
        );
      },
    );
  });

  describe('deletePage', () => {
    it('uses the soft-delete path (removePage), not a force delete', async () => {
      const { service, mocks } = build();
      await service.bind(CTX).deletePage('p1');
      // Passes git-sync provenance so the soft-delete stamps
      // lastUpdatedSource='git-sync' (loop-guard).
      expect(mocks.pageService.removePage).toHaveBeenCalledWith(
        'p1',
        'svc-user',
        'ws-1',
        { actor: 'git-sync', aiChatId: null },
      );
      // No forceDelete on the service surface used here.
      expect((mocks.pageService as any).forceDelete).toBeUndefined();
    });

    // The cross-space MOVE guard re-reads the page and SKIPS the soft-delete when
    // the page has already moved to a DIFFERENT space (otherwise a move-out would
    // trash the page from both vaults).
    describe('cross-space move guard', () => {
      it("skips removePage when the page moved to another space (move-out)", async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          deletedAt: null,
          workspaceId: 'ws-1',
          spaceId: 'space-2',
        });

        const res = await service.bind(CTX_SPACE).deletePage('p1');

        // The page still lives in space-2 — it must NOT be trashed.
        expect(mocks.pageService.removePage).not.toHaveBeenCalled();
        expect(res).toEqual({ id: 'p1', skipped: 'moved-to-other-space' });
      });

      it('soft-deletes when the page is still in the reconciling space (genuine delete)', async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          deletedAt: null,
          ...IN_SPACE,
        });

        await service.bind(CTX_SPACE).deletePage('p1');

        // Same space -> a real deletion; removePage runs with git-sync provenance.
        expect(mocks.pageService.removePage).toHaveBeenCalledWith(
          'p1',
          'svc-user',
          'ws-1',
          { actor: 'git-sync', aiChatId: null },
        );
      });

      it('soft-deletes when the page row is not found (guard must not swallow a real delete)', async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue(undefined);

        await service.bind(CTX_SPACE).deletePage('p1');

        expect(mocks.pageService.removePage).toHaveBeenCalledWith(
          'p1',
          'svc-user',
          'ws-1',
          { actor: 'git-sync', aiChatId: null },
        );
      });

      it('soft-deletes when the page is already soft-deleted (deletedAt non-null)', async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          deletedAt: new Date('2026-06-20T10:00:00.000Z'),
          workspaceId: 'ws-1',
          spaceId: 'space-2',
        });

        await service.bind(CTX_SPACE).deletePage('p1');

        // deletedAt is non-null -> not treated as a live move-out; removePage runs.
        expect(mocks.pageService.removePage).toHaveBeenCalledWith(
          'p1',
          'svc-user',
          'ws-1',
          { actor: 'git-sync', aiChatId: null },
        );
      });
    });
  });

  describe('movePage', () => {
    it('computes a fractional position when none is supplied', async () => {
      // db query returns a last sibling at 'a0' -> jittered key after it.
      const { service, mocks } = build([{ position: 'a0' }]);
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        ...IN_SPACE,
      });

      await service.bind(CTX).movePage('p1', PARENT_UUID);

      expect(mocks.pageService.movePage).toHaveBeenCalledTimes(1);
      const [dto, page, provenance, actorUserId] =
        mocks.pageService.movePage.mock.calls[0];
      expect(dto.pageId).toBe('p1');
      expect(dto.parentPageId).toBe(PARENT_UUID);
      expect(typeof dto.position).toBe('string');
      expect(dto.position.length).toBeGreaterThan(0);
      expect(page).toEqual({ id: 'p1', ...IN_SPACE });
      expect(provenance).toEqual({ actor: 'git-sync', aiChatId: null });
      // The git-initiated move is attributed to the service user (lastUpdatedById
      // parity with create/delete/rename).
      expect(actorUserId).toBe('svc-user');
    });

    it('passes through an explicit position unchanged', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        ...IN_SPACE,
      });

      await service.bind(CTX).movePage('p1', null, 'zz');
      const [dto] = mocks.pageService.movePage.mock.calls[0];
      expect(dto.position).toBe('zz');
      // db not consulted for a supplied position.
      expect(mocks.db.selectFrom).not.toHaveBeenCalled();
    });

    it('skips (cross-space) and moves nothing when the page does not exist', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue(undefined);
      await expect(
        service.bind(CTX).movePage('gone', 'parent-1'),
      ).resolves.toEqual({ id: 'gone', skipped: 'cross-space' });
      expect(mocks.pageService.movePage).not.toHaveBeenCalled();
    });

    // Mirror of the createPage case. A malformed
    // (non-UUID) destination parentPageId would reach computeMovePosition's raw
    // uuid predicate (22P02, swallowed but mis-logged) or — when a position is
    // supplied — pageService.movePage's findById -> NotFoundException (NOT a
    // 22P02, so NOT swallowed -> the space wedges). movePage coerces it to root
    // (null). The page here has a current parent, so coerced-root != current
    // parent and the echo-guard does not short-circuit — the move proceeds
    // against a null (root) parent (`dto.parentPageId === null`).
    it('coerces a malformed (non-UUID) parentPageId to root and does NOT wedge (F1)', async () => {
      const { service, mocks } = build([]); // no siblings -> fresh position key
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        ...IN_SPACE,
        parentPageId: '22222222-2222-4222-8222-222222222222',
      });

      await service.bind(CTX).movePage('p1', '[broken-parent');

      expect(mocks.pageService.movePage).toHaveBeenCalledTimes(1);
      const [dto] = mocks.pageService.movePage.mock.calls[0];
      expect(dto.pageId).toBe('p1');
      // Coerced to root: the malformed parent never reaches the uuid predicate.
      expect(dto.parentPageId).toBeNull();
      expect(typeof dto.position).toBe('string');
    });

    // Well-formed variant (same hole as createPage): pageService.movePage throws
    // NotFound for a NEW parent that is missing / trashed / in another space, so
    // the move failed every cycle forever. Coerced to root with a WARN instead.
    it.each([
      ['does not exist', undefined],
      [
        'is trashed',
        { id: PARENT_UUID, spaceId: 'space-1', deletedAt: new Date() },
      ],
      [
        'lives in another space',
        { id: PARENT_UUID, spaceId: 'space-2', deletedAt: null },
      ],
    ])(
      'coerces a valid-uuid destination parent that %s to root, with a WARN',
      async (_case, parentRow) => {
        const { service, mocks } = build([]);
        const warn = jest
          .spyOn((service as any).logger, 'warn')
          .mockImplementation(() => undefined);
        mocks.pageRepo.findById.mockImplementation(async (id: string) =>
          id === PARENT_UUID
            ? parentRow
            : {
                id: 'p1',
                ...IN_SPACE,
                parentPageId: '22222222-2222-4222-8222-222222222222',
              },
        );

        await service.bind(CTX_SPACE).movePage('p1', PARENT_UUID);

        expect(mocks.pageService.movePage).toHaveBeenCalledTimes(1);
        const [dto] = mocks.pageService.movePage.mock.calls[0];
        expect(dto.parentPageId).toBeNull();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`parentPageId '${PARENT_UUID}'`),
        );
      },
    );

    it('does not validate an UNCHANGED parent (movePage does not either; echo guard skips)', async () => {
      const { service, mocks } = build([]);
      // The page's current parent is PARENT_UUID and that row is gone: an echo
      // move to the same parent must stay a no-op, not be re-rooted.
      mocks.pageRepo.findById.mockImplementation(async (id: string) =>
        id === 'p1'
          ? { id: 'p1', ...IN_SPACE, parentPageId: PARENT_UUID }
          : undefined,
      );

      const res = await service.bind(CTX_SPACE).movePage('p1', PARENT_UUID);

      expect(res).toEqual({ id: 'p1', skipped: 'no-op-move-echo' });
      expect(mocks.pageService.movePage).not.toHaveBeenCalled();
      expect(mocks.pageRepo.findById).not.toHaveBeenCalledWith(PARENT_UUID);
    });
  });

  describe('renamePage', () => {
    it('updates only the title with git-sync provenance', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        ...IN_SPACE,
        title: 'old',
      });

      await service.bind(CTX).renamePage('p1', 'new title');

      const [page, dto, user, provenance] =
        mocks.pageService.update.mock.calls[0];
      expect(page).toEqual({ id: 'p1', ...IN_SPACE, title: 'old' });
      expect(dto.title).toBe('new title');
      expect(user).toEqual({ id: 'svc-user' });
      expect(provenance).toEqual({ actor: 'git-sync', aiChatId: null });
    });

    it("strips the ` ~<slugId>` disambiguation suffix when it matches the page's OWN slugId", async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        ...IN_SPACE,
        slugId: 's1',
        title: 'old',
      });

      await service.bind(CTX).renamePage('p1', 'Real Title ~s1');

      const [, dto] = mocks.pageService.update.mock.calls[0];
      // The trailing ` ~s1` equals this page's own slugId -> a vault artifact; strip.
      expect(dto.title).toBe('Real Title');
    });

    it('leaves a FOREIGN ` ~<slugId>` tail untouched (only the own slugId is stripped)', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        ...IN_SPACE,
        slugId: 's1',
        title: 'old',
      });

      await service.bind(CTX).renamePage('p1', 'Real Title ~other');

      const [, dto] = mocks.pageService.update.mock.calls[0];
      // ` ~other` is not this page's slugId -> a genuine title; must not be corrupted.
      expect(dto.title).toBe('Real Title ~other');
    });

    it('skips (cross-space) and renames nothing when the page does not exist', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue(undefined);
      await expect(
        service.bind(CTX).renamePage('gone', 'whatever'),
      ).resolves.toEqual({ id: 'gone', skipped: 'cross-space' });
      expect(mocks.pageService.update).not.toHaveBeenCalled();
    });
  });

  describe('restorePage', () => {
    it('restores via the repo restore path scoped to the workspace', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        ...IN_SPACE,
        deletedAt: new Date('2026-06-20T10:00:00.000Z'),
      });
      const res = await service.bind(CTX).restorePage('p1');
      // Stamps lastUpdatedSource='git-sync' on restore (loop-guard).
      expect(mocks.pageRepo.restorePage).toHaveBeenCalledWith(
        'p1',
        'ws-1',
        'git-sync',
      );
      expect(res).toEqual({ id: 'p1' });
    });
  });

  // A vault file of space A can carry the gitmost_id of a page in space B or in
  // another workspace. Every id-scoped write must leave such a page alone:
  // PageService runs these writes as the service user, without CASL.
  describe('foreign-page guard: id-scoped writes never touch a page of another space or workspace', () => {
    const OTHER_SPACE = {
      id: 'pB',
      workspaceId: 'ws-1',
      spaceId: 'space-2',
      slugId: 'sB',
      title: 'B title',
      parentPageId: null,
      deletedAt: null,
      updatedAt: new Date('2026-06-21T09:00:00.000Z'),
      content: null,
    };
    const OTHER_WORKSPACE = {
      ...OTHER_SPACE,
      workspaceId: 'ws-2',
      spaceId: 'space-1',
    };

    // NON-VACUITY: the title differs from the page's and the move carries an
    // explicit position, so without the guard both writes WOULD reach
    // pageService.update / pageService.movePage.
    it('an R-commit naming a page of another space neither renames nor moves it', async () => {
      const { service, mocks } = build([]);
      mocks.pageRepo.findById.mockResolvedValue(OTHER_SPACE);
      const client = service.bind(CTX);

      await expect(client.renamePage('pB', 'Bar')).resolves.toEqual({
        id: 'pB',
        skipped: 'cross-space',
      });
      await expect(client.movePage('pB', null, 'zz')).resolves.toEqual({
        id: 'pB',
        skipped: 'cross-space',
      });

      expect(mocks.pageService.update).not.toHaveBeenCalled();
      expect(mocks.pageService.movePage).not.toHaveBeenCalled();
    });

    it.each([
      ['another space', OTHER_SPACE],
      ['another workspace', OTHER_WORKSPACE],
    ])(
      'leaves a page of %s untouched on rename, move, restore and import',
      async (_case, row) => {
        const { service, mocks } = build([]);
        mocks.pageRepo.findById.mockResolvedValue(row);
        const client = service.bind(CTX);

        await client.renamePage('pB', 'Bar');
        await client.movePage('pB', null, 'zz');
        await client.restorePage('pB');
        await client.importPageMarkdown('pB', 'new body');

        expect(mocks.pageService.update).not.toHaveBeenCalled();
        expect(mocks.pageService.movePage).not.toHaveBeenCalled();
        expect(mocks.pageRepo.restorePage).not.toHaveBeenCalled();
        expect(mocks.collabGateway.writePageBody).not.toHaveBeenCalled();
      },
    );

    it('deletePage leaves a page of another workspace untouched', async () => {
      const { service, mocks } = build([]);
      mocks.pageRepo.findById.mockResolvedValue(OTHER_WORKSPACE);

      await expect(service.bind(CTX).deletePage('pB')).resolves.toEqual({
        id: 'pB',
        skipped: 'cross-space',
      });
      expect(mocks.pageService.removePage).not.toHaveBeenCalled();
    });

    it('restorePage skips a page id that matches no page', async () => {
      const { service, mocks } = build([]);
      mocks.pageRepo.findById.mockResolvedValue(undefined);

      await expect(service.bind(CTX).restorePage('gone')).resolves.toEqual({
        id: 'gone',
        skipped: 'cross-space',
      });
      expect(mocks.pageRepo.restorePage).not.toHaveBeenCalled();
    });
  });

  // Every datasource call honours the cycle's abort signal (lost lock or cycle
  // deadline), and a body write is awaited for a bounded time only.
  describe('cycle abort and body-write deadline', () => {
    const LIVE_PAGE = {
      id: 'p1',
      ...IN_SPACE,
      deletedAt: null,
      updatedAt: new Date('2026-06-20T11:00:00.000Z'),
      content: null,
    };

    /** Let queued promise continuations run until `cond` holds. */
    async function until(cond: () => boolean): Promise<void> {
      for (let i = 0; i < 100 && !cond(); i++) await Promise.resolve();
      expect(cond()).toBe(true);
    }

    it('an aborted cycle signal stops every client call before it touches anything', async () => {
      const { service, mocks } = build([]);
      const controller = new AbortController();
      const reason = new Error('cycle deadline');
      controller.abort(reason);
      const client = service.bind({ ...CTX, signal: controller.signal });

      await expect(client.getPageJson('p1')).rejects.toBe(reason);
      await expect(client.importPageMarkdown('p1', 'x')).rejects.toBe(reason);
      await expect(client.createPage('T', 'x', 'space-1')).rejects.toBe(reason);
      await expect(client.renamePage('p1', 'X')).rejects.toBe(reason);
      await expect(client.movePage('p1', null, 'zz')).rejects.toBe(reason);
      await expect(client.deletePage('p1')).rejects.toBe(reason);

      expect(mocks.pageRepo.findById).not.toHaveBeenCalled();
      expect(mocks.pageService.create).not.toHaveBeenCalled();
      expect(mocks.pageService.removePage).not.toHaveBeenCalled();
      expect(mocks.collabGateway.writePageBody).not.toHaveBeenCalled();
    });

    it('stops waiting for a body write that does not finish in time, with a specific error', async () => {
      jest.useFakeTimers();
      try {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue(LIVE_PAGE);
        // The owning instance never answers.
        mocks.collabGateway.writePageBody.mockImplementation(
          () => new Promise(() => undefined),
        );

        const pending = service.bind(CTX).importPageMarkdown('p1', 'new body');
        const outcome = expect(pending).rejects.toThrow(
          `page.p1 did not finish within ${GIT_SYNC_BODY_WRITE_TIMEOUT_MS} ms`,
        );
        await until(
          () => mocks.collabGateway.writePageBody.mock.calls.length > 0,
        );
        await jest.advanceTimersByTimeAsync(GIT_SYNC_BODY_WRITE_TIMEOUT_MS);
        await outcome;
      } finally {
        jest.useRealTimers();
      }
    });

    it('stops waiting for a body write as soon as the cycle is aborted, and logs a later failure of that write', async () => {
      const { service, mocks } = build();
      const error = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation(() => undefined);
      mocks.pageRepo.findById.mockResolvedValue(LIVE_PAGE);
      let failWrite!: (err: Error) => void;
      mocks.collabGateway.writePageBody.mockImplementation(
        () =>
          new Promise((_, reject) => {
            failWrite = reject;
          }),
      );
      const controller = new AbortController();

      const pending = service
        .bind({ ...CTX, signal: controller.signal })
        .importPageMarkdown('p1', 'new body');
      await until(
        () => mocks.collabGateway.writePageBody.mock.calls.length > 0,
      );
      const reason = new Error('lock lost');
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);

      // The write fails later, with no awaiter left: logged, not unhandled.
      failWrite(new Error('merge exploded'));
      await until(() => error.mock.calls.length > 0);
      expect(String(error.mock.calls[0][0])).toContain('merge exploded');
      expect(String(error.mock.calls[0][0])).toContain('page.p1');
    });
  });

  // Continuous-sync methods: not called by the engine but wired into the
  // GitSyncClient seam. Exercised via the bound client.
  describe('listRecentSince', () => {
    it('queries non-deleted pages newest-first and ISO-stringifies updatedAt', async () => {
      const rows = [
        {
          id: 'p1',
          slugId: 's1',
          title: 'A',
          parentPageId: null,
          spaceId: 'space-1',
          updatedAt: new Date('2026-06-20T10:00:00.000Z'),
        },
      ];
      const { service, mocks } = build(rows);
      const qb = mocks.db.selectFrom.mock.results; // populated after the call

      const out = (await service
        .bind(CTX)
        .listRecentSince('space-1', '2026-06-19T00:00:00.000Z', 100)) as any[];

      // Query builder shaped against the `pages` table with the expected chain.
      expect(mocks.db.selectFrom).toHaveBeenCalledWith('pages');
      const builder = qb[0].value;
      expect(builder.select).toHaveBeenCalled();
      expect(builder.orderBy).toHaveBeenCalledWith('updatedAt', 'desc');
      // deletedAt is null + the conditional spaceId / since / cap clauses.
      const whereArgs = builder.where.mock.calls.map((c: any[]) => c[0]);
      expect(whereArgs).toContain('deletedAt');
      expect(whereArgs).toContain('spaceId');
      expect(whereArgs).toContain('updatedAt');
      expect(builder.limit).toHaveBeenCalledWith(100);

      expect(out).toEqual([
        {
          id: 'p1',
          slugId: 's1',
          title: 'A',
          parentPageId: null,
          spaceId: 'space-1',
          updatedAt: '2026-06-20T10:00:00.000Z',
        },
      ]);
    });

    it('omits the spaceId / since / cap clauses when not supplied', async () => {
      const { service, mocks } = build([]);

      await service.bind(CTX).listRecentSince(undefined, null);

      const builder = mocks.db.selectFrom.mock.results[0].value;
      const whereArgs = builder.where.mock.calls.map((c: any[]) => c[0]);
      // Only the deletedAt-is-null guard; no spaceId / updatedAt> clauses.
      expect(whereArgs).toEqual(['deletedAt']);
      expect(builder.limit).not.toHaveBeenCalled();
    });
  });

  describe('listTrash', () => {
    it('queries soft-deleted pages and ISO-stringifies deletedAt (null stays null)', async () => {
      const rows = [
        {
          id: 'p1',
          slugId: 's1',
          title: 'Trashed',
          parentPageId: null,
          spaceId: 'space-1',
          deletedAt: new Date('2026-06-21T09:00:00.000Z'),
        },
        {
          id: 'p2',
          slugId: 's2',
          title: 'NoDate',
          parentPageId: null,
          spaceId: 'space-1',
          deletedAt: null,
        },
      ];
      const { service, mocks } = build(rows);

      const out = (await service.bind(CTX).listTrash('space-1')) as any[];

      expect(mocks.db.selectFrom).toHaveBeenCalledWith('pages');
      const builder = mocks.db.selectFrom.mock.results[0].value;
      const whereCalls = builder.where.mock.calls;
      // deletedAt is-not null (the trash predicate) + spaceId filter.
      expect(whereCalls).toContainEqual(['deletedAt', 'is not', null]);
      expect(whereCalls).toContainEqual(['spaceId', '=', 'space-1']);
      expect(builder.orderBy).toHaveBeenCalledWith('deletedAt', 'desc');

      expect(out[0].deletedAt).toBe('2026-06-21T09:00:00.000Z');
      expect(out[1].deletedAt).toBeNull();
    });
  });
});
