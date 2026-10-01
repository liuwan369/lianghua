# 后端接口契约

系统按服务器运行池中的资产提供 BTC 五分钟反转策略所需的账本和 API 投影。`btc` 仍是默认资产和旧接口别名；资产是否可交易由交易运行时能力和配置决定，市场目录可发现不等于策略已启用。以下列出已提供的接口及尚未接通的能力。

`/api/bootstrap` 会返回 `capabilityDetails`，但控制台前端不读取它：推送由 `shared/stream.js` 直接连 `/api/stream`，其余能力判断在各页面。

## 现有服务可复用接口

生产前端已经有这些只读接口，可以先作为 adapter 的第一版数据源：

- `GET /api/account/status`：账户配置状态，不应回显秘密。

旧接口保留既有字段和时间格式。运行池由服务器配置的规范化资产 ID 列表决定，默认列表可只有 `btc`；不能因为目录发现了其他资产就宣称它们可交易。交易控制响应表示请求处理状态，最终运行状态由 `/api/runtime/status` 和事件查询确认，不能只根据 `accepted` 判断执行完成。

## REST

现代接口的成功与错误响应都带 `schemaVersion`、`source`、`asOf`、`stale` 和 `error`（无错误时为 `null`）。`asOf/sourceAt/quoteAt/startAt/endAt/expiresAt/updatedAt/savedAt/time` 等现代 DTO 时间统一使用 UTC Unix 秒数（可带小数），未知为 `null`。`asOf` 是数据来源时间，不用本次请求时间刷新旧数据的新鲜度。旧接口以及保留的原始兼容字段不改变格式。

失败时保留最后一次成功快照及其原始来源时间，设置 `stale=true` 和明确的 `error`。从未成功取得数据时使用 unavailable 状态和 `null`，不能清零、伪造空仓或成功结果。HTTP 请求只读取独立投影的 SQLite/原子快照或已有缓存，不解析运行日志，不在交易循环中执行账户、资源或历史统计查询。

