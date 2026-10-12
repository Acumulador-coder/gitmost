import { type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Per-role control over the new-chat auto-start behavior: whether picking a
  // role card sends a launch message and starts the dialog, and with what text.
  await db.schema
    .alterTable('ai_agent_roles')
    // When true (default), picking the role auto-sends a launch message and
    // starts the conversation; when false the client only binds the role and
    // reveals the composer (nothing is sent). Default true => existing roles
    // keep their previous behavior.
    .addColumn('auto_start', 'boolean', (col) => col.notNull().defaultTo(true))
    // Optional custom text sent on auto-start instead of the built-in default.
    // NULL/empty => the client falls back to its default launch message.
    .addColumn('launch_message', 'text', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('ai_agent_roles')
    .dropColumn('launch_message')
    .execute();
  await db.schema
    .alterTable('ai_agent_roles')
    .dropColumn('auto_start')
    .execute();
}
