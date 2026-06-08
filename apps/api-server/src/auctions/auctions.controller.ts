import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuctionsService } from './auctions.service';
import { CancelAuctionDto } from './dto/cancel-auction.dto';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { PlaceBidDto } from './dto/place-bid.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';

@Controller('auctions')
export class AuctionsController {
  constructor(private readonly auctionsService: AuctionsService) {}

  @Post()
  @UseGuards(AuthGuard)
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateAuctionDto) {
    return this.auctionsService.create(dto);
  }

  @Get()
  findAll(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.auctionsService.findAll(Number(page ?? 1), Number(pageSize ?? 10));
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.auctionsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard)
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateAuctionDto) {
    return this.auctionsService.update(id, dto);
  }

  @Get(':id/leaderboard')
  leaderboard(@Param('id') id: string) {
    return this.auctionsService.getLeaderboard(id);
  }

  @Post(':id/start')
  @UseGuards(AuthGuard)
  @Roles(UserRole.ADMIN)
  start(@Param('id') id: string) {
    return this.auctionsService.start(id);
  }

  @Post(':id/cancel')
  @UseGuards(AuthGuard)
  @Roles(UserRole.ADMIN)
  cancel(@Param('id') id: string, @Body() dto: CancelAuctionDto) {
    return this.auctionsService.cancel(id, dto);
  }

  @Post(':id/bids')
  @UseGuards(AuthGuard)
  @Roles(UserRole.ADMIN, UserRole.BIDDER)
  placeBid(@Param('id') id: string, @Body() dto: PlaceBidDto, @CurrentUser() user: AuthUser) {
    return this.auctionsService.placeBid(id, dto, user);
  }
}
