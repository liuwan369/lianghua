# 系统架构

唯一的架构文档。改了架构就同步改这里。行号会漂移，以文件和函数名为准。

## 进程

```
 浏览器 ──https──> nginx 443 (basic auth, 10 r/s)
                      │ X-PM-Authenticated
                      ▼
        控制面 system-dashboard-server.py  127.0.0.1:18766
        (systemd: pm-system-dashboard-dublin)
          │ 子进程: projection_worker.py ── journal → ledger.sqlite3
          │ 子进程: node dist/cli/account-data.js（账户只读，15 s 刷新）
          │ 启停: systemd-run --scope pm-engine-<run_id> + choom -500
          ▼
        交易引擎 node dist/cli/platform.js --live ──WS/HTTP──> Polymarket CLOB / Polygon
          │ 写 results/live/dashboard-<run_id>.jsonl

        行情采集器 node dist/cli/market-snapshot.js (systemd: pm-clob-market-snapshot)
          ├─ 每 250 ms 写 data/dashboard/market-snapshot.json（控制台展示用；一边无挂单时另带 one_sided，只展示不交易）
          ├─ 双边报价超过 2 秒没变时，每 2 秒向交易所 REST POST /books 核对一次，价格一样就写 quiet_confirmed_at（只展示不交易）
          └─ 记录器 market-recorder → data/market-history/（回测 scripts/backtest.py 只读它，手动在服务器上跑）
```

| 进程 | 启动方式 | 职责 |
|---|---|---|
| 控制面 | systemd `pm-system-dashboard-dublin`，`MemoryMax=900M` | HTTP API、托管前端、启停引擎、账户检查、SSE 推送 |
| 交易引擎 | 控制面 `_start_trading`，一次只跑一个 | 行情 → 策略 → 下单 → 成交 → 结算 |
| 行情采集器 | systemd `pm-clob-market-snapshot`，常驻 | 7 个币（btc,eth,sol,xrp,doge,hype,bnb）的公共盘口，`--stale-after-ms 2000`；同时做全量行情记录（盘口、成交 `k:"t"`、一边无卖价时的盘口 `k:"o"`、币本身价格 `k:"p"`：币安 1 秒 K 线，所有币一个连接，每币每秒一条 `{e 该秒, o 开, p 收}`；结算用的 Chainlink 价 `k:"c"`：Polymarket RTDS `crypto_prices_chainlink`，免凭证，所有币一个连接，每币约每秒一条 `{e 源时间秒, p}`，场次开始/结束那一秒的值就是官方 openPrice/closePrice） |
| 账本投影 | 控制面拉起 `scripts/dashboard/projection_worker.py`，约 250 ms 一轮 | 读 journal，写 `results/dashboard/ledger.sqlite3` |
| 账户读取 | 控制面常驻子进程 `dist/cli/account-data.js`，每 15 s | 余额、挂单、持仓、成交、Data API 平仓结果 |

引擎下单用自己的行情 WS，不读采集器文件。采集器文件只给控制台看，另外在 Gamma 发现失败时给引擎兜底（`live/discovery.ts` 读 `/api/live`）。

引擎跑在独立 systemd scope `pm-engine-<run_id>` 里（`systemd-run --scope` 原地 exec，pid 不变；`choom -n -500` 降低被 OOM 杀的优先级），所以重启控制面不会停掉引擎，控制面重启后按 pid 重新接管。

### 启动与停止

启动（`strategy_control` → `_start_trading`）必须同时满足：策略已保存且请求带上当前版本号、UUID `requestId`、`marketIds` 恰好一个能唯一对上目录的 marketId+roundId、`confirm_live`、服务器环境 `PM_TRADING_LIVE_UNLOCK=1`、账户检查通过、没有在跑的引擎、拿到 `deployment.lock`。启动前清理旧 journal，只保留最新 20 个 run。

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

## 模块

### `backend/engine/src`

