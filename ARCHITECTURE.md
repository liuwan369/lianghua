# 系统架构

唯一的架构文档。改了架构就同步改这里。行号会漂移，以文件和函数名为准。

## 进程

两台 AWS（2 vCPU、2 GB）：**爱尔兰 eu-west-1**（`pm-ire`，控制台 + 交易引擎，离 Polymarket 伦敦撮合约 24 ms）和**东京 ap-northeast-1**（`pm-tokyo`，只做转发：在东京收 Bybit/币安/OKX 成交，签名后转给爱尔兰）。旧的都柏林机器（`pm-new`）不跑交易，只做研究下载。

```
 浏览器 ──https──> nginx 443（basic auth，读 10 r/s、写 1 r/s）
                      │ X-PM-Authenticated
                      ▼
        控制面 system-dashboard-server.py  127.0.0.1:18766
        (systemd: pm-console，Nice 10，CPUWeight 20，MemoryMax 600M)
          │ 子进程: projection_worker.py ── journal → ledger.sqlite3
          │ 子进程: node dist/cli/account-data.js（账户只读，--max-old-space-size=160）
          │ 启停: systemd-run --scope pm-engine-<run_id>（CPUWeight 200，Nice -5）
          ▼
        交易引擎 node dist/cli/platform.js --live ──WS/HTTP──> Polymarket CLOB / Polygon
          │ ← 领先成交：爱尔兰直连三家交易所 + 东京转发（UDP×2 + TCP，端口 47001，HMAC）
          │ 写 results/live/dashboard-<run_id>.jsonl

 东京  pm-relay（systemd，node dist/cli/relay.js）── 三家交易所 WS ──> 签名转发到爱尔兰
```

| 进程 | 机器 | 启动方式 | 职责 |
|---|---|---|---|
| 控制面 | 爱尔兰 | systemd `pm-console` | HTTP API、托管前端、启停引擎、账户检查、SSE 推送 |
| 交易引擎 | 爱尔兰 | 控制面 `_start_trading`，一次只跑一个 | 领先信号 → 策略 → 下单 → 成交 → 结算 |
| 账本投影 | 爱尔兰 | 控制面拉起 `scripts/dashboard/projection_worker.py` | 读 journal，写 `results/dashboard/ledger.sqlite3` |
| 账户读取 | 爱尔兰 | 控制面常驻子进程 `dist/cli/account-data.js` | 余额、挂单、持仓、成交、Data API 平仓结果 |
| 转发 | 东京 | systemd `pm-relay` | 收 Bybit/币安/OKX 成交，`venue|id|seq|tradeTimeMs|price|tokyoRecvMs|mac` 发给爱尔兰 |

引擎下单用自己的行情 WS，市场发现只走 Gamma（`live/discovery.ts`）。

引擎跑在独立 systemd scope `pm-engine-<run_id>` 里，所以重启控制面不会停掉引擎，控制面重启后按 pid 重新接管。

行情采集与录制（`cli/market-snapshot.ts`、`cli/market-recorder.ts`、`dashboard/market-projection.ts`）现在不在任何机器上跑：2026-11-12 停了都柏林的录制，爱尔兰不装这个服务。代码留着，给计划中的伦敦录制机用；录好的数据在本机 `E:/pm-backup/market-history/`（到 11-13）。

### 启动与停止

启动（`POST /api/runtime/commands {action:"start", requestId, revision}` → `strategy_control` → `_start_trading`）必须同时满足：`revision` 等于已发布的版本号（> 0）、`requestId` 是 UUID（同一个编号重发只返回当前状态）、服务器环境 `PM_TRADING_LIVE_UNLOCK=1`、账户检查通过（签名、授权、结算凭据）、没有在跑的引擎、拿到 `deployment.lock`。不选市场：引擎自己从 Gamma 发现当前场，中途启动就等下一场。启动前把旧 run 的 journal 打包进 `results/archive/<run>.tar.gz`，`results/live/` 只留最新 3 个（`prune_run_journals`）。

```
node dist/cli/platform.js --live --duration-sec <N> --status-sec 2 --max-rounds <n>
  --journal-file results/live/dashboard-<run_id>.jsonl --state-file results/live/btc-reversal-<hash>.platform-state.json
  --stop-file <journal>.stop --strategy binance-lead --asset <币> --strategy-config results/dashboard/binance-lead-config.json
  --control-file <journal>.control.json --expected-market-id <id> --expected-round-id <roundId>
```