| 用途 | 方法 | 路径 | 频率/说明 |
|---|---|---|---|
| 应用能力与版本 | GET | `/api/bootstrap` | 页面首次加载 |
| 市场目录 | GET | `/api/markets?assetId=btc&asset=crypto&duration=5m` | `assetId` 可选过滤；运行时 accepted snapshot 优先；采集器 canonical paired snapshot 只读展示 |
| 单市场快照 | GET | `/api/markets/{marketId}/snapshot` | 首次加载/断线恢复 |
| 运行池 | GET/PUT | `/api/runtime/market-pool` | 服务器持久化规范化 `assetId` 列表；当前控制面支持 `btc/eth/sol`，单实例只能选择一个。`currentIds` 和 `effectiveRoundId` 仅在运行时新鲜且运行中时填充，否则为空/`null`；`nextRoundIds` 目前恒为空数组（服务器未实现下一场预告），前端不得据此推断下一场。`btc` 是兼容别名，未知资产拒绝保存 |
| 运行状态 | GET | `/api/runtime/status` | 首次加载、断线恢复 |
| 交易控制 | POST | `/api/runtime/commands` | start/pause/stop，带 requestId |
| 控制会话 | POST | `/api/trading/auth/session` | 用 `X-PM-Control-Token` 换取控制会话 cookie；前端 `openControlSession()` 调用 |
| 策略当前版本 | GET | `/api/strategy/config` | 页面加载；返回已规范化的 `assetId` |
| 保存策略草稿 | POST | `/api/strategy/drafts` | 独立持久化，不发布、不自动启动；`config.assetId` 缺省兼容为 `btc` |
| 激活策略 | POST | `/api/strategy/activate` | `{ expectedRevision, draftId, effectiveRoundId?: null }` |
| 策略参考参数 | — | `/api/strategy/presets` | 无此路由：GET/POST 返回 404，DELETE 返回 501（未实现 `do_DELETE`）。`presets=false` |
| 本场持仓 | GET | `/api/rounds/{roundId}/position?assetId=btc&marketId=...` | 首次加载/切场；按 `assetId + marketId + roundId` 精确匹配，旧 URL 仅作为兼容入口 |
| 本场订单 | GET | `/api/rounds/{roundId}/orders?assetId=btc&marketId=...` | 分页历史；按复合市场身份过滤，不能跨资产或跨市场合并 |
| 撤单/清余量 | POST | `/api/orders/{orderId}/cancel`、`/api/runtime/flatten` | 尚未接通，返回 501 和 `accepted=false` |
| 账户快照 | GET | `/api/account/snapshot` | 15 秒；不返回秘密 |
| 账户检查 | POST | `/api/account/check` | 仅检查，不保存 |
| 系统诊断 | GET | `/api/diagnostics/health` | 15 秒，资源和进程 |
| 汇总统计 | GET | `/api/metrics/summary?range=today&assetId=btc&marketId=...&roundId=...` | `run/today/month/all`，低频；过滤条件按账户和复合市场身份生效 |
| 场次记录 | GET | `/api/rounds?runId=...&assetId=btc&roundId=...&beforeRoundId=...&limit=50` | 按场次聚合成交：投入、份额、手续费、均价、结算状态与盈亏；`beforeRoundId` 游标分页 |
| 事件历史 | GET | `/api/events?runId=...&assetId=btc&marketId=...&roundId=...&cursor=...&limit=50` | 按事件 ID 游标分页，低频 |
| 成交记录 | GET | `/api/fills?runId=...&assetId=btc&marketId=...&roundId=...&cursor=...&limit=50` | 同一账本的成交 journal 修订记录，按复合身份过滤 |
| 结算记录 | GET | `/api/settlements?runId=...&assetId=btc&marketId=...&roundId=...&cursor=...&limit=50` | 每场最新结算状态和最终盈亏，按复合身份过滤 |
| 清空运行数据 | POST | `/api/ledger/reset` | 需控制会话 + `{"confirm":"RESET"}`；交易进程运行中返回 409。删除运行日志与投影，**保留链上结算状态文件**（`prepared`/`submitted` 是未完成赎回，删除等于放弃链上资金）、策略配置与运行池 |

`/api/bootstrap` 的 `capabilityDetails.streams=true`、`streams = {available: true, transport: "sse", endpoint: "/api/stream", fallbackTransport: "rest"}`；推送断开时前端退回各 REST 接口轮询。

运行状态来自异步账本投影的最近 `platform_status` 快照；订单由 `order` 生命周期投影到订单详情，同一 client order 更新同一条记录；`/api/fills` 返回成交 journal 修订记录，汇总按经济成交身份去重；结算投影每场保留最新状态，只有验证到账的结算才进入最终盈亏和胜率。运行状态 DTO 另提供 `processRunning`，只表示控制面 `trading_status()` 直接观察到的本地交易子进程事实（`true`、`false` 或未知 `null`），不从异步账本 projection、行情新鲜度或交易所动作推导；因此 projection 追赶或过期时，前端仍能独立判断进程是否运行。日志仍在追赶或运行快照过期时，状态必须 `stale=true`。run 已选中但异步投影尚未登记时，运行、订单、成交、结算或统计查询返回 HTTP 200、`status="unavailable"`、`available=false`、`stale=true` 和空时间/业务值，稍后由 REST 重查；不能将该窗口改成 404 或零值。

统计响应提供规范字段 `fill_count`、`order_count`、`fill_notional`、`fees`、`estimated_fees`、`settled_markets`、`pnl`、`pnl_semantics`、`settled_wins`、`settled_losses`、`settled_draws`、`pending_settlements`、`settled_pnl_pending`、`win_rate`、`unsettled_cost`、`unsettled_rounds` 和 `exposed_pnl`（驼峰别名 `unsettledCost`、`unsettledRounds`、`exposedPnl`）。资本在成交时已经支出，收益只有结算确认后才可证明，所以只报已结算盈亏会把"已花钱但未确认"的场次当成没交易过，等于把亏损显示成盈利。`exposed_pnl` = 已确认盈亏 − 未结算场次的已投入成本，与 `pnl` 并列显示；结算确认后该场次移出 `unsettled_rounds`，两个数字自动收敛，全部确认后相等。`settled_pnl` 报告**已知**部分而不是因为个别场次缺盈亏就整体隐藏，未知场次数由 `settled_pnl_pending` 同时给出。为旧控制台保留 `fills=fill_count`、`orders=order_count`、`wins=settled_wins`、`losses=settled_losses`；`orders` 必须使用订单生命周期计数，不能用成交数代替。`fees` 只包含已确认费用，`estimated_fees` 单独保留运行时估算费用，不把估算费用当成已确认费用。

