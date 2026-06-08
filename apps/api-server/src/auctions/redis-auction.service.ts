import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

type AuctionState = {
  status: string;
  currentPriceCent: number;
  leaderUserId: string | null;
  endAt: Date;
  incrementCent: number;
  capPriceCent: number;
  extensionWindowSec: number;
  extensionSec: number;
  version: number;
  cancelReason?: string | null;
};

export type RedisBidResult =
  | { code: 'ACCEPTED'; state: AuctionState; extended: boolean }
  | { code: 'DUPLICATE' | 'MISSING' | 'NOT_RUNNING' | 'ENDED' | 'SELF_LEADING' }
  | { code: 'LOW'; minimumAmountCent: number };

const PLACE_BID_SCRIPT = `
local stateKey = KEYS[1]
local leaderboardKey = KEYS[2]
local requestKey = KEYS[3]
if redis.call('EXISTS', stateKey) == 0 then return {'MISSING'} end
if redis.call('EXISTS', requestKey) == 1 then return {'DUPLICATE'} end
local status = redis.call('HGET', stateKey, 'status')
if status ~= 'RUNNING' then return {'NOT_RUNNING'} end
if redis.call('HGET', stateKey, 'leaderUserId') == ARGV[1] then return {'SELF_LEADING'} end
local now = tonumber(ARGV[3])
local endAt = tonumber(redis.call('HGET', stateKey, 'endAt'))
if endAt <= now then return {'ENDED'} end
local currentPrice = tonumber(redis.call('HGET', stateKey, 'currentPriceCent'))
local increment = tonumber(redis.call('HGET', stateKey, 'incrementCent'))
local amount = tonumber(ARGV[2])
local minimum = currentPrice + increment
if amount < minimum then return {'LOW', tostring(minimum)} end
local cap = tonumber(redis.call('HGET', stateKey, 'capPriceCent'))
local accepted = math.min(amount, cap)
local sold = accepted >= cap
local extended = false
if not sold then
  local window = tonumber(redis.call('HGET', stateKey, 'extensionWindowSec'))
  if endAt - now <= window * 1000 then
    endAt = endAt + tonumber(redis.call('HGET', stateKey, 'extensionSec')) * 1000
    extended = true
  end
end
local version = tonumber(redis.call('HGET', stateKey, 'version')) + 1
local nextStatus = sold and 'SOLD' or 'RUNNING'
redis.call('HSET', stateKey,
  'status', nextStatus,
  'currentPriceCent', accepted,
  'leaderUserId', ARGV[1],
  'endAt', endAt,
  'version', version)
redis.call('ZADD', leaderboardKey, accepted, ARGV[1])
redis.call('SET', requestKey, '1', 'EX', ARGV[4])
return {'ACCEPTED', tostring(accepted), nextStatus, tostring(endAt), tostring(version), extended and '1' or '0'}
`;

const CANCEL_SCRIPT = `
local stateKey = KEYS[1]
if redis.call('EXISTS', stateKey) == 0 then return {'MISSING'} end
if redis.call('HGET', stateKey, 'status') ~= 'RUNNING' then return {'NOT_RUNNING'} end
local version = tonumber(redis.call('HGET', stateKey, 'version')) + 1
redis.call('HSET', stateKey, 'status', 'CANCELLED', 'cancelReason', ARGV[1], 'version', version)
return {'CANCELLED', tostring(version)}
`;

const FINISH_EXPIRED_SCRIPT = `
local stateKey = KEYS[1]
if redis.call('EXISTS', stateKey) == 0 then return {'MISSING'} end
if redis.call('HGET', stateKey, 'status') ~= 'RUNNING' then return {'NOT_RUNNING'} end
if tonumber(redis.call('HGET', stateKey, 'endAt')) > tonumber(ARGV[1]) then return {'NOT_EXPIRED'} end
local leaderUserId = redis.call('HGET', stateKey, 'leaderUserId')
local status = leaderUserId == '' and 'UNSOLD' or 'SOLD'
local version = tonumber(redis.call('HGET', stateKey, 'version')) + 1
redis.call('HSET', stateKey, 'status', status, 'version', version)
return {'FINISHED', status, leaderUserId, tostring(version)}
`;