引擎只认 `--strategy binance-lead`；配置文件的 `strategyId` 必须是 `binance-lead`，`config` 里的 `durationMinutes`/`maxRounds`/`mode` 是控制面的运行设置（变成 `--duration-sec`/`--max-rounds`），引擎丢掉，其余字段由 `normalizeBinanceLeadConfig` 校验。控制面 `scripts/dashboard/strategy_config.py` 的 `validate_config` 按同样的范围校验，字段集合必须完全一致。

状态文件名里的 `btc-reversal` 只是历史名字，没改：它按账户跨 run、跨策略共用，结算记录在 `<状态文件>.settlements.json`，换名字会丢掉未完成的赎回和账户的订单/持仓。里面旧的 `strategyStates["btc-reversal"]` 不读也不删。

旧的 `results/dashboard/btc-reversal-config.json` 不再读。没有 `binance-lead-config.json` 时控制面返回 binance-lead 默认值、`savedRevision: 0`，启动要求已发布的版本，所以部署后必须在策略页保存并激活一次才能启动。

暂停/恢复：控制面写 `<journal>.control.json` 的 `paused`，引擎每 1 s 读一次（同一个定时器也热加载策略配置）。

停止：Linux 发 SIGTERM。引擎暂停 → 撤掉所有挂单 → 对账 → 最多再等 5 分钟把结算跑完 → 落盘退出。控制面最多等 8 s，超时也不 kill 实盘进程。账户快照读到零挂单才算"已确认停止"。

启动失败会写进 `<journal>.console.log` 的 `platform_error`（例：2026-11-15 地区检查 `polymarket.com/api/geoblock` 超时一次，`GEO-CHECK FAILED`），引擎不重试，控制台再点启动即可。

## 模块

### `backend/engine/src`

| 文件 | 职责 |
|---|---|
| `cli/platform.ts` | 引擎唯一入口：参数、市场发现与换轮（15 s 发现，提前 10 s 预热下一场）、策略挂载、配置/控制文件 1 s 轮询、结算调度 15 s、写 journal、停机流程 |
| `cli/relay.ts` | 东京转发入口：三家交易所成交 → HMAC 签名 → UDP×2 + TCP 发给爱尔兰 |
| `cli/market-snapshot.ts`、`cli/market-recorder.ts` | 行情采集与全量录制（现在不运行，留给伦敦录制机） |
| `cli/account-data.ts` | 账户读取器入口（stdin 收只读命令，JSONL 输出） |
| `cli/account-check.ts` | 一次性账户检查（钱包、签名、授权、余额） |
| `platform/core.ts` | `TradingCore`：资金预留、订单状态机、成交入账、持仓、风控与停机、对账 |
| `platform/platform.ts` | `TradingPlatform`：盘口状态、把事件发布给策略、结算入口 |
| `platform/polymarket.ts` | 实盘连接器：下单网关、行情队列、快照校验、用户 feed、账户恢复、心跳 |
| `platform/snapshot-gate.ts` | 双边盘口快照能否交易（纯函数） |
| `platform/store.ts` | 状态文件原子落盘（`.lock`/`.next`），下单前签名意图 `.intent` |
| `platform/journal.ts` | 异步 JSONL journal |
| `platform/live-settlement.ts`、`settlement.ts` | 收盘后结算：Gamma 查结果、赎回、到账核对 |
| `platform/cash-flows.ts` | 链上充提分类，调整日内基线 |
| `platform/contracts.ts` | 共享类型 |
| `live/clob/client.ts` | `ClobWrapper`：签名、下单 HTTP（超时 3 s）、撤单、心跳、连接保活（undici Agent，空闲 60 s，每 30 s 触达） |
| `live/clob/wallet.ts` | 钱包、funder、签名类型 |
| `live/feeds/polymarket.ts` | 公共行情 WS：L2 盘口、新鲜度看门狗 |
| `live/feeds/user.ts` | 认证用户 WS：订单与成交，断线补偿 |
| `live/feeds/index.ts` | `FeedQueue`：同一 key 只留最新盘口；币安信号走优先通道，不合并 |
| `live/feeds/lead-trades.ts` | 领先成交：Bybit（stream.bybit.com + stream.bytick.com）、币安 USD-M（`fstream.binance.com/market/ws/btcusdt@aggTrade`）、OKX（`BTC-USDT-SWAP`）直连，加东京转发（`relay` 编解码、监听、HMAC 校验），每家按成交编号去重、谁先到用谁（`VenueIngest`、`runLeadTrades`、`leadSignalFeed`） |
| `live/feeds/binance-trades.ts` | `LeadSignalDetector`：每家一个，250 ms 窗口判信号；带开盘价、开盘前 60 s 均价、信号前 300 s 的信号数和每秒波动 |
| `live/feeds/btc.ts` | 各币在交易所的代码 |
| `live/orderbook.ts` | 本地 L2 盘口副本 |
| `live/discovery.ts` | 通过 Gamma 发现 5 分钟盘 |
| `live/account*.ts`、`live/onchain.ts`、`live/contracts.ts` | 账户只读数据、北京日（UTC+8）、链上读取、合约地址 |
| `dashboard/market-projection.ts` | 采集器的公共盘口投影（随采集器停用） |
| `strategies/binance-lead.ts` | 策略本体 |
| `models.ts` | 价格量化、手续费公式 `shares × rate × (p(1−p))^exp` |

