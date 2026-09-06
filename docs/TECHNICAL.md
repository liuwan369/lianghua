# 技术说明

## 本地页面

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-dashboard.ps1
```

本地开发页面默认监听 `127.0.0.1:8765`；当前主节点迁移到 AWS 都柏林后，正式服务默认只监听服务器本机，先通过 SSH 隧道查看，避免未认证交易接口暴露公网。

## 采集服务

- 采集器：`pm-r25-tokyo-collector.service`
- 页面服务：`pm-system-dashboard-tokyo.service`
- 东京采集接口：`http://127.0.0.1:18766/api/live`
- 旧东京主机：`13.115.254.211`（历史对照）
- 当前主节点：`34.242.206.196`，AWS `eu-west-1a`，`t3.small`；公网入口尚未开放，使用 SSH 隧道。

页面服务通过只读接口获取东京聚合状态，不把完整数据库暴露给浏览器。

## 当前部署核对

- `http://127.0.0.1:8765/api/trading/status` 当前可返回 `mode=paper`、`live_unlocked=false`、`account_configured=false`。
- 东京页面域名可访问；东京主机 SSH 已复核，可直接维护远程服务。
- 东京访问 `https://polymarket.com/api/geoblock` 当前返回 `country=JP, blocked=true`。官方地理文档把日本列为“仅网页端 close-only，API 本身不限制”，所以不能用这个布尔值单独否定 API；但账户资格和真实 CLOB 接单仍需分别验证。

## 网络入口与延迟