费用来源分三级，只有第三级才算估算。Polymarket 的费用是**撮合时即确定的公式值**，不是事后结算数字：`fee = C × feeRate × p × (1 - p)`，四舍五入到 5 位小数，crypto 市场 taker 费率 0.07、maker 0，makers 不收费（见 <https://docs.polymarket.com/polymarket-learn/trading/fees>）。因此：

- `fee_source="reported"`：交易所在成交回报里直接给出的费用，最权威。实测 maker 成交为 0。
- `fee_source="rate-derived"`：费率取自该市场自身的费用元数据，份额与价格均为精确值，按上述官方公式算出。这是**确定性计算结果，不是估算**，计入 `fees` 与 `pnl`。交易所不会对 taker 成交回报费用，等 `reported` 等不到，若把它当估算会让 `pnl` 永久为 `null`。
- `fee_source="estimate"`：连费率都未知时的兜底猜测，仍然只进 `estimated_fees`，并继续阻断 `pnl`（`pnl_error="cost_basis_unverified"`）。

后到的 `reported` 费用仍可覆盖同一笔成交的 `rate-derived` 值。现代统计默认 `range=today`，按北京时间（UTC+8）当日零点至快照时间内的事件过滤；`range=month` 按北京时间当月一日零点起算；`range=run` 表示当前运行。`today/month/all` 汇总同一 `account_id` 下已投影的实盘运行，账户标识未知时仅统计当前运行，避免混入其他账户。`all` 不代表交易所账户完整历史。

无当前 run 或统计投影尚未建立时，`/api/metrics/summary` 使用 HTTP 200 和 `status="unavailable"`、`available=false`、`stale=true`、`completeness="unavailable"`（投影等待时为 `waiting`）；金额、计数、胜率及 `asOf` 为 `null`。投影查询成功后返回 `available=true`；若尚未追上 journal，仍可带最后投影值并同时标记 stale。账户保存回执 `{ok:true,report:{saved:true,...}}` 仅表示配置已保存；其中 `account_check_ready`、`live_start_ready` 和 `settlement_credentials_ready` 独立表达检查/启动资格，保存成功不代表账户已检查通过。

`platform_settlement` 只有 `state=confirmed` 且 `payout_verified=true` 才计入已确认结算，同一结算重复记录不重复计数。`pnl` 是已确认结算净盈亏，不是钱包现金对账；只有完整的已确认成交、实际手续费及已核实结算款齐全，且平台持仓快照可核对成交成本时才给数值，否则为 `null`。`abs(pnl) <= 1e-9` 为平局，不计失败；胜率分母仅包含盈亏已确定的胜局与负局，无结果或平局不进入分母，分母为零时 `win_rate=null`。

账本从交易运行时 `platform_status.runtime.markets` 取得身份映射：`marketId` 是 conditionId，`roundId` 是运行时明确提供的 BTC 五分钟边界标识。`market.name`/`market_slug` 只是兼容显示字段，不能在缺少 `roundId` 时代填。`order`/`fill` 事件即使只带 `market_slug`，也会在映射到达后补齐两个字段；结算事件即使只带 `market_id`，也会补齐 `round_id`。映射尚未发布时标识保持 `null`，不得用事件时间或当前场次猜测旧订单所属轮次。运行重启后同一账户的成交汇总按 `trade_id + order_id` 的经济身份去重，账户之间不合并；单次 journal 的 `event_id` 只用于事件记录去重，不能作为跨运行成交身份。