### `scripts/`

| 文件 | 职责 |
|---|---|
| `system-dashboard-server.py` | 控制面：路由、鉴权、启停引擎、PnL 拼装、静态前端 |
| `dashboard/push.py` | `PushHub`：SSE 推送，按路径节奏重渲染 |
| `dashboard/ledger.py` | 账本：journal 解析与查询（场次、订单、成交、结算、统计）；`_strategy_projection` 投影 binance-lead 的 getStatus，`platform_status` 只覆盖 `platform_runtime`（每个 run 一行，不进事件表）；`lead_signal` 进事件表，同时把 outcome 和跳过原因分类存进 `lead_signals`，最近 20 条随运行快照给控制台；`data_version` 每次业务写入加一，控制面按它缓存统计 |
| `dashboard/projection_worker.py` | 投影子进程，不读账户配置 |
| `dashboard/read_model.py` | 拉起并读取投影快照 |
| `dashboard/official_pnl.py` | 从 Data API 结果按场次算官方盈亏 |
| `dashboard/account_data.py` | 管理 account-data 子进程，缓存快照 |
| `dashboard/strategy_config.py` | binance-lead 配置与草稿持久化（默认值、校验范围同引擎）、支持的币种 |
| `dashboard/config.py` | 配置文件锁与错误类型 |
| `dashboard/market_snapshot.py` | 校验采集器快照 |
| `dashboard/system_metrics.py` | 主机与进程指标 |
| `dashboard_account.py` | 账户配置的检查与保存，响应不含秘密 |
| `deploy.py` | 部署（爱尔兰控制台 + 引擎、东京转发） |
| `backtest.py` | 读录制行情（本机回测用） |

### `frontend/console/`

| 文件 | 职责 |
|---|---|
| `auto-trade.html` + `live.js` | 实盘：启停命令、今日数字、信号源、当前场盘口、本场信号与下单 |
| `stats.html` + `stats.js` | 统计：`/api/stats/lead` 的漏斗、没买到、挂单/限价单、反向信号就卖出、按优势定股数、反向信号卖出（第 3 个，模拟）、行情太乱就暂停（模拟）、晚了多少、速度、按来源、跳过、按小时 |
| `history.html` + `history.js` | 历史：`/api/orders/lead` 分页，点一行展开 |
| `settings.html` + `settings.js` | 设置：策略参数（草稿→发布，含第一单方式、挂单秒数、行情太乱就暂停、按优势定股数、反向信号就卖出）、账户只读、系统健康、运行日志、清空统计 |
| `console.css` | 全站唯一样式表 |
| `shared/preview-core.js` | 请求、转义模板 `html```、格式化（北京时间）、轮询（标签页隐藏时暂停）、侧栏 |
| `shared/stream.js` | 推送客户端：登记页面的 GET，用一条 EventSource 订阅 |

## 数据流

```
行情 WS ─> feeds/polymarket ─> FeedQueue ─> snapshot-gate ─> platform.publish ─> 策略 onEvent
策略 submit ─> core 风控/预留 ─> .intent fsync ─> CLOB POST /order
用户 WS 订单/成交 ─> core 入账（状态 fsync）─> journal
journal ─> projection_worker ─> ledger.sqlite3 ─> 控制面 API ─> /api/stream (SSE) ─> 页面
账户读取器 ─> /api/account/snapshot、official_pnl ─> 统计与历史
```

