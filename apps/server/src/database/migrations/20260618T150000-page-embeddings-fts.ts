import { type Kysely, sql } from 'kysely';

/**
 * Chunk-level lexical index for HYBRID retrieval (RRF) over `page_embeddings`.
 *
 * Hybrid retrieval fuses a lexical and a vector ranking with Reciprocal Rank
 * Fusion so exact keyword / identifier matches and semantic matches both
 * surface. This migration adds the lexical side at chunk granularity so both
 * CTEs of the fused query rank the same chunk rows.
 *
 * `fts` is a GENERATED ALWAYS ... STORED `tsvector` built from `content` with
 * the SAME text-search config as `pages.tsv`: `to_tsvector('english',
 * f_unaccent(content))`. Using the identical config keeps lexical behaviour
 * consistent with the existing page search (incl. unaccented Cyrillic content).
 * `f_unaccent(text)` is declared IMMUTABLE (migration 20250729T213756), which is
 * exactly what a GENERATED STORED column requires — so this needs NO trigger.
 * The column is independent of the embedding vector dimension: it indexes text,
 * not the vector, so it works for any model dimension.
 *
 * NOTE: `fts` is deliberately NOT added to the `PageEmbeddings` Kysely type. It
 * is a generated column accessed ONLY via raw SQL (the hybrid query); adding it
 * to the Kysely type would force it into the explicit-column insert in
 * `insertChunks` and break inserts (a GENERATED column cannot be written to).
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Generated STORED tsvector mirroring pages.tsv's config. f_unaccent is
  // IMMUTABLE so it is valid inside a GENERATED column expression (no trigger).
  await sql`
    ALTER TABLE page_embeddings
      ADD COLUMN IF NOT EXISTS fts tsvector
      GENERATED ALWAYS AS (to_tsvector('english', f_unaccent(content))) STORED
  `.execute(db);

  // GIN index for fast `fts @@ query` lexical matching on the chunk text.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_embeddings_fts
      ON page_embeddings USING gin(fts)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_page_embeddings_fts`.execute(db);
  await sql`
    ALTER TABLE page_embeddings DROP COLUMN IF EXISTS fts
  `.execute(db);
}
