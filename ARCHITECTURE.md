# 系统技术架构

Polymarket 五分钟反转实盘系统。本文件是**唯一的架构基准**：任何 AI 或人接手前先读完它，改动后同步更新它。旧文档（`shared/contracts/*`、`frontend/console/docs/*`）只作接口细节参考，冲突时以本文件和代码为准。

最后核对：2026-09-29，版本 `640a419`。行号会随代码变化漂移，以函数名为准。

---

## 0. 一分钟看懂

- **做什么**：盯 Polymarket 的 BTC "5 分钟涨跌"盘。任意一边的卖一价从下往上穿过触发价（默认 0.67）时，以限价（默认 0.70）买入穿越的那一边；反向再穿越时加仓另一边，最多 4 级。每轮收盘后链上结算赎回。
- **在哪跑**：AWS 都柏林单机 `root@34.242.206.196`，目录 `/root/pm-system`。本地 Windows 只写代码，不能跑交易链路。
- **几个进程**：控制面（Python）按需拉起交易引擎（Node）；另外常驻一个行情采集器（Node）、一个账本投影（Python）和一个账户读取子进程（Node）。
- **真钱**。账户秘密只在服务器上，不进源码、日志、浏览器。

## 1. 铁律

对所有 AI 和人生效，冲突时铁律优先：

1. 禁止过度工程化、过早抽象：先写具体可用的代码。
2. 禁止流程主义、审计驱动：别拿报告代替改代码。
3. 禁止用安全门槛替代交付：拦住不显示不是修复。
4. 分轻重缓急：先修会亏钱、会漏单、会卡交易的问题。
5. 热路径要最快的实现，动手前查业界做法对照。
6. **先量后改**：瓶颈必须有实测数据（服务器 journal 或探针），不凭感觉。
7. 在现有系统上**逐层调优**，不推倒重建。
8. 对话简洁，可以幽默。

---

## 2. 进程与部署拓扑

```
                      nginx (443, basic auth, 10 r/s)
                               │
                  ┌────────────▼─────────────┐
                  │ 控制面 system-dashboard-  │  127.0.0.1:18766 only
                  │ server.py (systemd)       │
                  └─┬──────┬──────┬───────┬───┘
       spawn/stop   │      │      │       │ read
   ┌────────────────▼┐  ┌──▼────┐ ┌▼─────────────┐  ┌──────────────────┐
   │ 交易引擎         │  │投影    │ │account-data  │  │ market-snapshot  │
   │ dist/cli/       │  │worker │ │(node 子进程)  │  │ .json            │
   │ platform.js     │  │.py    │ └──────────────┘  └────────▲─────────┘
   └──┬───────┬──────┘  └──┬────┘                            │ 250ms
      │WS/HTTP│ journal    │ ledger.sqlite3        ┌──────────┴────────┐
      ▼       └───────────►│                        │ 行情采集器         │
   Polymarket CLOB / Polygon                        │ market-snapshot.js│
                                                    │ (systemd,常驻)    │
                                                    └───────────────────┘
```

| 进程 | 入口 | 启动方式 | 职责 |
|---|---|---|---|
| 控制面 | `scripts/system-dashboard-server.py` | systemd `pm-system-dashboard-dublin`，只绑 127.0.0.1:18766 | HTTP API、静态前端、启停引擎、账户检查 |
| 交易引擎 | `backend/engine/dist/cli/platform.js --live` | 控制面 `_start_trading` 按需 spawn，一次一个 | 行情→策略→下单→成交→结算 |
| 行情采集器 | `dist/cli/market-snapshot.js` | systemd `pm-clob-market-snapshot`，常驻 | 7 个币种的盘口，每 250ms 原子写 `data/dashboard/market-snapshot.json`，`--stale-after-ms 2000` |
| 账本投影 | `scripts/dashboard/projection_worker.py` | 控制面拉起，每 250ms 一轮 | journal → `ledger.sqlite3` |
| 账户读取 | `dist/cli/account-data.js` | 控制面常驻子进程，15s 刷新 | 余额、挂单、持仓、成交 |

