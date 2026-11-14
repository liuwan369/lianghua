# 控制面 HTTP API

`scripts/system-dashboard-server.py`，只监听 `127.0.0.1:18766`，外部经 nginx（`config/pm-console-nginx.conf`）访问。路由在 `make_handler` 的 `_get` / `do_POST`。

## 通用

- `/api/*`（除 `/api/account/status`）的 JSON 响应都带 `schemaVersion`、`source`、`asOf`（Unix 秒）、`stale`、`error`。
- 数据暂不可用时返回 200 + `available=false`、`stale=true`，不返回零值。查询参数非法 400，记录不存在 404，数据源异常 503。
- 场次、成交、结算、事件、统计、领先单接口的上一次成功响应会被缓存；之后出 5xx 时返回缓存并标 `stale=true`。`/api/stats/lead`、`/api/orders/lead` 另按账本文件 mtime 缓存，账本没写就不重算。
- 身份字段：`marketId` 是 conditionId，`roundId` 是五分钟起点的 Unix 秒字符串，`assetId` 只有 `btc`。
- `range`：`run` 当前（或最后一次）运行；`today` / `7d` / `month` 按北京时间 00:00 切天（`7d` 是今天和前六天）；`all` 全部。`today/7d/month/all` 覆盖该账户的所有运行。

## 鉴权

- 登录只有一道：nginx 对整个站点做 HTTPS + Basic Auth（`/etc/nginx/pm-console.htpasswd`），转发时覆盖 `X-PM-Authenticated: $remote_user` 和 `X-Forwarded-Proto: $scheme`。没有控制密码，也没有会话 cookie。
- GET 没有应用层鉴权（依赖 nginx）。
- 写操作（`POST /api/runtime/commands`、`/api/strategy/drafts`、`/api/strategy/activate`、`/api/ledger/reset`）全部要满足：`Content-Type: application/json`（否则 415）；`Origin` 存在、是 `https` 且 host 等于 `Host`（否则 403）；服务器 `PM_TRUST_ACCOUNT_PROXY=1` 且带 `X-PM-Authenticated`、`X-Forwarded-Proto: https`（否则 401）。本机直连没有这些头，写操作一律拒绝；测试自己带上这些头。
- 账户在控制台只读：账户文件（`PM_ACCOUNT_PROFILE`，默认 `/root/.config/pm-system/account.json`，权限 600）由运维在服务器上写，控制台只读它给引擎和账户读取器用。
- 启动还要满足业务条件：UUID `requestId`、当前已保存的配置版本、服务器 `PM_TRADING_LIVE_UNLOCK=1`、15 分钟内的账户检查通过（后台每 10 分钟刷新一次）。

## GET

