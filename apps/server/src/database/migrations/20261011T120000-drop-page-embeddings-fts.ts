import { type Kysely, sql } from 'kysely';

/**
 * Drop `page_embeddings.fts` and its GIN index.
 *
 * The column was the chunk-level lexical leg of the AI agent's own hybrid
 * retrieval (`PageEmbeddingRepo.hybridSearch`, migration 20260618T150000). The
 * agent's `searchPages` now runs the shared SearchService (#701), whose lexical
 * side is `pages.tsv`, and `hybridSearch` is gone — nothing reads `fts` any more,
 * while Postgres still computed the GENERATED STORED tsvector and maintained the
 * GIN index on every chunk insert.
 *
 * DROP COLUMN is a catalog change (no table rewrite), so `up` is cheap.
 * `down` restores the column on `ru_en`, the config migration 20260707T130000
 * left it on; re-adding a STORED generated column rewrites the table.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_page_embeddings_fts`.execute(db);
  await sql`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS fts`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE page_embeddings
      ADD COLUMN IF NOT EXISTS fts tsvector
      GENERATED ALWAYS AS (to_tsvector('ru_en', f_unaccent(content))) STORED
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_embeddings_fts
      ON page_embeddings USING gin(fts)
  `.execute(db);
}