**引擎下单用的是它自己的行情 WS，不读采集器文件。** 采集器只供前端展示，以及引擎发现市场失败时兜底。

### 启动引擎（控制面 `strategy_control` → `_start_trading`）

必须全部满足：已保存的策略版本号、UUID 请求号、明确一个 marketId+roundId、`PM_TRADING_LIVE_UNLOCK=1`、账户检查通过、当前没有在跑的引擎。

```
node dist/cli/platform.js --live --duration-sec <N> --status-sec 2 --max-rounds <n>
  --journal-file results/live/dashboard-<run_id>.jsonl --state-file <state>
  --stop-file <journal>.stop --strategy btc-reversal --asset btc
  --strategy-config results/dashboard/btc-reversal-config.json
  --control-file <journal>.control.json --expected-market-id X --expected-round-id Y
```

### 停止

Linux 发 SIGTERM。引擎依次：暂停 → 撤掉所有挂单 → 对账 → 等结算跑完 → 落盘退出。控制面最多等 8 秒，**超时也绝不 kill 实盘进程**。账户读到零挂单才算"已确认停止"。

---

## 3. 引擎模块地图（`backend/engine/src`）

| 目录/文件 | 负责 |
|---|---|
| `cli/platform.ts` | 引擎入口：参数解析、市场发现与换轮、策略挂载、配置热加载（1s）、结算调度（15s）、写 journal、停机流程 |
| `platform/core.ts` | **交易核心** `TradingCore`：账本、资金预留、风控与停机、下单/撤单/成交/对账 |
| `platform/platform.ts` | `TradingPlatform`：盘口状态、事件发布给策略、结算入口 |
| `platform/polymarket.ts` | 实盘连接器：网关、行情队列与消费、快照校验、用户 feed、账户恢复、各类定时器 |
| `platform/store.ts` | 状态文件落盘（fsync）、下单前签名意图文件 `.intent` |
| `platform/journal.ts` | 异步 JSONL 事件日志（不 fsync） |
| `platform/live-settlement.ts`、`settlement.ts` | 链上赎回（EOA 或 relayer），可断点续做 |
| `platform/snapshot-gate.ts` | 双边盘口快照是否可交易（纯函数） |
| `platform/cash-flows.ts` | 链上充提分类（算真实 PnL 用） |
| `platform/contracts.ts` | 共享类型 |
| `live/clob/client.ts` | `ClobWrapper`：签名、**下单 HTTP**、撤单、对账读取、连接保活 |
| `live/clob/wallet.ts` | 钱包、funder、签名类型解析 |
| `live/feeds/polymarket.ts` | 公共行情 WS：L2 + 快速 BBO 合并、新鲜度看门狗 |
| `live/feeds/user.ts` | 私有用户 WS：订单与成交事件，断线后 REST 补单 |
| `live/feeds/index.ts` | `FeedQueue`：同一 key 只留最新盘口，优先事件先出 |
| `live/discovery.ts` | 通过 Gamma 发现 5 分钟盘，采集器兜底 |
| `live/account-*.ts` | 账户读取与权益（控制面 account-data 用） |
| `strategies/btc-reversal.ts` | 策略本体（见 §5） |
| `models.ts` | 价格量化、手续费公式：`shares × rate × (p(1−p))^exp` |

---

## 4. 热路径：从一帧行情到下单

这是延迟优化的主战场。`[I/O]` 标出下单前的每次磁盘或网络操作。