赎回到账的判定以**钱包实际收到的 pUSD 为准，不是以我们自己那笔交易的回执为准**。Polymarket 自己运行自动赎回 relayer，可能比我们的赎回早一个区块烧掉同一批持仓；此时我们的交易成功上链但烧掉 0 份额、到账 0，不能判成付款失败。结算适配器会查是谁先把这批 tokenId 转出钱包并按对方回执记账，状态为 `confirmed`、原因标注"持仓已由平台自动赎回"。只有持仓仍在或确实无人赎回时才是 `settlement_receipt_balance_or_payout_mismatch`。

`pending_settlements` 表示结算尚未确认到账的场次数；明确确认无成交且无持仓、无需赎回的场次使用 `accounting_state=no_trade` 和 `redemption_required=false`，不计入该字段。`settled_pnl_pending` 表示已确认到账但成本或费用不完整、暂时无法确定盈亏的场次数；这些状态都不能被统计成失败或零盈亏。

订单 DTO 包含订单状态及其 `fills`。持仓 DTO 包含 `available`、`yesShares`、`noShares`、`averagePrice`、`occupiedUsd` 和按结果的 `outcomePnl`，找不到对应场次时为 unavailable；只有来源明确确认的零持仓才可表示 empty。运行时快照存放在 `platform_runtime`，每个 run **只保留一行最新快照**，因此交易停止后历史场次在快照中不再存在；此时持仓 DTO 改由成交记录回落，返回 `source="fills"` 并给出 `totalShares`、`averagePrice`、`occupiedUsd`、`fees`、`settlementState`、`creditedUsd`。成交记录无法区分多空分腿，所以 `yesShares/noShares` 为 `null` 而不是断言零。前端必须把 `source="fills"` 当成可渲染的历史数据，不能当成读取失败而清空面板——这与"只有明确确认的零持仓才可表示 empty"是同一条规则。`/api/fills` 返回成交 journal 修订记录，同一经济成交可能有多条状态/费用修订；每条记录必须保留 `tradeId/orderId/tradeStatus/feeUsd`（同时兼容 snake_case），不能将各页记录直接累加为成交金额；汇总以 `trade_id + order_id` 去重后的投影结果为准。`/api/settlements` 每场只返回最新结算状态，包含 `state/payout_verified/pnl/accounting_state/pnl_error`；有成交场次的 `accounting_state` 为 `confirmed` 或 `pending`，`pnl_error` 为 `payout_unverified`、`cost_basis_unverified` 或 `null`。明确确认无成交且无持仓的场次使用 `accounting_state=no_trade`、`pnl_error=no_trade`、`redemption_required=false`，表示无需赎回而不是待结算，不伪造 `payout_verified` 或 `pnl`。

市场目录返回 `assetId/symbol/name/marketId/roundId/cycle/startAt/endAt/yesToken/noToken/yesBid/yesAsk/noBid/noAsk/volume/liquidity/quoteAt/sourceAt/expiresAt/enabled/nextRound`，并在有 canonical paired snapshot 时保留 `yes/no/orderBook/sequence/depthAvailable/strategyEligible`。每行还返回 `supported` 和 `canEnable`（两者都等于「`assetId` 属于服务器支持集合」，当前支持集为 `btc/eth/sol`）以及 `current`（本场是否正在进行）和 snake_case 兼容的 `market_id`/`round_id`。`canEnable` 是前端判断能否加入运行池的实际依据；前端不猜测资格，缺少该字段即视为不可启用。采集器文件的 `current_markets[*].snapshot`（兼容 `paired_snapshot`）必须包含 `marketId/roundId/sequence/sourceAt/expiresAt/YES/NO`；每行还返回 `collector_online/healthy/quote_fresh/stale/strategyEligible`，顶层 `collector_online` 表示至少一行健康，`partial` 表示同批次存在健康和失效资产。采集器快照即使新鲜也始终 `strategyEligible=false`，只有交易运行时 accepted snapshot 才能表示策略可用。`depthAvailable=true` 还要求 YES/NO 五档完整且各自 `depthExpiresAt`（如提供）晚于当前时间；过期深度不能冒充可用五档。`marketId` 是 Polymarket conditionId，未知时为 `null`，不得用 slug 冒充；`roundId` 是运行时或 canonical 快照明确提供的 BTC 五分钟起始 Unix 边界字符串，未知时为 `null`，不能从 `name/slug` 或当前时间推导。两者在行情、运行状态、订单、持仓与事件中保持一致。不要让页面直接使用旧的 `up_bid/down_bid` 字段。

