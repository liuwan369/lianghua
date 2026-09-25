# 后端接口契约

系统按服务器运行池中的资产提供 BTC 五分钟反转策略所需的账本和 API 投影。`btc` 仍是默认资产和旧接口别名；资产是否可交易由交易运行时能力和配置决定，市场目录可发现不等于策略已启用。以下列出已提供的接口及尚未接通的能力；前端以 `/api/bootstrap` 的 `capabilityDetails` 判断能力是否可用。

## 现有服务可复用接口

生产前端已经有这些只读接口，可以先作为 adapter 的第一版数据源：

- `GET /api/v1/status`：运行状态、策略版本、当前运行摘要。
- `GET /api/v1/markets`：优先使用交易运行时市场快照，采集器为回退来源。
- `GET /api/account/status`：账户配置状态，不应回显秘密。
- `GET /api/v1/runs?limit=50`、`GET /api/v1/events?run_id=...`：运行和事件记录。
- `GET /api/v1/summary?run_id=...`：当前运行汇总。
- `GET /api/v1/system-metrics`：CPU、内存、磁盘、负载和服务进程。
- `GET /api/strategy-config`、`PUT /api/strategy-config`：策略读取和保存。

旧接口保留既有字段和时间格式。运行池由服务器配置的规范化资产 ID 列表决定，默认列表可只有 `btc`；不能因为目录发现了其他资产就宣称它们可交易。交易控制响应表示请求处理状态，最终运行状态由 `/api/runtime/status` 和事件查询确认，不能只根据 `accepted` 判断执行完成。

## REST

现代接口的成功与错误响应都带 `schemaVersion`、`source`、`asOf`、`stale` 和 `error`（无错误时为 `null`）。`asOf/sourceAt/quoteAt/startAt/endAt/expiresAt/updatedAt/savedAt/time` 等现代 DTO 时间统一使用 UTC Unix 秒数（可带小数），未知为 `null`。`asOf` 是数据来源时间，不用本次请求时间刷新旧数据的新鲜度。旧接口以及保留的原始兼容字段不改变格式。

失败时保留最后一次成功快照及其原始来源时间，设置 `stale=true` 和明确的 `error`。从未成功取得数据时使用 unavailable 状态和 `null`，不能清零、伪造空仓或成功结果。HTTP 请求只读取独立投影的 SQLite/原子快照或已有缓存，不解析运行日志，不在交易循环中执行账户、资源或历史统计查询。

| 用途 | 方法 | 路径 | 频率/说明 |
|---|---|---|---|
| 应用能力与版本 | GET | `/api/bootstrap` | 页面首次加载 |
| 市场目录 | GET | `/api/markets?assetId=btc&asset=crypto&duration=5m` | `assetId` 可选过滤；运行时 accepted snapshot 优先；采集器 canonical paired snapshot 只读展示 |
| 单市场快照 | GET | `/api/markets/{marketId}/snapshot` | 首次加载/断线恢复 |
| 运行池 | GET/PUT | `/api/runtime/market-pool` | 服务器持久化规范化 `assetId` 列表；当前控制面支持 `btc/eth/sol`，单实例只能选择一个；当前/下一场由运行时维护。`btc` 是兼容别名，未知资产拒绝保存 |
| 运行状态 | GET | `/api/runtime/status` | 首次加载、断线恢复 |
| 交易控制 | POST | `/api/runtime/commands` | start/pause/stop，带 requestId |
| 策略当前版本 | GET | `/api/strategy/config` | 页面加载；返回已规范化的 `assetId` |
| 保存策略草稿 | POST | `/api/strategy/drafts` | 独立持久化，不发布、不自动启动；`config.assetId` 缺省兼容为 `btc` |
| 激活策略 | POST | `/api/strategy/activate` | `{ expectedRevision, draftId, effectiveRoundId?: null }` |
| 策略参考参数 | GET/POST/DELETE | `/api/strategy/presets` | 尚未提供，`presets=false` |
| 本场持仓 | GET | `/api/rounds/{roundId}/position?assetId=btc&marketId=...` | 首次加载/切场；按 `assetId + marketId + roundId` 精确匹配，旧 URL 仅作为兼容入口 |
| 本场订单 | GET | `/api/rounds/{roundId}/orders?assetId=btc&marketId=...` | 分页历史；按复合市场身份过滤，不能跨资产或跨市场合并 |
| 撤单/清余量 | POST | `/api/orders/{orderId}/cancel`、`/api/runtime/flatten` | 尚未接通，返回 501 和 `accepted=false` |
| 账户快照 | GET | `/api/account/snapshot` | 15 秒；不返回秘密 |
| 账户检查 | POST | `/api/account/check` | 仅检查，不保存 |
| 系统诊断 | GET | `/api/diagnostics/health` | 15 秒，资源和进程 |
| 汇总统计 | GET | `/api/metrics/summary?range=today&assetId=btc&marketId=...&roundId=...` | `run/today/all`，低频；过滤条件按账户和复合市场身份生效 |
| 事件历史 | GET | `/api/events?runId=...&assetId=btc&marketId=...&roundId=...&cursor=...&limit=50` | 按事件 ID 游标分页，低频 |
| 成交记录 | GET | `/api/fills?runId=...&assetId=btc&marketId=...&roundId=...&cursor=...&limit=50` | 同一账本的成交 journal 修订记录，按复合身份过滤 |
| 结算记录 | GET | `/api/settlements?runId=...&assetId=btc&marketId=...&roundId=...&cursor=...&limit=50` | 每场最新结算状态和最终盈亏，按复合身份过滤 |