成交校验（`TradingCore.applyFill`）：价格不劣于限价；买单按花的钱判断（已成交成本 + 这笔 ≤ 股数 × 限价 + 0.01 USDC），因为买单签的是 USDC 上限，按更便宜的价格成交会多给股数；卖单按股数判断。FAK 从不挂单：交易所回 `matched` 后，回执列出的成交（`tradeIds`）都入账了就终结（买满为 `FILLED`，否则 `CANCELLED`，剩余作废、释放预留）；对回 `matched` 的 FAK 不发撤单（交易所会拒），还没到的成交留给账户恢复去扫。

签名后、POST 前把签名和载荷 fsync 到 `<state>.intent`。POST 结果不明时订单进 `UNKNOWN` 并阻断该市场，等对账，绝不为不确定的 POST 再生成一张新单。账户恢复时交易所查不到的 GTC 单，本场未结束前最多原样重发同一份已签名订单两次；FAK 单、只挂单和 binance-lead 的 GTC 从不重发（信号早已过期，`replaysPreparedOrder`）。

FAK 没成交的回复（`ClobWrapper.submitOrder` 的 `fakKilled`）：交易所报 "no orders found to match with FAK order"（实盘是 HTTP 400 `{error, orderID}`，带我们签名的哈希），或 `success` + `unmatched` + makingAmount/takingAmount 为 0 + 没有 tradeIDs，网关给 `rejected`，订单直接 `REJECTED`、释放预留、不阻断市场。`delayed`（撮合还没发生）照常 `OPEN` 等用户 feed；超时、5xx、连接断开仍是 `UNKNOWN`。账户恢复里，回执拿到过、详情 404、开放订单和成交扫描里都没有、该 token 没持仓的 FAK 当场放弃（`abandonsMissingFak`），不等 `UNKNOWN_ABANDON_AFTER_SEC` 的 5 分钟。journal 的 `order` 行带 `error`（交易所原话，过 `safeErrorMessage`）。

```
Bybit ×2 / 币安 / OKX 直连 + 东京转发 ─> lead-trades 每家去重 ─> 每家一个 LeadSignalDetector ─> leadEvent（全部字段）─> 优先队列 ─> platform.publish ─> 策略 onEvent
```

## 策略 `binance-lead`

默认值（`BINANCE_LEAD_DEFAULTS`）：`shares 5`、`thresholdBp 2`、`windowMs 250`、`limitPremium 0.03`、`fromSec 15`、`toSec 265`、`maxAsk 0.80`、`leadVenues [bybit, binance, okx]`、`tokyoRelay true`、`openBandBp 0`、`openLine tick`、`restAfterMissSec 0`、`restShadow true`、`entryOrder fak`、`regimePause false`、`edgeSizing false`、`exitOnReverse false`、`maxQuoteAgeSeconds 2`、`maxQuoteSkewSeconds 1.5`。可选 `roundBudgetUsd`、`totalBudgetUsd`、`dailyLossUsd`。实盘配置在控制台设置页，见 [STRATEGY.md](STRATEGY.md)。

