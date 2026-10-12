import { type Kysely, sql } from 'kysely';

/**
 * Trigram indexes for the opt-in agent-lookup search mode.
 *
 * The lookup mode adds a substring branch that runs leading-wildcard
 * `LOWER(f_unaccent(col)) LIKE '%q%'` predicates on pages.title and
 * pages.text_content. A leading wildcard cannot use a b-tree index, so without a
 * GIN trigram index each such predicate is a sequential scan.
 *
 *  - TITLE: the lookup-mode title predicate `LOWER(f_unaccent(title)) LIKE
 *    '%q%'` is identical to the /search/suggest one, already served by
 *    `idx_pages_title_trgm` from the perf-indexes migration.
 *
 *  - TEXT_CONTENT: the substring branch scans text_content when the query is
 *    not titleOnly; the GIN trigram index turns that `%q%` predicate into a
 *    Bitmap Index Scan, at the cost of disk and write amplification on page
 *    edits.
 *
 * DEPLOY-TIME LOCK: Kysely runs each migration in a transaction, so this is a
 * plain CREATE INDEX. `ensureConcurrentIndexes` (database/concurrent-indexes.ts)
 * pre-builds it CONCURRENTLY before the migrator runs, so on an existing DB the
 * `IF NOT EXISTS` below no-ops; on a fresh DB it builds on an empty table. Keep
 * this create in lockstep with the CANONICAL definition in CONCURRENT_INDEXES
 * (same expression + opclass).
 */
export async function up(db: Kysely<any>): Promise<void> {
  // The title predicate is served by idx_pages_title_trgm — see header.
  // Only the text_content index is introduced here.

  // text_content trigram index. Its expression is coalesce-free —
  // `LOWER(f_unaccent(text_content))` — to EXACTLY match the coalesce-free
  // lookup-mode text substring predicate in search.service.ts, so Postgres can
  // use it (a `coalesce(...)` mismatch would silently fall back to a Seq Scan).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_pages_text_content_trgm
      ON pages USING gin ((LOWER(f_unaccent(text_content))) gin_trgm_ops)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Only drop the index this migration introduced. idx_pages_title_trgm is owned
  // by the #348 perf-indexes migration, so leave it for that migration's down().
  await sql`DROP INDEX IF EXISTS idx_pages_text_content_trgm`.execute(db);
}
