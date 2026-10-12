import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { RawBuilder, sql } from 'kysely';
import * as pgvector from 'pgvector';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';

/**
 * Repository for `page_embeddings` — the pgvector store backing the AI agent's
 * semantic search.
 *
 * The `embedding` column is a dimension-agnostic pgvector `vector` (no fixed
 * `(N)`, see migration 20260617T140000), which is NOT a native Kysely column
 * type, so every read/write of a vector is serialized with the `pgvector` npm
 * helper (`pgvector.toSql(number[])` → a `'[1,2,3]'` text literal) and cast back
 * to `vector` via a raw `::vector` SQL cast. Reindex is a HARD delete + insert
 * (see `deleteByPage`) so search never returns stale vectors.
 *
 * TRADE-OFF: a dimension-agnostic column cannot carry an HNSW/ivfflat ANN index
 * (those require a fixed dimension), so the vector arm (`vectorCandidateArm`) is
 * a sequential scan with the `<=>` cosine operator. Fine at wiki scale; re-add an
 * HNSW index if a single embedding dimension is ever pinned per deployment.
 */

/** A single chunk row to persist for a page (page-body embeddings). */
export interface PageEmbeddingChunkRow {
  pageId: string;
  workspaceId: string;
  spaceId: string;
  // null for page-body chunks; set only for attachment chunks (future).
  attachmentId: string | null;
  chunkIndex: number;
  chunkStart: number;
  chunkLength: number;
  content: string;
  modelName: string;
  modelDimensions: number;
  // #530 PR-1: the active embedding fingerprint (see computeEmbeddingFingerprint).
  // null only when no provider resolves (the indexer no-ops in that case).
  fingerprint: string | null;
  embedding: number[];
}

/**
 * Rows per INSERT statement in {@link PageEmbeddingRepo.insertChunks}. Each row
 * binds 12 parameters, so a batch binds 6,000 — far under Postgres's 65,535
 * per-statement limit — and, since every row also carries its vector as a text
 * literal (~10 bytes per dimension), keeps one statement in the low megabytes.
 */
export const PAGE_EMBEDDING_INSERT_BATCH_ROWS = 500;

@Injectable()
export class PageEmbeddingRepo {
  private readonly logger = new Logger(PageEmbeddingRepo.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * HARD-delete embedding rows for a page (within its workspace). Used before a
   * reindex and on page deletion — a hard delete (not soft) guarantees search
   * never returns vectors for content that no longer exists.
   *
   * `fingerprints` — FINGERPRINT-SCOPED delete. When omitted (the default)
   * EVERY row of the page is deleted, which is what the PURGE paths want (page
   * deleted / emptied / trashed: the page must vanish from every generation).
   *
   * The REPLACE path (indexer delete+insert of the same page) passes the single
   * generation it is rewriting — the TARGET fingerprint — whenever a swap is in
   * flight (active != target). Without that scope, editing a page mid-reindex
   * would delete its ACTIVE-generation rows too and, because the new rows carry
   * the TARGET fingerprint (which search does not serve until the flip), the page
   * would silently drop out of semantic search for the whole reindex window.
   * Scoping the delete to the target keeps the page's
   * active-generation rows intact and served until the pointer flips.
   *
   * NOTE the SQL `IN` semantics: rows with a NULL fingerprint (legacy) never match
   * a scoped delete — they are a separate generation and are reclaimed by the
   * generational GC (`deleteOtherGenerations`), not here.
   */
  async deleteByPage(
    pageId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
    fingerprints?: string[],
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    let query = db
      .deleteFrom('pageEmbeddings')
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId);
    if (fingerprints && fingerprints.length > 0) {
      query = query.where('fingerprint', 'in', fingerprints);
    }
    await query.execute();
  }