- 开盘线（`openBandBp`、`openLine`）：`LeadSignalDetector` 按成交时间记下每场开盘价（`openPrice`，本场开始时刻或之前最后一笔成交）和开盘前 60 秒均价（`openMean60`，每整秒最后一笔成交的均价，和官方目标价的 Chainlink 60 s TWAP 同一窗口）。策略只在信号离开盘线 −openBandBp ≤ d < openBandBp 时下单（d 按信号方向取正负，单位 bp），`openLine` 选用哪条线。
- 信号源（`leadVenues`、`tokyoRelay`，引擎启动时生效）：每家交易所一个检测器，窗口里只有那一家的价格；同一笔成交从直连和东京两条线来，谁先到用谁（`line` 记 `direct`/`tokyo`）。
- 按优势定股（`edgeSizing`）：`leadFairValue()` 用信号的 `price`/`openMean60`/`vol300Bp` 和剩余秒数算公允价，`decide` 算优势 = 公允价 − 限价 − 吃单费，`edgeShares()` 挑 5 / `shares` / 15；stage 记 `fair`/`edge`/`edgeShares`，开关关着时下单仍用 `shares`。`presignPrices` 返回每个限价的 `sizes`，`clob/client.ts presign` 每种股数各签一张。restore 时第一张 stage 的股数必须是三种之一。
- 反向信号卖出（`exitOnReverse`）：`decideExit` 在 `shadowExit` 之后跑，每场一次；记 `round.exitFirst`（时间、买一、股数、`sent`、`skip`），开着时发 FAK SELL，订单记在 `round.exit`（不是 stage，不进预算），`exitsByClient` 按 client id 索引，`recordExit` 收订单更新、认回只有核心有的 `:exit` 单。核心的 SELL 走现有路径（日亏到线时只放行 SELL）。`createLeadOrderLog` 用 `exitFor` 把卖单写成 `stage: exit` 的 `lead_order`（`proceeds_usd` = 成交额 − 手续费），`lead_exit_shadow` 在收盘后每场一行，带 `first_*` 和 `exit_*`。`live-settlement.ts receiptIsTrade`：带交易所 `OrderFilled` 的回执是撮合不是赎回，`externalPayout` 不算它。账本：`_apply_exit` 把卖出收回并进这场买单行的盈亏，`stage exit` 行不进漏斗；没有持仓可赎回的已结算场按成交算盈亏（`_trade_net`）。
- 行情太乱（`regimePause`）：每个信号带 `signals300`（这家检测器信号前 300 s 的信号数）和 `vol300Bp`（前 300 个整秒的每秒对数收益标准差）；`regimePause()` 判 > 12 或 > 0.89。开关开着时 `decide` 跳过这个信号，本场等下一个；关着时只在 `lead_order` 记 `regime_pause`。重启后前 300 s 没有这两个数，照常下单。
- 信号（`LeadSignalDetector`，在 feed 一侧）：领先成交价比之前 `windowMs` 内（按成交时间）最低价高 ≥ `thresholdBp` 为 UP，比最高价低 ≥ `thresholdBp` 为 DOWN；只认本地收到时间在开盘后 `[fromSec, toSec)` 秒内的成交。检测器参数跟当前场的配置走，场与场之间跟已保存配置。
- 一场一份配置：发现新场时复制当前配置；开场前 10 s（`CONFIG_FREEZE_SEC`）之前保存的修改还会跟进，之后冻结。
- 只接 `now <= startsAt` 时发现的场；中途启动等下一场。
- 当前盘口：本场最新一帧，一边没卖价也算。两边都有卖价、到达时年龄 ≤ 2 s、两边时间差 ≤ 1.5 s、两边卖价之和 ≤ 1.05 才算新鲜。行情断线、账户恢复（只限被阻断的市场）后作废，等新的一帧。
- 下单：本场第一个"当前盘口新鲜"、这一边卖价 ≤ `maxAsk`、在开盘线范围内（开了暂停时还要不乱）的信号，买信号那一边，限价 = 卖价 + `limitPremium`（向下取到 tick，最多 0.99），`shares` 股（不到 1 美元抬到 1 美元，金额凑整到分），`clientOrderId = <instanceId>:<marketId>:1`；`entryOrder` 决定是 FAK 还是 GTC。不合格就等下一个信号，不算本场的尝试。
- 一场一个信号：FAK 时最多 FAK + 一张挂单补单，GTC 时只一张；持有到结算。
- 下单前检查：单场预算、总预算、可用资金、tick 与最小股数、费用预估。
- 重启时未提交的 `CREATED` 意图标为 `ABANDONED`，从不补发。
- journal 每个信号一行 `lead_signal`：信号字段、所在场次、结果（`order_submitted`/`skipped`/`no_round`/`stopping`）和本场 reason、下单的限价与卖价。账本把它存成事件 `lead_signal`（不建场次行、不算成交），控制台用它显示"这场为什么没下单"。
- journal 每笔订单一行 `lead_order`（`cli/platform.ts` leadOrderFields，event_id `lead_order:<clientOrderId>`）：订单到 FILLED/CANCELLED/REJECTED 或意图 ABANDONED 时写，否则在场次结束或停机时按当时状态写。带信号来源（venue/line）、各阶段时间（毫秒 epoch：成交 `trade_time_ms` 是交易所时钟，`signal_recv_ms`/`decision_ms`/`post_sent_ms`/`ack_ms` 是本机墙钟；`ack_ms` 取订单 `venueReplyAt`，交易所的任何 HTTP 回复都算，包括 FAK 没撮合的拒绝，只用于计时，不参与 UNKNOWN 判断）、`t_*` 差值、卖价消失时间 `ask_gone_ms`（策略 stage.askGoneAtUnix：信号后本方卖价没了或高过限价的第一帧，只看下单后 10 秒）和没买满时的 `late_by_ms = ack_ms - ask_gone_ms`。`platform_settlement` 带 `winning_token_id`/`winning_side`（读到赔付向量时），控制台按 market_id 关联输赢。
- 没买到后挂单（`restAfterMissSec` > 0）：本场 FAK 被拒或撤销且没买满，交易所回复后 2 秒内（暂停、被拦时不挂），剩余时间够 `restAfterMissSec` + 5 秒、剩余股数不低于交易所最小量，就在同一限价挂一张只挂单 GTC 买单（客户端编号 `:rest`，买剩余股数，按预算和余额检查，手续费预留 0）。交易所接受后计时，`restAfterMissSec` 秒后撤单，没确认每秒重发；场次结束的收尾撤单兜底。只挂单撞价被拒（卖价已回到限价以内）就算本场结束。一场最多 FAK + 挂单两张。重启恢复两张都校验（挂单跟在没买满的 FAK 后面、同 token、同限价、不超过剩余股数）；只在核心里找到的 `:rest` 单按订单补回并按 createdAt 补上撤单时间。`restShadow`（挂单关着时）：FAK 没买满后 5 秒内本方卖价回到限价以内的第一帧记在 FAK stage 的 `restShadowFillAt`，不下单；`lead_order` 带 `stage`/`rest_mode`/`rest_shadow_fill_ms`，统计 `/api/stats/lead` 的 `rest` 分 live/shadow。
- 第一单用限价单（`entryOrder = gtc`）：本场那一笔是同限价的普通 GTC 买单（`:1`，stage `kind: "gtc"`），没有 `:rest`。交易所接受（OPEN/PARTIAL）后计时，`restAfterMissSec` 秒后撤剩余，和挂单补单同一套撤单重试。下单走预签名：签名的订单和 FAK 一样，订单类型在 POST 里（`takePresigned` 把普通 GTC 映射到 FAK 的预签）。核心：买够股数，或买单剩余预算不足 0.01 股（`buyBudgetSpent`，零头单）就是 FILLED；买单预留跟着剩余预算走、不低于未成交股数 × 限价；交易所回 matched、不在挂单列表、预算已花完、成交都已确认的单在账户恢复里直接结束（`closeSpent`，不依赖订单详情查询）。`replaysPreparedOrder` 不重发 binance-lead 的 GTC。`lead_order` 带 `taker_shares`/`maker_shares`（按成交的 isMaker 分），统计 `gtc` 块。
- 反向信号卖出（只记录，用户 2026-11-14）：本场买到股份后（第一笔成交更新 0.5 秒后起），数和持仓方向相反的信号；第 3 个时记下持仓那边当时的买一价和持股数（`round.exitShadow`），不下单。每场一行 journal `lead_exit_shadow`（触发时或场次结束时写），账本 `lead_exit_shadows` 表，统计 `exit_shadow` 按结果算误卖和少亏。
- 状态行（`cli/platform.ts statusRuntime`，约 6 KB）只带控制台读的字段：`strategy_runtime.currentRound` 是当前场的完整 `getStatus()`（`config`、`stages`（至多 1 个，含 `signal`、`askAtSignal`）、`reason`、`latest`，加上 `roundOutcome` 的 `upShares/downShares/costUsd/netIfUpUsd/netIfDownUsd`）；`rounds` 只有还在结算的其他场（有活动订单、未结算持仓或未终结成交），每场只有身份和 `upTokenId/downTokenId/upShares/downShares`，结算盈亏的 coverage 用它们；`markets` 是当前场和需要结算但没有策略场次的市场；`snapshots` 只有当前场，每边 5 档。

