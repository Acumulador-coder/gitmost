import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';

/**
 * Repository for the MUTABLE page->chat binding: the pointer that says "for
 * THIS user, on THIS page, this chat opens." A conscious open (history select)
 * or "New chat" (unbind) moves the pointer without touching the immutable
 * `ai_chats.page_id` provenance.
 *
 * One row per (userId, pageId) — the UNIQUE(user_id, page_id) invariant; writes
 * upsert / delete on that key. Absence of a row == "nothing bound" == an empty
 * chat opens.
 */
@Injectable()
export class AiChatPageBindingRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * Resolve the chat bound to a page for a user, or null when nothing is bound.
   * Joins the chat and re-checks ownership at read time so a stale row can never
   * surface a chat the user no longer owns / that left the workspace / was
   * soft-deleted: a deleted bound chat resolves to null (=> a fresh empty chat),
   * NOT a 500. There is deliberately no "newest chat on the page" fallback:
   * after "New chat" the row is gone, and a fallback would resurrect the
   * unbound chat.
   */
  async findChatIdByPage(
    userId: string,
    workspaceId: string,
    pageId: string,
  ): Promise<string | null> {
    const row = await this.db
      .selectFrom('aiChatPageBindings as b')
      .innerJoin('aiChats as c', 'c.id', 'b.chatId')
      .select('c.id as chatId')
      .where('b.userId', '=', userId)
      .where('b.pageId', '=', pageId)
      .where('c.creatorId', '=', userId) // never point at another user's chat
      .where('c.workspaceId', '=', workspaceId) // nor a cross-workspace chat
      .where('c.deletedAt', 'is', null) // a deleted chat => fresh chat, not a 500
      .executeTakeFirst();
    return row?.chatId ?? null;
  }

  /**
   * Upsert the binding (user, page) -> chat on the UNIQUE(user_id, page_id) key.
   * The conscious-open writer (history select) and the server's first-message
   * (birth) writer both use this.
   */
  async upsert(
    userId: string,
    pageId: string,
    chatId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .insertInto('aiChatPageBindings')
      .values({ userId, pageId, chatId })
      .onConflict((oc) =>
        oc.columns(['userId', 'pageId']).doUpdateSet({
          chatId,
          updatedAt: new Date(),
        }),
      )
      .execute();
  }

  /**
   * Clear the binding for (user, page) — "New chat" unbinds the page so reopening
   * yields a fresh empty chat. A no-op when nothing is bound.
   */
  async clear(
    userId: string,
    pageId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('aiChatPageBindings')
      .where('userId', '=', userId)
      .where('pageId', '=', pageId)
      .execute();
  }
}
