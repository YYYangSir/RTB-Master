# 阶段 11 P1-F：Redis Lua 原子竞价优化报告

## 已完成

- 新增 Redis 热点竞拍状态。
- 开拍时初始化 Redis 状态，服务重启或缓存缺失时可从 MySQL 恢复。
- 使用 Redis Lua 脚本原子执行：
  1. `requestId` 幂等校验。
  2. 竞拍状态和结束时间校验。
  3. 最低出价校验。
  4. 当前价、领先者、结束时间和版本号更新。
  5. 最后时刻自动延时。
  6. 封顶成交状态切换。
  7. Redis ZSET 排行榜更新。
- 主播异常取消通过 Redis Lua 原子切换为 `CANCELLED`。
- 排行榜优先读取 Redis ZSET，不再在每次广播时聚合全部 MySQL 出价流水。
- MySQL 继续持久化出价流水、竞拍状态和订单。
- 数据库镜像仅接受更高 `version`，避免并发落库顺序反转。
- `orders.auctionId UNIQUE` 继续作为唯一订单兜底。

## 自动验证

### 规则测试

```bash
pnpm --filter api-server test
```

结果：`4/4` 通过。

### 完整 Smoke

```bash
pnpm smoke
```

关键结果：

```json
{
  "finalStatus": "SOLD",
  "paidStatus": "PAID",
  "extensionStatus": "EXTENDED",
  "cancelledStatus": "CANCELLED",
  "leaderboardStatus": "CONSISTENT",
  "recoveryStatus": "RECOVERED",
  "illegalLowBidStatus": "REJECTED",
  "duplicateRequestStatus": "IDEMPOTENT",
  "afterSoldBidStatus": "REJECTED",
  "concurrentBidStatus": "ONE_ACCEPTED_ONE_STALE_PRICE_REJECTED"
}
```

### 浏览器 E2E

```bash
pnpm e2e
```

结果：

```json
{
  "adminStatus": "已成交",
  "finalPrice": "¥300.00",
  "winner": "E2E 用户 A",
  "paidStatus": "PAID",
  "browserFlow": "PASSED"
}
```

## 性能对比

测试环境与 P1-E 一致：Apple M2、`8` 核、`16 GB` 内存、单 API 实例、本地 Docker MySQL 和 Redis。

| 场景 | 指标 | 优化前 | 优化后 | 变化 |
|---|---|---:|---:|---:|
| 单场热点竞拍 | 吞吐 | `984.01 req/s` | `1435.97 req/s` | `+45.9%` |
| 单场热点竞拍 | P95 | `27.44 ms` | `12.08 ms` | `-56.0%` |
| 单场热点竞拍 | `409` 数量 | `142` | `0` | 消除 |
| 十场并行竞拍 | 成功请求 | `92/100` | `100/100` | 全部成功 |
| 十场并行竞拍 | `409` 数量 | `8` | `0` | 消除 |
| 重复与非法请求 | 吞吐 | `1496.07 req/s` | `2286.68 req/s` | `+52.8%` |
| 重复与非法请求 | P95 | `62.22 ms` | `40.53 ms` | `-34.9%` |
| 封顶成交竞争 | 吞吐 | `1297.80 req/s` | `1850.50 req/s` | `+42.6%` |
| 封顶成交竞争 | P95 | `21.72 ms` | `9.67 ms` | `-55.5%` |
| 封顶成交竞争 | 成功请求 | `1` | `1` | 一致 |
| 封顶成交竞争 | 重复订单 | `0` | `0` | 一致 |

## 行为变化说明

优化前，同一时刻提交的冲突请求可能返回 `409`，要求客户端重试。

优化后，Redis Lua 会严格顺序处理同一场竞拍：

- 第一个合法价格被接受。
- 后续相同价格会基于更新后的当前价被识别为过期价格，返回 `400`。
- 不再出现 MySQL 乐观更新冲突导致的 `409`。

## 当前边界

- Redis 已作为热点状态的可信来源，MySQL 作为持久化镜像和最终订单兜底。
- 当前为单 API 实例验证，尚未接入 Socket.IO Redis Adapter 和多实例部署。
- 当前落库为请求内同步持久化。后续如需更高吞吐，可评估可靠队列或 Outbox，但不能牺牲订单一致性。
- 当前压测统计 REST 出价确认延迟，尚未统计 WebSocket 广播到达延迟。

## 下一步

进入 P1-G：整理 README、演示脚本、架构说明和正式验收材料。

