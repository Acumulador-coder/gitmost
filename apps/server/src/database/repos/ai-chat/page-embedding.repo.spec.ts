import {
  PAGE_EMBEDDING_INSERT_BATCH_ROWS,
  PageEmbeddingRepo,
  PageEmbeddingChunkRow,
} from './page-embedding.repo';
import type { KyselyDB } from '../../types/kysely.types';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

/**
 * Recording Kysely (DummyDriver wired to the Postgres query compiler): compiles
 * queries to SQL + bound parameters without a live database, so we can assert the
 * shape of the SQL the repo emits. Mirrors the pattern used by
 * page.repo.embeddable.spec.ts.
 */
function makeRecordingDb() {
  const compiled: { sql: string; parameters: readonly unknown[] }[] = [];
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new (class extends DummyDriver {
          async acquireConnection() {
            return {
              executeQuery: async (q: {
                sql: string;
                parameters: readonly unknown[];
              }) => {
                compiled.push({ sql: q.sql, parameters: q.parameters });
                return { rows: [] };
              },
              // eslint-disable-next-line @typescript-eslint/no-empty-function
              streamQuery: async function* () {},
            } as any;
          }
        })(),
      createIntrospector: (d: Kysely<any>) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, compiled };
}

/**
 * #599 — FINGERPRINT-SCOPED deleteByPage. The indexer's delete+insert replace must
 * only ever remove the generation it is REWRITING while a swap is in flight;
 * removing every row of the page would delete its ACTIVE-generation rows too and
 * drop the page out of semantic search for the whole reindex window (acceptance 3).
 * The PURGE paths (page deleted / emptied) keep the unscoped behaviour.
 */
describe('PageEmbeddingRepo.deleteByPage fingerprint scope (#599)', () => {
  it('adds a fingerprint IN (...) predicate when a scope is supplied', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await repo.deleteByPage('page-1', 'ws-1', undefined, ['fp-target']);

    expect(compiled).toHaveLength(1);
    const { sql, parameters } = compiled[0];
    // NOTE: the recording Kysely has no camelCase plugin, so identifiers compile
    // as the TS names ("pageEmbeddings"); the real app maps them to snake_case.
    expect(sql).toMatch(/delete from "pageEmbeddings"/i);
    expect(sql).toMatch(/"fingerprint" in \(\$\d+\)/i);
    expect(parameters).toContain('fp-target');
  });

  it('deletes EVERY row of the page when no scope is supplied (purge path)', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await repo.deleteByPage('page-1', 'ws-1');

    expect(compiled).toHaveLength(1);
    // No fingerprint predicate at all -> every generation of this page is purged.
    expect(compiled[0].sql).not.toMatch(/fingerprint/i);
  });
});

/**
 * #599 — the GENERATIONAL GC. `deleteOtherGenerations` must reclaim every row that
 * belongs to neither of the kept generations, INCLUDING legacy NULL-fingerprint
 * rows: `fingerprint NOT IN (...)` alone evaluates to NULL (not true) for them, so
 * they would survive forever without the explicit `IS NULL` arm.
 */
