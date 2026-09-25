# BTC 五分钟反转前端控制台

前端静态服务当前使用 `http://127.0.0.1:5175/`，入口是 `overview.html`、`market.html`、`auto-trade.html`、`strategy.html` 和 `settings.html`。

页面保留深海渐变和圆润交易终端视觉，`shared/preview-core.js` 提供最小共享边界。浏览器不保存运行池、行情、持仓、订单或账户秘密；交易状态只来自服务器。

代码接入边界已经包含目标市场目录、运行池、运行状态、账户状态、诊断、统计、事件和按 `marketId + roundId` 隔离的读模型。生产只读联调结果需要单独看待：当前 `/api/markets` 已返回有效 `marketId`、`roundId`，`collector_online=true`、`stale=false`，并且 `sequence/sourceAt/expiresAt` 持续更新；但 `depthAvailable=false`、`strategyEligible=false`，所以前端不会开放启动。旧 `/api/v1/markets` 仍是兼容回退，若该旧响应缺少 `roundId`，前端只展示目录/报价，不查询持仓和订单，并明确等待后端提供轮次标识。

生产当前运行池返回 `market_pool_unavailable`，runtime 返回 `stopped`、`runtime_snapshot_stale`，账户状态返回 `live_start_ready=false`；账户保存/检查仍可能返回 `account_response_invalid`。`/api/metrics/summary` 在生产返回 HTTP 404。WebSocket 只有在运行配置中的 `streams.markets`、`streams.runtime`、`streams.orders` 提供地址后才建立实时连接；当前生产 `streams=false`，页面使用独立 REST 轮询并保留最近快照。当前只完成市场目录和状态类只读联调，没有验证真实订单、成交或结算；账户页只显示服务器状态，账户保存回执必须是 `ok: true` 且包含 `report`，否则不会清空输入或显示成功。

策略配置保存草稿和发布激活是两个动作：草稿必须包含完整配置（包括 `maxStages`）、`draftId` 和 `expectedRevision`；只有激活接口返回确认的正版本后，启动按钮才允许提交该版本。检查已保存账户使用 `POST /api/account/check` 空 JSON `{}`，不提交当前表单。控制会话使用同源 HTTPS、`X-PM-Control-Token` 和服务器 HttpOnly cookie，前端不保存控制密码，也不自行创建实盘解锁开关。撤单、清余量和参考参数在服务器能力为 false/501 时保持禁用。

市场页在页面可见时使用有界 REST 刷新：上一请求完成后约 1 秒再排下一次；页面隐藏时暂停，恢复可见立即刷新。总览页把行情/运行状态、慢统计/诊断、账户摘要分成独立刷新组（约 3 秒、15 秒、30 秒），页面隐藏时暂停，恢复可见立即刷新。请求失败、空响应或 `stale` 响应不会填充演示数据；已有服务器快照会保留并标记 stale，没有成功快照则显示 unavailable。

自动交易页对当前 `marketId + roundId` 使用独立的有界单市场快照刷新；同时每约 10 秒串行重读市场目录和运行池以发现轮次切换，再刷新新市场快照。相同 `marketId + roundId` 只刷新 REST 快照，不重建 WebSocket；只有身份或流地址变化才重启流。轮次切换会先标记旧盘口 stale、清空旧持仓/订单占位，异步响应回写前再次校验身份；空/stale 运行池保留最近有效运行上下文。断线或过期时保留最后一次成功盘口。

后端接入先阅读：

1. `FRONTEND-ARCHITECTURE.md`
2. `DATA-MODEL.md`
3. `API-CONTRACT.md`
4. `UI-MODULES.md`
5. `LAYOUT-SPEC.md`
6. `INTEGRATION-CHECKLIST.md`

本次只更新前端对接说明，没有修改生产目录、后端或共享契约。
