import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import './styles.css';

const API_URL = 'http://127.0.0.1:3000/api';
const SOCKET_URL = 'http://127.0.0.1:3000';

type AuctionState = {
  id?: string;
  auctionId?: string;
  status: string;
  currentPriceCent: number;
  incrementCent?: number;
  capPriceCent?: number;
  leaderUserId: string | null;
  endAt: string | null;
  version: number;
  extensionSec?: number;
  cancelReason?: string | null;
  leaderboard?: LeaderboardItem[];
  participantCount?: number;
  product?: ProductState;
  liveRoom?: { title: string };
  order?: OrderState | null;
};

type ProductState = {
  name: string;
  description: string;
  imageUrl?: string | null;
};

type LeaderboardItem = {
  rank: number;
  userId: string;
  nickname: string;
  amountCent: number;
};

type OrderState = {
  id: string;
  amountCent: number;
  status: 'PENDING_PAYMENT' | 'PAID';
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? '请求失败');
  return body;
}

function yuan(cent = 0) {
  return `¥${(cent / 100).toFixed(2)}`;
}

function remaining(endAt: string | null | undefined, now: number) {
  if (!endAt) return '-';
  return `${Math.max(0, Math.ceil((new Date(endAt).getTime() - now) / 1000))} 秒`;
}

function statusText(status?: string) {
  return {
    DRAFT: '等待主播开拍',
    RUNNING: '竞拍进行中',
    SOLD: '竞拍已成交',
    UNSOLD: '本场已流拍',
    CANCELLED: '竞拍已取消',
  }[status ?? ''] ?? '尚未加入竞拍';
}