## 风控（`platform/core.ts`）

- 单场预算 `roundBudgetUsd`：本场两个 token 的持仓成本 + 挂单预留 + 新单成本。
- 总预算 `totalBudgetUsd`：全部占用 + 新单成本。可用资金 `availableUsd` 同时受现金和资本上限约束。
- 日内亏损 `dailyLossUsd`：权益 = 现金 + 持仓盯市，按北京日（UTC+8）换日重设基线；权益跌破基线减上限即停止新开仓，换日自动解除。充提按链上记录调整基线。
  - 运行中跨日：基线 = 那一刻的权益。重启时状态文件是前几天的：基线 = 启动时这次账户读取的权益（不是状态文件里旧的现金）；同一天内重启保留当天的基线和亏损。
- 盯市优先级：当前买一 → 见过的最后买一 → 场馆给的 mark（重启后保住，不会把未平亏损当成本藏起来）→ 成本；已判定的市场按赔付价。
- 其他停机原因：订单状态未知 / 签名身份 / 重启恢复的订单需对账（对账后自动解除，按市场隔离）；状态持久化失败（不自动解除）。
- 心跳：`startHeartbeat` 每 5 s 一次，单次超时 2 s，失败立即重试一次。场馆 10 s 收不到心跳会撤掉全部挂单。

