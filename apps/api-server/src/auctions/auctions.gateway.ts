import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { AuctionEventsService } from './auction-events.service';
import { AuctionsService } from './auctions.service';

@WebSocketGateway({
  cors: { origin: '*' },
})
export class AuctionsGateway {
  private readonly logger = new Logger(AuctionsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly auctionsService: AuctionsService,
    private readonly events: AuctionEventsService,
    private readonly authService: AuthService,
  ) {}

  afterInit(server: Server) {
    this.events.setServer(server);
  }

  @SubscribeMessage('joinAuction')
  async joinAuction(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { auctionId?: string; userId?: string; token?: string },
  ) {
    if (!body?.auctionId) {
      return { ok: false, message: 'auctionId is required' };
    }

    const auction = await this.auctionsService.findOne(body.auctionId);
    await client.join(this.events.room(body.auctionId));
    if (body.userId) {
      if (!body.token) {
        return { ok: false, message: 'token is required when joining as user' };
      }
      const user = await this.authService.authenticate(body.token);
      if (user.id !== body.userId) {
        return { ok: false, message: 'token user does not match userId' };
      }
      await client.join(this.events.userRoom(body.auctionId, body.userId));
    }
    client.emit('auctionSnapshot', await this.auctionsService.toSnapshot(auction));
    this.logger.debug(`client joined auction ${body.auctionId}`);
    return { ok: true };
  }

  @SubscribeMessage('leaveAuction')
  async leaveAuction(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { auctionId?: string },
  ) {
    if (!body?.auctionId) {
      return { ok: false, message: 'auctionId is required' };
    }

    await client.leave(this.events.room(body.auctionId));
    return { ok: true };
  }
}
