# 阶段 10 P1-D：自动化测试闭环

## 已完成

### 规则测试

- 将竞拍价格和延时规则抽取为纯函数 `evaluateBid`。
- 使用现有 Jest 和 ts-jest，不新增下载依赖。
- 覆盖非法低价、合法最低出价、最后时刻延时、封顶成交优先级。

执行：

```bash
pnpm --filter api-server test
```

结果：

```text
Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
```

### API Smoke 扩展

执行：

```bash
pnpm smoke
```

新增覆盖：

1. 非法低价返回 `400`。
2. 相同 `requestId` 重复提交只处理一次。
3. 成交后继续出价返回 `400`。
4. 两个用户并发提交相同价格时，只接受一个请求。P1-D 的 MySQL 事务版本中另一个返回 `409`；P1-F Redis Lua 优化后，另一个会作为过期价格返回 `400`。

关键结果：

```json
{
  "illegalLowBidStatus": "REJECTED",
  "duplicateRequestStatus": "IDEMPOTENT",
  "afterSoldBidStatus": "REJECTED",
  "concurrentBidStatus": "ONE_ACCEPTED_ONE_CONFLICT"
}
```

> 注：以上为 P1-D 历史结果。P1-F 已将热点竞价迁移到 Redis Lua，最新结果见 `phase-11-p1-f-redis-lua-report.md`。

### 浏览器 E2E

本机没有安装 Playwright。为避免增加大体积下载，新增零依赖真实浏览器 E2E：

```bash
pnpm e2e
```

脚本使用本机 Google Chrome 无头模式和 Chrome DevTools Protocol，自动启动并清理 API、主播端、用户端和浏览器进程。

覆盖：

1. 主播通过页面创建竞拍。
2. 主播通过页面开始竞拍。
3. 用户 A 和用户 B 通过页面创建演示用户并加入竞拍。
4. 用户 A 出价 `100` 元。
5. 用户 B 出价 `200` 元。
6. 用户 A 出价 `300` 元触发成交。
7. 页面展示用户 A 获胜。
8. 用户 A 通过页面完成模拟支付。

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

## 下一步

进入 P1-E：建立单实例压测基线。
