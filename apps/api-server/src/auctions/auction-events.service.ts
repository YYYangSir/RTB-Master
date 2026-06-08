import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

@Injectable()
export class AuctionEventsService {
  private server?: Server;

  setServer(server: Server) {
    this.server = server;
  }

  emit(auctionId: string, event: string, payload: unknown) {
    this.server?.to(this.room(auctionId)).emit(event, payload);
  }

  emitToUser(auctionId: string, userId: string, event: string, payload: unknown) {
    this.server?.to(this.userRoom(auctionId, userId)).emit(event, payload);
  }

  room(auctionId: string) {
    return `auction:${auctionId}`;
  }

  userRoom(auctionId: string, userId: string) {
    return `auction:${auctionId}:user:${userId}`;
  }
}
