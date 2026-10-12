/**
 * Pure helpers for adopting a brand-new chat's authoritative server id.
 *
 * This docblock is the single authoritative explanation of the new-chat id
 * adoption design. Other call sites (use-chat-session.ts, the server's
 * `chatStreamMetadata`) reference here rather than restating it.
 *
 * When a user sends the first turn of a BRAND-NEW chat, the client has no chat
 * id yet (`activeChatId === null`). The server creates the row and the client
 * must "adopt" that row's real id so the SECOND turn targets the same chat.
 * Adopting the newest chat in the refetched list would race a second tab that
 * created a chat at the same moment (this tab would adopt the SIBLING chat and
 * leak its later turns into it), so we adopt by IDENTITY, two ways:
 *
 * PRIMARY path: the server streams the real chat id on the assistant message
 * metadata's `start` part (see `chatStreamMetadata` server-side);
 * `extractServerChatId` reads it off the finished message and
 * `resolveAdoptedChatId` turns it into the id to adopt for a new chat. This is
 * authoritative and immune to the race.
 *
 * FALLBACK path (only when a new chat's first turn errors BEFORE the `start`
 * chunk, so no metadata id ever reached the client): adopt the single chat that
 * NEWLY appeared in the per-user list relative to a pre-refetch snapshot —
 * `newlyAddedChatIds` (the fallback effect adopts only when exactly one id is
 * new). This is unambiguous and does not race a second tab.
 */

/**
 * Resolve the id to adopt from the server-streamed metadata. Returns
 * `serverChatId` only for a brand-new chat (`activeChatId === null`) that
 * received a truthy id; otherwise null (existing chat, or no id streamed).
 */
export function resolveAdoptedChatId(
  activeChatId: string | null,
  serverChatId: string | null | undefined,
): string | null {
  return activeChatId === null && serverChatId ? serverChatId : null;
}

/**
 * Read the authoritative server chat id off a finished assistant message. The
 * server attaches it as `message.metadata.chatId` on the `start` part (see
 * `chatStreamMetadata`). Returns it only when it is a string; undefined for
 * a missing message, missing metadata, or a non-string `chatId`.
 */
export function extractServerChatId(
  message: { metadata?: unknown } | undefined,
): string | undefined {
  const m = message?.metadata as { chatId?: string } | undefined;
  return typeof m?.chatId === "string" ? m.chatId : undefined;
}

/**
 * #488: read the authoritative RUN id off a streaming assistant message. The
 * server attaches it as `message.metadata.runId` on the `start` part when a run
 * wraps the turn (see server `chatStreamMetadata`, #184/#487). This is the live
 * run-fact update the client FSM adopts (mirrors `extractServerChatId`). Returns
 * it only when it is a string; undefined otherwise.
 */
export function extractRunId(
  message: { metadata?: unknown } | undefined,
): string | undefined {
  const m = message?.metadata as { runId?: string } | undefined;
  return typeof m?.runId === "string" ? m.runId : undefined;
}

/**
 * The deduped set of ids present in `afterIds` but not in `beforeIds`. A
 * paginated/flatMapped list can repeat the same id, so dedupe: one genuinely-new
 * chat must not read as multiple from a duplicate.
 */
export function newlyAddedChatIds(
  beforeIds: readonly string[],
  afterIds: readonly string[],
): Set<string> {
  const before = new Set(beforeIds);
  return new Set(afterIds.filter((id) => !before.has(id)));
}