| 路径 | 用途与主要字段 |
|---|---|
| `/` | 302 到 `/console/` |
| `/console/*` 静态文件（`frontend/console/`） | HTML 不缓存并注入 `window.__POLY_PREVIEW_CONFIG__`；JS/CSS 用 ETag 协商 |
| `/api/stream?p=<GET 路径>&p=…` | SSE 推送，见下文 |
| `/api/runtime/status` | 引擎状态，见下文 |
| `/api/runtime/book` | 正在跑的引擎当前场次的盘口，见下文；没有引擎时 `{running:false, available:false}` |
| `/api/strategy/config` | 见下文 |
| `/api/account/status` | 账户就绪情况，不含任何秘密：`wallet`、`account_check_state`（ready/stale/unknown）、`account_check_ready`、`last_check`（最近一次检查报告：余额、授权、签名人是否匹配等）、`last_check_at`、`last_check_error`、`server_live_enabled`、`execution_credentials_ready`、`live_start_ready`、`settlement_credentials_ready`、各凭据 `*_configured` 布尔、`node_label` |
| `/api/account/snapshot` | 余额 `collateral`、占用 `occupancy`、持仓 `positions`（含可赎回 `redeemable`）、挂单 `open_orders`；每段 `{available, complete, items}`；不含成交史、链上活动、平仓记录 |
| `/api/diagnostics/health` | 见下文 |
| `/api/stats/lead?range=run\|today\|7d\|all` | 领先策略统计，见下文 |
| `/api/orders/lead?range=&limit=200&before=` | 领先单列表，见下文 |
| `/api/metrics/summary?range=run\|today\|month\|all&runId=&assetId=&marketId=&roundId=` | 统计：`fill_count`、`order_count`、`fill_notional`、`fees`、`settled_pnl`/`pnl`、`settled_wins`/`settled_losses`、`win_rate`、`unsettled_cost`、`unsettled_rounds`、`exposed_pnl`、`pending_settlements`、`pnl_source`、`pnl_source_error`、`pnl_source_as_of` |
| `/api/rounds?runId=&roundId=&beforeRoundId=&limit=` | 按场次聚合：投入、份额、手续费、均价、`status`、`settled`、`pnl`、`pnlSource`；官方已结算的场次 `status="已结算"` |
| `/api/rounds/{roundId}/orders?marketId=&limit=&offset=` | 该场订单 `orders[]`（含 `fills`）、`total` |
| `/api/rounds/{roundId}/position?marketId=` | 该场持仓：`yesShares/noShares/averagePrice/occupiedUsd/outcomePnl`；`attempt`（本场那一笔，没下单时 null）：`direction/price`（限价）`/askAtSignal/shares/filledShares/status/moveBp/signalPrice/refPrice/venue/line/signalAt`；`reason`、`roundStatus`、`config`、`latest`（`upAsk/downAsk/twoSided/freshOnArrival/staleReason`）。运行快照已无此场时 `source="fills"` 由成交回落 |
| `/api/events?runId=&cursor=&limit=` | 事件分页 `items[]`、`cursor`。信号（`lead_signal`）和领先单（`lead_order`）不在这里 |
| `/api/fills?…` | 成交事件分页（同一成交可能有多条修订） |
| `/api/settlements?…` | 每场最新结算；`pnl` 取官方结果、`pnlSource`；`winning_token_id`、`winning_side`（`Up`/`Down`） |

### `/api/runtime/status`

`status`/`state`（starting/running/paused/stopped/failed）、`serviceState`、`commandStatus`（executing/confirmed/failed）、`processRunning`、`remoteOrdersState`、`stopResult`（`{confirmed, process_stopped, remote_orders_state, reason, message}` 或 null）、`runId`、`strategyId`（`binance-lead`）、`assetId`（`btc`）、`configRevision`、`startedAt`、`paused`、`risk`、`funds`（`availableUsd/occupiedUsd/reservedUsd/positionCostUsd/...`，未知为 null）、`currentRound`（策略当前场：`marketId/roundId/startsAt/endsAt/status/reason/attempted/stages[0..1]/latest/config/upShares/downShares/netIfUpUsd/netIfDownUsd`）、`markets`（引擎正在看的场：`marketId/roundId/name/startsAt/endsAt/instruments`）、`projection`。

领先行情：`leadFeedHealthy`（某个交易所某条线路 10 s 内有当前成交，null=未知）、`leadVenues`（引擎启动时的交易所，如 `["bybit","binance","okx"]`）、`leadRelay`（是否接东京中继）、`leadLines`（`{venues: {<venue>: {direct|tokyo: {frames, trades, delivered, lastAt, leadSumMs, leadCount, leadMeanMs}}}, relay: {listening, port, error, messages, accepted, badSource, badFormat, badMac, tcpClients}}`）、`leadSignals[]`（最近 20 个信号，最新在前：`trade_id/venue/line/direction/move_bp/received_at/market_id/round_id/outcome`（`order_submitted`/`skipped`/`no_round`/`stopping`）`/reason/limit_price/ask_at_signal/order_shares`）。

### `/api/runtime/book`

取自引擎每 2 s 一行的 `platform_status`（只带当前场的配对快照，每边 5 档），推送和页面每 1 s 刷新，所以盘口最多比交易所晚约 3 s。

