# 控制面 HTTP API

`scripts/system-dashboard-server.py`，只监听 `127.0.0.1:18766`，外部经 nginx 访问。路由在 `make_handler` 的 `_get` / `do_POST` / `do_PUT`。

## 通用

- `/api/*`（除 `/api/live`、`/api/account/status|check|save`、`/api/trading/*`）的 JSON 响应都带 `schemaVersion`、`source`、`asOf`（Unix 秒）、`stale`、`error`。
- 数据暂不可用时返回 200 + `available=false`、`stale=true`，不返回零值。查询参数非法 400，记录不存在 404，数据源异常 503。
- 场次、成交、结算、事件、统计接口的上一次成功响应会被缓存；之后出 5xx 时返回缓存并标 `stale=true`。
- 身份字段：`marketId` 是 conditionId，`roundId` 是五分钟起点的 Unix 秒字符串，`assetId` 是币（btc/eth/sol/xrp/doge/hype/bnb）。

## 鉴权

- nginx 对整个站点做 basic auth，转发时设置 `X-PM-Authenticated: $remote_user` 和 `X-Forwarded-Proto`。
- GET 没有应用层鉴权（依赖 nginx）。
- 写操作（`/api/runtime/commands`、`/api/strategy/*`、`/api/runtime/market-pool`、`/api/ledger/reset`）：`Content-Type` 必须是 `application/json`；带 `Origin` 时其 host 必须等于 `Host`。服务器设了 `PM_TRUST_ACCOUNT_PROXY=1` 且请求是 HTTPS、带 `Origin` 和 `X-PM-Authenticated` 时直接通过；否则要控制会话 cookie `pm_control_session`（HMAC 签名，默认 12 小时）或 `X-PM-Control-Token` / `Authorization: Bearer` 控制密码。
- 账户接口（`/api/account/check|save`）：`Origin` 必须存在且等于 `Host`；HTTPS 代理已认证或 `Origin` 等于 `PM_ACCOUNT_PUBLIC_ORIGIN` 时通过，否则只接受本机来源并要控制密码。
- 启动还要满足业务条件：UUID `requestId`、当前已保存的配置版本、`marketIds` 恰好一个市场、内部 `confirm_live`、服务器 `PM_TRADING_LIVE_UNLOCK=1`、账户检查通过（见 ARCHITECTURE.md）。

## GET

| 路径 | 用途与主要字段 |
|---|---|
| `/` | 302 到 `/console/` |
| `/console/*` 静态文件（`frontend/console/`） | HTML 不缓存并注入 `window.__POLY_PREVIEW_CONFIG__`；JS/CSS 用 ETag 协商 |
| `/api/bootstrap` | 应用信息、`capabilityDetails`、`streams`（SSE 端点）、`runtime` |
| `/api/stream?p=<GET 路径>&p=…` | SSE 推送，见下文 |
| `/api/markets?assetId=` | 币种目录 `items[]`：`assetId/marketId/roundId/startAt/endAt/yesBid/yesAsk/noBid/noAsk/orderBook/quoteAt/stale/strategyEligible/supported/canEnable/current/oneSided`。`oneSided`：一边没有挂单时（快收盘赢的那边没人卖）交易所当前的盘口 `{at, yesBid, yesAsk, noBid, noAsk}`，空的一边为 null；只用于展示，有它时 `stale` 仍为 true，不能交易；比双边价旧或超过 15 秒则为 null。`quietConfirmedAt`：双边报价超过 2 秒没人改价时，采集器向交易所 REST 盘口核对、两边最优价都没变的时间（unix 秒）；只用于展示，`stale` 仍为 true；超过 3 秒没再核对上则为 null |
| `/api/markets/{marketId}/snapshot?roundId=&marketId=` | 单市场盘口，找不到 404 |
| `/api/runtime/status` | 引擎状态：`status`、`processRunning`、`strategyId`（`binance-lead`）、风控、资金、当前场次、停止结果；`leadFeedHealthy`（币安 aggTrade 行情是否在收，null=未知）；`leadSignals[]` 最近 20 个币安信号，最新在前：`trade_id/direction/move_bp/received_at/market_id/round_id/outcome`（`order_submitted`/`skipped`/`no_round`/`stopping`）`/reason/limit_price/ask_at_signal` |
| `/api/runtime/market-pool` | 运行池：`desiredIds`、`currentIds`、`effectiveRoundId` |
| `/api/strategy/config` | `strategyId="binance-lead"`、已发布配置 `config`、`savedRevision`、`draft`、`activationScope="future_uncreated_round"`。`config` 字段：`assetId, shares, thresholdBp, windowMs, limitPremium, fromSec, toSec, maxAsk, makerHoldSec, maxQuoteAgeSeconds, maxQuoteSkewSeconds, roundBudgetUsd, totalBudgetUsd, dailyLossUsd`（后三个可为 null）和控制面的 `mode, durationMinutes, maxRounds`。`maxAsk` 是信号那一边的卖价上限（含等于，默认 0.80），之前发布的配置没有这个字段时按 0.80 读。`makerHoldSec` 是挂单秒数，0 = FAK 吃单，> 0 = 在买一价只挂单、挂这么多秒后撤，没有这个字段时按 0 读。从没发布过时返回默认值、`savedRevision: 0`（旧的 btc-reversal 配置不读），此时启动被拒 |
| `/api/account/status` | 账户配置就绪情况（不含秘密）：`account_check_state`、`server_live_enabled`、`control_source` 等 |
| `/api/account/snapshot` | 余额、占用、持仓、挂单；不含成交史、链上活动、平仓记录 |
| `/api/diagnostics/health` | `status` ok/degraded、`services`（trading/collector/projection）、`resources`、问题列表在 `error` |
| `/api/metrics/summary?range=run\|today\|month\|all&runId=&assetId=&marketId=&roundId=` | 统计：`fill_count`、`order_count`、`fill_notional`、`fees`、`settled_pnl`/`pnl`、`settled_wins`/`settled_losses`、`win_rate`、`unsettled_cost`、`unsettled_rounds`、`exposed_pnl`、`pending_settlements`、`pnl_source`、`pnl_source_error`、`pnl_source_as_of`。today/month 按北京时间 |
| `/api/rounds?runId=&assetId=&roundId=&beforeRoundId=&limit=` | 按场次聚合：投入、份额、手续费、均价、`status`、`settled`、`pnl`、`pnlSource`；官方已结算的场次 `status="已结算"` |
| `/api/rounds/{roundId}/orders?assetId=&marketId=&limit=&offset=` | 该场订单 `orders[]`（含 `fills`）、`total` |
| `/api/rounds/{roundId}/position?assetId=&marketId=` | 该场持仓：`yesShares/noShares/averagePrice/occupiedUsd/outcomePnl`；`attempt`（本场那一笔，没下单时 null）：`direction/price`（限价）`/askAtSignal/shares/filledShares/status/moveBp/binancePrice/refPrice/signalAt`；`reason`（策略对本场的说明，没下单时就是原因）、`roundStatus`、`config`、`latest`（当前盘口 `upAsk/downAsk/twoSided/freshOnArrival/staleReason`）。运行快照已无此场时 `source="fills"` 由成交回落 |
| `/api/events?runId=&cursor=&limit=` | 事件分页 `items[]`、`cursor`。币安信号（账本事件 `lead_signal`，一天几百条）不在这里，看 `/api/runtime/status` 的 `leadSignals` |
| `/api/fills?…` | 成交事件分页（同一成交可能有多条修订） |
| `/api/settlements?…` | 每场最新结算；`pnl` 取官方结果，`pnlSource` |
| `/api/live` | 采集器快照（引擎发现兜底用） |

