import { type Kysely, sql } from 'kysely';

/**
 * `ai_chat_run_steps` — append-only per-step persistence for an assistant turn.
 * Each finished agent step's UI `parts` (its text part + a part per tool call,
 * WITH the tool output) is INSERTed as its own row the moment the step ends.
 *
 * A separate table, because a jsonb UPDATE (even `||`) rewrites the entire
 * TOASTed row version under MVCC, so re-persisting a growing `metadata.parts`
 * on every step is O(n²) WAL / dead tuples; an INSERT writes only that step's
 * bytes.
 *
 * The full `metadata.parts` on the message row is assembled once at finalize
 * (the terminal completed/error/aborted write). Mid-run, a resuming client's
 * seed is the step rows concatenated in `step_index` order. A row that already
 * carries non-empty `metadata.parts` and no step rows reconstructs from the row
 * (see reconstructRunParts / assembleStepParts in ai-chat.service.ts).
 *
 * ON DELETE CASCADE on `message_id`: the step rows are a derived projection of the
 * assistant message; they must vanish with it (or with its workspace).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ai_chat_run_steps')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    // The assistant message row this step belongs to (the #183 projection). The
    // step rows are a derived, per-step slice of that message, so they cascade.
    .addColumn('message_id', 'uuid', (col) =>
      col.references('ai_chat_messages.id').onDelete('cascade').notNull(),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    // 0-based index of the finished step within the turn. Ordering key for
    // reconstruction; unique per message (idempotent step re-persist).
    .addColumn('step_index', 'integer', (col) => col.notNull())
    // The step's UI parts (text part + a `tool-*` part per call, WITH output).
    // Concatenated in step order to rebuild the turn's `metadata.parts`.
    .addColumn('parts', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Idempotent per-step persist: a retried INSERT of the same (message, step)
  // is a no-op (the service uses ON CONFLICT DO NOTHING). This also serves the
  // reconstruction read (WHERE message_id ORDER BY step_index).
  await db.schema
    .createIndex('ai_chat_run_steps_message_step_uidx')
    .ifNotExists()
    .on('ai_chat_run_steps')
    .columns(['message_id', 'step_index'])
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ai_chat_run_steps').ifExists().execute();
}
