# 接入清单

这是一份实际联调清单，不是交付前置流程。前半部分是仍需后端提供或仍需人工核对的事项；已由前端代码实现的约束移到「已实现的前端约束」，不再作为待办。

## 仍依赖后端或需人工核对

- [ ] 五个入口都由同一部署前缀和路由配置生成。
- [ ] `market-pool` 的 `nextRoundIds` 目前服务器恒返回空数组；下一场预告若要可用，需后端先实现。
- [ ] 实时流（`streams.markets/runtime/orders`）服务器端尚未提供，`capabilityDetails.streams=false`；接通后再验证帧序号与断线保留。
- [ ] 逐笔撤单、flatten、策略 presets、指定场次激活仍未接通（501 或无路由），页面须保持不可用。
- [ ] 用真实接口检查空数据、过期数据、断线、重复 command、权限错误以及缺失 `roundId` 的旧市场响应。
- [ ] 用浏览器检查桌面和窄屏布局，确认无横向滚动和整页闪烁。

后端尚未提供的能力必须在页面保持 `unavailable/stale`，不能用演示数据填充。

## 已实现的前端约束

以下由代码保证，回归时确认没有被改坏即可：

- 页面只通过 `PolyPreviewAdapter` 读写；`fetch` 只存在于 `shared/preview-core.js` 一处，`storage` 无调用方。
- `marketId + roundId` 隔离盘口、持仓、订单和策略阶段；旧接口缺 `roundId` 时只展示目录/报价。
- 时间归一化（Unix 秒/毫秒/ISO）、stale 快照保留（错误时保留上次成功字段并标 stale）。
- 启动门禁：市场身份 → 运行状态 → 策略激活且币种一致 → 盘口新鲜 → 账户就绪（统一走 `accountStartBlockReason`）。启动不要求五档深度，缺失只显示「深度暂不可用」。
- 盘口新鲜度只信服务器 `stale`，不用浏览器时钟；本地倒计时用 `expiresAt - sourceAt`。
- 草稿保存与激活分离；激活带 `{strategyId, draftId, expectedRevision}`，不带 `effectiveRoundId`。
- 控制命令带 `requestId`，响应与最终状态分开；`remoteOrdersState=unconfirmed` 不显示为撤单完成。
- 运行池首次写入门禁（仅在服务器明确返回空池且浏览器从未收到成功快照时允许）。
- 已保存账户检查发送 `{}`；保存回执须有 `ok:true` 和对象 `report`。账户秘密不回显、错误信息脱敏。
- 后台标签暂停低优先级刷新，返回时先取快照。
- loading/stale/empty/error 均有可见状态。

## 最近一次真实只读联调

2026-09-28，通过服务器本机 `http://127.0.0.1:18766` 直接读取（控制台只监听 loopback）：

- `/api/markets?asset=crypto&duration=5m`：HTTP 200，`collector_online=true`、`stale=false`，BTC 有有效 `marketId`/`roundId`，连续 10 次采样 `sequence` 持续递增、报价年龄 0.3–1.2 秒（阈值 2 秒），`depthAvailable=true`。`strategyEligible` 在交易未运行时为 `false`（仅运行时 accepted snapshot 才为 true）。换场瞬间旧场会短暂 `stale=true` 并带 `market_snapshot_expired`，新场开始后立即恢复——属正常行为。
- `/api/runtime/market-pool`：HTTP 200，`available=true`、`stale=false`、`desiredIds=["btc"]`；`currentIds`/`nextRoundIds` 为空、`effectiveRoundId=null`（交易未运行）。
- `/api/runtime/status`：`status=stopped`、`processRunning=false`、`stale=true`、`error=runtime_snapshot_stale`。停止状态下运行快照过期属正常，不阻止启动。
- `/api/account/status`：`account_check_ready=true`、`settlement_credentials_ready=true`、`live_start_ready=true`、`server_live_enabled=true`。账户已就绪。
- `/api/diagnostics/health`：`status=degraded`（交易未运行所致），`services` 键为 `trading`/`collector`/`projection`，三者均带 `stale` 字段。
- `/api/bootstrap`：`editMarketPool=true`、`fills=true`、`settlements=true`、`strategyDrafts=true`、`strategyActivate=true`、`restRefresh=true`；`cancelOrder`/`flatten`/`presets`/`activateAtRound`/`streams` 为 `false`。
- 用部署后的前端代码对上述真实 DTO 跑启动门禁：五级全部通过，启动按钮可用；`hasFreshBbo` 在 0s/±30s/+5min 客户端时钟偏移下结果一致。
- 本轮为只读复核：未执行启动、停止、下单、账户保存或控制会话写入，未把订单、成交或结算标记为已验证。
- 浏览器会话必须使用正常的 Basic Auth challenge、代理会话或请求头注入；不能把 `user:password@host` 写进页面 URL。账户密码、Token 和私钥不得写入前端或文档。
