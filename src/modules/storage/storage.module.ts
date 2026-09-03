import { Module, Global } from '@nestjs/common';
import { DrivePoolService } from './drive-pool.service';
import { DriveRouterService } from './drive-router.service';
import { DriveController } from './drive.controller';

@Global()
@Module({
  controllers: [DriveController],
  providers: [DrivePoolService, DriveRouterService],
  exports: [DrivePoolService, DriveRouterService],
})
export class StorageModule {}