```
{running, available, stale, error,            // error: runtime_snapshot_pending / no_current_round / book_snapshot_unavailable / book_snapshot_stale
 marketId, roundId, name, startsAt, endsAt,
 sequence, sourceAt, expiresAt, runtimeAt, ageMs,
 up:   {tokenId, bid, ask, bidSize, askSize, bids: [[价, 量]×≤5], asks: [[价, 量]×≤5], sourceAt, expiresAt, depthSourceAt, depthExpiresAt},
 down: {同上},
 twoSided,                                    // 两边都有卖价
 strategyView: {upAsk, downAsk, twoSided, freshOnArrival, staleReason} | null,   // 策略最后一帧看到的
 projection: {state, stale, age_seconds}}
```

`stale=true`：没有快照、快照过期或运行快照过期。

### `/api/strategy/config`

`strategyId="binance-lead"`、已发布配置 `config`、`savedRevision`、`savedAt`、`draft`、`activeRevision`、`nextRoundRevision`、`activationScope="future_uncreated_round"`。`config` 字段恰好是：`assetId`（只能 `btc`）、`shares`、`thresholdBp`、`windowMs`、`limitPremium`、`fromSec`、`toSec`、`maxAsk`、`leadVenues`（`bybit/binance/okx` 中不重复的至少一个）、`tokyoRelay`（布尔）、`openBandBp`、`openLine`（`tick` 开盘价 / `mean60` 开盘前 60 秒均价）、`restAfterMissSec`（没买到后挂单秒数，0 = 关，[0, 30]）、`restShadow`（布尔，挂单关着时记录模拟）、`maxQuoteAgeSeconds`、`maxQuoteSkewSeconds`、`roundBudgetUsd`、`totalBudgetUsd`、`dailyLossUsd`（后三个可为 null），和控制面的 `mode`、`durationMinutes`、`maxRounds`。`leadVenues`、`tokyoRelay` 在引擎启动时生效。已发布文件缺 `maxAsk/openBandBp/openLine/leadVenues/tokyoRelay/restAfterMissSec/restShadow` 时按引擎默认值读（0.80/0/tick/三家全开/开/0/开）；文件里残留的已退役字段（`makerHoldSec`、`leadSource`、分档、反转腿）读时丢弃，和引擎一样。从没发布过时返回默认值、`savedRevision: 0`，此时启动被拒。

### `/api/diagnostics/health`

```
{status: "ok"|"degraded", nodeLabel, error: "问题1; 问题2" | null,
 services: {engine: {running, pid, state, runId, runtimeStale, runtimeAsOf, process},
            accountBridge: {available, stale, error, cacheAgeSeconds, process},
            projection: {state, stale, age_seconds, worker_alive, ..., process},
            console: {process}},
 leadFeed: {running, healthy, venues, relayConfigured, asOf,
            lines: {<venue>: {direct|tokyo: {frames, trades, delivered, lastAt, leadMeanMs, lastTradeAgeSeconds, ...}}},
            relayListener: {listening, port, error, messages, accepted, badSource, badFormat, badMac, tcpClients} | null},
 resources: {cpu: {percent, cores}, load, memory: {used_bytes, total_bytes, percent}, disk: {...}, services: {...}}}
```

`process` 是 `{state, pid, rss_bytes, uptime_seconds}`。问题代码：`trading_runtime_unavailable`、`ledger_projection_unavailable`、`resource_snapshot_stale`、`lead_feed_unhealthy`、`relay_listener_down`、`account_bridge_unavailable`。

### `/api/stats/lead`

全部在账本里算（`lead_signals` 表、`lead_orders` 表、结算），按账本 `data_version` 缓存。一笔单的输赢：方向那一边的 token 等于结算的 `winning_token_id` 就是赢；结算还没来是 pending。结算常落在下一次运行里，按 `market_id` 跨运行找。