## 用户 feed 断线补偿（`live/feeds/user.ts`）

断线重连后先关闭下单门，从断线时刻往前 5 s 起，用 REST 拉两次近期成交和未结订单，间隔 250 ms，两次一致才入账并调用 `reconcileAfterReconnect` 对账，然后才恢复。补偿期间到达的 WS 帧会被入账而不是丢弃；不一致或失败就断开重连（2 s 后）。

## 结算

引擎每 15 s 扫已收盘的市场，跳过还有挂单或成交未终结的；用 Gamma（`gamma-api.polymarket.com/markets?condition_ids=`）查判定结果，再赎回。Polymarket 自己的自动赎回常常抢先一个块，结算适配器会查到这笔外部赎回并按实际到账确认。结算状态存在 `<state>.settlements.json`，清空数据时保留（里面有未完成的赎回）。

## 盈亏口径

已结算盈亏以 Polymarket 官方 Data API 为准（`scripts/dashboard/official_pnl.py`）：已平仓（`/v2/positions?status=CLOSED`）的 `realizedPnl`，加上持仓（`/v2/positions`）里已判定未赎回的 `cashPnl + realizedPnl`（输掉的 token 永远在这里），按 slug `<币>-updown-5m-<roundId>` 对到场次。数据来自账户读取器的快照，不额外请求。

Data API v1 在 2026-11-02 停用（410），读取改走 v2（`live/account-data.ts v2Pages`）：返回包一层 `{data, pagination}`，只能按 `next_cursor` 翻页（带 `offset` 直接 400），以 `has_more` 判断有没有下一页；字段是下划线写法，入口处由 `fromV2Row` 转回 v1 名字，下游不改（`token_id→asset`、`current_size→size`、`avg_price→avgPrice`、`current_price→curPrice`、`entry_cost_usdc→initialValue`、`unrealized_pnl→cashPnl`、`total_size→totalBought`、已平仓 `last_event_at→timestamp`）。活动记录 `/v2/activity` 默认不返回充值、提现，要带 `exclude_deposits_withdrawals=false`。

- 账户快照完整且新鲜才算一次有效读取；读取失败时沿用上一次成功结果，标 `stale=true`、`pnl_source_error="official_data_stale"`、`pnl_source_as_of`。
- 从未成功读取时才退回账本口径：`pnl_source="ledger"`、`pnl_source_error="official_data_unavailable"`。
- 账本负责进行中的场次，以及"已交易、已收盘、官方还没出结果"的投入成本（`unsettled_cost`、`exposed_pnl`）。
- 场次表和结算列表里，官方已有结果的场次统一显示为已结算。

## 磁盘上的文件

`E` = `/root/pm-system/backend/engine`

| 路径 | 说明 |
|---|---|
| `E/results/live/dashboard-<run_id>.jsonl`、`.console.log`、`.control.json`、`.stop` | 每个 run 的 journal 及附属文件；启动新 run 时只留最新 3 个，更早的打包进 `E/results/archive/<run>.tar.gz`。延迟只记下单路径（每笔订单一次），不记每个盘口；platform_status 每 --status-sec 写 journal，stdout（`.console.log`）只在状态或原因变化时、否则每 60 s 打一行，停止/失败那一行必打 |
| `E/results/live/btc-reversal-<hash>.platform-state.json`（含 `.intent` `.lock` `.next`） | 引擎状态，按账户跨 run、跨策略共用（名字是历史遗留，见"启动与停止"） |
| `…platform-state.json.settlements.json` | 结算记录，清空数据时保留 |
| `E/results/dashboard/binance-lead-config.json`、`binance-lead-config.draft.json` | 已发布配置、草稿（旧的 `btc-reversal-config*.json` 不再读，留在原处） |
| `E/results/dashboard/market_pool.json` | 运行池 |
| `E/results/dashboard/ledger.sqlite3`、`snapshot.json` | 账本投影 |
| `E/results/dashboard-state.json` | 控制面当前 run 信息 |
| `E/results/account-history/<钱包>.json` | 账户读取器记住的订单详情 |
| `/root/pm-system/data/dashboard/deployment.lock` | 部署与启动共用的 flock |
| `/root/pm-releases/<rev7>-<UTC>/`（东京 `/root/pm-relay-releases/`） | 每次部署的发布目录，`before/` 里是被替换的旧文件 |

