import { type Kysely, sql } from 'kysely';

/**
 * The `ru_en` text-search configuration + the config swap.
 *
 * The `english` FTS config stems only Latin words, so «ресторанов москвы» does
 * not match «ресторан в москве». `ru_en` layers russian_stem over the Cyrillic
 * token classes and english_stem over the ascii ones, so both languages get
 * morphology from one config.
 *
 *   CREATE TEXT SEARCH CONFIGURATION ru_en (COPY = simple);
 *   ALTER ... asciiword/asciihword/hword_asciipart WITH english_stem;
 *   ALTER ... word/hword/hword_part           WITH russian_stem;
 *
 * `to_tsvector('ru_en', …)` with the LITERAL config name is IMMUTABLE, so it is
 * valid inside a trigger, a generated column and an index expression.
 *
 * INVARIANT: the config of the STORED column and the config of the QUERY must
 * change together. This migration flips both stored sides (pages.tsv via its
 * trigger + a reindex; page_embeddings.fts via its generated expression), and
 * the query side uses `ru_en` in the same release. Trigram indexes are
 * LOWER(f_unaccent(...)) and do not depend on the FTS config.
 *
 * REINDEX / LOCK MODEL (deploy-critical). Kysely runs each migration in its own
 * transaction (no `disableTransactions`; transactional DDL), so the pages.tsv
 * reindex is a single `UPDATE pages SET tsv`, atomic within this migration: at
 * COMMIT every row is `ru_en` at once and no dual-config read window is needed.
 *
 *   - pages.tsv: swapping the trigger is a cheap catalog change (no table lock),
 *     and the reindex is a single `UPDATE pages SET tsv = <ru_en expr>` — a
 *     ROW-level-lock (RowExclusiveLock) backfill, NOT an ACCESS EXCLUSIVE rewrite
 *     (mirrors the existing space_id backfill in 20250725T052004). On a LARGE
 *     tenant this still writes every row + its WAL and leaves dead tuples, so it
 *     can take MINUTES and blocks the startup migrator for that time — but it
 *     never blocks concurrent reads. It stays inline unconditionally.
 *
 *   - page_embeddings.fts is a GENERATED STORED column; Postgres cannot change a
 *     generated expression without DROP+ADD, which is a full-table ACCESS
 *     EXCLUSIVE REWRITE of page_embeddings — it blocks ALL reads AND writes on
 *     that table (including the RAG agent) for the rewrite's duration. That inline
 *     rewrite is appropriate for small/typical tenants (this fork's target) and
 *     is the DEFAULT.
 *
 *     LARGE TENANTS have two documented escape hatches, either of which makes the
 *     migration genuinely no-op the rewrite (it is NOT a blind DROP+ADD):
 *       (a) Set `SEARCH_EMBEDDINGS_FTS_INLINE_REWRITE=false`. The migration then
 *           SKIPS the embeddings rewrite entirely and logs a WARNING. The operator
 *           MUST perform the ru_en fts swap out-of-band; until they do, the RAG
 *           lexical leg stays on `english` while the query config is `ru_en` — a
 *           documented, operator-owned desync window. (pages.tsv still swaps
 *           inline — the gate is ONLY the embeddings rewrite.)
 *       (b) Perform the swap out-of-band BEFORE deploy — add a plain column →
 *           batched backfill → brief-lock swap → CREATE INDEX CONCURRENTLY — so
 *           the `fts` column's generated expression already references the TARGET
 *           config when the migration runs. The migration reads the column's
 *           generation expression from pg_catalog and then does nothing (no
 *           DROP, no ADD, no rewrite). `DROP COLUMN IF EXISTS` alone would not
 *           do: it guards against absence, not presence.
 */

// pages.tsv trigger body for a given FTS config — mirrors the latest form
// (20250729T213756): f_unaccent + a 1MB text cap on text_content, weights A/B.
function pagesTriggerSql(config: 'ru_en' | 'english') {
  return sql`
    CREATE OR REPLACE FUNCTION pages_tsvector_trigger() RETURNS trigger AS $$
    begin
        new.tsv :=
                  setweight(to_tsvector('${sql.raw(config)}', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('${sql.raw(config)}', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `;
}

async function swapPagesConfig(db: Kysely<any>, config: 'ru_en' | 'english') {
  // 1. Point the trigger at the target config (new/edited rows use it going
  //    forward). CREATE OR REPLACE FUNCTION takes only a brief catalog lock.
  await pagesTriggerSql(config).execute(db);

  // 2. Reindex existing rows: recompute tsv directly with the target config. A
  //    plain UPDATE — row locks, no ACCESS EXCLUSIVE. Equivalent to firing the
  //    trigger but cheaper (no self-update round trip).
  await sql`
    UPDATE pages
    SET tsv =
        setweight(to_tsvector('${sql.raw(config)}', f_unaccent(coalesce(title, ''))), 'A') ||
        setweight(to_tsvector('${sql.raw(config)}', f_unaccent(substring(coalesce(text_content, ''), 1, 1000000))), 'B')
  `.execute(db);
}

// The default in-migration ACCESS EXCLUSIVE rewrite of page_embeddings.fts is
// ON unless the operator explicitly opts out with the env flag. Parsed strictly
// (mirrors CLIENT_TELEMETRY_ENABLED / DEBUG_MODE in common/): only a literal
// (case-insensitive) 'false' disables it; anything else — unset included —
// keeps the default true.
function inlineEmbeddingsRewriteEnabled(): boolean {
  return (
    (process.env.SEARCH_EMBEDDINGS_FTS_INLINE_REWRITE ?? 'true').toLowerCase() !==
    'false'
  );
}

