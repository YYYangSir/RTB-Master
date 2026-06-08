import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AuctionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuctionEventsService } from './auction-events.service';
import { evaluateBid } from './auction-rules';
import { AuthUser } from '../auth/auth.service';
import { CancelAuctionDto } from './dto/cancel-auction.dto';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { PlaceBidDto } from './dto/place-bid.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';
import { RedisAuctionService } from './redis-auction.service';
import { isPrismaUnavailableError } from '../prisma/prisma-errors';

@Injectable()
export class AuctionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuctionsService.name);
  private settlementTimer?: NodeJS.Timeout;
  private settling = false;
  private readonly bidRateBuckets = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AuctionEventsService,
    private readonly redisAuctions: RedisAuctionService,
  ) {}

  onModuleInit() {
    this.settlementTimer = setInterval(() => {
      void this.settleExpiredAuctions().catch((error: unknown) => {
        if (isPrismaUnavailableError(error)) {
          this.logger.warn(`Skip expired auction settlement while database is unavailable: ${this.messageOf(error)}`);
          return;
        }
        this.logger.error('Unexpected expired auction settlement failure', error instanceof Error ? error.stack : String(error));
      });
    }, 500);
  }

  onModuleDestroy() {
    if (this.settlementTimer) clearInterval(this.settlementTimer);
  }

  async create(dto: CreateAuctionDto) {
    if (dto.capPriceCent <= dto.startPriceCent) {
      throw new BadRequestException('capPriceCent must be greater than startPriceCent');
    }

    const [product, liveRoom] = await Promise.all([
      this.prisma.product.findUnique({ where: { id: dto.productId } }),
      this.prisma.liveRoom.findUnique({ where: { id: dto.liveRoomId } }),
    ]);

    if (!product) {
      throw new NotFoundException('product not found');
    }
    if (!liveRoom) {
      throw new NotFoundException('live room not found');
    }

    return this.prisma.auction.create({
      data: {
        ...dto,
        currentPriceCent: dto.startPriceCent,
      },
      include: {
        product: true,
        liveRoom: true,
      },
    });
  }

  async findOne(id: string) {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      include: {
        product: true,
        liveRoom: true,
        order: {
          include: {
            winner: true,
          },
        },
        bids: {
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: {
            user: {
              select: {
                id: true,
                nickname: true,
              },
            },
          },
        },
        _count: { select: { bids: true } },
      },
    });

    if (!auction) {
      throw new NotFoundException('auction not found');
    }

    return auction;
  }

  async findAll(page: number, pageSize: number) {
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safePageSize = Number.isInteger(pageSize) && pageSize > 0
      ? Math.min(pageSize, 100)
      : 10;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.auction.count(),
      this.prisma.auction.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        include: {
          product: true,
          liveRoom: true,
          order: true,
          _count: { select: { bids: true } },
        },
      }),
    ]);

    return {
      items,
      total,
      page: safePage,
      pageSize: safePageSize,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    };
  }

  async update(id: string, dto: UpdateAuctionDto) {
    const auction = await this.findOne(id);
    if (auction.status !== AuctionStatus.DRAFT && auction.status !== AuctionStatus.SCHEDULED) {
      throw new BadRequestException('only draft or scheduled auctions can be updated');
    }

    const nextStartPriceCent = dto.startPriceCent ?? auction.startPriceCent;
    const nextCapPriceCent = dto.capPriceCent ?? auction.capPriceCent;
    if (nextCapPriceCent <= nextStartPriceCent) {
      throw new BadRequestException('capPriceCent must be greater than startPriceCent');
    }

    return this.prisma.auction.update({
      where: { id },
      data: {
        ...dto,
        currentPriceCent: dto.startPriceCent ?? auction.currentPriceCent,
        version: { increment: 1 },
      },
      include: {
        product: true,
        liveRoom: true,
        order: true,
        _count: { select: { bids: true } },
      },
    });
  }

  async start(id: string) {
    const auction = await this.findOne(id);
    if (auction.status !== AuctionStatus.DRAFT && auction.status !== AuctionStatus.SCHEDULED) {
      throw new BadRequestException('only draft or scheduled auctions can be started');
    }

    const startAt = new Date();
    const endAt = new Date(startAt.getTime() + auction.durationSec * 1000);

    const updated = await this.prisma.auction.update({
      where: { id },
      data: {
        status: AuctionStatus.RUNNING,
        startAt,
        endAt,
        version: { increment: 1 },
      },
      include: {
        product: true,
        liveRoom: true,
      },
    });
    await this.redisAuctions.initialize(id, this.redisState(updated));
    this.events.emit(id, 'auctionStarted', await this.toSnapshot(updated));
    return updated;
  }

  async placeBid(id: string, dto: PlaceBidDto, actor?: AuthUser) {
    let redisAccepted = false;
    try {
      if (actor && actor.id !== dto.userId) {
        throw new BadRequestException('authenticated user can only bid as self');
      }
      this.ensureBidRateLimit(id, dto.userId);
      const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
      if (!user) throw new NotFoundException('user not found');

      let previousLeaderUserId = (await this.redisAuctions.getState(id))?.leaderUserId ?? null;
      let redisResult = await this.redisAuctions.placeBid(id, dto.requestId, dto.userId, dto.amountCent);
      if (redisResult.code === 'MISSING') {
        await this.initializeRedisFromDatabase(id);
        previousLeaderUserId = (await this.redisAuctions.getState(id))?.leaderUserId ?? null;
        redisResult = await this.redisAuctions.placeBid(id, dto.requestId, dto.userId, dto.amountCent);
      }
      if (redisResult.code === 'DUPLICATE') {
        const [bid, auction] = await Promise.all([
          this.prisma.bid.findUnique({ where: { requestId: dto.requestId } }),
          this.findOne(id),
        ]);
        return {
          accepted: true,
          duplicate: true,
          extended: false,
          bid,
          auction,
          snapshot: await this.toSnapshot(auction),
        };
      }
      if (redisResult.code === 'LOW') {
        throw new BadRequestException(`amountCent must be at least ${redisResult.minimumAmountCent}`);
      }
      if (redisResult.code === 'ENDED') {
        throw new BadRequestException('auction has ended');
      }
      if (redisResult.code === 'SELF_LEADING') {
        throw new BadRequestException('current leader cannot bid again until another user leads');
      }
      if (redisResult.code !== 'ACCEPTED') {
        throw new BadRequestException('auction is not running');
      }

      const state = redisResult.state;
      const result = await this.prisma.$transaction(async (tx) => {
        redisAccepted = true;
        await tx.auction.updateMany({
          where: { id, version: { lt: state.version } },
          data: {
            currentPriceCent: state.currentPriceCent,
            leaderUserId: state.leaderUserId,
            status: state.status as AuctionStatus,
            endAt: state.endAt,
            version: state.version,
          },
        });
        const bid = await tx.bid.create({
          data: {
            auctionId: id,
            userId: dto.userId,
            requestId: dto.requestId,
            amountCent: state.currentPriceCent,
          },
        });
        if (
          state.status === AuctionStatus.SOLD &&
          process.env.AUCTION_TEST_FAIL_ORDER_CREATE === '1'
        ) {
          throw new Error('test order generation failure');
        }
        const order = state.status === AuctionStatus.SOLD
          ? await tx.order.upsert({
              where: { auctionId: id },
              update: {},
              create: {
                auctionId: id,
                winnerUserId: dto.userId,
                amountCent: state.currentPriceCent,
              },
            })
          : null;
        return {
          accepted: true,
          duplicate: false,
          extended: redisResult.extended,
          bid,
          order,
          auction: await tx.auction.findUniqueOrThrow({ where: { id } }),
        };
      });
      if (result.auction) {
        const snapshot = await this.toSnapshot(result.auction);
        const event = {
          ...snapshot,
          bid: result.bid,
          order: result.order,
        };
        this.events.emit(id, 'bidAccepted', event);
        if (previousLeaderUserId && previousLeaderUserId !== dto.userId) {
          this.events.emitToUser(id, previousLeaderUserId, 'outbid', {
            auctionId: id,
            previousLeaderUserId,
            newLeaderUserId: dto.userId,
            currentPriceCent: result.auction.currentPriceCent,
            serverTime: Date.now(),
          });
        }
        if (redisResult.extended) {
          this.events.emit(id, 'auctionExtended', event);
        }
        if (result.auction.status === AuctionStatus.SOLD) {
          this.events.emit(id, 'auctionEnded', event);
        }
      }
      return result.auction
        ? { ...result, snapshot: await this.toSnapshot(result.auction) }
        : result;
    } catch (error) {
      if (typeof redisAccepted !== 'undefined' && redisAccepted) {
        await this.restoreRedisFromDatabase(id, dto.requestId);
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException('duplicate bid or order');
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || error.code === 'P2028')
      ) {
        throw new ConflictException('auction state changed, retry bid');
      }
      throw error;
    }
  }

  async cancel(id: string, dto: CancelAuctionDto) {
    const auction = await this.findOne(id);
    if (auction.status !== AuctionStatus.RUNNING) {
      throw new BadRequestException('only running auctions can be cancelled');
    }

    await this.ensureRedisState(auction);
    const reason = dto.reason?.trim() || '主播异常取消';
    const redisResult = await this.redisAuctions.cancel(id, reason);
    if (redisResult.code !== 'CANCELLED' || redisResult.version === undefined) {
      throw new ConflictException('auction state changed, retry cancel');
    }
    await this.prisma.auction.updateMany({
      where: { id, version: { lt: redisResult.version } },
      data: {
        status: AuctionStatus.CANCELLED,
        cancelReason: reason,
        version: redisResult.version,
      },
    });
    const updated = await this.prisma.auction.findUniqueOrThrow({
      where: { id },
      include: {
        product: true,
        liveRoom: true,
      },
    });
    const event = await this.toSnapshot(updated);
    this.events.emit(id, 'auctionCancelled', event);
    return updated;
  }

  private async settleExpiredAuctions() {
    if (this.settling) return;
    this.settling = true;
    try {
      const auctions = await this.prisma.auction.findMany({
        where: {
          status: AuctionStatus.RUNNING,
          endAt: { lte: new Date() },
        },
      });
      await Promise.all(auctions.map((auction) => this.settleExpiredAuction(auction)));
    } finally {
      this.settling = false;
    }
  }

  private async settleExpiredAuction(auction: {
    id: string;
    status: AuctionStatus;
    currentPriceCent: number;
    leaderUserId: string | null;
    endAt: Date | null;
    incrementCent: number;
    capPriceCent: number;
    extensionWindowSec: number;
    extensionSec: number;
    version: number;
    cancelReason: string | null;
  }) {
    await this.ensureRedisState(auction);
    const result = await this.redisAuctions.finishExpired(auction.id);
    if (result.code !== 'FINISHED' || !result.status || result.version === undefined) return;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.auction.updateMany({
        where: { id: auction.id, version: { lt: result.version } },
        data: {
          status: result.status as AuctionStatus,
          version: result.version,
        },
      });
      const current = await tx.auction.findUniqueOrThrow({ where: { id: auction.id } });
      const order = result.status === AuctionStatus.SOLD && result.leaderUserId
        ? await tx.order.upsert({
            where: { auctionId: auction.id },
            update: {},
            create: {
              auctionId: auction.id,
              winnerUserId: result.leaderUserId,
              amountCent: current.currentPriceCent,
            },
          })
        : null;
      return { auction: current, order };
    });
    this.events.emit(auction.id, 'auctionEnded', {
      ...await this.toSnapshot(updated.auction),
      order: updated.order,
    });
  }

  async getLeaderboard(auctionId: string) {
    const redisState = await this.redisAuctions.getState(auctionId);
    if (redisState) {
      const { entries, participantCount } = await this.redisAuctions.getLeaderboard(auctionId);
      const users = await this.prisma.user.findMany({
        where: { id: { in: entries.map((entry) => entry.userId) } },
        select: { id: true, nickname: true },
      });
      const nicknameById = new Map(users.map((user) => [user.id, user.nickname]));
      return {
        leaderboard: entries.map((entry, index) => ({
          rank: index + 1,
          ...entry,
          nickname: nicknameById.get(entry.userId) ?? '未知用户',
        })),
        participantCount,
      };
    }
    return this.getDatabaseLeaderboard(auctionId);
  }

  private async getDatabaseLeaderboard(auctionId: string) {
    const rows = await this.prisma.bid.groupBy({
      by: ['userId'],
      where: { auctionId },
      _max: { amountCent: true },
      orderBy: { _max: { amountCent: 'desc' } },
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((row) => row.userId) } },
      select: { id: true, nickname: true },
    });
    const nicknameById = new Map(users.map((user) => [user.id, user.nickname]));
    return {
      leaderboard: rows.slice(0, 5).map((row, index) => ({
        rank: index + 1,
        userId: row.userId,
        nickname: nicknameById.get(row.userId) ?? '未知用户',
        amountCent: row._max.amountCent ?? 0,
      })),
      participantCount: rows.length,
    };
  }

  async toSnapshot(auction: {
    id: string;
    status: AuctionStatus;
    currentPriceCent: number;
    leaderUserId: string | null;
    endAt: Date | null;
    version: number;
    incrementCent?: number;
    capPriceCent?: number;
    extensionSec?: number;
    cancelReason?: string | null;
  }) {
    const [redisState, leaderboardState] = await Promise.all([
      this.redisAuctions.getState(auction.id),
      this.getLeaderboard(auction.id),
    ]);
    const state = redisState ?? auction;
    return {
      auctionId: auction.id,
      status: state.status,
      currentPriceCent: state.currentPriceCent,
      leaderUserId: state.leaderUserId,
      endAt: state.endAt,
      version: state.version,
      seq: state.version,
      incrementCent: state.incrementCent,
      capPriceCent: state.capPriceCent,
      extensionSec: state.extensionSec,
      cancelReason: state.cancelReason,
      ...leaderboardState,
      serverTime: Date.now(),
    };
  }

  private async initializeRedisFromDatabase(id: string) {
    const auction = await this.findOne(id);
    await this.ensureRedisState(auction);
  }

  private async restoreRedisFromDatabase(id: string, failedRequestId?: string) {
    const auction = await this.findOne(id);
    const leaderboard = await this.getDatabaseLeaderboard(id);
    await this.redisAuctions.restoreFromDatabase(
      id,
      this.redisState(auction),
      leaderboard.leaderboard.map((entry) => ({
        userId: entry.userId,
        amountCent: entry.amountCent,
      })),
      failedRequestId,
    );
  }

  private async ensureRedisState(auction: {
    id: string;
    status: AuctionStatus;
    currentPriceCent: number;
    leaderUserId: string | null;
    endAt: Date | null;
    incrementCent: number;
    capPriceCent: number;
    extensionWindowSec: number;
    extensionSec: number;
    version: number;
    cancelReason?: string | null;
  }) {
    if (await this.redisAuctions.getState(auction.id)) return;
    if (!auction.endAt) throw new BadRequestException('auction has not started');
    await this.redisAuctions.initialize(auction.id, this.redisState(auction));
  }

  private redisState(auction: {
    status: AuctionStatus;
    currentPriceCent: number;
    leaderUserId: string | null;
    endAt: Date | null;
    incrementCent: number;
    capPriceCent: number;
    extensionWindowSec: number;
    extensionSec: number;
    version: number;
    cancelReason?: string | null;
  }) {
    if (!auction.endAt) throw new BadRequestException('auction has not started');
    return { ...auction, endAt: auction.endAt };
  }

  private ensureBidRateLimit(auctionId: string, userId: string) {
    const key = `${auctionId}:${userId}`;
    const now = Date.now();
    const windowMs = 1000;
    const limit = 60;
    const recent = (this.bidRateBuckets.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= limit) {
      this.bidRateBuckets.set(key, recent);
      throw new HttpException('too many bid requests, slow down', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.bidRateBuckets.set(key, recent);
  }

  private messageOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