`/api/bootstrap` 保留兼容字段 `capabilityDetails.streams=false`，并提供 `streams.available=false`、`streams.transport=null` 和空的逐主题 endpoint。没有真实 WebSocket/SSE 服务时不得填入 URL 或宣称可用；`streams.fallbackTransport="rest"` 与 `capabilityDetails.restRefresh=true` 表示可由控制台读取下列 REST 接口。该标志说明查询接口存在，不承诺服务器推送或替前端执行轮询。

运行状态来自异步账本投影的最近 `platform_status` 快照；订单由 `order` 生命周期投影到订单详情，同一 client order 更新同一条记录；`/api/fills` 返回成交 journal 修订记录，汇总按经济成交身份去重；结算投影每场保留最新状态，只有验证到账的结算才进入最终盈亏和胜率。日志仍在追赶或运行快照过期时，状态必须 `stale=true`。run 已选中但异步投影尚未登记时，运行、订单、成交、结算或统计查询返回 HTTP 200、`status="unavailable"`、`available=false`、`stale=true` 和空时间/业务值，稍后由 REST 重查；不能将该窗口改成 404 或零值。

统计响应提供规范字段 `fill_count`、`order_count`、`fill_notional`、`fees`、`estimated_fees`、`settled_markets`、`pnl`、`pnl_semantics`、`settled_wins`、`settled_losses`、`settled_draws`、`pending_settlements`、`settled_pnl_pending` 和 `win_rate`。为旧控制台保留 `fills=fill_count`、`orders=order_count`、`wins=settled_wins`、`losses=settled_losses`；`orders` 必须使用订单生命周期计数，不能用成交数代替。`fees` 只包含已确认费用，`estimated_fees` 单独保留运行时估算费用，不把估算费用当成已确认费用。现代统计默认 `range=today`，按 UTC 当日零点至快照时间内的事件过滤；`range=run` 表示当前运行，旧 `/api/v1/summary?run_id=...` 保留单运行默认行为。`today/all` 汇总同一 `account_id` 下已投影的实盘运行，账户标识未知时仅统计当前运行，避免混入其他账户。`all` 不代表交易所账户完整历史。

无当前 run 或统计投影尚未建立时，`/api/metrics/summary` 使用 HTTP 200 和 `status="unavailable"`、`available=false`、`stale=true`、`completeness="unavailable"`（投影等待时为 `waiting`）；金额、计数、胜率及 `asOf` 为 `null`。投影查询成功后返回 `available=true`；若尚未追上 journal，仍可带最后投影值并同时标记 stale。账户保存回执 `{ok:true,report:{saved:true,...}}` 仅表示配置已保存；其中 `account_check_ready`、`live_start_ready` 和 `settlement_credentials_ready` 独立表达检查/启动资格，保存成功不代表账户已检查通过。

`platform_settlement` 只有 `state=confirmed` 且 `payout_verified=true` 才计入已确认结算，同一结算重复记录不重复计数。`pnl` 是已确认结算净盈亏，不是钱包现金对账；只有完整的已确认成交、实际手续费及已核实结算款齐全，且平台持仓快照可核对成交成本时才给数值，否则为 `null`。`abs(pnl) <= 1e-9` 为平局，不计失败；胜率分母仅包含盈亏已确定的胜局与负局，无结果或平局不进入分母，分母为零时 `win_rate=null`。