```
1  feeds/polymarket.ts  ws.on("message")
     JSON.parse → 身份/时钟过滤 → applyMessage(L2) → bestBidAskChanges(快速BBO)
     → 新鲜度≤2s → 发布门(顶档变/250ms/健康变/深度变) → sink({kind:"book"})
2  platform/polymarket.ts  FeedQueue.push（每个 key 只留最新）→ 消费循环
     → acceptSnapshot（snapshot-gate 校验，行情+feed 都健康）
3  platform.ts  ingestSnapshot → core.markBatch → publish(book)
4  platform.ts  publish：每个事件 freeze(clone()) 一次，所有消费者共享同一份
     → 监听者（journal 异步写）→ strategy.onEvent(shared, context())
5  strategies/btc-reversal.ts  onEvent → 返回 submit 动作
6  core.ts  submit（clientOrderId 去重）→ submitOrder
     → 风控门 → 预留资金 → 状态 SUBMITTING → gateway.submit
7  platform/polymarket.ts  网关：要求行情 WS、feed、用户 feed 全部健康
8  clob/client.ts  submitOrder
     → negRisk（已由 warmMarket 缓存）
     → SDK createOrder 本地 EIP-712 签名（不走网络）
     → [I/O 磁盘] onPrepared → store.savePreparedOrder：写 .intent 并 fsync
     → l2Json（HMAC 请求头）→ fetchJson → [I/O 网络] fetch POST /order
```

**下单后**：用户 WS 推订单/成交 → `core.observeVenueStatus` / `core.applyFill`（fsync 状态）→ 策略记录阶段。ACK 里的 tradeIds 在 0/250/750/1500ms 用 REST 各核对一次。

### 实测延迟（2026-09-29，4 笔真实下单）

| 段 | 中位 | 归属 |
|---|---|---|
| 触发 → 发出 POST | ~22ms | 我们 |
| 签名 | ~4.4ms | 我们 |
| `.intent` fsync | ~4ms | 我们（不能砍，见 §6） |
| 等场馆首字节 `response_headers` | ~307ms | 网络+场馆撮合 |
| 端到端 | ~334ms（首笔 1018ms） | |

**结论：90% 以上是等场馆。** 我们自己能控的只有 30–40ms。

### 连接保活（`640a419` 已上线）

- **问题**：Node 默认 dispatcher 连接空闲 4 秒就关，而每轮只下一单、相隔 300 秒，所以每单都要重新握手（冷 80–139ms，热 24–29ms）。SDK 的 25 秒心跳走 axios，是另一条连接，保不住下单这条。
- **修法**：`live/clob/client.ts` 的 `installKeepAliveTransport()` 把 undici `Agent`（keepAliveTimeout 60s）装成全局 dispatcher，外加每 30 秒 `touchTransport()` 发一次 GET `/time`。探针验证：空闲 300 秒后仍复用同一条连接，34.6ms。
- **不能踩的坑**：
  - **必须用 `Agent`，不能用 `Pool`**。Pool 只绑一个域名，而全局 fetch 还要访问 Gamma、data-api、RPC、relayer，换成 Pool 这些全部断掉。
  - **不能设 `connections`**。它限制的是每个域名的并发数；行情发现一次就同时发 4 个 CLOB 请求，下单会排在后面超时，然后被标成 UNKNOWN，系统随即停止交易。
  - `pipelining` 必须保持 1。
  - `touchTransport` 必须读完响应体，否则连接不会还回池子。
  - undici 版本锁死为 `7.18.2`，与 Node 24.13.0 内置版本一致。

---

## 5. 策略逻辑（`strategies/btc-reversal.ts`）

| 参数 | 默认 | 含义 |
|---|---|---|
| `triggerPrice` | 0.67 | 卖一价从下往上穿过它就入场 |
| `maxBuyPrice` | 0.70 | 下单限价（GTC、非 postOnly） |
| `confirmationPrice` | 0.70 | 只做统计，**不是入场条件** |
| `stageShares` | `[5,18,54,130]`（线上 `[5,18,60,120]`） | 每一级的股数 |
| `maxStages` | 4 | 每轮最多几级 |
| `roundBudgetUsd` / `totalBudgetUsd` | 不限 | 单轮 / 总占用上限 |
| `maxRounds` | 0（不限） | 跑几轮后停（由 CLI 数收盘轮数） |
| `maxQuoteAgeSeconds` / `maxQuoteSkewSeconds` | 2 / 1.5 | 行情多旧、两边时间差多大就不交易 |