```
{range, from, to, run_count, runId,
 funnel: {signals,              // 范围内 lead_signal 条数
          signals_in_window,    // outcome != no_round
          orders,               // 本场 FAK 条数（挂单补单另算在 rest）
          filled,               // filled_shares > 0
          fill_rate,            // filled / orders
          settled, won,         // 已成交且已出结果 / 其中赢
          win_rate,             // won / settled
          pnl_usd,              // 官方场次盈亏优先，否则账本：赢 filled×1 − filled×均价 − 费；输 −filled×均价 − 费
          pnl_source,           // official / ledger / mixed / null
          fees_usd},
 misses: {count,                // filled_shares == 0 且 status ∈ CANCELLED/REJECTED/ABANDONED
          resolved,             // 其中已出结果的
          would_have_won,
          hypothetical_pnl_if_filled},   // Σ 赢 shares×(1−limit) / 输 −shares×limit，再减 0.07×limit×(1−limit)×shares
 late_by_ms: {n, p10, p50, p90,         // 未成交单的 late_by_ms
              histogram: {"<0", "0-50", "50-100", "100-200", "200-400", ">400"},
              ask_gone_after_trade_ms: {missed: {n, p50, p90}, filled: {n, p50, p90}}},
 latency: {t_signal_ms|t_decide_ms|t_post_ms|t_ack_ms|t_total_ms: {n, p50, p90}},
 by_source: {rows: [{venue, line, orders, filled, fill_rate, settled, won, win_rate, pnl_usd}],
             lines: [{venue, tokyo_delivered, direct_delivered,
                      tokyo_first_share,          // tokyo.delivered / (tokyo + direct)，取当前运行最新的 lead_lines
                      tokyo_lead_mean_ms, direct_lead_mean_ms}]},
 skips: {time_window, band, ask_too_high, book, budget, paused, mid_round_start, already_attempted, other},
 by_hour: [24 × {hour, orders, filled, settled, won, pnl_usd}]}   // 北京时间小时，按场次开始时间
```

分位数用相邻秩线性插值，没有数据为 null。`skips` 数 `outcome` 为 `skipped`/`stopping` 的信号，入账时按原因归类一次存进 `lead_signals.bucket`（`dashboard/ledger.py` `SKIP_RULES`，对应 `binance-lead.ts` 的中文原因）：`time_window`「不在本场」；`band`「超出 ±」「开盘价未知」「开盘前 60 秒均价未知」；`ask_too_high`「高于上限」「高于最高限价」；`book`「没有当前盘口」「一边没有卖价」「不新鲜」「行情恢复中」；`budget`「预算」「可用余额不足」「daily loss」；`paused`「已暂停新增交易」；`mid_round_start`「中途启动」「错过本场开始」；`already_attempted`「本场已尝试」「本场已买到」「已下单（FAK）」；其余 `other`（如「交易所规则暂不可用」「停机中」）。

### `/api/orders/lead`

```
{range, items: [lead_order 全部字段 + {recv_ts, outcome: "won"|"lost"|"pending", filled, pnl, pnl_source, would_have_won}],
 next_before}
```

最新在前，`limit` 1-500（默认 200）；下一页把 `next_before`（上一页最后一条的 `recv_ts`）作为 `before` 传回，没有下一页时为 null。`pnl` 只对已成交且已出结果的单有值（官方优先）；`would_have_won` 只对未成交且已出结果的单有值。`lead_order` 字段（`cli/platform.ts leadOrderFields`）：`client_order_id, order_id, market_id, round_id, round_start, direction, token_id, status, venue_status, error, venue, line, relay_recv_ms, trade_id, trade_time_ms, signal_recv_ms, move_bp, signal_price, open_line, open_value, band_bp, sec_since_open, ask_at_signal, limit_price, shares, filled_shares, avg_fill_price, fee_usd, decision_ms, post_sent_ms, ack_ms, ask_gone_ms, ask_gone_venue_ms, t_signal_ms, t_decide_ms, t_post_ms, t_ack_ms, t_total_ms, ask_gone_after_trade_ms, late_by_ms, stage, rest_mode, parent_client_order_id, rest_shadow_fill_ms`。`stage`：`fak` 本场那一单 / `rest` 没买到后挂的只挂单（`parent_client_order_id` 指向本场 FAK）；`rest_mode`：本场配置 `live` 挂了单、`shadow` 只记录、`off`；`rest_shadow_fill_ms`：shadow 下 FAK 没买满后 5 秒内本方卖价回到限价以内的第一帧时间，没有为 null。`exit_shadow`（只记录不卖）：`held_rounds`、`settled`、`would_sell`（第 3 个反向信号时会卖的场）、`would_sell_rate`、`mistaken`/`mistaken_rate`/`mistaken_cost_usd`（卖掉的本来会赢）、`saved`/`saved_usd`（卖掉的本来会输）、`net_usd`（按当时买一价卖出扣吃单手续费，和拿到结算比）、`bid_p50`，来自 journal `lead_exit_shadow`（每场一行：`market_id, round_id, round_start, direction, token_id, held_shares, opposite_signals, triggered, trigger_ms, trigger_sec_since_open, bid, sell_shares`）。同一 `client_order_id` 被重启后重写时，后写的替换先写的。

