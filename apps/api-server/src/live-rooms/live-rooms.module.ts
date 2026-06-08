import { Module } from '@nestjs/common';
import { LiveRoomsController } from './live-rooms.controller';
import { LiveRoomsService } from './live-rooms.service';

@Module({
  controllers: [LiveRoomsController],
  providers: [LiveRoomsService],
})
export class LiveRoomsModule {}

