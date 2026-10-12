// TTL for the cached spaceHasRestrictions verdict (see WsService). This cache is
// a read-side fast path: while it is `false`, emitTreeEvent/emitCommentEvent
// broadcast page-bearing payloads to the WHOLE space room. If a space gains its
// first restriction (or loses its last one), the verdict goes stale for up to
// this TTL, during which a title/icon-bearing payload could fan out to
// now-unauthorized sockets. Kept short because no restriction-mutation path
// calls WsService.invalidateSpaceRestrictionCache yet.
export const WS_CACHE_TTL_MS = 3_000;
export const WS_SPACE_RESTRICTION_CACHE_PREFIX = 'ws:space-restrictions:';

export function getSpaceRoomName(spaceId: string): string {
  return `space-${spaceId}`;
}

export function getUserRoomName(userId: string): string {
  return `user-${userId}`;
}
