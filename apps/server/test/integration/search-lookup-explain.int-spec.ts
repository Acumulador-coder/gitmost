import { randomUUID } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
} from './db';

/**
 * Dead-index guard — EXPLAIN on the REAL DB.
 *
 * The lookup mode's substring predicates run a leading-wildcard
 * `LOWER(f_unaccent(col)) LIKE '%q%'`. Those are only fast when Postgres uses
 * the GIN trigram indexes:
 *   - idx_pages_title_trgm         on (LOWER(f_unaccent(title)))
 *   - idx_pages_text_content_trgm  on (LOWER(f_unaccent(text_content)))
 *
 * Postgres uses a functional index ONLY when the query expression matches the
 * index expression EXACTLY: wrapping the columns in `coalesce(col,'')` forces a
 * Seq Scan on pages for EVERY lookup (the MCP client always sends
 * substring:true).
 *
 * Discriminator: `SET enable_seqscan = off` asks the planner "CAN this predicate
 * use the index at all?". With seqscan disabled:
 *   - the coalesce-FREE predicate plans a Bitmap Index Scan on the trgm index
 *     (no Seq Scan on pages);
 *   - the coalesce-WRAPPED predicate cannot use the index and falls back to a
 *     Seq Scan on pages even though seqscan is disabled.
 */
describe('SearchService agent-lookup EXPLAIN — trgm index is live [integration]', () => {
  let db: Kysely<any>;
  let workspaceId: string;
  let spaceId: string;

  async function insertPage(title: string, textContent: string): Promise<void> {
    const id = randomUUID();
    await db
      .insertInto('pages')
      .values({
        id,
        slugId: `slug-${id.slice(0, 12)}`,
        title,
        textContent,
        spaceId,
        workspaceId,
      })
      .execute();
  }

  // Run EXPLAIN (no ANALYZE — we only inspect the chosen plan) and return the
  // concatenated plan text.
  async function explain(query: string): Promise<string> {
    const rows = await sql<{ 'QUERY PLAN': string }>`EXPLAIN ${sql.raw(query)}`.execute(
      db,
    );
    return (rows.rows as any[]).map((r) => r['QUERY PLAN']).join('\n');
  }

  beforeAll(async () => {
    db = getTestDb();
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;

    // Seed enough rows that a trigram index is a plausible plan. The content is
    // varied so the '%needle%' pattern is selective.
    for (let i = 0; i < 200; i++) {
      await insertPage(
        `seed-title-${i}`,
        `seed body content number ${i} lorem ipsum dolor sit amet ${i}`,
      );
    }
    await insertPage('backup-srv.local', 'the needle-token-xyz lives here');

    // Keep the trgm indexes' stats fresh so the planner costs them correctly.
    await sql`ANALYZE pages`.execute(db);
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  // Force the planner to answer "can the index be used?" rather than "is it
  // cheaper than a seq scan on this size?". Restored after each test.
  beforeEach(async () => {
    await sql`SET enable_seqscan = off`.execute(db);
  });
  afterEach(async () => {
    await sql`RESET enable_seqscan`.execute(db);
  });

  it('title predicate (coalesce-FREE, as fixed) uses idx_pages_title_trgm, not a Seq Scan', async () => {
    const plan = await explain(
      `SELECT id FROM pages WHERE LOWER(f_unaccent(title)) LIKE '%srv.local%'`,
    );
    expect(plan).toContain('idx_pages_title_trgm');
    expect(plan).not.toMatch(/Seq Scan on pages/i);
  });

  it('text_content predicate (coalesce-FREE, as fixed) uses idx_pages_text_content_trgm, not a Seq Scan', async () => {
    const plan = await explain(
      `SELECT id FROM pages WHERE LOWER(f_unaccent(text_content)) LIKE '%needle-token%'`,
    );
    expect(plan).toContain('idx_pages_text_content_trgm');
    expect(plan).not.toMatch(/Seq Scan on pages/i);
  });

  // Negative control: the coalesce-wrapped predicate must NOT be able to use
  // the index — even with seqscan disabled it can only Seq Scan pages. If this
  // ever stops seq-scanning, the coalesce/index expressions have re-aligned and
  // the guard above is no longer meaningful.
  it('coalesce-WRAPPED text predicate (the bug) cannot use the index — falls to Seq Scan', async () => {
    const plan = await explain(
      `SELECT id FROM pages WHERE LOWER(f_unaccent(coalesce(text_content,''))) LIKE '%needle-token%'`,
    );
    expect(plan).not.toContain('idx_pages_text_content_trgm');
    expect(plan).toMatch(/Seq Scan on pages/i);
  });
});
