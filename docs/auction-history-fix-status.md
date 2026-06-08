# 主播端竞拍记录修复

## 问题

主播端原先只保存一个当前竞拍 ID。新建竞拍后，页面会切换到新竞拍，旧竞拍看起来像“消失”。

数据库中的旧竞拍实际没有被删除，也不会因为创建新竞拍而自动结束。

## 修复

- 新增 `GET /api/auctions?page=1&pageSize=10` 分页查询竞拍记录，按创建时间倒序排列。
- 返回商品、直播间、订单和出价次数摘要。
- 主播端新增“竞拍记录与并行场次”列表。
- 点击任意竞拍记录，可切换实时控制台并订阅该场竞拍。
- 切换后可查看逐次出价流水、竞拍者昵称、成交订单和支付状态。
- 主播端每页展示 `10` 条记录，可通过上一页、下一页切换。
- 新建竞拍不会删除或结束之前的竞拍。

## 能力边界

- 后端支持多场竞拍同时运行。
- 不同 `auctionId` 使用独立 Redis 状态和 Socket.IO 房间。
- 同一场竞拍内部通过 Redis Lua 严格顺序处理。

## 验证

```json
{
  "auctionHistoryStatus": "PRESERVED",
  "concurrentBidStatus": "ONE_ACCEPTED_ONE_STALE_PRICE_REJECTED",
  "timedSoldStatus": "SOLD",
  "timedUnsoldStatus": "UNSOLD"
}
```
