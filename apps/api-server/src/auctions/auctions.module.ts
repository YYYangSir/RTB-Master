import { Module } from '@nestjs/common';
import { AuctionEventsService } from './auction-events.service';
import { AuctionsController } from './auctions.controller';
import { AuctionsGateway } from './auctions.gateway';
import { AuctionsService } from './auctions.service';
import { RedisAuctionService } from './redis-auction.service';

@Module({
  controllers: [AuctionsController],
  providers: [AuctionEventsService, RedisAuctionService, AuctionsService, AuctionsGateway],
})
export class AuctionsModule {}