账本从交易运行时 `platform_status.runtime.markets` 取得身份映射：`marketId` 是 conditionId，`roundId` 是运行时明确提供的 BTC 五分钟边界标识。`market.name`/`market_slug` 只是兼容显示字段，不能在缺少 `roundId` 时代填。`order`/`fill` 事件即使只带 `market_slug`，也会在映射到达后补齐两个字段；结算事件即使只带 `market_id`，也会补齐 `round_id`。映射尚未发布时标识保持 `null`，不得用事件时间或当前场次猜测旧订单所属轮次。运行重启后同一账户的成交汇总按 `trade_id + order_id` 的经济身份去重，账户之间不合并；单次 journal 的 `event_id` 只用于事件记录去重，不能作为跨运行成交身份。

`pending_settlements` 表示结算尚未确认到账的场次数；`settled_pnl_pending` 表示已确认到账但成本或费用不完整、暂时无法确定盈亏的场次数，两者都不能被统计成失败或零盈亏。

订单 DTO 包含订单状态及其 `fills`。持仓 DTO 包含 `available`、`yesShares`、`noShares`、`averagePrice`、`occupiedUsd` 和按结果的 `outcomePnl`，找不到对应场次时为 unavailable；只有来源明确确认的零持仓才可表示 empty。`/api/fills` 返回成交 journal 修订记录，同一经济成交可能有多条状态/费用修订；每条记录必须保留 `tradeId/orderId/tradeStatus/feeUsd`（同时兼容 snake_case），不能将各页记录直接累加为成交金额；汇总以 `trade_id + order_id` 去重后的投影结果为准。`/api/settlements` 每场只返回最新结算状态，包含 `state/payout_verified/pnl/accounting_state/pnl_error`；`accounting_state` 为 `confirmed` 或 `pending`，`pnl_error` 为 `payout_unverified`、`cost_basis_unverified` 或 `null`。

市场目录返回 `assetId/symbol/name/marketId/roundId/cycle/startAt/endAt/yesToken/noToken/yesBid/yesAsk/noBid/noAsk/volume/liquidity/quoteAt/sourceAt/expiresAt/enabled/nextRound`，并在有 canonical paired snapshot 时保留 `yes/no/orderBook/sequence/depthAvailable/strategyEligible`。采集器文件的 `current_markets[*].snapshot`（兼容 `paired_snapshot`）必须包含 `marketId/roundId/sequence/sourceAt/expiresAt/YES/NO`；每行还返回 `collector_online/healthy/quote_fresh/stale/strategyEligible`，顶层 `collector_online` 表示至少一行健康，`partial` 表示同批次存在健康和失效资产。采集器快照即使新鲜也始终 `strategyEligible=false`，只有交易运行时 accepted snapshot 才能表示策略可用。`depthAvailable=true` 还要求 YES/NO 五档完整且各自 `depthExpiresAt`（如提供）晚于当前时间；过期深度不能冒充可用五档。`marketId` 是 Polymarket conditionId，未知时为 `null`，不得用 slug 冒充；`roundId` 是运行时或 canonical 快照明确提供的 BTC 五分钟起始 Unix 边界字符串，未知时为 `null`，不能从 `name/slug` 或当前时间推导。两者在行情、运行状态、订单、持仓与事件中保持一致。不要让页面直接使用旧的 `up_bid/down_bid` 字段。

行情新鲜度统一使用 `stale_after_ms`：缺省为 2000ms，显式值必须大于 0 且不超过 15000ms；非法值、过期或连接不可用时保留原始 canonical 快照并标记 `stale=true`，不得继续标记为 `strategyEligible`。运行时策略的 `maxQuoteAgeSeconds` 映射到同一阈值；YES/NO 的 `sourceAt` 只有在字段存在时校验，存在但无效或过期仍使快照失效。

旧 `/api/v1/markets` 保留原始 `round_id` slug 字段供旧调用方读取；该兼容字段不代表现代 `roundId` 身份，也不会参与账本归属或结算统计。

运行时 journal 至少应发送 `order`、`fill`、`platform_settlement`、`platform_status`、`platform_stopped` 和错误事件。`platform_status.runtime.markets[]` 及策略 `currentRound/rounds[]` 必须带 `marketId` 和 `roundId`；`order`/`fill` 应带 `market_id/round_id`，账本会在状态映射晚到时回填。启动、暂停、恢复、停止命令的 HTTP 回执只表示 `accepted` 或 `executing`，最终状态必须由运行时状态事件确认。