  /**
   * GENERATIONAL GC: hard-delete every embedding row of this workspace whose
   * fingerprint is NOT one of `keep` — including legacy NULL-fingerprint rows,
   * which are simply a very old generation (nothing serves them: the search
   * vector arm filters `fingerprint = $active`, and NULL never equals anything).
   *
   * Both call sites go through EmbeddingGenerationService.gcGenerations (which
   * adds the logging + coverage-cache invalidation): the indexer calls it at the
   * START of a reindex run with keep = [active, target] (so at most 2 generations
   * survive: the one still being served and the one being built), and
   * EmbeddingGenerationService.completeRun calls it again right AFTER a successful
   * pointer flip with keep = [target] (which reclaims the superseded generation).
   *
   * IDEMPOTENT — it is a set-difference delete, so re-running it (an aborted run
   * that is retried) is a no-op once the extra generations are gone. Running it at
   * the START is what makes a retried run clean: a PARTIAL target generation from
   * an aborted run whose config has since moved on is no longer active nor target,
   * so it is reclaimed here instead of lingering forever.
   *
   * Between the start of a reindex and the post-flip GC the workspace holds ~2x
   * the pgvector rows (active + target generations): the old generation must
   * stay readable while the new one is built. With no ANN index the `<=>` seq
   * scan also has to skip the other generation's rows. The GC caps this at 2
   * generations; the post-flip GC brings it back to 1.
   *
   * FAIL-CLOSED on an empty `keep`: delete nothing, log, return 0. Dropping the
   * fingerprint predicate instead would wipe the workspace's whole vector index,
   * including the served generation; an empty set means the caller lost its
   * fingerprints, never "purge everything" (that is deleteByWorkspace).
   *
   * Returns the number of rows deleted (0 when nothing to reclaim).
   */
  async deleteOtherGenerations(
    workspaceId: string,
    keep: string[],
    trx?: KyselyTransaction,
  ): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const kept = keep.filter((fp) => typeof fp === 'string' && fp.length > 0);

    // Nothing to keep => refuse. Without this the query below would carry no
    // predicate but the workspace id and delete EVERY embedding row of the
    // workspace (see the fail-closed rationale above).
    if (kept.length === 0) {
      this.logger.error(
        `deleteOtherGenerations: refusing to GC workspace ${workspaceId} with an ` +
          `EMPTY keep set — that would delete every embedding row of the workspace, ` +
          `including the generation currently serving search. This is a caller bug ` +
          `(a run always keeps at least its target fingerprint); nothing was deleted.`,
      );
      return 0;
    }