| 文件 | 职责 |
|---|---|
| `cli/platform.ts` | 引擎唯一入口：参数、市场发现与换轮（15 s 发现，提前 10 s 预热下一场）、策略挂载、配置/控制文件 1 s 轮询、结算调度 15 s、写 journal、停机流程 |
| `cli/market-snapshot.ts` | 行情采集器入口 |
| `cli/market-recorder.ts` | 采集器内的全量行情记录（盘口和成交，gzip JSONL，按天轮换、过期删除） |
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
| `live/feeds/binance-trades.ts` | 币安 aggTrade 两条线路按成交 id 去重、`LeadSignalDetector`（250 ms 窗口判信号）、`binanceLeadFeed` |
| `live/feeds/btc.ts` | 各币在交易所的代码（采集器订阅币安 1 秒 K 线、引擎订阅币安 aggTrade 用） |
| `live/orderbook.ts` | 本地 L2 盘口副本 |
| `live/discovery.ts` | 通过 Gamma 发现 5 分钟盘，采集器兜底 |
| `live/account*.ts`、`live/onchain.ts`、`live/contracts.ts` | 账户只读数据、北京日（UTC+8）、链上读取、合约地址 |
| `dashboard/market-projection.ts` | 采集器的公共盘口投影 |
| `strategies/binance-lead.ts` | 策略本体 |
| `models.ts` | 价格量化、手续费公式 `shares × rate × (p(1−p))^exp` |

### `scripts/`

| 文件 | 职责 |
|---|---|
| `system-dashboard-server.py` | 控制面：路由、鉴权、启停引擎、PnL 拼装、静态前端 |
| `dashboard/push.py` | `PushHub`：SSE 推送，按路径节奏重渲染 |
| `dashboard/ledger.py` | 账本：journal 解析与查询（场次、订单、成交、结算、统计）；`_strategy_projection` 投影 binance-lead 的 getStatus，`lead_signal` 进事件表，最近 20 条随运行快照给控制台 |
| `dashboard/projection_worker.py` | 投影子进程，不读账户配置 |
| `dashboard/read_model.py` | 拉起并读取投影快照 |
| `dashboard/official_pnl.py` | 从 Data API 结果按场次算官方盈亏 |
| `dashboard/account_data.py` | 管理 account-data 子进程，缓存快照 |
| `dashboard/strategy_config.py` | binance-lead 配置与草稿持久化（默认值、校验范围同引擎）、支持的币种 |
| `dashboard/config.py` | 配置文件锁与错误类型 |
| `dashboard/market_snapshot.py` | 校验采集器快照 |
| `dashboard/system_metrics.py` | 主机与进程指标 |
| `dashboard_account.py` | 账户配置的检查与保存，响应不含秘密 |
| `deploy-reversal-release.py` | 部署 |

### `frontend/console/`

| 文件 | 职责 |
|---|---|
| `*.html` + `*-block.js/css` | 四个页面：自动交易（本场下单/没下单的原因、当前盘口能否下单、最近币安信号、币安行情健康）、市场、策略（binance-lead 参数表单）、设置 |
| `stats-panel.js` | 自动交易页的交易统计、服务器状态、清空数据 |
| `event-log.js` | 设置页的运行日志 |
| `shared/preview-core.js` | 请求、侧栏、格式化 |
| `shared/stream.js` | 推送客户端：登记页面的 GET，用一条 EventSource 订阅 |
| `shared/api-adapter.js` | 接口适配 |
| `shared/view-model.js` | 数据整形（场次标签等） |
| `shared/preview-store.js` | 页面状态 |

## 数据流

```
行情 WS ─> feeds/polymarket ─> FeedQueue ─> snapshot-gate ─> platform.publish ─> 策略 onEvent
策略 submit ─> core 风控/预留 ─> .intent fsync ─> CLOB POST /order
用户 WS 订单/成交 ─> core 入账（状态 fsync）─> journal
journal ─> projection_worker ─> ledger.sqlite3 ─> 控制面 API ─> /api/stream (SSE) ─> 页面
账户读取器 ─> /api/account/snapshot、official_pnl ─> 统计与历史
```

成交校验（`TradingCore.applyFill`）：价格不劣于限价；买单按花的钱判断（已成交成本 + 这笔 ≤ 股数 × 限价 + 0.01 USDC），因为买单签的是 USDC 上限，按更便宜的价格成交会多给股数；卖单按股数判断。FAK 从不挂单：交易所回 `matched` 后，回执列出的成交（`tradeIds`）都入账了就终结（买满为 `FILLED`，否则 `CANCELLED`，剩余作废、释放预留）；对回 `matched` 的 FAK 不发撤单（交易所会拒），还没到的成交留给账户恢复去扫。

签名后、POST 前把签名和载荷 fsync 到 `<state>.intent`。POST 结果不明时订单进 `UNKNOWN` 并阻断该市场，等对账，绝不为不确定的 POST 再生成一张新单。账户恢复时交易所查不到的 GTC 单，本场未结束前最多原样重发同一份已签名订单两次；FAK 单从不重发（信号早已过期，`replaysPreparedOrder`）。

