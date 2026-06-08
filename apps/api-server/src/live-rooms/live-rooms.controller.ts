import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateLiveRoomDto } from './dto/create-live-room.dto';
import { LiveRoomsService } from './live-rooms.service';

@Controller('live-rooms')
export class LiveRoomsController {
  constructor(private readonly liveRoomsService: LiveRoomsService) {}

  @Post()
  @UseGuards(AuthGuard)
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateLiveRoomDto) {
    return this.liveRoomsService.create(dto);
  }

  @Get()
  findAll() {
    return this.liveRoomsService.findAll();
  }
}