**判定流程**：

1. 只在 `now <= market.startsAt` 时接新一轮，中途启动要等下一轮。配置每秒热加载一次，但**下一轮开始才生效**。
2. 双边报价过门：未过期、不超过 2 秒、两边时间差不超过 1.5 秒、时间戳不倒退。
3. 第一对报价只记作基线，不交易。
4. 入场：`prev.ask < trigger && now.ask >= trigger`，并且**只能有一边**穿越。两边同时在触发价上方属于歧义，不交易。
5. 买穿越的那一边，股数 = `stageShares[已用级数]`。同方向不重复加仓，所以各级 UP/DOWN 交替。
6. 预算三道检查：单轮预算、总预算、可用资金。
7. `clientOrderId = ${instanceId}:${marketId}:${stageIndex}`，每一级固定一个 ID，天然幂等。
8. 收盘时撤掉未成交的挂单。

被拒的单，或撤单时一股没成交的单，**不占级数**。

---

## 6. 风控与安全门（`platform/core.ts`）

| 停机原因 | 触发 | 怎么解除 |
|---|---|---|
| 日内亏损上限 | 按买一价盯市的权益低于当日基线减 `dailyLossUsd`（UTC+8 换日） | 换日或调高上限；停机期间仍允许卖出 |
| 订单状态未知需对账 | POST 超时或结果不明 | 对账完成后自动解除（按市场隔离） |
| 签名身份需对账 | 签名哈希 ≠ 场馆 orderId | 对账后自动解除 |
| 重启恢复的订单需对账 | 重启时 `.intent` 有未决订单 | 对账后自动解除 |
| 状态持久化失败 | fsync 失败 | **不自动解除** |
| 平台已停止 | `stop()` | 下次恢复 |

**下单门**：账户恢复中、该市场被阻断、已停机、tick/最小量、手续费预留、单轮预算、单笔上限、挂单数上限、可用资金。

**资金预留**：买单预留 `金额 + 手续费`，按成交比例释放，拒单、撤单确认或对账发现订单不存在时退回。`availableUsd = min(现金 − 预留, 资本上限 − 已占用)`。

**签名先落盘，再发 POST（不能砍）**：签完名、发 POST 之前，把签名哈希和载荷 fsync 到 `<state>.intent`。进程若在 POST 途中崩溃，重启后能凭签名去场馆查这单到底发没发出去，只在收盘前、且查询返回 404 时，原样重发**同一份签名**。原则：**绝不为一个不确定的 POST 再生成一张新单**，否则可能重复下单。代价约 4ms。

---

## 7. 结算与账本

- **结算**：每 15 秒扫一遍已收盘的市场。跳过还有挂单或成交未终结的市场；等市场判定后，经 collateral adapter 调 `redeemPositions` 赎回。每个钱包同时只有一笔待确认交易。能识别场馆的自动赎回（它常比我们早一个块）。停机时最多再等 5 分钟把结算跑完。
- **Journal**：`results/live/dashboard-<run_id>.jsonl`，只追加，不 fsync。记录 order、fill、latency、settlement、status 等事件。
- **账本**：`results/dashboard/ledger.sqlite3`，由投影进程写，控制面只读。主要表：`runs`、`events`、`order_details`、`trade_details`、`settlement_details`、`latency_samples`、`platform_runtime`。
- **PnL**：只统计已验证的结算。`pnl = 实际到账 − Σ(买入金额 + 手续费)`。这是引擎口径，不等于钱包对账口径。

---

## 8. 控制 API（`scripts/system-dashboard-server.py`）

应用只监听 127.0.0.1:18766。外网经 nginx 进来，需要 basic auth，限流 10 r/s。GET 没有应用层鉴权；POST 需要控制会话 cookie、token，或 nginx 传来的已认证头，且 Origin 必须等于 Host。

