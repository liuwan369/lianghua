# 系统架构

更新时间：2026-09-08

## 数据流

```text
Polymarket 市场 WS/REST ─┐
Polymarket 公开活动 API ─┼─> 都柏林采集器 ─> SQLite 日库 ─> 页面 / 小时分析
Binance BTC 行情 WS ─────┤
Polygon 链上日志 ─────────┘

Polymarket 主 WS ─> TypeScript 策略 ─> 风控 ─> 纸面执行器
                                           └─> 真实执行器（当前锁定）

公开资金地址 ─> 官方 SDK/Polygon 只读预检 ─> 钱包类型、Owner、余额、授权缺项
Session Key ─> 官方 SDK 认证与下单（等待官方权限，尚未接通）

浏览器 ─HTTPS+登录保护─> Nginx ─> 都柏林页面 API ─> 启停纸面引擎 / 读取汇总
```

## 组件职责

| 组件 | 文件 | 作用 | 当前状态 |
| --- | --- | --- | --- |
| 主交易引擎 | `_external/btc-5m-market-trading-bot/src/` | 市场发现、盘口、策略、风控、订单与回报 | 纸面可用，实盘锁定 |
| 账户预检 | `src/live/account.ts`、`onchain.ts` | 严格区分资金钱包、Owner、Session、Relayer、Builder | 公开只读已接通 |
| 动态补仓模型 | `pm_maker/` | 配对成本、补仓数量、风险和影子成交 | 已接入回放测试 |
| 公开数据采集 | `scripts/pm-r25-tokyo-evidence-collector.py` | 采集盘口、成交、BTC、Polygon；文件名是历史名称 | 都柏林持续运行 |
| 分析服务 | `scripts/pm-r25-live-evidence-analysis.py` | 生成最近窗口的完整性和行为报告 | 每小时运行 |
| 页面后端 | `scripts/system-dashboard-server.py` | 页面静态文件、实时状态、模拟启停与日志汇总 | 都柏林运行 |
| 页面前端 | `docs/system-dashboard.html/js` | 交易、配置、订单三个用户入口 | 可用 |

## 交易状态机

```text
发现市场 -> 建立两边盘口 -> 检查数据新鲜度 -> 计算报价
    -> 模拟/提交挂单 -> 接收成交 -> 计算另一边补仓量
    -> 继续报价 / 撤单停止 -> 官方结算后计算结果
```

实盘额外要求：主行情 WS 和用户订单 WS 都在线、两边盘口完整且不超过 `250ms`、账户预检通过。任一关键通道断开或订单状态不明，系统进入撤单、核对、重建仓位并停止，不自动恢复交易。

账户身份固定分层：Deposit Wallet 持有资金；Owner 或获官方授权的 Session Key 负责订单签名；Relayer API Key 负责官方 Relayer API 访问和免 Gas 钱包操作；Builder 凭据只用于获批准的 Builder 集成。五者不得互相替代。Session Key 当前为 Beta 受邀功能，不是自建 bot 的默认依赖。

## 部署

- 当前主节点：AWS 都柏林 `eu-west-1a`，项目目录 `/root/pm-system`。
- Node.js：`24.13.0`，满足官方 `@polymarket/client 0.9.0` 要求。
- 页面服务监听服务器 `127.0.0.1:18766`。
- Nginx 通过 `https://34-242-206-196.sslip.io:80` 提供受密码保护的公网入口。
- 用户通过 SSH 隧道映射为本机 `127.0.0.1:18765`。
- 东京节点只作历史数据和延迟对照，不是当前主交易节点。
- 云仓库只备份代码和小型报告；SQLite 原始行情库保留在服务器/本机。

## 安全边界

- 页面不接收或保存钱包私钥。
- 默认 `trade_authorization=false`。
- 真实执行必须同时具备服务器账户配置、显式实盘解锁和代码预检。
- 当前三个条件均未满足，不会提交真实订单。
