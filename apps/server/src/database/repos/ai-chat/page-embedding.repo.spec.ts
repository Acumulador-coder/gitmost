import { PageEmbeddingRepo } from './page-embedding.repo';
import type { KyselyDB } from '../../types/kysely.types';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

/**
 * Unit test for the pure access-scoping branch of searchByEmbedding: when the
 * caller has NO accessible spaces (`spaceIds` empty), the method must early-
 * return [] WITHOUT touching the database. We inject a db whose query builder
 * throws if invoked, so any DB access fails the test.
 *
 * NOTE: the dimension-mixing case (filter by model_dimensions) needs a live
 * pgvector-enabled Postgres and is intentionally NOT covered here — it requires
 * a real DB and is out of scope for this pure unit test.
 */
describe('PageEmbeddingRepo.searchByEmbedding', () => {
  it('early-returns [] for empty spaceIds without any DB call', async () => {
    const throwingDb = {
      selectFrom: () => {
        throw new Error('DB should not be queried for empty spaceIds');
      },
    } as unknown as KyselyDB;

    const repo = new PageEmbeddingRepo(throwingDb);
    const result = await repo.searchByEmbedding(
      'ws-1',
      [0.1, 0.2, 0.3],
      [],
      10,
    );
    expect(result).toEqual([]);
  });
});

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