| 常用 GET | 用途 |
|---|---|
| `/api/runtime/status` | 引擎状态、风控、资金 |
| `/api/markets`、`/api/markets/{id}/snapshot` | 市场目录与盘口 |
| `/api/strategy/config` | 已保存的配置和草稿 |
| `/api/account/status`、`/api/account/snapshot` | 账户就绪情况与余额持仓 |
| `/api/rounds`、`/api/rounds/{id}/orders`、`/position` | 每轮历史 |
| `/api/fills`、`/api/settlements`、`/api/events`、`/api/metrics/summary` | 账本查询 |
| `/api/diagnostics/health` | 各服务健康 |
| `/api/v1/status` | 旧接口，部署脚本在用 |

| POST | 用途 |
|---|---|
| `/api/runtime/commands` | start / stop / pause / resume |
| `/api/strategy/drafts`、`/api/strategy/activate` | 保存草稿、发布配置 |
| `/api/runtime/market-pool` | 选择币种 |
| `/api/ledger/reset` | 清空数据（保留结算记录），需 `confirm:"RESET"` 且没有引擎在跑 |
| `/api/account/check`、`/api/account/save` | 账户检查与保存 |
| `/api/trading/auth/session` | 登录控制会话 |

**没有**延迟查询接口。延迟数据在 journal 的 order 事件和 `ledger.sqlite3` 的 `latency_samples` 表里。

---

## 9. 前端（`frontend/console`）

纯静态页面，由控制面托管。每页加载 `shared/`（`preview-core` 负责请求，`api-adapter` 负责接口适配，`view-model` 负责数据整形，`preview-store` 管状态），再加载本页的 block JS。全部靠轮询；`ws-client.js` 存在，但默认不开 WS。

| 页面 | 看什么 | 主要轮询 |
|---|---|---|
| `overview` | 总览、启停、清空数据 | 行情 + 状态 3s，其余 15s |
| `auto-trade` | 当前轮盘口、持仓、订单、成交 | 盘口 500ms，持仓/订单 1s，状态 2s |
| `market` | 市场目录、选币 | 1s |
| `strategy` | 策略参数表单 | 进页面读一次 |
| `settings` | 账户检查、控制密码 | 点击时 |

---

## 10. 服务器上的状态文件

`E` = `/root/pm-system/backend/engine`

| 路径 | 谁写 |
|---|---|
| `E/results/live/dashboard-<run_id>.jsonl` / `.console.log` | 引擎 |
| `E/results/live/dashboard-<run_id>.control.json` | 控制面写，引擎每秒读（暂停/恢复） |
| `E/results/live/btc-reversal-<hash>.platform-state.json`（含 `.intent` `.lock` `.next`） | 引擎 |
| `…platform-state.json.settlements.json` | 引擎结算（清空数据时保留） |
| `E/results/dashboard/btc-reversal-config.json`、`.draft.json` | 控制面 |
| `E/results/dashboard/market_pool.json` | 控制面 |
| `E/results/dashboard/ledger.sqlite3` | 投影进程 |
| `E/results/dashboard-state.json` | 控制面（当前 run 信息） |
| `/root/pm-system/data/dashboard/market-snapshot.json` | 采集器 |
| `/root/pm-system/data/dashboard/deployment.lock` | 部署和启动共用的 flock |
| `/root/.config/pm-system/account.json` | 账户配置（秘密） |
| `/root/.pm-releases/<release>/` | 部署归档与回滚材料 |

---

## 11. 部署

```
python scripts/deploy-reversal-release.py     # 不带参数，部署当前 HEAD
```

- 只部署**已提交**的版本：按 `git archive` 在本地构建，打包源码和 `dist`，SFTP 上传后在服务器上应用。
- 前提：**交易必须是停止状态**，否则直接拒绝。
- 应用时在 `deployment.lock` 下执行；清理不在清单里的旧文件，校验哈希，必要时重启控制面和采集器。任何一步出错都会自动回滚，回滚材料在 `/root/.pm-releases/<release>/before.tar.gz`。
- **服务器的 `node_modules` 不归部署管**。新增 npm 依赖要先在服务器上手动装：`cd /root/pm-system/backend/engine && npm install <pkg>@<ver>`。
- 服务器上的 git HEAD 不会随部署更新；判断实际运行的版本，看 release 目录名或文件哈希。

