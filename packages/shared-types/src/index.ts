export enum AuctionStatus {
  DRAFT = 'DRAFT',
  SCHEDULED = 'SCHEDULED',
  RUNNING = 'RUNNING',
  SOLD = 'SOLD',
  UNSOLD = 'UNSOLD',
  CANCELLED = 'CANCELLED',
}

export enum OrderStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PAID = 'PAID',
}

export interface AuctionSnapshot {
  auctionId: string;
  status: AuctionStatus;
  incrementCent: number;
  capPriceCent: number;
  currentPriceCent: number;
  leaderUserId: string | null;
  endAt: string | null;
  version: number;
  seq: number;
  extensionSec?: number;
  cancelReason?: string | null;
  participantCount: number;
  leaderboard: LeaderboardItem[];
  serverTime: number;
}

export interface LeaderboardItem {
  rank: number;
  userId: string;
  nickname: string;
  amountCent: number;
}

export interface AuctionEvent<T> {
  auctionId: string;
  seq: number;
  version: number;
  serverTime: number;
  payload: T;
}

export interface PlaceBidRequest {
  requestId: string;
  userId: string;
  amountCent: number;
}