FAK 没成交的回复（`ClobWrapper.submitOrder` 的 `fakKilled`）：交易所报 "no orders found to match with FAK order"（实盘是 HTTP 400 `{error, orderID}`，带我们签名的哈希），或 `success` + `unmatched` + makingAmount/takingAmount 为 0 + 没有 tradeIDs，网关给 `rejected`，订单直接 `REJECTED`、释放预留、不阻断市场。`delayed`（撮合还没发生）照常 `OPEN` 等用户 feed；超时、5xx、连接断开仍是 `UNKNOWN`。账户恢复里，回执拿到过、详情 404、开放订单和成交扫描里都没有、该 token 没持仓的 FAK 当场放弃（`abandonsMissingFak`），不等 `UNKNOWN_ABANDON_AFTER_SEC` 的 5 分钟。journal 的 `order` 行带 `error`（交易所原话，过 `safeErrorMessage`）。

```
币安 aggTrade ×2 ─> binance-trades 去重 ─> LeadSignalDetector ─> 优先队列 ─> platform.publish ─> 策略 onEvent
```

## 策略 `binance-lead`

默认值（`BINANCE_LEAD_DEFAULTS`）：`shares 5`、`thresholdBp 2`、`windowMs 250`、`limitPremium 0.03`、`fromSec 15`、`toSec 265`、`maxAsk 0.80`、`maxQuoteAgeSeconds 2`、`maxQuoteSkewSeconds 1.5`。可选 `roundBudgetUsd`、`totalBudgetUsd`、`dailyLossUsd`。

- 信号（`LeadSignalDetector`，在 feed 一侧）：币安成交价比之前 `windowMs` 内（按成交时间）最低价高 ≥ `thresholdBp` 为 UP，比最高价低 ≥ `thresholdBp` 为 DOWN；只认本地收到时间在开盘后 `[fromSec, toSec)` 秒内的成交。检测器参数跟当前场的配置走，场与场之间跟已保存配置。
- 一场一份配置：发现新场时复制当前配置；开场前 10 s（`CONFIG_FREEZE_SEC`）之前保存的修改还会跟进，之后冻结。
- 只接 `now <= startsAt` 时发现的场；中途启动等下一场。
- 当前盘口：本场最新一帧，一边没卖价也算。两边都有卖价、到达时年龄 ≤ 2 s、两边时间差 ≤ 1.5 s、两边卖价之和 ≤ 1.05 才算新鲜。行情断线、账户恢复（只限被阻断的市场）后作废，等新的一帧。
- 下单：本场第一个"当前盘口新鲜"、这一边卖价 ≤ `maxAsk` 的信号，买信号那一边，FAK 限价 = 卖价 + `limitPremium`（向下取到 tick，最多 0.99），`shares` 股，`clientOrderId = <instanceId>:<marketId>:1`。盘口不新鲜或卖价高于 `maxAsk` 就等下一个信号，不算本场的尝试。
- 一场最多一笔，成不成交都不再下；持有到结算。
- 下单前检查：单场预算、总预算、可用资金、tick 与最小股数、费用预估。
- 重启时未提交的 `CREATED` 意图标为 `ABANDONED`，从不补发。
- journal 每个信号一行 `lead_signal`：信号字段、所在场次、结果（`order_submitted`/`skipped`/`no_round`/`stopping`）和本场 reason、下单的限价与卖价。账本把它存成事件 `lead_signal`（不建场次行、不算成交），控制台用它显示"这场为什么没下单"。
- 状态行 `strategy_runtime` 是 `getStatus()`：每场 `stages`（至多 1 个，含 `signal`、`askAtSignal`）、`reason`、`latest`（当前盘口摘要），加上 `roundOutcome` 的 `upShares/downShares/costUsd/netIfUpUsd/netIfDownUsd`；结算盈亏的 coverage 用 `upTokenId/downTokenId` + `upShares/downShares`。

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

已结算盈亏以 Polymarket 官方 Data API 为准（`scripts/dashboard/official_pnl.py`）：`closed-positions` 的 `realizedPnl`，加上 `positions` 里已判定未赎回的 `cashPnl + realizedPnl`（输掉的 token 永远在这里），按 slug `<币>-updown-5m-<roundId>` 对到场次。数据来自账户读取器的快照，不额外请求。