    const result = await db
      .deleteFrom('pageEmbeddings')
      .where('workspaceId', '=', workspaceId)
      .where((eb) =>
        eb.or([
          // `fingerprint NOT IN (...)` evaluates to NULL (not true) for a NULL
          // fingerprint, so legacy rows need this explicit arm to be GC'd.
          eb('fingerprint', 'is', null),
          eb('fingerprint', 'not in', kept),
        ]),
      )
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /**
   * Count DISTINCT non-deleted pages holding at least one row of ONE
   * generation. This is the coverage NUMERATOR: how many pages the ACTIVE
   * fingerprint actually serves (`indexed`). Mirrors the vector arm's filters
   * (workspace + fingerprint, trashed pages excluded) so the number reflects what
   * search can really retrieve.
   *
   * `changedSince` narrows the count to pages TOUCHED since a
   * given instant — i.e. how many of the pages the completed run's coverage
   * measurement no longer describes are nonetheless already covered by the active
   * generation (the event-driven indexer embedded them). computeCoverage subtracts
   * this from the numerator to split the corpus into the run's OLD bucket and the
   * CHANGED bucket; see the rule there.
   */
  async countPagesByFingerprint(
    workspaceId: string,
    fingerprint: string,
    changedSince?: Date,
  ): Promise<number> {
    let query = this.db
      .selectFrom('pageEmbeddings as pe')
      .innerJoin('pages as p', 'p.id', 'pe.pageId')
      .where('pe.workspaceId', '=', workspaceId)
      .where('pe.fingerprint', '=', fingerprint)
      .where('p.deletedAt', 'is', null)
      .where('pe.deletedAt', 'is', null);
    if (changedSince) {
      query = query.where('p.updatedAt', '>', changedSince);
    }
    const row = await query
      .select((eb) => eb.fn.count('pe.pageId').distinct().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * HARD-delete every embedding row for an entire workspace. Used when AI Search
   * is disabled for the workspace (WORKSPACE_DELETE_EMBEDDINGS).
   */
  async deleteByWorkspace(
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('pageEmbeddings')
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  /**
   * Bulk-insert chunk rows for a page. The `embedding` value is serialized with
   * `pgvector.toSql` and cast to `vector` so Postgres stores it in the
   * dimension-agnostic `vector` column (any dimension). No-op on an empty array.
   *
   * Inserted in batches of {@link PAGE_EMBEDDING_INSERT_BATCH_ROWS} rows (AI-6):
   * every row binds 12 parameters, and Postgres rejects a statement with more
   * than 65,535 of them, so a single multi-row INSERT failed for any page of
   * 5,462+ chunks — AFTER every provider call had been paid for, and the reindex
   * transaction rolled back. The batches stay atomic: they run in the caller's
   * transaction, or in one of their own when the caller passes none.
   */
  async insertChunks(
    rows: PageEmbeddingChunkRow[],
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (rows.length === 0) return;
    if (!trx && rows.length > PAGE_EMBEDDING_INSERT_BATCH_ROWS) {
      await this.db
        .transaction()
        .execute((tx) => this.insertChunkBatches(rows, tx));
      return;
    }
    await this.insertChunkBatches(rows, dbOrTx(this.db, trx));
  }

  private async insertChunkBatches(
    rows: PageEmbeddingChunkRow[],
    db: KyselyDB | KyselyTransaction,
  ): Promise<void> {
    for (
      let start = 0;
      start < rows.length;
      start += PAGE_EMBEDDING_INSERT_BATCH_ROWS
    ) {
      await this.insertChunkBatch(
        rows.slice(start, start + PAGE_EMBEDDING_INSERT_BATCH_ROWS),
        db,
      );
    }
  }

  private async insertChunkBatch(
    rows: PageEmbeddingChunkRow[],
    db: KyselyDB | KyselyTransaction,
  ): Promise<void> {
    await db
      .insertInto('pageEmbeddings')
      .values(
        rows.map((row) => ({
          pageId: row.pageId,
          workspaceId: row.workspaceId,
          spaceId: row.spaceId,
          attachmentId: row.attachmentId,
          chunkIndex: row.chunkIndex,
          chunkStart: row.chunkStart,
          chunkLength: row.chunkLength,
          content: row.content,
          modelName: row.modelName,
          modelDimensions: row.modelDimensions,
          fingerprint: row.fingerprint,
          // pgvector.toSql -> '[1,2,3]'; cast the bound literal to vector.
          embedding: sql`${pgvector.toSql(row.embedding)}::vector`,
        })),
      )
      .execute();
  }

  /**
   * Build the VECTOR candidate arm for SearchService's fused RRF union — a
   * page-level nearest-neighbour sub-select. Returns a `sql` fragment (not an
   * executed query) so the caller can UNION ALL it with the lexical arm inside a
   * single ranked-ids query.
   *
   * SCALING BOUNDARY: the column is dimension-agnostic, so it carries NO ANN
   * index — this is a brute-force O(N) KNN seq scan with `<=>`, accepted for
   * small tenants. It is NOT unbounded, though: the caller (SearchService) runs this
   * fused query under a per-statement timeout (SEARCH_VECTOR_STATEMENT_TIMEOUT_MS)
   * and DEGRADES to lexical-only on a 57014 cancellation, so a pathological scan
   * can never hang the interactive search request.
   *
   * The arm collapses a page's chunks to its best (MIN) cosine distance:
   *   SELECT pages.id, NULL fts_score, NULL sub_tier,
   *          MIN(pe.embedding <=> $qvec) AS vec_distance
   *   FROM page_embeddings pe JOIN pages ON pages.id = pe.page_id
   *   WHERE <scope> AND pe.model_dimensions = $dim AND pe.fingerprint = $fp
   *   GROUP BY pages.id ORDER BY vec_distance LIMIT $limit
   *
   * `scope` is SearchService's shared scope predicate (workspace + space/id set +
   * creator + descendants + deleted_at), referencing the `pages` table — it must
   * be spliced verbatim so the vector candidate set mirrors the lexical scope
   * EXACTLY, minus the lexical text predicate (vector candidates need not match
   * text). The vector is bound via pgvector's `toSql(...)::vector`, and both the
   * dimension and the ACTIVE fingerprint are filtered so `<=>` only ever compares
   * compatible, same-generation vectors (pgvector errors on a dimension
   * mismatch; a fingerprint mismatch would fuse incomparable vectors).
   *
   * `workspaceId` is ALSO filtered directly on `page_embeddings` — not only via
   * the pages join. It is IMMUTABLE (there are no cross-workspace page moves), so
   * an embedding row's workspace_id always matches its page's, and this drops NO
   * legitimate hit; it lets the composite index idx_page_embeddings_ws_space_fp_dim
   * (workspace_id, space_id, fingerprint, model_dimensions) bite from its LEADING
   * column, and workspace-scopes candidates at the embedding level (defense in
   * depth).
   *
   * SPACE is deliberately NOT filtered on page_embeddings: `page_embeddings.space_id`
   * is stamped at index time and is NOT updated when a page is MOVED between spaces
   * (movePageToSpace does not reindex, and PAGE_MOVED_TO_SPACE has no reindex
   * consumer), so a moved page's rows carry the OLD space until the next reindex. A
   * `page_embeddings.space_id = ANY(scope)` predicate would then wrongly drop a
   * legitimate vector hit for a page moved INTO the searched space. Space scoping
   * is therefore enforced ONLY by the join to `pages` (pages.space_id ∈ scope,
   * always current) — the same way the lexical arm scopes, so no space leak.
   *
   * The NULL fts_score / sub_tier columns keep the arm UNION-compatible with the
   * lexical arm's column list.
   */
  vectorCandidateArm(params: {
    queryEmbedding: number[];
    dimensions: number;
    fingerprint: string;
    scope: RawBuilder<unknown>;
    limit: number;
    workspaceId: string;
  }): RawBuilder<unknown> {
    const qvec = sql`${pgvector.toSql(params.queryEmbedding)}::vector`;
    return sql`
      SELECT pages.id AS id,
             NULL::float AS fts_score,
             NULL::int AS sub_tier,
             MIN(page_embeddings.embedding <=> ${qvec}) AS vec_distance
      FROM page_embeddings
      JOIN pages ON pages.id = page_embeddings.page_id
      WHERE ${params.scope}
        AND page_embeddings.workspace_id = ${params.workspaceId}
        AND page_embeddings.model_dimensions = ${params.dimensions}
        AND page_embeddings.fingerprint = ${params.fingerprint}
      GROUP BY pages.id
      ORDER BY vec_distance ASC
      LIMIT ${params.limit}
    `;
  }

  /**
   * Count DISTINCT non-deleted pages that have at least one embedding row in this
   * workspace — i.e. how many pages currently have stored embeddings.
   *
   * NOTE: this counts pages embedded by ANY model dimension, whereas the vector
   * arm (`vectorCandidateArm`) only serves rows matching the active model's
   * dimension.
   * After switching the embedding model, this number can therefore exceed the
   * set of pages actually reachable by search until those pages are re-indexed.
   * It is an indexing-coverage indicator, not an exact searchable-page count.
   */
  async countIndexedPages(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom('pageEmbeddings as pe')
      .innerJoin('pages as p', 'p.id', 'pe.pageId')
      .where('pe.workspaceId', '=', workspaceId)
      // Exclude trashed pages and any soft-deleted embedding rows (defence in
      // depth: embeddings are hard-deleted, so pe.deletedAt is normally null).
      .where('p.deletedAt', 'is', null)
      .where('pe.deletedAt', 'is', null)
      .select((eb) => eb.fn.count('pe.pageId').distinct().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
}