describe('PageEmbeddingRepo.deleteOtherGenerations (#599)', () => {
  it('deletes rows outside the kept generations AND the legacy NULL-fingerprint rows', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await repo.deleteOtherGenerations('ws-1', ['fp-active', 'fp-target']);

    expect(compiled).toHaveLength(1);
    const { sql, parameters } = compiled[0];
    expect(sql).toMatch(/delete from "pageEmbeddings"/i);
    expect(sql).toMatch(/"workspaceId" = \$\d+/i);
    // Both generations are kept...
    expect(sql).toMatch(/"fingerprint" not in \(\$\d+, \$\d+\)/i);
    // ...and NULL rows (a very old generation) are explicitly reclaimed.
    expect(sql).toMatch(/"fingerprint" is null/i);
    expect(parameters).toContain('fp-active');
    expect(parameters).toContain('fp-target');
  });

  /**
   * #599 (review F3) — an EMPTY `keep` must FAIL CLOSED.
   *
   * The guard used to be inverted: with `kept.length === 0` the fingerprint
   * predicate was DROPPED, leaving `DELETE FROM page_embeddings WHERE workspace_id
   * = $1` — a full wipe of the workspace's vector index, the generation currently
   * serving search included. It is unreachable from today's two call sites (both
   * pass a resolved sha256 fingerprint), but "unreachable" is exactly the state a
   * refactor changes, and the defensive branch of a bulk DELETE must be the SAFE
   * one: an empty keep-set can only mean the caller lost its fingerprints, never
   * "purge everything" (that is deleteByWorkspace).
   */
  it('review F3 — an EMPTY keep set deletes NOTHING (fail-closed, not a full wipe)', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await expect(repo.deleteOtherGenerations('ws-1', [])).resolves.toBe(0);

    // NON-VACUITY: restore the old `if (kept.length > 0)` wrapper (fail-open) and
    // this reddens — a DELETE with no fingerprint predicate is compiled and every
    // embedding row of the workspace goes.
    expect(compiled).toHaveLength(0);
  });

  it('review F3 — a keep set of only blank/invalid entries is empty too, and still deletes NOTHING', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    // The filter drops non-strings/blanks; what survives is [] -> fail closed.
    await expect(
      repo.deleteOtherGenerations('ws-1', ['', null as unknown as string]),
    ).resolves.toBe(0);

    expect(compiled).toHaveLength(0);
  });
});

/**
 * AI-6 — every row binds 12 parameters and Postgres rejects a statement with more
 * than 65,535, so one multi-row INSERT failed for a page of 5,462+ chunks (after
 * every provider call was paid for). insertChunks must split the rows into
 * batches that each stay under the limit, keep their order, and stay atomic.
 */
describe('PageEmbeddingRepo.insertChunks batching (AI-6)', () => {
  const PG_MAX_PARAMS = 65_535;

  function rows(n: number): PageEmbeddingChunkRow[] {
    return Array.from({ length: n }, (_, i) => ({
      pageId: 'page-1',
      workspaceId: 'ws-1',
      spaceId: 'space-1',
      attachmentId: null,
      chunkIndex: i,
      chunkStart: i * 10,
      chunkLength: 10,
      content: `chunk ${i}`,
      modelName: 'm',
      modelDimensions: 2,
      fingerprint: 'fp',
      embedding: [0.1, 0.2],
    }));
  }

  it('splits a 6,000-chunk page into INSERTs that each bind fewer than 65,535 parameters, in order', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await repo.insertChunks(rows(6000));

    const inserts = compiled.filter((q) => /^insert into/i.test(q.sql));
    expect(inserts).toHaveLength(Math.ceil(6000 / PAGE_EMBEDDING_INSERT_BATCH_ROWS));
    for (const q of inserts) {
      expect(q.parameters.length).toBeLessThan(PG_MAX_PARAMS);
    }
    // Every row is inserted exactly once, in the caller's order: the chunkIndex
    // values bound across all batches are 0..5999.
    const perRow = inserts[0].parameters.length / PAGE_EMBEDDING_INSERT_BATCH_ROWS;
    const chunkIndexes = inserts.flatMap((q) =>
      q.parameters.filter((_, i) => i % perRow === 4),
    );
    expect(chunkIndexes).toEqual(Array.from({ length: 6000 }, (_, i) => i));
  });

  it('wraps the batches in a transaction of its own when the caller passes none', async () => {
    const { db } = makeRecordingDb();
    const transaction = jest.spyOn(db, 'transaction');
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await repo.insertChunks(rows(PAGE_EMBEDDING_INSERT_BATCH_ROWS + 1));

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('keeps a page that fits in one batch to a single INSERT', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await repo.insertChunks(rows(3));

    expect(compiled).toHaveLength(1);
    expect(compiled[0].sql).toMatch(/^insert into "pageEmbeddings"/i);
  });
});
