import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLiveRoomDto } from './dto/create-live-room.dto';

@Injectable()
export class LiveRoomsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateLiveRoomDto) {
    return this.prisma.liveRoom.create({
      data: dto,
    });
  }

  findAll() {
    return this.prisma.liveRoom.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }
}

