# 阶段 9 P1-A：竞拍规则增强

## 已完成

- 自动延时：剩余时间小于等于延时窗口时，合法出价会延长竞拍结束时间。
- 封顶优先：出价达到封顶价时直接成交，不再触发延时。
- 主播异常取消：新增 `POST /api/auctions/:id/cancel`，支持取消原因。
- 并发保护：取消操作使用竞拍状态和 `version` 乐观更新，避免与并发出价互相覆盖。
- 实时事件：补充 `auctionExtended` 和 `auctionCancelled`。
- 快照字段：补充 `seq`、加价幅度、封顶价、延时时长和取消原因。
- 主播端：增加倒计时、延时提示和异常取消按钮。
- 用户端：增加倒计时、延时提示和取消结果提示。

## 数据库迁移

```text
20260601151304_p1_a_cancel_reason
```

新增字段：

```text
Auction.cancelReason
```

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
  "cancelledOrder": null
}
```

覆盖场景：

1. 原有完整成交和模拟支付链路。
2. 短时竞拍中的最后时刻合法出价触发延时。
3. 延时后的 `endAt` 与实时广播一致。
4. 主播异常取消成功并实时广播取消原因。
5. 取消后的出价被服务端拒绝。
6. 已取消竞拍不生成订单。

## 下一步

进入 P1-B：排行榜、被超越提醒和断线恢复。