export function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [auctionId, setAuctionId] = useState('');
  const [joinedAuctionId, setJoinedAuctionId] = useState('');
  const [auction, setAuction] = useState<AuctionState | null>(null);
  const [userId, setUserId] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [nickname, setNickname] = useState('竞拍用户');
  const [message, setMessage] = useState('请先创建演示用户并加入竞拍');
  const [order, setOrder] = useState<OrderState | null>(null);
  const [now, setNow] = useState(Date.now());
  const joinedAuctionIdRef = useRef('');
  const userIdRef = useRef('');
  const authTokenRef = useRef('');

  function mergeAuction(data: AuctionState) {
    setAuction((current) => ({ ...current, ...data }));
  }

  useEffect(() => {
    joinedAuctionIdRef.current = joinedAuctionId;
  }, [joinedAuctionId]);

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const instance = io(SOCKET_URL);
    instance.on('connect', () => {
      setConnected(true);
      if (joinedAuctionIdRef.current) {
        instance.emit('joinAuction', {
          auctionId: joinedAuctionIdRef.current,
          userId: userIdRef.current,
          token: authTokenRef.current,
        });
        setMessage('实时连接已恢复，竞拍状态已同步');
      }
    });
    instance.on('disconnect', () => setConnected(false));
    instance.on('auctionSnapshot', mergeAuction);
    instance.on('auctionStarted', mergeAuction);
    instance.on('bidAccepted', (data: AuctionState) => {
      setAuction((previous) => {
        if (
          previous?.leaderUserId === userIdRef.current &&
          data.leaderUserId !== userIdRef.current
        ) {
          setMessage('你已被超越，可以继续出价');
        }
        return { ...previous, ...data };
      });
    });
    instance.on('auctionExtended', (data: AuctionState) => {
      mergeAuction(data);
      setMessage(`竞拍已延时 ${data.extensionSec ?? 20} 秒`);
    });
    instance.on('outbid', () => {
      setMessage('你已被超越，可以继续出价');
    });
    instance.on('auctionCancelled', (data: AuctionState) => {
      mergeAuction(data);
      setMessage(`竞拍已取消：${data.cancelReason ?? '主播异常取消'}`);
    });
    instance.on('auctionEnded', (data: AuctionState) => {
      mergeAuction(data);
      setOrder(data.order ?? null);
      setMessage('竞拍已成交');
    });
    setSocket(instance);
    return () => {
      instance.close();
    };
  }, []);

  const minimumBidCent = useMemo(
    () => (auction?.currentPriceCent ?? 0) + (auction?.incrementCent ?? 10000),
    [auction],
  );

  async function createUser() {
    try {
      const login = await request<{ token: string; user: { id: string } }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ nickname, role: 'BIDDER' }),
      });
      setUserId(login.user.id);
      setAuthToken(login.token);
      setMessage(`用户已创建：${nickname}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建用户失败');
    }
  }

  async function joinAuction(event: FormEvent) {
    event.preventDefault();
    if (!socket || !auctionId) return;
    if (joinedAuctionId) socket.emit('leaveAuction', { auctionId: joinedAuctionId });
    try {
      const detail = await request<AuctionState>(`/auctions/${auctionId}`);
      setAuction(detail);
      socket.emit('joinAuction', { auctionId, userId, token: authToken });
      setJoinedAuctionId(auctionId);
      setMessage('已加入竞拍房间');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加入竞拍失败');
    }
  }

  async function placeBid() {
    if (!userId || !joinedAuctionId) {
      setMessage('请先创建用户并加入竞拍');
      return;
    }
    try {
      const result = await request<{ duplicate: boolean; auction: AuctionState; snapshot?: AuctionState; order?: OrderState | null }>(
        `/auctions/${joinedAuctionId}/bids`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            userId,
            amountCent: minimumBidCent,
          }),
        },
      );
      mergeAuction(result.snapshot ?? result.auction);
      if (result.order) setOrder(result.order);
      setMessage(result.duplicate ? '重复请求已忽略' : '出价成功');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '出价失败');
    }
  }

  async function pay() {
    if (!order) return;
    try {
      const paid = await request<OrderState>(`/orders/${order.id}/pay`, {
        method: 'POST',
      });
      setOrder(paid);
      setMessage('模拟支付成功');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '支付失败');
    }
  }

  const isWinner = auction?.status === 'SOLD' && auction.leaderUserId === userId;
  const leader = auction?.leaderboard?.find((item) => item.userId === auction.leaderUserId);

  return (
    <main className="phone">
      <header>
        <p className="eyebrow">LIVE AUCTION</p>
        <h1>直播竞拍</h1>
        <span className={connected ? 'badge online' : 'badge offline'}>
          {connected ? '实时连接正常' : '连接中断'}
        </span>
      </header>

      <section className="video">
        <span className="live-tag">LIVE</span>
        <strong>{auction?.liveRoom?.title ?? '珠宝竞拍直播间'}</strong>
        <span>主播正在展示商品，直播画面为演示占位</span>
      </section>

      <section className="product-card">
        <div className="product-image">
          {auction?.product?.imageUrl
            ? <img src={auction.product.imageUrl} alt={auction.product.name} />
            : <span>拍卖品展示图</span>}
        </div>
        <div>
          <small>本场拍卖品</small>
          <h2>{auction?.product?.name ?? '等待加入竞拍'}</h2>
          <p>{auction?.product?.description ?? '加入直播间后查看商品详情与竞拍规则。'}</p>
        </div>
      </section>

      {!joinedAuctionId ? (
        <section className="card join-card">
          <h2>快速加入竞拍</h2>
          <label>昵称<input value={nickname} onChange={(event) => setNickname(event.target.value)} /></label>
          <button className="secondary" onClick={createUser}>创建演示用户</button>
          <small>用户 ID：{userId || '尚未创建'}</small>
          <form onSubmit={joinAuction}>
            <label>竞拍 ID<input value={auctionId} onChange={(event) => setAuctionId(event.target.value)} required /></label>
            <button className="secondary" type="submit">加入直播间</button>
          </form>
        </section>
      ) : (
        <section className="session">
          <span>当前用户：{nickname}</span>
          <small>竞拍 ID：{joinedAuctionId}</small>
        </section>
      )}

      <section className="card auction-card">
        <div className={`auction-state ${auction?.status?.toLowerCase() ?? ''}`}>
          {statusText(auction?.status)}
        </div>
        <div className="price">
          <span>当前价格</span>
          <strong>{yuan(auction?.currentPriceCent)}</strong>
        </div>
        <div className="rule-grid">
          <span><small>最低可出价</small><b>{yuan(minimumBidCent)}</b></span>
          <span><small>封顶价</small><b>{yuan(auction?.capPriceCent)}</b></span>
          <span><small>剩余时间</small><b>{remaining(auction?.endAt, now)}</b></span>
        </div>
        <div className="details">
          <span>当前领先：{leader?.nickname ?? '暂无用户领先'}</span>
          <span>参与人数：{auction?.participantCount ?? 0}</span>
        </div>
        <button className="bid" disabled={auction?.status !== 'RUNNING'} onClick={placeBid}>
          出价 {yuan(minimumBidCent)}
        </button>
        {isWinner && <p className="winner">竞拍成功，你是赢家</p>}
        {auction?.status === 'SOLD' && !isWinner && <p className="ended">竞拍已结束</p>}
        {auction?.status === 'CANCELLED' && <p className="ended">竞拍已取消：{auction.cancelReason}</p>}
        <div className="leaderboard">
          <strong>实时排行榜</strong>
          {auction?.leaderboard?.length ? (
            <ol>
              {auction.leaderboard.map((item) => (
                <li className={item.userId === userId ? 'me' : ''} key={item.userId}>
                  <span>#{item.rank} {item.nickname}</span>
                  <b>{yuan(item.amountCent)}</b>
                </li>
              ))}
            </ol>
          ) : <small>等待第一位用户出价</small>}
        </div>
        {isWinner && order && (
          <div className="order">
            <strong>成交订单</strong>
            <span>订单号：{order.id}</span>
            <span>成交价：{yuan(order.amountCent)}</span>
            <span>支付状态：{order.status}</span>
            <button className="pay" disabled={order.status === 'PAID'} onClick={pay}>
              {order.status === 'PAID' ? '已完成模拟支付' : '模拟支付'}
            </button>
          </div>
        )}
        <p className="notice">现场提示：{message}</p>
      </section>
    </main>
  );
}