`name` 是后端 slug（例如 `btc-updown-5m-1790647800`），是身份字段而不是展示字段：直接当标题会把时间戳怼给用户。前端视图模型据此派生 `label`（例如 `BTC 5分钟 · 10:20 场`）和 `closeText`（本地时分），标题与列表用派生值，完整 slug 降到副行保留可追溯性。派生字段随场次翻滚变化，必须参与行重绘比对键，否则行会停留在上一场的时间。同理 `endAt` 是 Unix 秒，任何界面都不能原样显示。

行情新鲜度统一使用 `stale_after_ms`：缺省为 2000ms，显式值必须大于 0 且不超过 15000ms；非法值、过期或连接不可用时保留原始 canonical 快照并标记 `stale=true`，不得继续标记为 `strategyEligible`。运行时策略的 `maxQuoteAgeSeconds` 映射到同一阈值；YES/NO 的 `sourceAt` 只有在字段存在时校验，存在但无效或过期仍使快照失效。

**新鲜度判定归服务器所有。** 浏览器不得用本地时钟判断报价是否过期：服务器和客户端之间的任何时钟偏移都会让有效快照被永久判成过期，从而彻底堵死启动。前端只信服务器的 `stale` 布尔，加上身份（`marketId`/`roundId`）、`sequence` 和双边报价是否齐全；因此服务器必须在过期、断线或来源不健康时如实置 `stale=true`，这是前端唯一的过期信号。真正的执行前闸门在服务器端 `backend/engine/src/platform/snapshot-gate.ts`，它在任何下单前重新校验序号、来源时间和有效期。前端若需本地倒计时，只能使用服务器测量出的寿命差值（`expiresAt - sourceAt`），不能把服务器的 `expiresAt` 直接与浏览器时钟比较。


运行时 journal 至少应发送 `order`、`fill`、`platform_settlement`、`platform_status`、`platform_stopped` 和错误事件。`platform_status.runtime.markets[]` 及策略 `currentRound/rounds[]` 必须带 `marketId` 和 `roundId`；`order`/`fill` 应带 `market_id/round_id`，账本会在状态映射晚到时回填。启动、暂停、恢复、停止命令的 HTTP 回执只表示 `accepted` 或 `executing`，最终状态必须由运行时状态事件确认。

事件 `items` 必须含 `id/time/kind/marketId/roundId/severity/message`，保留原始 `event/market/side` 等字段供旧调用方使用；标识与时间未知时为 `null`。分页响应含下一页 `cursor`，无后续记录时为 `null`。运行时市场快照优先于采集器缓存，过期报价不能被标为新鲜。

## 推送（SSE）

`GET /api/stream?p=<GET 路径>&p=...`（URL 编码），一条 `EventSource` 连接订阅多个路径。每条消息 `data: {"path", "version", "body"}`，`body` 与直接 GET 该路径的响应完全相同（服务器用同一个处理函数生成）。新连接先收到每个路径的当前值；之后内容变了才推，不变的每 5 秒补一次。可订阅：`/api/markets`、`/api/runtime/status`、`/api/rounds`、`/api/fills`、`/api/settlements`、`/api/events`、`/api/account/snapshot`、`/api/metrics/summary`、`/api/account/status`、`/api/runtime/market-pool`、`/api/strategy/config`、`/api/diagnostics/health`（含子路径）。每 15 秒一行 `: ping` 心跳；超过 50 条连接返回 503，前端退回轮询。推送不用于确认控制命令完成，命令结果以 `/api/runtime/status` 为准。

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