事件 `items` 必须含 `id/time/kind/marketId/roundId/severity/message`，保留原始 `event/market/side` 等字段供旧调用方使用；标识与时间未知时为 `null`。分页响应含下一页 `cursor`，无后续记录时为 `null`。运行时市场快照优先于采集器缓存，过期报价不能被标为新鲜。

## WebSocket / SSE

以下为预留能力，当前 `capabilityDetails.streams=false`，尚未提供，不能以这些流确认控制命令完成：

- `/api/stream/markets`：报价、五档 depth、场次切换；按 marketId 订阅。当前仍未接通，不能宣称可用。
- `/api/stream/runtime`：启动/暂停/停止状态、策略阶段、错误、服务事件。
- `/api/stream/orders`：订单状态、成交、撤单、结算。

高频行情不能和账户、系统资源、历史统计共用一个轮询。每个消息必须带 sequence 和来源时间。

## 控制命令

```json
{
  "action": "start",
  "strategyId": "btc-reversal",
  "assetId": "btc",
  "revision": 12,
  "requestId": "uuid"
}
```

控制命令、草稿保存和策略激活使用服务器现有控制认证。响应只代表命令处理状态；最终结果由运行状态和事件查询确认。服务状态使用 `stopped/starting/running/paused/failed` 等运行时实际状态，不能用进程存在推断所有交易动作已完成。控制响应还返回 `commandStatus=accepted|executing|confirmed|failed`；暂停最终以 `strategyRuntime.paused=true` 确认，停止后的远端订单以 `remoteOrdersState=unconfirmed` 表示尚未通过账户查询确认。

账户状态只返回 `wallet` 摘要、`accountCheckState`、`accountCheckReady`、`executionCredentialsReady`、`liveStartReady`、`walletKind`、`signatureType` 和 `settlementCredentialsReady` 等非秘密诊断字段。服务器仍兼容读取既有 `POLYMARKET_SESSION_PRIVATE_KEY`、`POLY_FUNDER`、`POLY_SIGNATURE_TYPE` 环境/profile 字段；profile 成为来源时也不得静默丢弃这些字段。最近检查必须匹配当前钱包且未过期；链上余额检查与异步 CLOB 可用余额分开，未知时为 `null`。Builder/Relayer 凭据是否可用于结算只在运行时明确返回时标记为布尔值，否则为 `null`。`account/save` 在交易运行中拒绝，任何 API 响应、日志或文档都不得返回密钥、Token 或 Secret。

资金投影分开返回可用余额、已预留资金、持仓成本、估算手续费和已确认手续费；撤单请求或进程停止都不表示交易所已经释放资金。结算 `confirmed` 只有在 `payout_verified`、交易回执和到账金额同时核实时才可进入已确认盈亏；未决订单、未确认结算和费用缺失保持 `null`，不计入最终胜率。

策略激活使用 `expectedRevision` 检查版本，并以 `draftId` 指定已保存草稿，成功后原子发布新版本。`activationScope=future_uncreated_round` 表示仅影响引擎尚未创建的未来场次：当前及已预热场次配置已冻结。任意非空 `effectiveRoundId` 暂不支持，返回 501，不伪造指定场次已排期。旧 `PUT /api/strategy-config` 保留保存即发布行为，不能当作现代“只保存草稿”的等价回退。

## 前端调用方式

页面不直接调用 `fetch`。统一使用 `window.PolyPreviewAdapter`：

```js
await PolyPreviewAdapter.loadMarkets();
await PolyPreviewAdapter.commandRuntime({ action: "start", strategyId, revision, requestId });
await PolyPreviewAdapter.saveStrategy(draft);
```

adapter 完成 DTO 转换后写入 `PolyPreviewStore`，页面只订阅对应分片。预览模式返回明确的“待接入”结果，不模拟成功，也不把本地草稿当成服务器运行状态。

运行池编辑、策略 presets、指定场次激活、逐笔撤单、flatten 和实时流均按 bootstrap 中对应的 `false` 能力展示不可用，不模拟成功。账户页面只读取服务器保存状态；账户秘密不进入 DTO、浏览器存储或日志，如需更换账户，由服务器环境配置或部署系统完成。