## POST

| 路径 | 用途 |
|---|---|
| `POST /api/runtime/commands` | `{action: start\|pause\|resume\|stop, requestId, revision\|expectedRevision, startPaused?}`。`startPaused: true` 让引擎从暂停开始（只收行情、出信号、记跳过原因，按「继续」前不下单）。启动不选市场：引擎自己发现当前场次，中途启动就等下一场。同一 `requestId` 再发返回已有运行。返回 `accepted`、`status`、`commandStatus`、`serviceState`、`remoteOrdersState`。最终状态看 `/api/runtime/status` |
| `POST /api/strategy/drafts` | `{strategyId:"binance-lead", config, expectedRevision}` 保存草稿；`config` 必须恰好是上面的字段，范围同引擎 `normalizeBinanceLeadConfig`（份额 (0,10000]、阈值 (0,1000] bp、窗口 (0,60000] ms、加价 [0,1)、0 ≤ fromSec < toSec ≤ 300、卖价上限 (0,1)、`leadVenues` 非空不重复、`tokyoRelay` 布尔、开盘价范围 [0,1000]、`openLine` ∈ {tick, mean60}、`restAfterMissSec` ∈ [0, 30]、`restShadow` 布尔、两个盘口门 > 0、预算和日亏损为空或 > 0），不合法 400；版本冲突 409 |
| `POST /api/strategy/activate` | `{expectedRevision, draftId}` 发布草稿，对之后尚未冻结的场次生效；`effectiveRoundId` 非空返回 501 |
| `POST /api/ledger/reset` | `{confirm:"RESET"}`，引擎在跑或无法确认已停时 409。删 journal、引擎状态和投影，保留结算记录和配置 |

## 推送 `/api/stream`

`scripts/dashboard/push.py` 的 `PushHub`。页面把要轮询的 GET 路径作为 `p` 参数订阅（每连接最多 24 个路径，全站最多 50 条连接，满了返回 503）。每条消息是 `data: {"path","version","body"}`，`body` 与直接 GET 该路径完全相同（同一个 handler 渲染）。新连接先收每个路径的当前值，之后只推变化；内容没变每 5 s 重发一次，空闲每 15 s 发 `: ping`；`retry: 2000`。

重渲染节奏（秒）：

| 路径前缀 | 节奏 |
|---|---|
| `/api/runtime/status`、`/api/runtime/book`、`/api/settlements`、`/api/account/snapshot` | 1 |
| `/api/fills`、`/api/account/status`、`/api/strategy/config` | 2 |
| `/api/orders/lead` | 3 |
| `/api/rounds`、`/api/events`、`/api/diagnostics/health` | 5 |
| `/api/metrics/summary`、`/api/stats/lead` | 10 |

`/api/runtime/book` 在 `ledger.sqlite3`/WAL/`snapshot.json` 变了就重渲染（每条状态行都会变）。其余账本类路径（`/api/rounds`、`/api/fills`、`/api/settlements`、`/api/events`、`/api/metrics/*`、`/api/stats/lead`、`/api/orders/lead`）看账本的 `data_version`（每次信号、订单、成交、结算等业务写入加一，状态行不加）和投影状态，没变就不重渲染；`/api/stats/lead`、`/api/orders/lead`、`/api/rounds`、`/api/events`、`/api/fills` 的账本部分也按它缓存在内存里，`asOf`/`stale` 每次现取。账户快照看读取器刷新时间。推送断开时 `shared/stream.js` 让页面退回普通轮询。