行情录制（不再运行，格式供本机回测读旧数据）：每行一个盘口事件：`t` 接收时间、`a` 币、`m` marketId、`r` roundId、`q` 序号、`ue`/`de` 两边交易所时间、`ub`/`ua`/`db`/`da` 两边买一卖一、`ubl`/`ual`/`dbl`/`dal` 五档 `[价, 量]`。同一文件里还有成交行（feed 的 `last_trade_price`）：`{t,a,m,r,k:"t",tok:"u"|"d",p 价,s 量,side 吃单方向 BUY|SELL}`，盘口行没有 `k`。`zcat` 可读，正在写的当天文件末尾报 unexpected end of file 属正常。

秘密只在服务器：爱尔兰 `E/.env`（钱包、签名私钥、Relayer/Builder 凭据、RPC）、`/root/.config/pm-system/console.env`（实盘解锁、转发端口等，不含密钥值）、`/root/.config/pm-system/relay.key`（转发 HMAC 密钥，东京同一份）、nginx 口令 `/etc/nginx/pm-console.htpasswd`；东京 `/root/.config/pm-system/relay.env`、`relay.key`。全部 600 权限，不进源码、日志、文档、浏览器。

## 部署与回滚

`python scripts/deploy.py [ireland|tokyo|all]`：

1. 工作区里 `backend/engine`、`frontend/console`、`scripts`、`config` 有未提交改动就拒绝。本地用 `git archive HEAD` 在 `.deploy/<rev7>-build` 构建 `dist`，按目标打包（测试目录 `regress/` 和 `src/` 不上线），经 `ssh <别名> tar xzf -` 解到发布目录，再把脚本本身用 `ssh <别名> python3 - apply` 送过去执行。
2. 爱尔兰（`pm-ire`）：拿 `data/dashboard/deployment.lock`；有活动的 `pm-engine-*`、`dist/cli/platform.js` 进程或控制面 `processRunning` 不是 false 就拒绝。发布目录 `/root/pm-releases/<rev7>-<UTC>/`。
3. 东京（`pm-tokyo`）：只发 `dist` 和 package 文件到 `/root/pm-relay`，发布目录 `/root/pm-relay-releases/<rev7>-<UTC>/`，单元 `config/pm-relay.service`，用 `/usr/local/bin/node`（Node 24）。
4. 两边相同：被覆盖或删除的文件先复制到发布目录的 `before/`；只删发布范围内不再发布的文件，`results/`、`node_modules/`、`.env`、`data/` 永不触碰；`package-lock.json` 变了才 `npm ci --omit=dev`；装单元（爱尔兰在 nginx、证书、口令都在时装站点并 `nginx -t` 后重载），重启后检查（控制面 30 秒内三个地址 200；中继 active 且无 `relay_error`，`--wait-status` 等 70 秒内 `sent` > 0），失败就从 `before/` 回滚并非零退出。

一次性准备（Node 24、中继密钥、env 文件、nginx/certbot、防火墙）由 `python scripts/deploy.py setup-ireland` / `setup-tokyo` 打印，运维手动执行。

## 已知限制与延后

- 没有自动备份（ROADMAP 4.1）。爱尔兰的账本、结算记录、状态文件只在这一块盘上；旧 run 的 journal 在 `results/archive/`，本机 `E:/pm-backup/aws-runs/` 有手动拷的一份。
- 研究数据都在本机 `E:/pm-backup/`（录制行情到 11-13、各交易所逐笔成交、research-* 脚本和结论）；predict.fun 历史在都柏林 `pm-new:/root/pf-history/`。
- 账本自己计算已结算盈亏的旧逻辑（`scripts/dashboard/ledger.py`）待官方数据连续稳定、没出现 `ledger` 回退后删除（ROADMAP 4.3）。
