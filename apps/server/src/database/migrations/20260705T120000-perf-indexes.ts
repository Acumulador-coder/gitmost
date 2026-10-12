import { type Kysely, sql } from 'kysely';

/**
 * Targeted hot-path indexes.
 *
 * 1. GIN trigram indexes for `/search/suggest`, which runs a leading-wildcard
 *    `LOWER(f_unaccent(col)) LIKE '%q%'` per keystroke. The index EXPRESSIONS
 *    match the predicates in search.service.ts exactly so the planner uses them
 *    (EXPLAIN: Bitmap Index Scan).
 *
 *    The two-arg `unaccent('unaccent', $1)` body of `f_unaccent` cannot be
 *    inlined into an index expression (`function unaccent(unknown, text) does
 *    not exist` — the literal loses its regdictionary coercion). The
 *    schema-qualified single-arg `public.unaccent($1)` is the same operation
 *    (the default dictionary IS `unaccent`) and inlines cleanly, so
 *    `f_unaccent` is redefined to it. Output-identical for every caller (the
 *    tsvector trigger, the `tsv @@` search, the suggest LIKE), so no reindex is
 *    needed; `down()` restores the two-arg body. The `unaccent` extension lives
 *    in `public`.
 *
 * 2. Composite indexes for two ORDER-BY-id queries that would otherwise sort
 *    on top of a created_at index:
 *    - page_history: `findPageHistoryByPageId` does WHERE page_id ORDER BY id
 *      DESC, but only `(page_id, created_at DESC)` exists → extra sort.
 *    - comments: `findPageComments` does WHERE page_id ORDER BY id ASC, but only
 *      `(page_id)` exists → extra sort.
 *
 * DEPLOY-TIME LOCK: Kysely runs each migration in a transaction, so these are
 * plain CREATE INDEX statements. The two slow GIN trigram builds are pre-built
 * CONCURRENTLY by `ensureConcurrentIndexes` (database/concurrent-indexes.ts)
 * before the migrator runs, so on an existing DB their `IF NOT EXISTS` creates
 * below no-op; on a fresh DB they build on an empty table. Keep the two trigram
 * creates in lockstep with their CANONICAL definitions in CONCURRENT_INDEXES.
 * The b-tree indexes are fast and not pre-built.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Index-compatible, output-identical redefinition of f_unaccent (see header).
  await sql`
    CREATE OR REPLACE FUNCTION f_unaccent(text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE PARALLEL SAFE STRICT
    AS $func$
      SELECT public.unaccent($1);
    $func$
  `.execute(db);

  // Search-suggest trigram indexes. Expressions match search.service.ts.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_pages_title_trgm
      ON pages USING gin ((LOWER(f_unaccent(title))) gin_trgm_ops)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_name_trgm
      ON users USING gin ((LOWER(f_unaccent(name))) gin_trgm_ops)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_groups_name_trgm
      ON groups USING gin ((LOWER(f_unaccent(name))) gin_trgm_ops)
  `.execute(db);

  // page_history: WHERE page_id ORDER BY id DESC (findPageHistoryByPageId).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_history_page_id
      ON page_history (page_id, id DESC)
  `.execute(db);

  // comments: WHERE page_id ORDER BY id ASC (findPageComments).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_comments_page_id_id
      ON comments (page_id, id)
  `.execute(db);

  // page_access(workspace_id): #348 made hasRestrictedPagesInWorkspace uncached
  // (F1 fix), so `EXISTS(SELECT 1 FROM page_access WHERE workspace_id=?)` now runs
  // per-request on every whole-workspace list endpoint (global search + suggest,
  // favorites, notifications, recent, created-by). page_access only had a
  // space_id index → that EXISTS was a seq scan in the common zero-restriction
  // case. This index makes it an index-only existence probe.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_access_workspace_id
      ON page_access (workspace_id)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Drop the expression indexes before restoring the function body.
  await sql`DROP INDEX IF EXISTS idx_pages_title_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_users_name_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_groups_name_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_page_history_page_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_comments_page_id_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_page_access_workspace_id`.execute(db);

  // Restore the original two-arg (dictionary-named) f_unaccent body.
  await sql`
    CREATE OR REPLACE FUNCTION f_unaccent(text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE PARALLEL SAFE STRICT
    AS $func$
      SELECT unaccent('unaccent', $1);
    $func$
  `.execute(db);
}