控制台进程只允许监听本机地址（`127.0.0.1`/`localhost`/`::1`），传入其他 host 会直接拒绝启动。控制类端点没有独立的网络层鉴权，安全模型依赖「loopback 绑定 + 控制令牌 + 反向代理」三者共同成立；对外暴露必须经由 `config/` 里的反向代理配置，不能把服务直接绑到公网地址。

控制命令、草稿保存和策略激活使用服务器现有控制认证。响应只代表命令处理状态；最终结果由运行状态和事件查询确认。服务状态使用 `stopped/starting/running/paused/failed` 等运行时实际状态，不能用进程存在推断所有交易动作已完成。控制响应还返回 `commandStatus=accepted|executing|confirmed|failed`；暂停最终以 `strategyRuntime.paused=true` 确认，停止后的远端订单以 `remoteOrdersState=unconfirmed` 表示尚未通过账户查询确认。

账户状态只返回 `wallet` 摘要、`accountCheckState`、`accountCheckReady`、`executionCredentialsReady`、`liveStartReady`、`walletKind`、`signatureType` 和 `settlementCredentialsReady` 等非秘密诊断字段。服务器仍兼容读取既有 `POLYMARKET_SESSION_PRIVATE_KEY`、`POLY_FUNDER`、`POLY_SIGNATURE_TYPE` 环境/profile 字段；profile 成为来源时也不得静默丢弃这些字段。最近检查必须匹配当前钱包且未过期；链上余额检查与异步 CLOB 可用余额分开，未知时为 `null`。Builder/Relayer 凭据是否可用于结算只在运行时明确返回时标记为布尔值，否则为 `null`。`account/save` 在交易运行中拒绝，任何 API 响应、日志或文档都不得返回密钥、Token 或 Secret。

资金投影分开返回可用余额、已预留资金、持仓成本、估算手续费和已确认手续费；撤单请求或进程停止都不表示交易所已经释放资金。结算 `confirmed` 只有在 `payout_verified`、交易回执和到账金额同时核实时才可进入已确认盈亏；未决订单、未确认结算和费用缺失保持 `null`，不计入最终胜率。

策略激活使用 `expectedRevision` 检查版本，并以 `draftId` 指定已保存草稿，成功后原子发布新版本。`activationScope=future_uncreated_round`：新配置用于所有尚未开始、且离开盘超过 10 秒的场次；开盘前 10 秒起及当前场次的配置已冻结（BUGS P2-12）。任意非空 `effectiveRoundId` 暂不支持，返回 501，不伪造指定场次已排期。

## 前端调用方式

页面不直接调用 `fetch`。统一使用 `window.PolyPreviewAdapter`：

```js
await PolyPreviewAdapter.loadMarkets();
await PolyPreviewAdapter.commandRuntime({ action: "start", strategyId, revision, requestId });
await PolyPreviewAdapter.saveStrategy(draft);
```

adapter 完成 DTO 转换后写入 `PolyPreviewStore`，页面只订阅对应分片。数据源只有后端一个：不存在预览/演示模式（`demo` 在配置展开之后被硬编码为 `false`，外部配置无法开启），后端未连接时显示 unavailable/stale，不模拟成功，也不把本地草稿当成服务器运行状态。`preview-core.js` 里的 `storage` 已无任何调用方，运行池、行情、持仓、订单和账户都不写入浏览器本地存储。

共享层文件名和全局对象仍带 `preview`/`PolyPreview` 前缀，这只是历史命名，不表示预览环境；生产就是用这些名字。

策略 presets、指定场次激活、逐笔撤单、flatten 和实时流尚未接通，展示为不可用，不模拟成功。运行池编辑已接通（`capabilityDetails.editMarketPool=true`，GET/PUT `/api/runtime/market-pool` 可用），不属于这一类。账户页面只读取服务器保存状态；账户秘密不进入 DTO、浏览器存储或日志，如需更换账户，由服务器环境配置或部署系统完成。
