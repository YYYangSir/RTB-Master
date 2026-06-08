import { FormEvent, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import './styles.css';

const API_URL = 'http://127.0.0.1:3000/api';
const SOCKET_URL = 'http://127.0.0.1:3000';

type AuctionState = {
  id?: string;
  auctionId?: string;
  status: string;
  startPriceCent?: number;
  incrementCent?: number;
  capPriceCent?: number;
  currentPriceCent: number;
  leaderUserId: string | null;
  endAt: string | null;
  version: number;
  extensionSec?: number;
  cancelReason?: string | null;
  leaderboard?: LeaderboardItem[];
  participantCount?: number;
  product?: ProductState;
  liveRoom?: { title: string };
  createdAt?: string;
  durationSec?: number;
  extensionWindowSec?: number;
  _count?: { bids: number };
  bids?: BidRecord[];
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

type BidRecord = {
  id: string;
  amountCent: number;
  createdAt: string;
  user: {
    id: string;
    nickname: string;
  };
};

type OrderState = {
  id: string;
  amountCent: number;
  status: string;
  winner?: {
    nickname: string;
  };
};

type AuctionPage = {
  items: AuctionState[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

function yuan(cent: number) {
  return `¥${(cent / 100).toFixed(2)}`;
}

function remaining(endAt: string | null | undefined, now: number) {
  if (!endAt) return '-';
  return `${Math.max(0, Math.ceil((new Date(endAt).getTime() - now) / 1000))} 秒`;
}

function formatTime(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.message ?? '请求失败');
  }
  return body;
}

function statusText(status?: string) {
  return {
    DRAFT: '待开始',
    RUNNING: '竞拍中',
    SOLD: '已成交',
    UNSOLD: '已流拍',
    CANCELLED: '已取消',
  }[status ?? ''] ?? '尚未创建';
}

export function App() {
  const [adminToken, setAdminToken] = useState('');
  const [adminName, setAdminName] = useState('演示主播');
  const [auctionId, setAuctionId] = useState('');
  const [auction, setAuction] = useState<AuctionState | null>(null);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState('请创建一场竞拍');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [now, setNow] = useState(Date.now());
  const auctionIdRef = useRef('');
  const auctionPageRef = useRef(1);
  const [events, setEvents] = useState<string[]>(['等待创建竞拍']);
  const [auctions, setAuctions] = useState<AuctionState[]>([]);
  const [auctionPage, setAuctionPage] = useState(1);
  const [auctionTotal, setAuctionTotal] = useState(0);
  const [auctionTotalPages, setAuctionTotalPages] = useState(1);

  function pushEvent(text: string) {
    setEvents((current) => [text, ...current].slice(0, 6));
  }

  async function adminRequest<T>(path: string, init?: RequestInit) {
    return request<T>(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        ...init?.headers,
      },
    });
  }

  async function loginAdmin() {
    try {
      const result = await request<{ token: string; user: { nickname: string } }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ nickname: adminName, role: 'ADMIN' }),
      });
      setAdminToken(result.token);
      setMessage(`主播身份已登录：${result.user.nickname}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '主播登录失败');
    }
  }

  function mergeAuction(data: AuctionState) {
    setAuction((current) => ({ ...current, ...data }));
    void refreshAuctions();
  }

  async function refreshAuctions(page = auctionPageRef.current) {
    try {
      const result = await request<AuctionPage>(`/auctions?page=${page}&pageSize=10`);
      setAuctions(result.items);
      setAuctionPage(result.page);
      auctionPageRef.current = result.page;
      setAuctionTotal(result.total);
      setAuctionTotalPages(result.totalPages);
    } catch {
      // The control panel remains usable if the history refresh fails temporarily.
    }
  }

  async function refreshSelectedAuction(id = auctionIdRef.current) {
    if (!id) return;
    try {
      setAuction(await request<AuctionState>(`/auctions/${id}`));
    } catch {
      // Real-time snapshots still keep the control panel usable.
    }
  }

  useEffect(() => {
    auctionIdRef.current = auctionId;
  }, [auctionId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void refreshAuctions();
  }, []);

  useEffect(() => {
    const instance = io(SOCKET_URL);
    instance.on('connect', () => {
      setConnected(true);
      if (auctionIdRef.current) {
        instance.emit('joinAuction', { auctionId: auctionIdRef.current });
      }
    });
    instance.on('disconnect', () => setConnected(false));
    instance.on('auctionSnapshot', mergeAuction);
    instance.on('auctionStarted', (data: AuctionState) => {
      mergeAuction(data);
      pushEvent('竞拍已正式开始');
    });
    instance.on('bidAccepted', (data: AuctionState) => {
      mergeAuction(data);
      void refreshSelectedAuction(data.auctionId);
      pushEvent(`收到新出价：${yuan(data.currentPriceCent)}`);
    });
    instance.on('auctionEnded', (data: AuctionState) => {
      mergeAuction(data);
      void refreshSelectedAuction(data.auctionId);
      pushEvent('竞拍已成交');
    });
    instance.on('auctionExtended', (data: AuctionState) => {
      mergeAuction(data);
      setMessage(`最后时刻有人出价，竞拍已延时 ${data.extensionSec ?? 20} 秒`);
      pushEvent(`触发自动延时 ${data.extensionSec ?? 20} 秒`);
    });
    instance.on('auctionCancelled', (data: AuctionState) => {
      mergeAuction(data);
      void refreshSelectedAuction(data.auctionId);
      setMessage(`竞拍已取消：${data.cancelReason ?? '主播异常取消'}`);
      pushEvent('主播已取消竞拍');
    });
    setSocket(instance);
    return () => {
      instance.close();
    };
  }, []);

  useEffect(() => {
    if (!socket || !auctionId) return;
    socket.emit('joinAuction', { auctionId });
    return () => {
      socket.emit('leaveAuction', { auctionId });
    };
  }, [socket, auctionId]);

  async function createAuction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      if (!adminToken) throw new Error('请先登录主播身份');
      const product = await adminRequest<{ id: string }>('/products', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('productName'),
          description: data.get('description'),
          imageUrl: data.get('imageUrl') || undefined,
        }),
      });
      const room = await adminRequest<{ id: string }>('/live-rooms', {
        method: 'POST',
        body: JSON.stringify({ title: data.get('roomTitle') }),
      });
      const created = await adminRequest<AuctionState & { id: string }>('/auctions', {
        method: 'POST',
        body: JSON.stringify({
          productId: product.id,
          liveRoomId: room.id,
          startPriceCent: Number(data.get('startPriceYuan')) * 100,
          incrementCent: Number(data.get('incrementYuan')) * 100,
          capPriceCent: Number(data.get('capPriceYuan')) * 100,
          durationSec: Number(data.get('durationSec')),
        }),
      });
      setAuctionId(created.id);
      setAuction(created);
      setMessage('竞拍已创建，可以开始竞拍');
      pushEvent('竞拍创建成功，可将竞拍 ID 分享给用户');
      await refreshAuctions(1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建失败');
    }
  }

  async function startAuction() {
    try {
      if (!adminToken) throw new Error('请先登录主播身份');
      const started = await adminRequest<AuctionState>(`/auctions/${auctionId}/start`, {
        method: 'POST',
      });
      setAuction(started);
      setMessage('竞拍已开始');
      pushEvent('主播点击开始竞拍');
      await refreshAuctions();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '开拍失败');
    }
  }

  async function cancelAuction() {
    if (!window.confirm('确认取消当前竞拍？取消后不可继续出价。')) return;
    try {
      if (!adminToken) throw new Error('请先登录主播身份');
      const cancelled = await adminRequest<AuctionState>(`/auctions/${auctionId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: '主播异常取消' }),
      });
      setAuction(cancelled);
      setMessage('竞拍已取消');
      await refreshAuctions();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '取消失败');
    }
  }

  async function copyAuctionId() {
    if (!auctionId) return;
    await navigator.clipboard.writeText(auctionId);
    setMessage('竞拍 ID 已复制，可发送给用户加入直播间');
  }

  async function loadAuction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const id = String(data.get('existingAuctionId') ?? '').trim();
    if (!id) return;
    try {
      const detail = await request<AuctionState>(`/auctions/${id}`);
      setAuctionId(id);
      setAuction(detail);
      setMessage('已有竞拍已载入，实时状态将自动同步');
      pushEvent('已载入已有竞拍');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '载入失败');
    }
  }

  async function selectAuction(id: string) {
    try {
      const detail = await request<AuctionState>(`/auctions/${id}`);
      setAuctionId(id);
      setAuction(detail);
      setMessage('竞拍记录已切换，实时状态将自动同步');
      pushEvent(`切换竞拍记录：${id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '切换失败');
    }
  }

  async function updateAuctionRules(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auctionId || auction?.status !== 'DRAFT') return;
    const data = new FormData(event.currentTarget);
    try {
      if (!adminToken) throw new Error('请先登录主播身份');
      const updated = await adminRequest<AuctionState>(`/auctions/${auctionId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          startPriceCent: Number(data.get('editStartPriceYuan')) * 100,
          incrementCent: Number(data.get('editIncrementYuan')) * 100,
          capPriceCent: Number(data.get('editCapPriceYuan')) * 100,
          durationSec: Number(data.get('editDurationSec')),
          extensionWindowSec: Number(data.get('editExtensionWindowSec')),
          extensionSec: Number(data.get('editExtensionSec')),
        }),
      });
      setAuction(updated);
      setMessage('未开始竞拍规则已更新');
      pushEvent('主播更新未开始竞拍规则');
      await refreshAuctions();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '规则更新失败');
    }
  }

  const currentStep = !auctionId ? 1 : auction?.status === 'DRAFT' ? 2 : 3;

  return (
    <main className="page">
      <header>
        <p className="eyebrow">抖音电商 AI 课题</p>
        <h1>直播竞拍主播后台</h1>
        <span className={connected ? 'status online' : 'status offline'}>
          {connected ? '实时服务已连接' : '实时服务未连接'}
        </span>
      </header>

      <section className="steps">
        {['配置竞拍', '分享并开拍', '实时控场'].map((label, index) => (
          <div className={currentStep >= index + 1 ? 'step active' : 'step'} key={label}>
            <b>{index + 1}</b><span>{label}</span>
          </div>
        ))}
      </section>

      <section className="panel auth-panel">
        <div className="section-title"><span>身份</span><h2>主播身份登录</h2></div>
        <div className="load-auction">
          <label>主播昵称<input value={adminName} onChange={(event) => setAdminName(event.target.value)} /></label>
          <button className="primary" onClick={loginAdmin}>登录主播身份</button>
        </div>
        <p className="muted">{adminToken ? '已获取主播 token，可创建、修改、开始和取消竞拍。' : '创建或管理竞拍前需要先登录主播身份。'}</p>
      </section>

      <section className="panel">
        <div className="section-title"><span>步骤 1</span><h2>配置竞拍商品与规则</h2></div>
        <form className="load-auction" onSubmit={loadAuction}>
          <label>已有竞拍 ID<input name="existingAuctionId" placeholder="刷新页面或 API 创建后，可在此载入" /></label>
          <button type="submit">载入已有竞拍</button>
        </form>
        <form className="form-grid" onSubmit={createAuction}>
          <label>商品名称<input name="productName" defaultValue="演示珠宝" required /></label>
          <label>直播间名称<input name="roomTitle" defaultValue="珠宝竞拍直播间" required /></label>
          <label className="wide">商品介绍<textarea name="description" defaultValue="高价值珠宝竞拍演示商品" required /></label>
          <label className="wide">图片 URL<input name="imageUrl" placeholder="可选：https://..." /></label>
          <label>起拍价（元）<input name="startPriceYuan" type="number" defaultValue="0" min="0" required /></label>
          <label>固定加价（元）<input name="incrementYuan" type="number" defaultValue="100" min="1" required /></label>
          <label>封顶价（元）<input name="capPriceYuan" type="number" defaultValue="500" min="1" required /></label>
          <label>竞拍时长（秒）<input name="durationSec" type="number" defaultValue="120" min="1" required /></label>
          <button className="primary" type="submit">创建竞拍</button>
        </form>
      </section>

      {auctionId && (
        <section className="panel">
          <div className="section-title"><span>编辑</span><h2>未开始竞拍规则编辑</h2></div>
          {auction?.status === 'DRAFT' ? (
            <form className="form-grid" key={auction.id} onSubmit={updateAuctionRules}>
              <label>起拍价（元）<input name="editStartPriceYuan" type="number" defaultValue={(auction.startPriceCent ?? auction.currentPriceCent ?? 0) / 100} min="0" required /></label>
              <label>固定加价（元）<input name="editIncrementYuan" type="number" defaultValue={(auction.incrementCent ?? 10000) / 100} min="1" required /></label>
              <label>封顶价（元）<input name="editCapPriceYuan" type="number" defaultValue={(auction.capPriceCent ?? 50000) / 100} min="1" required /></label>
              <label>竞拍时长（秒）<input name="editDurationSec" type="number" defaultValue={auction.durationSec ?? 120} min="1" required /></label>
              <label>延时窗口（秒）<input name="editExtensionWindowSec" type="number" defaultValue={auction.extensionWindowSec ?? 10} min="1" required /></label>
              <label>每次延时（秒）<input name="editExtensionSec" type="number" defaultValue={auction.extensionSec ?? 20} min="1" required /></label>
              <button className="primary" type="submit">保存规则</button>
            </form>
          ) : <p className="muted">只有待开始竞拍允许编辑规则。当前状态：{statusText(auction?.status)}</p>}
        </section>
      )}

      <section className="panel">
        <div className="row">
          <div className="section-title"><span>记录</span><h2>竞拍记录与并行场次</h2></div>
          <button onClick={() => void refreshAuctions()}>刷新记录</button>
        </div>
        <p className="muted">新建竞拍不会删除或结束旧竞拍。点击任意记录可切换实时控制台。</p>
        <div className="auction-records">
          {auctions.length ? auctions.map((item) => (
            <button
              className={auctionId === item.id ? 'auction-record selected' : 'auction-record'}
              key={item.id}
              onClick={() => void selectAuction(item.id ?? '')}
            >
              <span>
                <strong>{item.product?.name ?? '未命名拍品'}</strong>
                <small>{item.liveRoom?.title ?? '未命名直播间'}</small>
              </span>
              <span>
                <b className={`state ${item.status?.toLowerCase()}`}>{statusText(item.status)}</b>
                <small>{yuan(item.currentPriceCent ?? 0)} · {item._count?.bids ?? 0} 次出价</small>
              </span>
            </button>
          )) : <p className="muted">暂无竞拍记录</p>}
        </div>
        <div className="pagination">
          <span>共 {auctionTotal} 条 · 第 {auctionPage}/{auctionTotalPages} 页</span>
          <div className="actions">
            <button disabled={auctionPage <= 1} onClick={() => void refreshAuctions(auctionPage - 1)}>上一页</button>
            <button disabled={auctionPage >= auctionTotalPages} onClick={() => void refreshAuctions(auctionPage + 1)}>下一页</button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="row">
          <div>
            <div className="section-title"><span>步骤 2-3</span><h2>实时竞拍控制台</h2></div>
            <p className="muted auction-id">竞拍 ID：{auctionId || '尚未创建'}</p>
          </div>
          <div className="actions">
            <button disabled={!auctionId} onClick={copyAuctionId}>复制竞拍 ID</button>
            <button className="primary" disabled={!auctionId || auction?.status !== 'DRAFT'} onClick={startAuction}>开始竞拍</button>
            <button className="danger" disabled={!auctionId || auction?.status !== 'RUNNING'} onClick={cancelAuction}>异常取消</button>
          </div>
        </div>
        <div className="metrics">
          <article><span>状态</span><strong className={`state ${auction?.status?.toLowerCase() ?? ''}`}>{statusText(auction?.status)}</strong></article>
          <article><span>当前价格</span><strong>{yuan(auction?.currentPriceCent ?? 0)}</strong></article>
          <article><span>领先用户</span><strong>{auction?.leaderUserId ?? '-'}</strong></article>
          <article><span>参与人数</span><strong>{auction?.participantCount ?? 0}</strong></article>
          <article><span>剩余时间</span><strong>{remaining(auction?.endAt, now)}</strong></article>
          <article><span>版本</span><strong>{auction?.version ?? 0}</strong></article>
        </div>
        <div className="dashboard-grid">
          <div className="leaderboard">
            <h3>实时排行榜</h3>
            {auction?.leaderboard?.length ? (
              <ol>
                {auction.leaderboard.map((item) => (
                  <li key={item.userId}>
                    <span>{item.nickname}</span>
                    <strong>{yuan(item.amountCent)}</strong>
                  </li>
                ))}
              </ol>
            ) : <p className="muted">等待用户出价</p>}
          </div>
          <div className="event-log">
            <h3>现场动态</h3>
            <ul>{events.map((event, index) => <li key={`${event}-${index}`}>{event}</li>)}</ul>
          </div>
        </div>
        <p className="notice">{message}</p>
      </section>

      <section className="panel">
        <div className="section-title"><span>详情</span><h2>当前竞拍详情</h2></div>
        {!auctionId ? <p className="muted">点击竞拍记录后查看详情</p> : (
          <>
            <div className="detail-grid">
              <article><span>拍品</span><strong>{auction?.product?.name ?? '-'}</strong></article>
              <article><span>直播间</span><strong>{auction?.liveRoom?.title ?? '-'}</strong></article>
              <article><span>创建时间</span><strong>{formatTime(auction?.createdAt)}</strong></article>
              <article><span>累计出价</span><strong>{auction?._count?.bids ?? auction?.bids?.length ?? 0} 次</strong></article>
            </div>
            {auction?.order ? (
              <div className="order-summary">
                <strong>成交订单</strong>
                <span>订单号：{auction.order.id}</span>
                <span>买家：{auction.order.winner?.nickname ?? auction.leaderUserId ?? '-'}</span>
                <span>成交价：{yuan(auction.order.amountCent)}</span>
                <span>支付状态：{auction.order.status}</span>
              </div>
            ) : <p className="muted">当前竞拍尚未生成成交订单。</p>}
            <h3>逐次出价记录</h3>
            {auction?.bids?.length ? (
              <div className="bid-table-wrap">
                <table className="bid-table">
                  <thead><tr><th>时间</th><th>竞拍者</th><th>出价</th></tr></thead>
                  <tbody>
                    {auction.bids.map((bid) => (
                      <tr key={bid.id}>
                        <td>{formatTime(bid.createdAt)}</td>
                        <td>{bid.user.nickname}</td>
                        <td>{yuan(bid.amountCent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted">暂无出价记录</p>}
          </>
        )}
      </section>
    </main>
  );
}