## POST / PUT

| 路径 | 用途 |
|---|---|
| `POST /api/runtime/commands` | `{action: start\|pause\|resume\|stop, requestId, revision\|expectedRevision, assetId, marketIds}`。返回 `accepted`、`status`、`commandStatus`、`remoteOrdersState`。最终状态看 `/api/runtime/status` |
| `POST /api/strategy/drafts` | `{strategyId:"binance-lead", config, expectedRevision}` 保存草稿；`config` 必须恰好是上面的字段，范围同引擎 `normalizeBinanceLeadConfig`（份额 (0,10000]、阈值 (0,1000] bp、窗口 (0,60000] ms、加价 [0,1)、0 ≤ fromSec < toSec ≤ 300、卖价上限 maxAsk (0,1)、挂单秒数 makerHoldSec [0,300]、两个盘口门 > 0、预算和日亏损为空或 > 0），不合法 400；版本冲突 409 |
| `POST /api/strategy/activate` | `{expectedRevision, draftId}` 发布草稿，对之后尚未冻结的场次生效；`effectiveRoundId` 非空返回 501 |
| `POST\|PUT /api/runtime/market-pool` | 设置运行池（单币） |
| `POST /api/ledger/reset` | `{confirm:"RESET"}`，引擎在跑或无法确认已停时 409。删 journal、引擎状态和投影，保留结算记录、配置、运行池 |
| `POST /api/account/check`、`/api/account/save` | 账户检查 / 保存，返回 `{ok, report}`，不含秘密 |
| `POST /api/trading/auth/session` | 用控制密码换会话 cookie；HTTPS 代理已认证时直接返回 `proxy_authenticated` |
| `POST /api/runtime/flatten`、`/api/orders/{id}/cancel` | 未实现，返回 501 |

## 推送 `/api/stream`

`scripts/dashboard/push.py` 的 `PushHub`。页面把要轮询的 GET 路径作为 `p` 参数订阅（每连接最多 24 个路径，全站最多 50 条连接，满了返回 503）。每条消息是 `data: {"path","version","body"}`，`body` 与直接 GET 该路径完全相同（同一个 handler 渲染）。新连接先收每个路径的当前值，之后只推变化；内容没变每 5 s 重发一次，空闲每 15 s 发 `: ping`；`retry: 2000`。

重渲染节奏（秒）：

| 路径前缀 | 节奏 |
|---|---|
| `/api/markets/{id}/snapshot` | 0.1 |
| `/api/markets`（目录） | 2 |
| `/api/runtime/status` | 0.25 |
| `/api/rounds`、`/api/fills` | 0.5 |
| `/api/settlements`、`/api/events`、`/api/account/snapshot` | 1 |
| `/api/metrics/summary`、`/api/account/status`、`/api/runtime/market-pool`、`/api/strategy/config` | 2 |
| `/api/diagnostics/health` | 5 |

账本类路径只在 `ledger.sqlite3`/WAL/`snapshot.json` 变了才重渲染；市场路径看采集器文件和账本；账户快照看读取器刷新时间。推送断开时 `shared/stream.js` 让页面退回普通轮询。
