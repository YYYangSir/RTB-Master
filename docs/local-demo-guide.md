# 「实时竞拍大师」本地 Demo 使用说明

## 1. 项目说明

「实时竞拍大师」是一个面向抖音电商直播竞拍场景的全栈系统，完成了主播创建竞拍、买家实时出价、规则校验、自动延时、成交结算、订单支付、历史追踪以及高并发和故障恢复测试。

当前版本暂未部署公网可交互环境，因此第 6 项“在线 Demo 链接”使用本说明文档作为替代入口。评委可以通过演示视频快速查看系统效果，也可以按照本文在本地启动完整系统。

## 2. 快速入口

| 内容 | 链接 |
|---|---|
| 源代码仓库 | https://github.com/YYYangSir/RTB-Master |
| 主分支 | `main` |
| 最新提交记录 | https://github.com/YYYangSir/RTB-Master/commits/main |
| 演示视频 | https://my.feishu.cn/file/IGuHbFBDjoK9aNxD1IPcdWj9nah?from=from_copylink |

## 3. 本地运行环境

- macOS、Windows 或 Linux。
- Node.js `20+`。
- pnpm `10+`。
- Docker Desktop。
- Git。
- Google Chrome，仅浏览器 E2E 测试需要。

## 4. 获取并启动项目

```bash
git clone https://github.com/YYYangSir/RTB-Master.git
cd RTB-Master
pnpm install
pnpm env:setup
docker compose -f infra/docker-compose.yml up -d
pnpm db:generate
pnpm db:migrate
pnpm dev
```

等待终端显示三个应用启动成功后访问：

| 页面 | 地址 | 用途 |
|---|---|---|
| 主播端 | http://localhost:5173 | 创建、编辑、开始、取消竞拍，查看竞拍记录与订单详情 |
| 买家端 | http://localhost:5174 | 创建买家、加入直播间、实时出价、查看排行榜和订单 |
| API 健康检查 | http://localhost:3000/api/health | 返回服务健康状态 |

## 5. 推荐体验流程

1. 打开主播端，点击“登录主播身份”。
2. 创建一件拍品，配置起拍价、固定加价、封顶价、竞拍时长和自动延时规则。
3. 在主播端竞拍列表中选择该拍品，点击“开始竞拍”，复制竞拍 ID。
4. 打开多个买家端页面，分别创建不同买家，并使用同一个竞拍 ID 加入直播间。
5. 让多个买家轮流出价，观察主播端和所有买家端的当前价、领先者、参与人数和排行榜实时同步。
6. 尝试同一领先者连续出价，系统会拒绝该行为；成交或取消后再次出价也会被拒绝。
7. 出价达到封顶价后系统自动成交并生成唯一订单，赢家可以完成模拟支付。
8. 回到主播端，查看竞拍状态、逐次出价流水、成交订单和支付状态。

## 6. 自动化验证

```bash
pnpm env:check
pnpm --filter api-server test
pnpm smoke
pnpm e2e
pnpm perf:baseline
```

项目还提供测试 2.0 专项脚本和报告，覆盖 100 用户混合流量、1000 WebSocket 在线与广播、多直播间隔离、Redis/MySQL 故障恢复、封顶成交和取消竞拍一致性等场景。

## 7. 系统架构

系统架构图位于 `docs/system-architecture.png`，详细说明见 `docs/architecture.md`。

## 8. 常见问题

### pnpm 命令不存在

请先安装并启用 pnpm，再重新执行项目命令。

### MySQL 或 Redis 无法连接

确认 Docker Desktop 已启动，并执行：

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
```

### 页面无法访问

确认 `pnpm dev` 保持运行，并检查 `3000`、`5173`、`5174` 端口是否被其他进程占用。

### 数据是否会上传到外部 AI 服务

不会。当前系统运行时不调用外部 AI API，不需要任何模型 API Key。

## 9. 当前边界

- 当前为本地 Demo，未部署公网可交互服务。
- 直播画面为演示占位，不包含真实直播推流。
- 支付为模拟支付，不连接真实支付平台。
- 当前验证为单 API 实例，多实例 Socket.IO Redis Adapter 尚未接入。
