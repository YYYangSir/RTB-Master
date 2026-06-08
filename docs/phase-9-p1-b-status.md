# 阶段 9 P1-B：排行榜、提醒和断线恢复

## 已完成

- 实时排行榜：服务端按竞拍维度聚合每位用户最高出价，返回前五名。
- 参与人数：快照携带完整竞价参与人数，不受榜单前五名限制。
- REST API：新增 `GET /api/auctions/:id/leaderboard`。
- 实时广播：`auctionSnapshot`、`bidAccepted`、`auctionExtended` 和结束事件携带排行榜。
- 用户端：展示实时排行榜，并高亮当前用户。
- 用户端：当前领先用户被其他用户超过时，显示“你已被超越，可以继续出价”。
- 主播端：展示参与人数和实时排行榜。
- 断线恢复：Socket.IO 重连后自动重新加入原竞拍房间，并使用服务端快照覆盖本地状态。

## 当前实现边界

- 排行榜第一版从 MySQL 出价流水聚合生成。
- Redis ZSET 榜单和 Redis Lua 原子竞价留到 P1-F 性能优化阶段。
- 当前 smoke 验证服务端恢复快照；页面自动重连使用同一 `joinAuction -> auctionSnapshot` 机制。

## 自动验证

执行：

```bash
pnpm smoke
```

验证结果：

```json
{
  "finalStatus": "SOLD",
  "paidStatus": "PAID",
  "extensionStatus": "EXTENDED",
  "cancelledStatus": "CANCELLED",
  "cancelledOrder": null,
  "leaderboardStatus": "CONSISTENT",
  "recoveryStatus": "RECOVERED"
}
```

新增覆盖场景：

1. 用户 A 首次出价后排名第一，参与人数为 `1`。
2. 用户 B 超价后排名第一，用户 A 排名第二，参与人数为 `2`。
3. 新 Socket 客户端加入同一竞拍后，恢复最新价格、领先者和排行榜。

## 下一步

进入 P1-C：主播端和用户端演示体验整体优化。

