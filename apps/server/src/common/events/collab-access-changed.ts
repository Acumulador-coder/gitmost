import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventName } from './event.contants';

/**
 * CO-2 — the payload of COLLAB_ACCESS_CHANGED, emitted once a change of who may
 * open which pages is committed. The collaboration server re-checks the open
 * connections of `workspaceId`; each optional field present narrows them to
 * the pages of that space, those pages, and those users' connections.
 */
export interface CollabAccessChangedEvent {
  workspaceId: string;
  spaceId?: string;
  pageIds?: string[];
  userIds?: string[];
}

const logger = new Logger('CollabAccessChanged');

/**
 * Emit COLLAB_ACCESS_CHANGED, fire and forget: the access change is already
 * committed, so a failure here is logged, never thrown into the caller.
 */
export function emitCollabAccessChanged(
  eventEmitter: EventEmitter2,
  event: CollabAccessChangedEvent,
): void {
  try {
    eventEmitter.emit(EventName.COLLAB_ACCESS_CHANGED, event);
  } catch (err) {
    logger.error(
      `COLLAB_ACCESS_CHANGED emit failed for workspace ${event.workspaceId}; ` +
        `open collaboration documents keep their access until the next token ` +
        `re-check or reconnect: ` +
        (err instanceof Error ? err.message : String(err)),
      err instanceof Error ? err.stack : undefined,
    );
  }
}
