import { Injectable } from '@nestjs/common';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';

/**
 * Why git-sync refuses a space with page-level restrictions. git-sync exports
 * every page of a space into one vault that any space member can clone, and
 * writes pushed files as the service user, so it cannot enforce a page-level
 * access list (GA-2 / GA-3 / GA-4). Shared by every refusal so the operator and
 * the admin see the same reason.
 */
export const GIT_SYNC_RESTRICTED_SPACE_REASON =
  'the space contains pages with page-level access restrictions, which git ' +
  'sync cannot enforce (every space member could read them through a git ' +
  'clone, and a push would edit or move them without the page-level check)';

/**
 * The single predicate behind "git-sync refuses a space that contains a page
 * with page-level restrictions": the space-settings enable guard, the
 * orchestrator's per-cycle refusal and the `/git` gate all call it.
 */
@Injectable()
export class GitSyncRestrictionsService {
  constructor(private readonly pagePermissionRepo: PagePermissionRepo) {}

  /**
   * True when any page of the space carries a page-level restriction (a
   * `page_access` row). Trashed pages count too: git-sync can restore them.
   * A page moved to another space loses its `page_access` row (PageService
   * clears it on the move), so the row's space is always the page's space.
   */
  async spaceHasRestrictedPages(
    spaceId: string,
    // Kept for the callers' shape; a space id is unique across workspaces.
    workspaceId: string,
  ): Promise<boolean> {
    return this.pagePermissionRepo.hasRestrictedPagesInSpace(spaceId);
  }
}
