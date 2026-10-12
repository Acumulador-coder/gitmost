import { type Kysely, sql } from 'kysely';

/**
 * Share "approved" (publish-only-the-saved-version) mode.
 *
 * Adds `shares.published_mode`, the per-share switch between:
 *   - 'live'     — public readers see the current draft
 *   - 'approved' — public readers see the LAST manually-saved version
 *                  (page_history.kind='manual'), not the live draft
 *
 * NOT NULL with a 'live' default so every existing share keeps its current
 * (live) semantics with no data backfill. Standalone, single-concern and
 * additive: the first manual baseline is minted by the service on enable, not
 * by this migration. Stored as a short varchar to stay forward-compatible
 * without an enum migration.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('shares')
    .addColumn('published_mode', 'varchar(20)', (col) =>
      col.notNull().defaultTo(sql`'live'`),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('shares').dropColumn('published_mode').execute();
}