### 验证方式

本地只能跑 `npm run typecheck` 和 `npm run build`，项目**没有测试框架**。真实验证必须在服务器上做：

```
ssh -i ~/.ssh/id_ed25519_dublin_pm root@34.242.206.196
curl -s http://127.0.0.1:18766/api/runtime/status        # 必须在服务器内执行
```

---

## 12. 关键时间常数

| 项 | 值 | 位置 |
|---|---|---|
| 行情 WS PING / 看门狗 / 消息超时 | 5s / 1s / 15s | `feeds/polymarket.ts` |
| 行情源最大年龄 | 2s | 同上 |
| 用户 WS PING / 重连 | 10s / 2s | `feeds/user.ts` |
| 策略报价最大年龄 / 两边时间差 | 2s / 1.5s | 策略配置 |
| 下单超时 | 3s | `DEFAULT_ORDER_TIMEOUT_MS` |
| SDK 心跳 | 25s | `startHeartbeat` |
| 下单连接保活 idle / touch | 60s / 30s | `TRANSPORT_*` |
| 市场发现 / 换轮预热 | 15s / 提前 10s | `cli/platform.ts` |
| 结算扫描 | 15s | 同上 |
| 资金流刷新 | 30s | `platform/polymarket.ts` |
| 状态非关键落盘防抖 | 25ms | `store.ts` |
| 采集器发布 / 过期 | 250ms / 2s | `market-snapshot.ts` |

---

## 13. 路线图（从底层往上，逐层重构验证）

这是一次系统重构：每层的功能都要重新验证，不默认旧行为正确。顺序从最底层的输入往上走，因为上层依赖下层的正确性——行情不稳时调策略毫无意义。

每层同一个套路：**读代码 → 服务器实测 → 写状态文档 → 最小改动 → 小额实盘确认 → 再上一层**。

| 层 | 状态 | 说明 |
|---|---|---|
| L0 实时行情输入 | 🔄 进行中 | 市场发现、5m 场次、YES/NO、盘口、sequence、时间戳、过期、断线恢复。状态见 [MARKET-DATA.md](MARKET-DATA.md) |
| L1 下单网络层 | ✅ `640a419` 已实盘验证 | 连接保活 + 事件共享冻结。首单 `response_headers` 从 988ms 降到 236ms |
| L2 决策→下单 | ✅ `123d942` 已实盘验证 | 触发→POST 从 47ms 降到 15.8ms：原生 HMAC 头、签名预热、去掉冗余状态拷贝 |
| L3 订单回报 | ✅ 已核对，健康，未改代码 | 成交在 ACK 前后 ~0.5s 到、MATCHED 即入账；无丢单/重复；状态见 [ORDER-FLOW.md](ORDER-FLOW.md) |
| L4 风控 | 待做 | 停机、资金预留、对账 |
| L5 结算 / 账本 | 待做 | 赢亏算得准；延迟数据没有查询接口 |
| L6 策略 | 待做（最后） | 触发价、加仓级数、胜率——只有下面几层可信了才有意义 |

**顺序修正记录**：早期把顺序排成 下单→决策→策略→风控→账本，遗漏了最底层的行情输入，且把策略排得过前。已改为 L0..L6 自底向上。

### 已知但暂不处理

- `AbortSignal.any` 叠加长命 signal 的内存泄漏（Node 24.13.0 的 bug），出现在资金流扫描和市场发现里，约 12MB/天，**不在下单路径上**。先看进程实际跑多久再决定。
- 本地 node_modules 的 `undici` 装自 npmmirror 镜像，版本和完整性哈希与官方一致。
