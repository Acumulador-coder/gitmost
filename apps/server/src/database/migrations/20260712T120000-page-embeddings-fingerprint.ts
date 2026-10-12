import { type Kysely, sql } from 'kysely';

/**
 * Add the embedding FINGERPRINT column.
 *
 * The fingerprint is a deterministic id of the embedding configuration that
 * produced a row — model id + revision + query/doc prefix scheme + dimensions
 * (see AiService.computeEmbeddingFingerprint). Search filters vector candidates
 * by the workspace's ACTIVE fingerprint so a revision bump or a prefix-scheme
 * change never fuses incompatible vectors into results.
 *
 * Adds the column (nullable — existing rows stay NULL) and the composite index
 * the vector-candidate scan uses.
 *
 * Independent migration: it creates only its own objects and never touches
 * another migration's tables/indexes, so a partial failure cannot leave a
 * shared object half-built.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Nullable text column. Existing rows keep NULL (legacy generation) and are
  // simply not matched by the active-fingerprint filter until re-indexed.
  await sql`
    ALTER TABLE page_embeddings
      ADD COLUMN IF NOT EXISTS fingerprint text
  `.execute(db);

  // Composite btree supporting the scoped, dimension- + fingerprint-filtered
  // vector-candidate scan (workspace_id + space_id + fingerprint + model_dimensions).
  await db.schema
    .createIndex('idx_page_embeddings_ws_space_fp_dim')
    .ifNotExists()
    .on('page_embeddings')
    .columns(['workspace_id', 'space_id', 'fingerprint', 'model_dimensions'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('idx_page_embeddings_ws_space_fp_dim')
    .ifExists()
    .execute();

  await sql`
    ALTER TABLE page_embeddings
      DROP COLUMN IF EXISTS fingerprint
  `.execute(db);
}