- 账户快照完整且新鲜才算一次有效读取；读取失败时沿用上一次成功结果，标 `stale=true`、`pnl_source_error="official_data_stale"`、`pnl_source_as_of`。
- 从未成功读取时才退回账本口径：`pnl_source="ledger"`、`pnl_source_error="official_data_unavailable"`。
- 账本负责进行中的场次，以及"已交易、已收盘、官方还没出结果"的投入成本（`unsettled_cost`、`exposed_pnl`）。
- 场次表和结算列表里，官方已有结果的场次统一显示为已结算。

## 磁盘上的文件

`E` = `/root/pm-system/backend/engine`

| 路径 | 说明 |
|---|---|
| `E/results/live/dashboard-<run_id>.jsonl`、`.console.log`、`.control.json`、`.stop` | 每个 run 的 journal 及附属文件；启动新 run 前只保留最新 20 个。每个盘口的延迟指标按 1/10 抽样写入 |
| `E/results/live/btc-reversal-<hash>.platform-state.json`（含 `.intent` `.lock` `.next`） | 引擎状态，按账户跨 run、跨策略共用（名字是历史遗留，见"启动与停止"） |
| `…platform-state.json.settlements.json` | 结算记录，清空数据时保留 |
| `E/results/dashboard/binance-lead-config.json`、`binance-lead-config.draft.json` | 已发布配置、草稿（旧的 `btc-reversal-config*.json` 不再读，留在原处） |
| `E/results/dashboard/market_pool.json` | 运行池 |
| `E/results/dashboard/ledger.sqlite3`、`snapshot.json` | 账本投影 |
| `E/results/dashboard-state.json` | 控制面当前 run 信息 |
| `/root/pm-system/data/dashboard/market-snapshot.json` | 采集器快照 |
| `/root/pm-system/data/dashboard/deployment.lock` | 部署与启动共用的 flock |
| `/root/pm-system/data/market-history/<币>/<北京日期>.jsonl.gz` | 全量行情记录，保留 30 天（`config/pm-clob-market-snapshot.service` 的 `--record-days`） |

行情记录每行一个盘口事件：`t` 接收时间、`a` 币、`m` marketId、`r` roundId、`q` 序号、`ue`/`de` 两边交易所时间、`ub`/`ua`/`db`/`da` 两边买一卖一、`ubl`/`ual`/`dbl`/`dal` 五档 `[价, 量]`。同一文件里还有成交行（feed 的 `last_trade_price`）：`{t,a,m,r,k:"t",tok:"u"|"d",p 价,s 量,side 吃单方向 BUY|SELL}`，盘口行没有 `k`。`zcat` 可读，正在写的当天文件末尾报 unexpected end of file 属正常。

秘密只在服务器：账户配置 `/root/.config/pm-system/account.json`、`/root/pm-system/config/dashboard-secret.env`、nginx 口令 `/etc/nginx/pm-dashboard.htpasswd`。不进源码、日志、文档、浏览器。

## 部署与回滚

`python scripts/deploy-reversal-release.py`（无参数）：

1. 本地用 `git archive HEAD` 在 `.deploy/<release>-build` 构建 `dist`，打包源码、`dist` 和清单（每个文件的 sha256、历史上删过的文件）。
2. SFTP 上传到 `/root/.pm-releases/<release>/`，在服务器上于 `deployment.lock` 下应用。交易必须是停止状态，否则拒绝。
3. 先把将被覆盖的文件打包成 `before.tar.gz`，再写入新文件、删掉已删除的文件、校验哈希、按需重载 systemd/nginx、重启采集器和控制面，最后确认控制面回到"停止 + 实盘锁不变"。
4. 任何一步失败都从 `before.tar.gz` 自动回滚。服务器和本地各保留最近 5 个发布。

服务器 `node_modules` 不归部署管，新增 npm 依赖要先在服务器上手动装。服务器上的 git HEAD 不随部署变，看 release 目录名判断线上版本。

## 已知限制与延后

- O1：服务器 root 允许密码 SSH 登录且对公网开放。计划调试完后设 IP 白名单（80 端口需对外开放以续期证书）。
- O3：没有任何备份（账本、结算记录、账户配置只在这一块盘上）。调试完后再做。
- C30：账本自己计算已结算盈亏的旧逻辑（`scripts/dashboard/ledger.py`）待官方数据连续稳定、没出现 `ledger` 回退后删除。