@Injectable()
export class RedisAuctionService implements OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 2,
  });

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async initialize(auctionId: string, state: AuctionState) {
    await this.redis.hset(this.stateKey(auctionId), this.serialize(state));
    await this.redis.expire(this.stateKey(auctionId), 86400);
  }

  async restoreFromDatabase(
    auctionId: string,
    state: AuctionState,
    leaderboard: Array<{ userId: string; amountCent: number }>,
    failedRequestId?: string,
  ) {
    const stateKey = this.stateKey(auctionId);
    const leaderboardKey = this.leaderboardKey(auctionId);
    const pipeline = this.redis.pipeline();
    pipeline.del(stateKey);
    pipeline.del(leaderboardKey);
    pipeline.hset(stateKey, this.serialize(state));
    pipeline.expire(stateKey, 86400);
    for (const entry of leaderboard) {
      pipeline.zadd(leaderboardKey, entry.amountCent, entry.userId);
    }
    if (leaderboard.length > 0) {
      pipeline.expire(leaderboardKey, 86400);
    }
    if (failedRequestId) {
      pipeline.del(this.requestKey(auctionId, failedRequestId));
    }
    await pipeline.exec();
  }

  async getState(auctionId: string): Promise<AuctionState | null> {
    const state = await this.redis.hgetall(this.stateKey(auctionId));
    if (!Object.keys(state).length) return null;
    return {
      status: state.status,
      currentPriceCent: Number(state.currentPriceCent),
      leaderUserId: state.leaderUserId || null,
      endAt: new Date(Number(state.endAt)),
      incrementCent: Number(state.incrementCent),
      capPriceCent: Number(state.capPriceCent),
      extensionWindowSec: Number(state.extensionWindowSec),
      extensionSec: Number(state.extensionSec),
      version: Number(state.version),
      cancelReason: state.cancelReason || null,
    };
  }

  async placeBid(auctionId: string, requestId: string, userId: string, amountCent: number): Promise<RedisBidResult> {
    const result = await this.redis.eval(
      PLACE_BID_SCRIPT,
      3,
      this.stateKey(auctionId),
      this.leaderboardKey(auctionId),
      this.requestKey(auctionId, requestId),
      userId,
      amountCent,
      Date.now(),
      86400,
    ) as string[];
    if (result[0] !== 'ACCEPTED') {
      return result[0] === 'LOW'
        ? { code: 'LOW', minimumAmountCent: Number(result[1]) }
        : { code: result[0] as 'DUPLICATE' | 'MISSING' | 'NOT_RUNNING' | 'ENDED' | 'SELF_LEADING' };
    }
    const state = await this.getState(auctionId);
    if (!state) return { code: 'MISSING' };
    return { code: 'ACCEPTED', state, extended: result[5] === '1' };
  }

  async cancel(auctionId: string, reason: string) {
    const result = await this.redis.eval(CANCEL_SCRIPT, 1, this.stateKey(auctionId), reason) as string[];
    return { code: result[0], version: result[1] ? Number(result[1]) : undefined };
  }

  async finishExpired(auctionId: string) {
    const result = await this.redis.eval(
      FINISH_EXPIRED_SCRIPT,
      1,
      this.stateKey(auctionId),
      Date.now(),
    ) as string[];
    return {
      code: result[0],
      status: result[1],
      leaderUserId: result[2] || null,
      version: result[3] ? Number(result[3]) : undefined,
    };
  }

  async getLeaderboard(auctionId: string) {
    const members = await this.redis.zrevrange(this.leaderboardKey(auctionId), 0, 4, 'WITHSCORES');
    const participantCount = await this.redis.zcard(this.leaderboardKey(auctionId));
    return {
      entries: Array.from({ length: members.length / 2 }, (_, index) => ({
        userId: members[index * 2],
        amountCent: Number(members[index * 2 + 1]),
      })),
      participantCount,
    };
  }

  private serialize(state: AuctionState) {
    return {
      status: state.status,
      currentPriceCent: String(state.currentPriceCent),
      leaderUserId: state.leaderUserId ?? '',
      endAt: String(state.endAt.getTime()),
      incrementCent: String(state.incrementCent),
      capPriceCent: String(state.capPriceCent),
      extensionWindowSec: String(state.extensionWindowSec),
      extensionSec: String(state.extensionSec),
      version: String(state.version),
      cancelReason: state.cancelReason ?? '',
    };
  }

  private stateKey(auctionId: string) {
    return `auction:${auctionId}:state`;
  }

  private leaderboardKey(auctionId: string) {
    return `auction:${auctionId}:leaderboard`;
  }

  private requestKey(auctionId: string, requestId: string) {
    return `auction:${auctionId}:request:${requestId}`;
  }
}