- 官方 SDK 使用统一域名：`https://clob.polymarket.com`、`wss://ws-subscriptions-clob.polymarket.com/ws/market`、`https://data-api.polymarket.com` 和 `https://gamma-api.polymarket.com`。官方没有公布可直接购买同机房的“主服务器 IP”或地区专用入口。
- 这些域名会解析到 Cloudflare 等边缘 IP，IP 会变化，不能用 IP 归属地推断 Polymarket 源站位置。东京服务器本次响应头的 `cf-ray` 节点为 `NRT`，即接入东京边缘节点。
- 东京实测（2026-09-06）：REST 首字节约 `0.28–0.31 秒`，公开行情 WebSocket 建连约 `0.49 秒`。这证明东京线路可用，但不代表交易获准，也不能据此断言全球最快；比较其他地区必须从各地区服务器重复同一测试。
- Polymarket 不是所有地区都能交易。官方把限制分为三类：完全禁止、网页和 API 都 close-only、仅网页端 close-only。爱尔兰、日本、荷兰属于第三类，虽然 `/api/geoblock` 可能返回 `blocked=true`，官方文档明确说明 API 本身可用；德国、法国、波兰等属于网页和 API 都受限。用户本人仍必须符合平台资格，不能用服务器绕过司法辖区限制。
- 官方文档明确给出：撮合主服务器在 AWS `eu-west-2`，普通开发者最近的非 API 限制区域是 `eu-west-1`；完成 KYC/KYB 后可申请 `eu-west-2` 直接同区部署。因此普通方案第一候选恢复为 **AWS 都柏林 `eu-west-1`**。苏黎世、马德里只作为线路对照，不能再用不同端点、不同运营商的公共样本直接排出全球第一。
- 已取得的公共探针证据仍保留：AWS 都柏林一次新连接约 `39ms`；Oracle 苏黎世 `/time` 六次为 `44/45/60/45/97/50ms`。它们只能用于初筛；原始测量编号和样本保存在 `data/latency-location-screen-2026-09-06.json`。
- 公共探针每次都会新建 DNS/TCP/TLS 连接，只能筛机房和运营商，不能代表长连接 WebSocket 的消息年龄，更不能代表真实订单 ACK。对 `ws-subscriptions-clob.polymarket.com` 用普通 HTTP 得到 `404` 是没有发送 WebSocket Upgrade 的预期结果。
- 交易热路径已增加市场预热：在每个 5 分钟市场开始、策略接单前，一次取齐 API 版本和市场元数据，让 tick size、neg-risk、费用信息进入 SDK 内存缓存。真实订单日志会记录 CLOB ACK 耗时，用于计算事件到确认链路；这项改动不解锁真实交易。
- Cloudflare 边缘只负责接入和转发，订单最终仍由平台撮合系统处理；靠近解析出的 IP 不能保证更快或获得排队优先级。
- 统一测速器：`_external/btc-5m-market-trading-bot/scripts/latency-probe.mjs`。它从运行机器测官方地理限制、DNS、Cloudflare 节点、CLOB REST、WebSocket 建连、首个盘口和带平台时间戳的消息年龄；新机房必须运行同一脚本，不能混用网页 ping 和真实 WebSocket 指标。
- 都柏林 30 分钟基线（2026-09-06）：REST `p50=26.19ms / p95=35.38ms`，WebSocket 建连 `p50=46.64ms`，首盘口 `p50=16.78ms`，校准后稳定消息年龄 `p50=9ms / p95=86ms`，收包间隔 `p99=32.04ms`，7 个市场约 51 万条消息，0 陈旧事件、0 错误，Cloudflare 节点 `DUB`。地理接口返回 `IE / blocked=true`，按官方文档属于网页端限制，API 初筛通过；真实下单仍未验证。
- 都柏林内核 A/B 测试由 `_external/btc-5m-market-trading-bot/scripts/run-dublin-kernel-ab.sh` 自动执行。每组使用相同 REST/WS 探针，采用两轮相反顺序并夹入默认组；进程锁、异常恢复和完整性门槛已启用。只有零错误、零陈旧消息、完整样本且相对默认稳定改善至少 5% 的变体才会进入长测，否则保留默认内核配置。
- Node `ws` 已在实际 WebSocket 连接上验证调用 `setNoDelay(true)`；TCP_NODELAY 已生效，无需重复改业务代码。
- 测速器长测会在每个 BTC 5 分钟市场结束前关闭旧订阅并自动切换新市场，WebSocket 每 10 秒发送心跳，且把测试结束前的静默时间计入收包间隔。只有 `chrony` 提供了有限的具体时钟偏差时，盘口消息年龄才允许参加机房排名；`timedatectl=yes` 只能展示原始值。
- 东京统一基线（2026-09-06，10 次 REST、5 次 WS）：REST `p50=250.58ms / p95=300.86ms`；WS 建连 `p50=498.48ms`；订阅后两边完整盘口 `p50=241.67ms`；稳定阶段消息年龄 `p50=118ms / p95=130ms`；Cloudflare 节点 `NRT`；官方地理结果 `JP / blocked=true`。原始报告：`data/latency-tokyo-2026-09-06.json`。
- 修正测速器后的东京冒烟复核：时钟偏差约 `-0.001ms`，REST `p50=254.71ms / p95=267.85ms`，WS 建连 `p50=488.65ms`，首盘口 `p50=238.79ms`，稳定消息年龄 `p50=118ms / p95=195ms`，仍为 `JP / blocked=true`。报告：`data/latency-tokyo-smoke-final.json`。
- 最终机房尚未定案。下一台实测机器应选 AWS 都柏林 `eu-west-1`；安装 `chrony` 后连续运行统一测速器至少 30 分钟。准入条件是官方 API 地区规则允许、时钟偏差可量化、WebSocket 零断线且消息年龄/REST 的 p95、p99 明显优于东京。`blocked=true` 对爱尔兰、日本、荷兰只表示网页端限制，不能当作 API 淘汰条件。
- 下单热路径已改为本地签名后直接调用 `/order`，开启 `deferExec`，使用连接复用和 3 秒硬超时；日志分开记录签名、HTTP ACK 和总耗时。请求超时、连接重置或 5xx 被视为“平台状态不明”，程序停止，不能自动重复下单。
- 实盘只允许 Polymarket 主 WebSocket 驱动策略。Up/Down 两边盘口必须完整且新鲜，任一侧盘口年龄超过 `250ms` 就禁止下单；用户订单/成交 WebSocket 必须在线。用户频道或主行情频道掉线会立即进入最高优先级撤单和停止流程。CLOB REST 和东京 REST 只用于纸面后备，东京报价保留原始时间且超过 2 秒即丢弃。
- 用户成交推送可能先于 HTTP ACK。程序会把未知订单事件缓存 10 秒，HTTP 返回订单 ID 后重放，避免极快成交漏记仓位。
- HTTP ACK 返回的成交编号会保留，并由只读成交查询在后台核对，避免只依赖单一回报来源。WebSocket 完整盘口建立后，时间戳更旧的增量会直接丢弃，防止乱序消息把本地盘口倒退。
- ACK 超时或网络中断导致订单状态未知时，程序会冻结新单但保持用户回报通道在线，先撤销全部订单，再用至少 5 秒的账户查询窗口取得稳定的本市场完整成交并重建仓位，最后连续两次确认未成交订单为空；无论核对是否成功，本次运行都不会自动继续交易。
- maker 与 taker 成交统一以平台成交事件记账，普通订单更新只更新状态，不再重复增加仓位。未使用的逐交易所 BTC 明细不会进入策略队列，降低 HTTP ACK 等待期间的排队压力。
- 已移除被 GitHub 安全公告 `GHSA-v6qq-cv3g-3jjq` 标记为恶意包的 `poly-price-node@1.1.2`；启动健康检查改为直接请求官方 CLOB。东京项目目录不存在 `.env`，当前也未配置交易账户。生产依赖审计仍有 1 个来自官方 CLOB SDK 的传递性 `ws` 高危告警，不能用审计建议的破坏性降级自动修复，真实放行前需继续跟踪官方 SDK 更新。

## 交易引擎

```powershell
Set-Location _external/btc-5m-market-trading-bot
npm.cmd run build
npm.cmd test
node dist/cli/live.js preflight
```

入口：`dist/cli/live.js`。页面启动时调用 `run --paper`；真实模式需要额外的服务器环境解锁，不由页面自行开启，当前没有账户签名配置。

核心回放脚本：`pm-r26-historical-shadow-replay.py`、`pm-r27-parameter-sweep.py`、`pm-r28-risk-sweep.py`。它们只读历史数据，不提交订单。

## 验证原则

- Python 语法和单元测试必须通过。
- TypeScript 必须构建成功并通过 Vitest。
- 最新低延迟链路验证：TypeScript 类型检查、构建和 Vitest `82/82` 通过；地区检查失败时强制停止。
- `/api/trading/status` 和 `/api/live` 当前返回 200；最近事件约数秒内。分析定时任务已恢复并成功生成报告，报告会如实标记历史断线、队列满或行情序号缺口。
- 模拟启动后日志必须出现挂单/成交/撤单或明确的无成交原因。
- 停止后不应继续产生本地成交记录。
- 没有官方结算价时必须保持“未结算”，不能用盘口猜赢家。
