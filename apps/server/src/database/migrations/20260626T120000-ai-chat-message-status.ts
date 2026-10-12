import { type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Step-granular durability for the assistant turn: the assistant row is
  // created upfront (status 'streaming') and updated as each step completes, so
  // a process death mid-turn keeps the finished steps. NULLABLE on purpose:
  // older rows carry NULL, which the app treats as 'completed'. Values written
  // by the app: 'streaming' | 'completed' | 'error' | 'aborted'.
  await db.schema
    .alterTable('ai_chat_messages')
    .addColumn('status', 'text', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ai_chat_messages').dropColumn('status').execute();
}
