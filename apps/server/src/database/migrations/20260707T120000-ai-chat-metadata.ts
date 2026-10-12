import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Chat-level metadata bag. Holds the deferred-tool ACTIVATION set
  // (`activatedTools`) so it survives across turns and the model does not have to
  // re-run loadTools every turn. On load the stored set is intersected with the
  // current valid deferred names, so an allowlist / role change can never inject
  // a nonexistent tool.
  //
  // jsonb, defaulted to '{}' so every row (incl. pre-migration ones, backfilled
  // by the default) is a readable object — the app never has to null-guard the
  // bag itself, only individual keys.
  await db.schema
    .alterTable('ai_chats')
    .addColumn('metadata', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ai_chats').dropColumn('metadata').execute();
}
