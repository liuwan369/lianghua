# 接入清单

这是一份实际联调清单，不是交付前置流程。

- [ ] 五个入口都由同一部署前缀和路由配置生成。
- [ ] bootstrap 返回版本、能力和固定 5m crypto 范围。
- [ ] market DTO 有非空 assetId、marketId、roundId、YES/NO token 和有效期；旧 `/api/v1/markets` 缺 roundId 时只能用于目录/报价展示。
- [ ] market-pool 支持 desired/current/nextRound/effectiveRoundId，停用不撤当前场次，PUT 不接受客户端覆盖 current/next。
- [ ] 首次 GET 明确返回空池 `market_pool_unavailable` 时，且浏览器从未收到成功池快照，市场页才允许用一个完整且服务端支持的 `marketId + roundId` 资产发起首次 PUT；网络错误、已有池 stale 或非明确初始错误继续禁止写入。PUT 仍要求现有控制会话，认证失败如实显示。
- [ ] runtime command 支持 requestId 幂等，响应和最终状态分开；前端只在当前市场有服务器确认的可停止状态时开放 stop，状态 stale/unavailable 或缺少市场身份时保留按钮禁用并等待刷新；`remoteOrdersState` 为 `unconfirmed` 时不能显示为撤单已完成。
- [ ] `streams.markets`、`streams.runtime`、`streams.orders` 均配置真实 WebSocket 地址；未配置时使用独立 REST 轮询，页面标明轮询/待接入并保留快照，不生成实时假数据。
- [ ] WS 帧有 sequence/sourceAt/expiresAt；行情和订单帧有 marketId/roundId，旧帧不会覆盖新帧，断线保留最后成功快照并显示 stale。
- [ ] 启动按钮只有在当前市场目录/盘口快照具备 `marketId + roundId`、有效期、递增 `sequence`、新鲜双边 BBO，并且策略、账户和运行池门禁均由服务器确认时开放；启动不要求五档 YES/NO 深度，缺失只影响深度展示（显示“深度暂不可用”），stale、过期或身份不匹配仍保持禁用。
- [ ] 多币种每个 marketId 独立显示盘口、持仓、订单和阶段。
- [ ] 策略保存有服务端校验、完整 `maxStages`、`draftId`、`expectedRevision` 和已发布 revision。
- [ ] 策略草稿保存与策略激活分离；激活请求带 `strategyId`、`draftId`、`expectedRevision`，服务端确认正 revision 后才允许启动；不把草稿提示成已生效。
- [ ] 账户秘密不经过浏览器，账户页面只显示服务器状态；账户切换由服务器环境配置完成。
- [ ] 真实账户快照、账户检查和交易控制已与后端联调；未完成前保持 unavailable/stale，不把演示数据解释成真实交易数据。已保存账户检查发送 `{}`，候选表单检查不替代该检查；保存回执须有 `ok: true` 和对象 `report`。
- [ ] 诊断、账户、统计、日志分别取对应数据源。
- [ ] loading/stale/empty/error 都有可见状态，错误保留上次成功数据。
- [ ] 页面切到后台暂停低优先级刷新，返回时恢复快照。
- [ ] 页面只通过 `PolyPreviewAdapter` 读写，不直接调用 fetch 或 localStorage。
- [ ] 市场目录只由服务器返回并写入 Store，自动交易不复制币种列表或演示资产。
- [ ] 启用币种写入 market-pool 后，后端返回 effectiveRoundId/currentIds/nextRoundIds。
- [ ] 控制按钮传递 requestId 和 marketIds，不能只修改页面文字。
- [ ] 策略保存提交统一 ViewModel，价格单位在 adapter 中只转换一次。
- [ ] 用真实接口检查空数据、过期数据、断线、重复 command、权限错误以及缺失 roundId 的旧市场响应。
- [ ] 用浏览器检查桌面和窄屏布局，确认无横向滚动和整页闪烁。

以上清单描述真实联调前提；后端尚未提供的能力必须在页面保持 `unavailable/stale`，不能用演示数据填充。

## 代码接入状态

- 前端代码已实现五个入口、Store/Adapter 分片更新、`marketId + roundId` 隔离、Unix 秒/毫秒/ISO 时间归一化、盘口 fresh gate、账户启动门禁、stale 快照保留和无 WebSocket 时的独立 REST 轮询。
- 代码已包含目标接口和 legacy adapter 的兼容路径；接口是否能驱动真实交易仍以服务器响应和最终状态事件为准。
- 本清单不把真实订单、成交或结算标记为已验证；本轮只读复核没有执行启动、停止、下单、账户保存或控制会话写入。

## 最近一次真实只读联调

- 通过公网 Basic Auth 会话访问 `overview.html`、`market.html`、`auto-trade.html`、`strategy.html`、`settings.html`，五个入口均返回 HTTP 200。未认证访问返回 HTTP 401，符合部署保护；未在未认证页面上推断 DOM 或交易结果。
- `/api/markets?asset=crypto&duration=5m` 返回 HTTP 200；当前 `collector_online=true`、`stale=false`，BTC/ETH/SOL 均有有效 `marketId`、`roundId`，连续请求中的 `sequence`、`sourceAt`、`expiresAt` 持续更新。生产当前 `depthAvailable=false`、`strategyEligible=false`；新鲜双边 BBO 可独立更新报价，缺少五档不单独禁用启动，五档区域显示“深度暂不可用”，启动仍需通过策略、账户、运行池和服务器运行时门禁。
- `/api/runtime/market-pool` 返回 HTTP 200，但 `available=false`、`stale=true`、`error=market_pool_unavailable`；`/api/runtime/status` 返回 `status=stopped`、`stale=true`、`error=runtime_snapshot_stale`。
- `/api/account/status` 可读取服务器配置状态，但当前 `live_start_ready=false`、`account_check_ready=false`；账户保存/检查另有已观测的 `account_response_invalid` 状态。前端不会把账户配置完成解释为可启动交易。
- 截至 2026-09-25，`/api/diagnostics/health` 返回 `degraded`、`trading_runtime_unavailable`；`/api/account/snapshot` 返回 HTTP 200 但 `available=false`、`stale=true`、`account_response_invalid`。`/api/metrics/summary?range=today` 与 `?range=run` 均返回 HTTP 200，但 `available=false`、`stale=true`、错误为“当前没有运行记录”；路由已部署，当前没有可汇总的运行记录，且无 `runId` 可供 legacy 回退。生产 `streams=false`，因此页面使用 REST 轮询并保留最近成功快照，不创建 WebSocket。
- 浏览器会话必须使用正常的 Basic Auth challenge、代理会话或请求头注入；不能把 `user:password@host` 写进页面 URL，否则浏览器会拒绝相对 `fetch` 请求。账户密码、Token 和私钥不得写入前端或文档。
