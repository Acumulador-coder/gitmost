import { Module } from '@nestjs/common';
import { SpaceService } from './services/space.service';
import { SpaceController } from './space.controller';
import { SpaceMemberService } from './services/space-member.service';
import { GitSyncRestrictionsService } from '../../integrations/git-sync/services/git-sync-restrictions.service';

@Module({
  imports: [],
  controllers: [SpaceController],
  // GitSyncRestrictionsService backs the git-sync enable guard in
  // SpaceService.updateSpace. Provided here (it needs only the global Kysely
  // instance) because GitSyncModule is empty when GIT_SYNC_ENABLED is off.
  providers: [SpaceService, SpaceMemberService, GitSyncRestrictionsService],
  exports: [SpaceService, SpaceMemberService],
})
export class SpaceModule {}