// Read page_embeddings.fts's ACTUAL generated-column expression from pg_catalog
// (the generation expression is stored as a column default marked generated).
// Returns '' when the column is absent.
async function embeddingsFtsExpr(db: Kysely<any>): Promise<string> {
  const r = await sql<{ def: string }>`
    SELECT pg_get_expr(d.adbin, d.adrelid) AS def
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE a.attname = 'fts'
      AND a.attrelid = 'page_embeddings'::regclass
      AND NOT a.attisdropped
  `.execute(db);
  return r.rows[0]?.def ?? '';
}

async function swapEmbeddingsFtsConfig(
  db: Kysely<any>,
  config: 'ru_en' | 'english',
) {
  // 1. TRUE no-op path (real out-of-band escape hatch): if the column's current
  //    generation expression already references the TARGET config, there is
  //    nothing to do. An operator who pre-swapped the column out-of-band lands
  //    here and the migration does NOT rewrite the table. ('ru_en' and 'english'
  //    are disjoint tokens, neither a substring of the other or of the rest of
  //    the expression, so a plain contains-check is unambiguous.)
  const currentExpr = await embeddingsFtsExpr(db);
  if (currentExpr.includes(config)) return;

  // 2. Env-gated opt-out: large tenants set SEARCH_EMBEDDINGS_FTS_INLINE_REWRITE
  //    =false to skip the ACCESS EXCLUSIVE rewrite in-migration and own the swap
  //    out-of-band. Warn loudly so the desync window is not silent.
  if (!inlineEmbeddingsRewriteEnabled()) {
    // eslint-disable-next-line no-console
    console.warn(
      `[migration 20260707T130000] SEARCH_EMBEDDINGS_FTS_INLINE_REWRITE=false: ` +
        `SKIPPING the page_embeddings.fts rewrite to '${config}'. The operator MUST ` +
        `perform this fts swap out-of-band. Until then the RAG lexical leg stays on ` +
        `its current config while the query config is '${config}' (documented, ` +
        `operator-owned desync window).`,
    );
    return;
  }

  // 3. Default inline path: the generated `fts` expression can only change via
  //    DROP+ADD (a full-table ACCESS EXCLUSIVE rewrite; see the lock note in the
  //    header). The GIN index depends on the column, so it is dropped with it and
  //    recreated.
  await sql`DROP INDEX IF EXISTS idx_page_embeddings_fts`.execute(db);
  await sql`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS fts`.execute(db);
  await sql`
    ALTER TABLE page_embeddings
      ADD COLUMN fts tsvector
      GENERATED ALWAYS AS (to_tsvector('${sql.raw(config)}', f_unaccent(content))) STORED
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_embeddings_fts
      ON page_embeddings USING gin(fts)
  `.execute(db);
}

async function ruEnConfigExists(db: Kysely<any>): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pg_ts_config WHERE cfgname = 'ru_en'
  `.execute(db);
  return (r.rows[0]?.n ?? 0) > 0;
}

async function ensureRuEnConfig(db: Kysely<any>): Promise<void> {
  // Idempotent by EXISTENCE, not by drop-recreate. The old `DROP ... IF EXISTS;
  // CREATE` was safe only on a first run: on a re-run the page_embeddings.fts
  // generated column already has a hard dependency on ru_en, so dropping the
  // config would fail. Create only when it is genuinely missing.
  if (await ruEnConfigExists(db)) return;
  await sql`CREATE TEXT SEARCH CONFIGURATION ru_en (COPY = simple)`.execute(db);
  // Latin token classes → english_stem.
  await sql`
    ALTER TEXT SEARCH CONFIGURATION ru_en
      ALTER MAPPING FOR asciiword, asciihword, hword_asciipart
      WITH english_stem
  `.execute(db);
  // Cyrillic / non-ascii token classes → russian_stem.
  await sql`
    ALTER TEXT SEARCH CONFIGURATION ru_en
      ALTER MAPPING FOR word, hword, hword_part
      WITH russian_stem
  `.execute(db);
}

export async function up(db: Kysely<any>): Promise<void> {
  await ensureRuEnConfig(db);

  // Flip both stored sides to ru_en (query-side flips in the same commit).
  // swapEmbeddingsFtsConfig no-ops when fts already references ru_en, so a
  // re-run of up() is idempotent and does NOT re-rewrite the embeddings table.
  await swapPagesConfig(db, 'ru_en');
  await swapEmbeddingsFtsConfig(db, 'ru_en');
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse ORDER matters: the trigger and the generated column reference the
  // `ru_en` config by name, so they must be moved back to `english` BEFORE the
  // config can be dropped (a generated column that still depends on `ru_en` would
  // block the DROP with a dependency error).
  await swapEmbeddingsFtsConfig(db, 'english');
  await swapPagesConfig(db, 'english');

  // Drop the config ONLY if nothing still references it. When the embeddings
  // rewrite was gated off (SEARCH_EMBEDDINGS_FTS_INLINE_REWRITE=false), the fts
  // column can still reference ru_en — dropping the config would then fail with a
  // dependency error. Skip + warn so down() stays non-fatal; the operator drops
  // ru_en after completing the out-of-band english swap.
  if ((await embeddingsFtsExpr(db)).includes('ru_en')) {
    // eslint-disable-next-line no-console
    console.warn(
      `[migration 20260707T130000] down(): page_embeddings.fts still references ` +
        `ru_en (inline rewrite was gated off) — leaving the ru_en text-search ` +
        `configuration in place. Drop it out-of-band once fts is back on 'english'.`,
    );
    return;
  }
  await sql`DROP TEXT SEARCH CONFIGURATION IF EXISTS ru_en`.execute(db);
}
