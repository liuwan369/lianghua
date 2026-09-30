# 已知错误清单

所有 agent 开工前先看这里：动到相关代码时顺手修掉，修好后把条目移到"已修复"，写上提交号。

严重度：**P0** 会停摆或亏钱 · **P1** 改变真钱行为 · **P2** 显示错或数据不及时 · **P3** 体验。
每条都在线上服务器或用编译后的真实代码复现过，不是只看代码推断。

最后核对：2026-09-30，版本 `72f5205`。

---

## 未修复

### P2-16 诊断接口一旦报 degraded，前端就冻结在上一次"正常"的快照上

- **位置**：`frontend/console/shared/api-adapter.js` 291-293 行 `loadDiagnostics`：`resourceStatus` 对 `status=degraded` 返回 `degraded`，不等于 `ready`，又已有旧数据，于是只改 slice 状态、丢弃新的响应体。
- **复现**（真实 shared 模块 + settings-block + 真实 diagnostics DTO）：先 ok 再 degraded（交易进程 failed、CPU 99.9）→ 设置页标题显示"快照过期"，交易服务卡仍是"已停止"，CPU 仍是旧值；degraded 持续期间一直如此。`settings-block.js` 里"服务异常"那个分支只在会话首次加载时才能走到。
- **影响**：采集器过期、交易进程运行失败时，设置页和总览恰好看不到真正的故障，只显示"快照过期"。
- **修法**：293 行跳过保留旧数据的分支时排除 `degraded`：`if (status !== "ready" && status !== "degraded" && current.data) …`。传输失败仍走 `retainOnError`，不受影响。

### P2-17 市场页运行池写入被拒后，仍提示"运行池已设为 ETH"，盖掉真正的拒绝原因

- **位置**：`frontend/console/market-block.js` 271-280 行 `toggleEnabled` 的 finally 里无条件调用 `reportStrategyAssetMismatch(desiredIds)`，传的是请求值，不看写入是否成功。
- **复现**（无头 Edge 加载真实前端模块，PUT 返回 401"交易控制密码错误"）：提示依次变为"更新中"→ 正确的"需要先在设置页连接控制会话"→ **错误的"运行池已设为 ETH，请到策略页把币种改为 ETH"** → 约 45ms 后被轮询盖成通用文案。store 里运行池始终是 btc。
- **影响**：操作员看到一个假的"已设置"，和一条做不到的下一步（见 P2-18），真正的原因被盖掉，最后界面上看不出任何失败。
- **修法**：`reportStrategyAssetMismatch` 移出 finally，只在写入成功后、用 store 里服务器确认的 `desiredIds` 调用；结果提示保留到用户下一次操作，不被 `renderDetail` 每次轮询覆盖。

### P2-18 没有任何页面能改策略币种

- **位置**：`frontend/console/strategy-block.js` 118-142 行：能编辑的前提是 `strategyTargets(已发布配置, selectedAsset())`，而 `readForm`（276 行）提交的币种就是 `selectedAsset()`。所以只要能保存，提交的币种一定等于已发布币种；页面上也没有币种选择控件。
- **复现**（无头 Edge + 真实 DTO）：`strategy.html?assetId=eth` 所有输入和按钮禁用、表单清空；不带 assetId 时回落到 btc、只能保存 btc。后端 `save_draft`/`activate_draft` 实测可以把 btc 换成 eth，锁死只在前端。
- **影响**：ETH/SOL 等后端支持的币种无法通过界面交易；市场页"到策略页把币种改为 X"的提示做不到。不是死循环：把运行池切回 btc 仍能启动。不会错单。
- **修法**：把"可编辑"与"币种一致"解耦：有已发布配置就允许按它填表编辑，币种不一致时改为警告"保存并激活后，策略币种将从 BTC 改为 ETH"；运行中换币种由后端激活时的 `_validate_running_asset` 把关。

### P1-10 在场次末段启动必然失败

- **位置**：`scripts/system-dashboard-server.py` 2016-2038 行 `_modern_markets` 的 `fresh_future` 替换、1484-1496 行 `_start_trading` 把选中行映射成 expected 身份、1613 行 `--expected-market-id`；`backend/engine/src/cli/platform.ts` 709-710、293 行 `assertInitialMarketIdentity`。
- **原因**：场次末段当前场盘口提前变旧（见 P2-5），`/api/markets` 对该资产只返回下一场那一行（`current=false, nextRound=true`）。操作员这时点启动，控制面把下一场 marketId 当成启动选择器、映射成下一场 expected 身份；但引擎 `discoverMarket(now)` 只发现当前场，身份不匹配，run 在 `market_discovery` 阶段直接失败。
- **线上实证**：两条 3 行的失败 run 就是 `market_discovery` 阶段 `platform_run_failed`，创建时刻分别在本场第 287、264 秒（都落在末段窗口）。用真实 DTO + dist 复现：`markets-btc.json` 在 now=1790726958 只有下一场一行，`assertInitialMarketIdentity` 抛 `initial discovered market does not match requested marketId and roundId`。
- **影响**：末段窗口内启动全部失败，报的是通用错误（P2-7）。fail-closed，不下单不亏钱，但每场末段确定性挡住进场。
- **修法**：启动不要用 `nextRound` 行作为初始身份——`_start_trading` 里若选中行 `current!=true`/`nextRound=true` 则拒绝或改用当前直播场；或启动时不传 `--expected-market-id`，让引擎发现当前场后再由连续发现推进。修 P2-5（末段不提前切场）后这条也会消失。

### P2-11 `/api/runtime/status` 在每次启动的头 0–3 秒崩溃，连接直接断开

- **位置**：`scripts/system-dashboard-server.py` 1286 行 `runtime_row_fresh = (runtime.get("stale") ...)`，相邻 1280/1281/1289 行都有 `isinstance(runtime, dict)` 保护，唯独这里没有。
- **线上实证**：`dashboard-service.log` 里有 5 条一模一样的 `AttributeError: 'NoneType' object has no attribute 'get'`，时间都在 run 创建后 0–1 秒（12:51:04、12:59:47、13:11:44、14:18:02、14:18:05）。
- **影响**：`AttributeError` 不在 `do_GET` 的 except 列表里，服务器连 500 都不返回，直接断连。受影响的有 `/api/runtime/status`、`/api/bootstrap`、`/api/diagnostics/health`、`/api/v1/status`、`/api/strategy/config`、`/api/runtime/market-pool`。恰好是操作员点完启动、确认有没有启动成功的那几秒，前端只看到网络错误。不影响下单。
- **修法**：1286 行加 `isinstance(runtime, dict) and`。

### P2-12 已预热场次的配置没有冻结，与"下一场才生效"的承诺不符

- **位置**：`backend/engine/src/strategies/btc-reversal.ts` 271-272 行：场次从 `waiting_start` 转为 `running` 时执行 `round.config = clone(this.state.config)`，把建场时（423 行）冻结的配置换成此刻的实时配置。
- **复现**（dist）：开盘前 8 秒建场，配置 `[5,18,54,130]` rev1；接着发布 `[9,9,9,9]` rev2；开盘后本场按 rev2 下单，真实 submit 的 shares=9。
- **影响**：每场开盘前约 10 秒的窗口内发布的新配置，会在本场直接生效。前端却明确承诺"当前及已预热场次保持原配置"（`strategy-block.js` 320 行、契约 `DATA-MODEL.md` 47 行）。
- **修法**：删掉 271-272 行的重新克隆，只保留 `round.status = "running"`。

### P2-13 每个事件都全量深拷贝策略状态，下单延迟随累计场数线性变差

- **位置**：`cli/platform.ts` 685-686 行包装器在每个事件上执行 `reversal.exportState().rounds.find(...)`；触发帧内还有 `save() → core.setStrategyState → snapshot()` 两次全量 `structuredClone`，全部发生在 `platform.ts` 334 行 dispatch 下单之前。
- **实测**（dist 端到端，行情到 POST 前）：15 场约 2.3ms，100 场约 11.8ms，1000 场约 92ms。结算轮询（`cli/platform.ts` 887 行）还在每个市场的循环里各调一次 `getStatus()`。
- **影响**：当前 15 场可以忽略；不清空数据长期运行，会逐步拖慢下单。根因与 P0-3 相同，修 P0-3 后大部分会消失。
- **修法**：包装器改为轻量查询当前场配置；结算轮询每轮只取一次快照。

### P3-5 user WS 连接窗口内推来的成交和撤单帧会被丢掉

- **位置**：`backend/engine/src/live/feeds/user.ts` 551 行发订阅，553-613 行先 await 认证校验和重连补偿，624-625 行才挂 `ws.on("message")`。
- **复现**（真实 dist + 本地 WS 服务器）：窗口内推送的 `order:CANCELLATION` 和 MATCHED 成交都没有到达下游，且没有任何日志。
- **影响**：成交通常会被后续 MINED/CONFIRMED 帧或重连补偿补回；撤单通常由后续开放订单快照补回。实际效果是识别延迟、资金预留多挂一会儿，不会记错单。
- **修法**：`activeWs = ws` 之后立刻挂上消息监听，先缓存帧，等认证通过后再回放。

### P3-6 账户级恢复事件会清掉所有在跑场次的行情基线

- **位置**：`btc-reversal.ts` 235-243 行，`account_recovery_started` 不带 marketId，`resetQuoteReference(undefined)` 失效全部在跑场次。场次刚转 running、首帧还没到时发生，就要连吞两帧才开始识别跨价。
- **复现**（dist）：对照组第二帧跨价直接下单；实验组第二帧只建基线，这次跨价丢失。线上在 1790704500 场次边界确实出现过这个前置条件。
- **修法**：对 `firstSampleSeen=false` 的场次不置 `rebuildingReference`。

### P1-6 成交先 MATCHED 后 FAILED 时，账本把它当成真实成交（幽灵成交）

- **位置**：`scripts/dashboard/ledger.py` 的 `_trade_revision`（276 行）：`newer_failure = (new_status == "FAILED" and old_status not in ("CONFIRMED","FAILED") and new_time > old_time)`，要求 FAILED 的时间**严格晚于**前一条。
- **原因**：引擎给同一笔成交的每一次状态修订都写 `engine_ts = fill.ts`（`cli/platform.ts` 539 行），而 `fill.tsUnix` 取自场馆的 `match_time`（`user.ts` 153-168 行），同一笔成交的 match_time 不变。所以 MATCHED 和后来的 FAILED 带的是**同一个 engine_ts**，`new_time > old_time` 不成立，`newer_failure=False`，FAILED 修订被丢弃（`_trade_revision` 返回 None）。
- **复现**（真实 `_trade_revision`）：MATCHED 与 FAILED 同 `engine_ts` → 返回 None，成交停留在 MATCHED（幽灵成交）；把 FAILED 的 engine_ts 改到晚 5 秒 → 正常应用为 FAILED。
- **影响**：一笔场馆撮合后又在链上结算失败的成交，会被永久当成真实成交，计入 `fill_notional`、`fees`、以及结算 coverage，污染 PnL。线上 9 个 journal 里没有 FAILED 成交，所以还没发生；但这是 taker 成交结算失败时的真实场馆状态。
- **修法**：`newer_failure` 用 `new_time >= old_time`（和 recovery 分支一致）；或者不靠时间，直接规定"非终态成交收到 FAILED 一律接受"。

### P1-1 界面保存策略时，`maxRounds` 被悄悄清零

- **位置**：`frontend/console/shared/api-adapter.js` 的 `saveStrategy`（462-476 行）按固定白名单重建 config，白名单里漏了 `maxRounds`。
- **原因**：表单有传（`strategy-block.js` 281 行），在 adapter 这一层被丢掉。后端 `scripts/dashboard/strategy_config.py` 42-44 行发现缺字段，按默认值 0（不限场次）补上。
- **线上实证**：生效版本 22 的 `maxRounds=3`，服务器上那份草稿的 `maxRounds=0`。在界面上保存再激活后，"跑 3 场就停"会变成"一直跑"。
- **修法**：白名单加 `maxRounds: values.maxRounds ?? 0`。

### P2-1 阶梯用满时，"当前阶段"显示 `--`

- **位置**：`scripts/dashboard/ledger.py` 的 `_strategy_projection.round_view`（约 311-334 行）。
- **原因**：引擎有输出 `consumedStages`（`btc-reversal.ts` 160 行），但投影白名单没带上它。线上 SQLite 里存下来的每一场都没有这个字段。前端只能退回用 `nextStage - 1` 推算，满级时 `nextStage = null`，结果显示 `--`。
- **实例**：场次 1790704200，已用 1 级、`nextStage=None`。
- **修法**：round_view 的数字字段列表加 `"consumedStages"`。

### P2-2 盘口接口每秒才读一次采集器文件

- **位置**：`scripts/system-dashboard-server.py` 的 `_live_status_fetch`（1160 行：缓存不到 1 秒就直接返回）和 `refresh_live_background`（1144 行：`stop.wait(1)`）。
- **实测**：采集器每 250ms 写一次；接口里的数据每约 1000ms 才变一次，最多落后 27 帧；报价年龄中位数 0.94 秒、最大 1.43 秒，过期阈值是 2 秒。前端 500ms 轮询一次，但每两次里有一次拿到同一份旧数据。
- **修法**：按文件 mtime 判断是否需要重读，去掉 1 秒缓存。

### P2-3 每次换场（每 5 分钟）整个面板清空重画

- **位置**：`frontend/console/auto-trade-block.js` 的 `resetRoundPanels`（463-497 行），市场身份一变就由 `syncMarketContext` 调用。
- **现象**：所有字段清成 `--` 或"读取中"，订单、时间线、事件三块整段替换，等 REST 返回后才重新显示。
- **浏览器实测**（真实 Chromium 连线上控制台，采样 1222 次）：清空发生在场次结束前 **106.6 秒**，而不是边界时刻。原因是 P2-5 让服务器提前切到下一场。盘口字段空白 0.8 秒，持仓、订单、状态字段空白 0.5 秒。切回标签页后 1 秒内同时发出 11 个请求（1310-1320 行，8 个加载器以 0 延迟同时启动）。
- **修法**：先修 P2-5（去掉提前切场）；换场时保留上一场内容并标记"上一场"，新数据到了原地替换；切回标签页时错开请求时间。

### P2-6 阶段显示一直是"待接入"

- **位置**：`frontend/console/auto-trade-block.js` 486 行 `resetRoundPanels` 把 `[data-stage]` 写成"待接入"；只有 `renderPosition` 能把它改掉。
- **浏览器实测**：整个采样窗口（-295 秒到 +25 秒，引擎停止状态）里，`[data-stage]` 一直是"待接入"，持仓状态是"持仓数据尚未确认"，运行状态是"暂不可用"。引擎停止时，当前场次没有持仓数据，这一格永远不会被更新，"待接入"这个措辞让人以为是功能没做完。
- **修法**：没有持仓数据时显示"本场未交易"或"引擎未运行"，不要沿用"待接入"。

### P2-5 场次最后 1–2 分钟盘口被判"不完整"，前端提前约 105 秒切到下一场

- **位置**：`backend/engine/src/live/feeds/polymarket.ts` 803-807 行：UP 或 DOWN 任一边缺买一或卖一，就判 `incomplete_book`，这一帧不发布。
- **实测**：结果基本确定后，交易所盘口会变成单边。连续 7 次查询交易所 REST 盘口（结束前 64 秒到 4 秒）：UP 买盘为空、卖一 0.01；DOWN 卖盘为空、买一 0.99。这是真实行情，不是断线。代码却把它当成"盘口不完整"：采集器这一行 `healthy=False`，报价年龄一路涨到 123 秒；watchdog 每 5 秒按 `bilateral_quote_timeout` 重连一次（采集器每小时约 960 次重连，大多发生在这个窗口）。
- **连锁后果**：
  - `/api/markets` 在当前场标成 stale 后，按 `fresh_future` 改为返回下一场（`system-dashboard-server.py` 2026-2032 行）。实测每场结束前约 105 秒，服务器就切到下一场（1017 次采样中有 408 次返回的不是当前场）。
  - 自动交易页在同一时刻（浏览器实测 -106.6 秒）身份改变，触发 `resetRoundPanels`，整块清空。这就是"总体刷新"真正的触发点，不在场次边界。
  - 同一窗口里，前端还在请求当前场的 `/api/markets/{id}/snapshot`，服务器返回 404（实测 408 次采样中 404 占 408 次），就是 nginx 日志里那 346 次 404 的来源（P3-3）。
- **对交易的影响**：这个窗口里一边已经是 0.99，本来就不会穿越 0.67，所以不会漏单。但引擎会在这段时间持续报 `market_feed_unhealthy`，并且因为 `invalidateReference`，行情恢复后至少丢掉一次跨价机会。
- **修法**：单边盘口（一边只有卖一、另一边只有买一，且价格在 0.01/0.99 附近）按"已确定"处理：照常发布，标成终局状态，不触发 watchdog 重连；`/api/markets` 在这个状态下不要切到下一场。

### P2-4 统计接口在"已结算盈亏未知、又有未结算场次"时崩溃

- **位置**：`scripts/dashboard/ledger.py` 的 `metrics_summary`（2241 行）：`"exposed_pnl": (known_pnl - unsettled_cost) if known_pnl is not None or unsettled_rounds else None`。条件写的是 `or`，`known_pnl` 为 None 时只要 `unsettled_rounds` 非空，就执行 `None - float`，抛 TypeError，接口返回 400 `invalid_query`。
- **复现**（用线上账本副本）：`metrics_summary(run, range="run", asset_id="btc")` 抛 `TypeError: unsupported operand type(s) for -: 'NoneType' and 'float'`。线上 `GET /api/metrics/summary?range=run&assetId=btc&runId=...` 当前就返回 400。任何区间只要满足这两个条件都会触发。
- **连带的口径不一致**：`range=run` 不带过滤条件时走另一条代码路径 `summary()`（2023-2024 行），同一个运行返回 `pnl=0.0`；带上 `assetId` 就崩溃。同一个运行因为参数不同给出两种结果。
- **修法**：`known_pnl` 为 None 时 `exposed_pnl` 取 `-unsettled_cost` 或 None（按契约语义二选一），不要做 None 运算；`range=run` 的两条路径合成一条。

### P2-7 引擎启动失败时，真实错误被丢掉

- **位置**：`backend/engine/src/cli/platform.ts` 989 行 `reportError(phase, "platform_run_failed")` 只记阶段名，不记异常内容；1091-1093 行顶层 catch 对非参数错误一律输出 `"platform could not complete; inspect the phase and local configuration"`。
- **线上实证**：9-29 这一天有 4 次启动失败（run `125946`、`164720`、`164923`、`165134`），日志里只有 `phase=market_discovery` 或 `phase=platform_connect`，没有任何错误原因。当时是 RPC 过载、地域检查、时钟偏差还是 Gamma 超时，已经无从查起。前端只显示"交易进程运行失败"。
- **修法**：`reportError` 带上 `error.message`（截断并过滤掉私钥或十六进制长串），顶层 catch 同样输出真实 message。

### P1-3 "今日盈亏"两套日界，跨午夜必然对不上

- **位置**：引擎日界 `backend/engine/src/platform/core.ts` 9 行 `dayOf`（UTC+8）；账本日界 `scripts/dashboard/ledger.py` 的 `metrics_summary` 2020-2022 行（UTC 零点、UTC 月初）。
- **现象**：策略页"当前当日盈亏"读引擎 `dailyPnlUsd`（UTC+8 日、盯市、含未结算）；总览"今日"读账本已结算盈亏（UTC 日、只算已结算）。两个"今日"指的是不同时间段、不同口径。停机闸按 UTC+8，总览显示按 UTC，北京时间 0–8 点之间两者一定不一致，看着像账错。
- **不是数字算错**：现金五源（链上、CLOB、账户读取器、引擎状态文件、接口）实测分毫不差，见 [ACCOUNTING.md](ACCOUNTING.md)。
- **修法**：统一一套日界，建议都用 UTC+8（停机闸已是 UTC+8）；总览标签注明口径（已结算 vs 盯市）。

### P2-8 同一个界面词，不同页面用不同算法

- **位置**：`frontend/console/shared/view-model.js` 225-250 行用一长串 `??` 回退链取数；各页 block 取同名字段。
- **现象**：
  - **可用**：总览/自动交易取"余额 − 未成交买单名义"（不扣手续费、不套预算，`account-finance.ts:171`）；真正管下单的是引擎 `availableUsd`（扣费 + 套 `totalBudgetUsd`），前端只在前者取不到时才回退。实测当前前者 209.54、引擎 10（预算封顶）。
  - **总资产**：只显示 pUSD 抵押余额；引擎含持仓盯市的 `equityUsd` 没有任何地方显示。
  - **均价**：实盘持仓路径 = 含手续费成本 ÷ 股数（`ledger.py:1859`）；成交回退路径和轮次表 = 名义 ÷ 股数，不含费（`ledger.py:2394`）。
  - **投入/占用**：实盘路径 = 持仓成本；回退路径 = 名义 + 手续费（+估算）。
- **修法**：每个界面词固定一个数据来源，去掉回退链；"可用"应显示引擎真正的 `availableUsd`。

### P2-9 手续费验收标准：账本和引擎不一致

- **位置**：账本 `scripts/dashboard/ledger.py` 459-469、1514 行把 `rate-derived` 当可信算进已结算盈亏；引擎结果列 `backend/engine/src/cli/platform.ts` 589-592 行 `netIfUp/netIfDown` 只认 `reported`。
- **现象**：taker 成交基本拿不到场馆 `fee_usd`，落成 `rate-derived`。同一轮，账本能算出盈亏，引擎 UP/DOWN 结果列却是空。
- **修法**：统一一个标准。`rate-derived` 是按场馆费率算的，可信度够，建议两边都接受。

### P3-4 账户快照的持仓占用含已归零的输家仓位

- **位置**：`backend/engine/src/live/account-finance.ts` 155 行 `position_cost_usd = Σ size × avgPrice`，包含 `redeemable` 仓位。
- **实测**：账户读取器报了 20 个 `redeemable=true`、`currentValue=0` 的历史输家仓位，成本合计 $66.89，都算进了 `occupancy.position_cost_usd`。
- **影响小**：引擎读取时已正确丢掉它们（`platform/polymarket.ts:156`，引擎状态文件 `positions=[]`）；这个数不进下单闸、不进风控、前端也没显示。只是看原始快照会以为占用了 66 刀。
- **修法**：和引擎一样过滤 `redeemable && currentValue == 0`。

### P1-4 赢的场次盈亏永远算不出来（胜率永远偏低、已结算盈亏漏计赢利）

- **位置**：`scripts/dashboard/ledger.py` 的 `_coverage_from_runtime`（1437-1466）取的是结算那一刻运行时里该场的持仓份额；`_refresh_settlement`（1512-1528）要求"净份额等于 coverage"才算 PnL。
- **原因**：赢的场次在结算前，场馆常常已经自动赎回，引擎持仓已归零。实测场次 1790704200：买了 5 股 DOWN 并赢了，链上到账 5 USDC、`payout_verified=true`，但结算时运行时里 `upShares/downShares` 都是 0，`coverage={token: 0.0}`。于是"净买入 5 股 ≠ coverage 0 股"，PnL 判定失败，`pnl_error=cost_basis_unverified`，`pnl=None`。
- **实测影响**：这一场明明赢了（credited 5，成本 3.5，净赚约 1.5），却记成"待核对"。月度统计因此显示 `settled_wins=0 / settled_losses=2 / settled_pnl_pending=1`，**胜率 0%、已结算盈亏 -12.10 全是输的场**，赢的那场被吞掉。截图里"胜率 --%"和"已结算净盈亏"只算到输场，就是这个原因。
- **不是钱错**：现金五源一致（[ACCOUNTING.md](ACCOUNTING.md)），真实月度变化 -8.04（217.59→209.54，含未结算持仓），赢利确实到账了，只是账本的 PnL 口径把它判成"无法核对"。
- **修法**：coverage 不能只信结算那一刻的持仓（那时可能已被赎回归零）。应取该场**成交后、赎回前**的持仓峰值，或直接用成交累计的净份额（`trade_details` 已有 CONFIRMED、reported 的成交）来核对 credited。
- **根因更正（复核补充）**：这一场持仓归零，**主要不是**场馆自动赎回，而是 P1-7——成交后 1.5 秒一次落后的账户对账把持仓抹成空。真实 journal：成交在 `1790704238.402`，`239.863` 触发 `account_recovery_started`，下一条状态起 `positions=[]`、现金一直是成交前的 208.04，之后 126 条 `platform_status` 全部 `positions_count=0`。用真实 journal 重放账本：该场 credited=5.0、真实 pnl=+1.5，但 coverage 来自被抹空的持仓（0 股），与成交净份额 5 股对不上，于是 `pnl=None`。所以先修 P1-7，这条的大部分会随之消失；coverage 改用成交净份额是第二道保险。

### P2-10 "订单数"与"成交数"口径不一致，看着像丢了订单

- **位置**：统计面板"订单数"取账本 `order_count`，"成交"取运行时 `fills`；月度 `order_count=8`、`fill_count=8`，但截图"订单数 当月 8 / 今日 0"，而"唯一成交 1"。
- **原因**：`order_count` 数的是账本里所有订单记录（含被拒、被撤、状态推进的多条），`fills` 数的是去重后的成交；两个数放在同一张卡上但来源和口径不同。
- **影响**：只是显示困惑，不影响交易。当月 8 单里只有部分真正成交，用户看不出来。
- **修法**：卡片标注清楚口径，或统一成"下单数/成交数"两个明确不同的字段。

### P2-14 每次成交后，账户余额空白约 3.2 秒

- **位置**：`scripts/dashboard/account_data.py` 231-238 行 `invalidate()` 把 `self._identity = None`；随后 `_account()`（46-58 行）发现身份变了，当成"换了账户"，把缓存换成 `_empty(wallet, "account_changed")` 并 `_stop_process()` 杀掉账户读取子进程。触发点是新成交：`scripts/system-dashboard-server.py` `_note_fill_watermark`（约 297-316 行）。
- **复现**（服务器上，用控制面真实模块驱动 `AccountData`）：预热后 `available=True`；调用一次 `invalidate()`，快照立刻变成 `available=False`、`error_code=account_changed`，**3.2 秒后才恢复**。
- **影响**：每笔成交后，总览"可用余额"和自动交易"账户余额"显示"不可用"约 3 秒。现在是轮询，碰上才看得到；改成推送后，每次成交都会主动把"余额不可用"推给所有浏览器。不影响下单（引擎用自己的账户读取）。
- **修法**：成交后只需要"立刻刷新一次"，不是换账户。`invalidate()` 只清节流计时（`_attempt`），不清 `_identity`、不清缓存、不杀子进程；旧值保留到新值到来。

### P2-15 账本快照和心跳分两次写，读的人会误判"数据过期"

- **位置**：`scripts/dashboard/projection_worker.py` 77 行先原子写 `snapshot.json`，91 行再写 `heartbeat.json`；`scripts/dashboard/read_model.py` 104-114 行读快照后读心跳，两者 `snapshot_version` 对不上时 `checked_at = 0`。
- **原因**：两次写之间有空档。读的人如果落在中间，新快照配旧心跳，版本对不上，`checked_at=0`，`age_seconds ≈ 1.7e9`，`stale=True`。
- **影响**：这个"过期"会传到运行状态（`system-dashboard-server.py` 2088-2089）、订单与持仓的元数据（2344-2346）、健康检查（2604-2605）和命令状态（1283-1285）。交易时账本每秒改写约 4 次，轮询每 1-2 秒读一次，撞上概率低；改成推送后每 100ms 检查一次，会反复撞上，界面"正常→过期→正常"闪烁。
- **修法**：心跳版本对不上时，沿用上一次确认过的时间，不归零；或把快照和心跳合成一次原子写入。

### P3-7 控制面重启时引擎一起被杀，这次运行永远停在"执行中"

- **位置**：`scripts/system-dashboard-server.py` 501-518 行 `_restore_trading_state_locked`、1192-1215 行 `trading_status`；systemd 单元没设 `KillMode`，默认 `control-group` 会连引擎子进程一起杀。
- **现象**（真实模块复现）：重启后发现 pid 已死，只把 `_trading_pid` 置 None，`stop_result` 仍是 None。之后 `commandStatus` 一直是 `executing`，健康检查一直 `degraded`，界面显示"状态过期"而不是"已停止"，看不到"被重启杀掉"和"远端挂单未确认"。界面停止按钮要求 running=true，也点不到。部署脚本会先检查 running=False，所以正常发布不触发。
- **修法**：恢复时如果 pid 已不匹配、日志还在、`stop_result` 为 None，就执行 `_automatic_stop_result` 并持久化。要让引擎在控制面重启后跑完收尾，需要另改单元的 `KillMode`/`TimeoutStopSec`，是部署取舍。

### P3-8 停止时持锁等待 8 秒，期间几乎所有读接口卡住

- **位置**：`scripts/system-dashboard-server.py` 1679-1765 行 `stop_trading` 在 `with _trading_lock` 内 `process.wait(timeout=8)`（1730 行），已恢复 pid 的轮询在 1712-1714 行。
- **影响**：停止期间 `/api/runtime/status` 等需要这把锁的接口最多卡 8 秒，前端 8 秒超时正好触发，显示请求失败。

### P3-9 停止超过 8 秒后真正退出时，退出原因（包括 failed）丢失

- **位置**：`scripts/system-dashboard-server.py` 1195 行 `if not _trading_stop_result` 配合 1750-1760 行：超时时已写入一个"待确认"的 stop_result，进程稍后真正退出时 `_automatic_stop_result` 被跳过。

### P3-10 换场后 `/api/markets` 可能把已结束的上一场当成当前场返回

- **位置**：`scripts/system-dashboard-server.py` 1966-1968 行 `failed()` 沿用缓存时的 `current`/`nextRound`，不按当前时间重算；2013-2020 行优先选 `current is True`。
- **复现**（真实模块）：边界后 5 秒两场都 stale、缓存里有上一场 → 返回上一场 `current=True`、`endAt-now=-5s`；清空缓存 → 正确返回新一场。采集器断线时会一直错到恢复。
- **修法**：`failed()` 里按当前时间重算 `current`、`nextRound`。

### P3-11 自动交易页头部余额在两个值之间来回跳

- **位置**：`frontend/console/auto-trade-block.js` 1334 行订阅 `accountStatus` 时调用 `renderAccount`，把头部写成账户检查时的毛余额（不带过期标记），而 10 秒一次的账户快照写的是净余额。
- **复现**（真实 shared 模块 + 真实 DTO）：有 3.5 挂买单时，头部在 206.04 与 209.54 之间来回切。
- **修法**：1334 行只更新 `accountStatus` 和控件，不再调用 `renderAccount`。

### P3-12 自动交易页"结算状态"永远显示"本场暂无结算记录"

- **位置**：`frontend/console/auto-trade-block.js` 745-773 行只按当前场过滤，请求（990 行）也限定当前场；服务端 `settlements_page` 按 `round_id` 过滤。结算只在场次结束后才产生（`cli/platform.ts` 882 行），那时目录已切到下一场。
- **实证**（账本副本）：6 条结算记录全部在所属场次结束后 100 秒到 3.3 小时才生成，在所属场还是当前场时一条都不存在。
- **修法**：请求只带 assetId、取最新一条，渲染时标注它属于哪一场。`roundSettlementDue` 保留给 fills。

### P3-13 持仓面板在场次进行中显示"本场已结束"

- **位置**：`frontend/console/auto-trade-block.js` 539-547、603-607 行：`source="fills"` 的响应一律写"本场已结束 · 按成交记录显示"。`ed4ea25` 之后请求只查当前场，所以这个响应一定属于还没结束的那一场。
- **复现**（账本副本 + 真实 `Ledger.position`）：本场内停机，或运行中快照过期 10 秒，都返回 `source=fills`，界面显示"本场已结束"，旁边倒计时却是"剩余 3:20"。
- **修法**：按场次 `endAt` 是否已过决定前缀；未结束时显示 `position.error` 的可读原因。

### P3-14 总览在运行中切换运行池币种后，"停止交易"按钮变灰

- **位置**：`frontend/console/overview-block.js` 108-153、195 行：停止判断要求运行池首选币种和目录当前场与 runtime 身份完全匹配。
- **复现**（真实页面脚本 + 真实 DTO）：运行中把运行池切到 eth（引擎继续跑 btc）→ 停止按钮禁用，点击直接 return。另外每次干净停止后，头部一直显示"进程状态未知"（569 行先判身份，`cleanStopped` 分支走不到）。自动交易页的停止仍然可用。
- **修法**：停止按钮只看 `runtime.processRunning === true && !stale`；`cleanStopped` 判断挪到身份判断之前。

### P3-15 总览净盈亏卡的"N 场待核对"出现后不会消失

- **位置**：`frontend/console/overview-block.js` 383-387 行只在待核对数非零时改写副标题，没有恢复分支；334-339 行清空数据分支也不恢复。
- **复现**：待核对从 1 变 0 后，副标题仍是"1 场待核对"，同一屏脚注已显示"PnL 待核对 0"。

### P3-16 策略页重读失败再成功后，提示一直停在"策略接口断开"

- **位置**：`frontend/console/strategy-block.js` 202-213 行 `receive` 只在 `formKey` 变化时更新提示；版本不变时没有分支清掉断开提示。
- **复现**（无头 Edge）：200 → 503 → 200 后，状态标签是"BTC 服务器配置已读取"，保存提示仍是"策略接口断开"。

### P3-17 设置页和总览的运行状态在运行中途停止后冻结

- **位置**：`frontend/console/shared/api-adapter.js` 231-232 行 `loadRuntime` 全局分支；消费方 `overview-block.js` 563-570 行。
- **现象**：会话中途引擎停止后，全局 runtime slice 停在停止前的 running 快照上。

### P3-18 成交上报延迟指标被 MINED/CONFIRMED 修订拉高

- **位置**：`backend/engine/src/live/feeds/user.ts` 153-157 行按 `match_time` 计算 `authenticated_trade_report`，每个状态修订都算一次，MINED/CONFIRMED 比 MATCHED 晚几秒，延迟统计因此偏高。只影响延迟监控，不影响交易。

### P2-21 自动交易页启动按钮会误报"服务器进程状态未知"

- **位置**：`frontend/console/auto-trade-block.js` 1243-1246 行 `refreshRuntime`：`if (!context.assetId || !context.marketId || !context.roundId) { scheduleRuntimeRefresh(); return ... }`。运行状态的轮询**要求先有完整的市场身份**才会发请求。启动闸（1007-1008 行）用 `globalRuntime || selectedRuntime || { processRunning }`，这两个都没设时 `processRunning` 为 undefined，`runtimeStartBlockReason`（`view-model.js` 162 行）返回"服务器进程状态未知，暂不允许启动"。
- **现象**（用户截图 14:43:16）：服务器实际正常（`/api/runtime/status` 200、`status=stopped`、`processRunning=false`），页面却显示"暂不能启动：服务器进程状态未知""数据连接：后端未连接 · 等待快照""所选市场状态待接入"。**进程状态是全局事实，不依赖选了哪个市场**，却被市场身份卡住了。
- **触发**：任何时候市场目录暂时没有"当前场"——页面刚打开、换场窗口（见 **P2-5**，每场结束前约 105 秒当前场被判不完整）——运行状态轮询就停在原地，启动闸误报。另有一条：一次网络抖动走到 `retainOnError`（`api-adapter.js` 30 行把 `processRunningFresh` 置 false），也会让启动闸短暂报"未知"，下一次成功轮询才恢复（本地用真实 view-model 复现）。
- **影响**：操作员以为服务器出问题、启动不了；其实服务器好好的，只是页面没去问。不影响交易本身。
- **修法**：运行状态（进程是否在跑）的全局轮询**不依赖市场身份**，页面一加载就轮询；只有按场次作用域的那部分（本场状态、暂停/停止）才要求身份匹配。启动闸只看全局进程状态。

### P3-1 提示类事件显示成红色

- **位置**：`scripts/system-dashboard-server.py` 的 `_event_dto`（2358 行）把所有 `kind=error` 的事件都标成 `severity="error"`，前端 `vm.eventSeverity` 又以后端给的 severity 为准，按代码细分的规则因此失效。
- **实例**：`account_recovery_started` 只是提示，显示成红色。

### P3-2 `/api/events` 返回 26 条就有 90KB

- **位置**：`_event_dto` 用 `{**event, ...}` 把原始事件整份展开，每条约 2KB。

### P3-3 前端反复请求已结束场次的快照

- **现象**：nginx 日志里有 346 次 404，几乎都是 `/api/markets/{已结束场次}/snapshot`，其中一个 marketId 被请求了 118 次。
- **根因**：见 P2-5。不是前端记错了场次，而是场次最后约 105 秒里，服务器目录已经切到下一场，自动交易页却还在用当前场的 marketId 请求快照。

---

## 已修复

（修好一条就挪到这里，写上提交号）

### 第 2 批：启动与状态 — 已部署 `4dd1745`，两次小额实盘通过（2026-09-30）

每条都有回归测试 `backend/engine/scripts/regress/<编号>`（P1-11 在 `scripts/regress/P1-11.py`），旧代码上失败、新代码上通过，每条都做过独立审查。

- **P0-1 被拒订单后引擎起不来** — `6c7dd95`，补丁 `1167868`。恢复时按"已用级数"校验阶段份数。**首次部署 `d19f76b` 在线上启动即失败**（`state_open`，没下单）：线上状态文件里有旧代码按下标定份数的历史场 1790687700（0 成交撤单后第 2 级是 18 股），新规则拒收。补丁同时接受两种份数，其他份数仍拒收；测试加了该场原样的 D 场景。教训：改恢复校验必须先用**当前线上状态文件**重放。
- **P0-3 状态行无限增长** — `136d258`。状态行只带当前场、最近 8 场和还没办完的场。本地 1000 场：旧写法超过 256KB，新写法 4.6KB；线上两次运行单行最大 38.9KB、37.4KB（大头是盘口，场数不再累加）。
- **P1-9 场次计数** — `2a2308c`。两次运行都设 `maxRounds=3`：中途启动那场停在 `waiting_next_round`、不计数，之后正好跑 3 场，按 `round_limit_reached` 停机。run 1 三场都成交；run 2 两场成交，一场没触发。
- **P1-5 + P2-19 死市场回灌** — `f6370fd`。1790691600 在 run 1 记为 confirmed，run 2 里一次都没再出现（之前每次运行 36-39 次）。
- **P1-11 部署删 config/ 文件** — `8f9f273`。三次部署删掉的只有 git 已删的文件和 `__pycache__`，`config/` 下 7 个文件都在。
- **P1-12 心跳 25 秒** — `ca120c1`。线上 dist 确认 5 秒，两次运行心跳失败日志都是 0 条。**没走到的路径**：5 笔单都在 0.3 秒内成交，没有挂单超过 10 秒，所以"挂单不再被场馆撤"这次没有线上证据，由 `regress/P1-12.mjs` 保证。
- **P1-13 收盘后结算查不到市场**（run 1 发现）— `95f14af`。run 2 里 1790785800（输的场，run 1 一直卡在 not_found）记为"持仓全部落败，赎回收益为 0，无需链上交易"，没发交易。
- **P2-23 已确认的场每 15 秒重结算**（run 1 发现）— `3cdf3d6`。`account_recovery_started`：run 1 23 分钟 160 次，run 2 19 分钟 5 次；旧场不再重复 confirmed。
- **两次实盘**：run `20260930-162501-1fb3a0266703`（`1167868`）、run `20260930-170531-cb02c3f1c1d8`（`4dd1745`）。一共 5 笔成交，每笔 5 股，价格 0.67-0.69；账户 211.12 → 208.64（-2.48）。两次都没有全账户 halt，没有 `invalid account order`，也没有 `apply missing fills`。
- **结算等待上限**：实测后保持 5 分钟不变，理由见 `1586428`。run 2 里本场两轮都在运行期内由场馆自动赎回确认。

### 第 1 批：对账链 — 已修复 `a395db6`，已部署 `2f6f6ce`，小额实盘通过（2026-09-30）

这四条和 P0-2（`4ded4ed`）是同一条因果链，按 FIX-PROCESS 第 5 节必须同一批部署。

- **P1-8 每次下单都把整个账户置成 halt**：`refreshReconciliationRisk` 的 SUBMITTING 分支加 `!this.submissions.has(clientOrderId)`，本进程在途的单不再触发全账户 halt。磁盘恢复出的在途单仍由构造函数转成 UNKNOWN、按市场阻塞。测试 `regress/P1-8.mjs`：bug 场景在原代码上失败；对照场景确认恢复出的在途单仍被阻塞。
- **P2-22 ACK 前场馆已撤单却被提成 OPEN**（**修 P1-8 时发现**）：ACK 分支若 `venueStatus` 已是 canceled/expired，改走 `confirmCancelled`。原先被 P1-8 的误 halt 恢复循环"意外兜底"，P1-8 修好后失去兜底，所以同批修。测试 `regress/P2-22.mjs`。
- **P2-20 浮点累加与场馆份额严格比较**：三处 `!==` 改为 `Math.abs(a-b) > EPS`（core 两处、polymarket 一处）。测试 `regress/P2-20.mjs`：97.85+4.1 能对上 101.95；对照确认真实缺 4.1 股仍被拒。
- **P1-7 落后快照抹掉刚成交的现金和持仓**：两层。(a) `reconcile` 只对已结算（CONFIRMED/FAILED/无状态）的成交置 `accountingCashSuperseded`；(b) `recoverAccount` 在有**新鲜**临时成交时干净 return、跳过本轮对账，交给 5 秒定时器在成交终态后重试。测试 `regress/P1-7.mjs`。
  - **审查发现并已修的边界**：跳过若没有上限，一笔永远停在 MATCHED 的成交（进程在成交中途崩溃、场馆 RETRYING 循环）会让所有对账永远跳过、UNKNOWN 订单永远不被解决。已加 60 秒上限 `PROVISIONAL_FILL_MAX_AGE_SEC`：线上 8 笔真实成交 MATCHED→CONFIRMED 用时 6.0–7.9 秒，60 秒留足余量。
  - **审查确认安全**：跳过对账后 `setRecovering(false)` 会放开 recovery 闸，但未对账的 UNKNOWN 订单所在市场仍被 core 的按市场阻塞（`marketReconciliationBlocked`）挡住，两道闸独立，不会在未对账时放开下单。
- **全部测试**：`regress/` 下 P0-2、P1-8、P2-22、P2-20、P1-7 共 5 个，外加原有 `check-order-path`、`check-l2-headers`、`check-redundant-feed`，typecheck、build 全绿。每个回归测试都在它要防的原代码上失败过（负对照）。
- **线上验证：已通过**。部署版本 `2f6f6ce`（release `reversal-2f6f6ce-20260930T125745Z`），run `20260930-130519-e5b0a60f8ee1`，结果见下方"实盘结果"。

#### 第 1 批实盘验证方案（用户已确认，已执行）

- **用的配置**：线上现有生效版本 22，不改：`stageShares=[5]`、`maxStages=1`、`roundBudgetUsd=5`、`totalBudgetUsd=10`、`dailyLossUsd=10`、`maxRounds=3`。每场最多买 5 股 × 0.70 = **3.5 美元**，总占用上限 **10 美元**，日内亏损到 10 美元自动停。
- **最坏损失**：约 10 美元（3 场都买在输的一边、全部归零）。账户当前 209.54 pUSD、无挂单。
- **要看到的四件事**（都从服务器 journal 和状态文件里取证据）：
  1. **P1-8**：下单时 WS `live` 先于 ACK 到达（线上常态），账户**不再**进入 `halted=true, reason=restored orders require reconciliation`。
  2. **P1-7**：成交后几秒内若发生账户恢复，持仓和现金**不被抹掉**；成交 CONFIRMED 后下一次对账正常收敛，持仓数与场馆一致。
  3. **P0-2**：场次结束时策略撤掉未成交的挂单（若有），之后对账和重启**都不抛** `invalid account order`；撤单后预留在下一次对账释放。
  4. **P2-20**：若出现多笔部分成交，对账**不再**因 `apply missing fills` 失败。
- **P2-22**：场馆在 ACK 前推撤单的情况线上从未出现过，实盘里多半遇不到；靠回归测试保证。
- **注意 P1-9 仍未修**（第 2 批）：`maxRounds=3` 实际只会交易约 1-2 场（中途启动那场和回灌旧场会吃掉计数）。这不影响第 1 批的验证，只是交易场数比 3 少，也让最坏损失低于 10 美元。
- **通过标准**：引擎正常停在 `round_limit_reached`，journal 里没有 `invalid account order`、`apply missing fills` 的失败循环、全账户误 halt，停机后状态文件能正常恢复。任何一条不满足就重新部署上一个版本 `614a747`。

#### 第 1 批实盘结果

- **交易**：1 笔成交，场次 1790773800，买 DOWN 5 股 @ 0.67，成本 3.43。该场结算为 DOWN 赢，场馆自动赎回 5 美元。账户 **209.54 → 211.12，净赚 1.57**。引擎按 `round_limit_reached` 正常停止。
- **P1-8 通过**：整个运行 267 条状态里，全账户误 halt（`restored orders require reconciliation`）**0 次**；成交前后 `halted=false`。
- **P1-7 通过**：成交 MATCHED(845.23) → MINED(847.28) → CONFIRMED(851.66) 全程持仓 1、现金 206.1165，**没被抹掉**；停机时状态文件里持仓 5 股、成本 3.35 仍在。
- **P2-20 通过**：`apply missing fills` 错误 **0 次**。
- **重启恢复通过**：用线上部署的代码加载停机后的状态文件（含 9 笔历史订单，其中 2 笔 CANCELLED），`validateAccount` 接受，**不抛** `invalid account order`。
- **没有走到的路径**（如实记录，不算验证过）：
  - **P0-2**：这次订单**直接成交**，没有剩余挂单要在收盘时撤，所以"撤掉已 live 挂单"这条路径实盘没走到。它由回归测试 `regress/P0-2.mjs` 的四个场景保证；等以后自然出现未成交挂单时再补一次线上证据。
  - **P1-8 的 live-before-ACK**：这笔订单 WS 的 `live` **没有**先于 ACK 到达（订单直接从 SUBMITTING 变 FILLED），所以 P1-8 的触发条件本身没出现。"0 次误 halt"只能说明没出事，不能证明修复在那个时序下生效；由回归测试 `regress/P1-8.mjs` 保证。
  - **P1-7 的跳过对账**：这次运行两次账户恢复（`1790773570.6`、`1790774100.0`）都不在成交窗口里，没有撞上"有临时成交时跳过"的分支；持仓没被抹掉，是因为根本没有恢复在那几秒发生。跳过逻辑由 `regress/P1-7.mjs` 保证。
  - **P2-22**：线上从未出现过"ACK 前场馆推撤单"。
- **结论**：第 1 批部署安全、没有引入新问题，引擎正常交易、正常停机、状态能恢复。其中两条的线上证据是"没出事"而不是"触发后被修复拦住"，如实记录。
- **实盘中观察到的问题**（不是第 1 批引入的，已归到对应批次）：
  - **P2-19 仍在发生**：死市场 1790691600 这次运行又回灌了，36 条 `settlement_market_not_found`、约每 15 秒一条。第 2 批修。
  - **结论（第 2 批复核，不改代码）**：这不是 bug，是设计好的"停机时不强等，交给下次运行恢复"。第 2 批实测连续 5 场场馆的结算时间：**759、791、1059 秒**已出结果，另两场 700 秒和 400 秒后仍未出。也就是说场馆通常要 **13 到 18 分钟**才出结果，把 5 分钟上限拉长到 20 分钟，每次停机就要多等 15 分钟，而控制面停止命令只等 8 秒（`system-dashboard-server.py` 1712、1730 行）就返回"待确认"。拉长上限换来的只是账本早 15 分钟看到这场的盈亏，钱本来就不会丢：场馆自动赎回，下次启动时 `settlementRecoveryCandidates` 会把这场重新排进结算（`cli/platform.ts` 734-756 行，已用线上状态文件验证）。**所以保持 5 分钟上限不变。** 修 P1-5/P2-19 后，下次运行能把这类场正确记成已结算。
  - **原观察：场馆结算慢于引擎的结算等待时间，赢的场留待下次运行结算**。本场结束后，场馆 **729 秒**才宣布结果（CLOB `closed=true`）；引擎的收尾等待上限是结束后 5 分钟（`SETTLEMENT_DRAIN_MAX_MS`），到点报 `settlement_drain_timeout` 退出，这一场留在"待结算"。**钱没丢**：场馆随后自动赎回，账户实收 5 美元；下次启动时 `settlementRecoveryCandidates` 会把 1790773800 重新排进结算（已用线上状态文件验证）。影响是账本里这场的盈亏要到下次运行才出来（P1-4、P1-5 那条链）。同时查了最近 8 场，场馆结算时间在 5 分钟以内到 12 分钟以上都有，**5 分钟的等待上限经常不够**。归入第 2 批的 P1-5/P2-19 一起处理：结算等待上限可以按实测拉长，或停机时不强等、完全交给下次运行的恢复（它已经能正确接上）。




### P0-2 本地撤单后仍占着资金，下一次对账和重启都抛错 — 已修复 `4ded4ed`（本地已验证，待部署后线上验证）

- **原问题**：`core.ts` 撤单成功分支 `order.reconciliationPending ??= true`。订单先收到 WS `live`（614 行置 false）或先有部分成交（1177 行附近置 false）后，这一行不会改它，结果 `CANCELLED + reconciliationPending=false + reservedUsd>0`，`validateAccount`（185 行）拒绝，对账和每次重启都抛 `invalid account order`，引擎起不来。收盘撤已 live 的挂单就走这条，WS live 先于 ACK 是常态。
- **修法**：`order.reconciliationPending = order.reservedUsd > EPS || order.reservedShares > EPS`——pending 严格跟随"是否还持有预留"，正好就是 `validateAccount` 的不变量。
- **为什么不是 BUGS 原修法的 `= true`**：独立审查发现另一条路径。撤单 HTTP 在途时，User WS 先推 `orderCancelled`（`confirmCancelled` 置 CANCELLED、保留预留），再来一条非撤单状态，`core.ts:619` 对已终态订单把预留清成 0。此时强制 `pending=true` 会得到 `CANCELLED + pending=true + reserved=0`，同样被 `validateAccount` 拒、重启挂。所以原修法本身会引入新 bug，已改为按预留判断。
- **测试**：`backend/engine/scripts/regress/P0-2.mjs`，真实 TradingPlatform/Core/Store/Strategy，只假造网关，四个场景，每个都在它要防的版本上失败过：
  - A：WS live → 本地撤单。原 `??=` 失败，修复后通过。
  - B：部分成交 → 本地撤单。原 `??=` 失败，修复后通过。
  - 对照：直接撤单，改前改后都通过（没误伤正常路径）。
  - C：撤单在途时预留被释放到 0。`= true` 失败，修复后通过（防住审查员发现的回归）。
  - 原有三个检查脚本 `check-order-path`、`check-l2-headers`、`check-redundant-feed` 全部仍通过；typecheck、build 干净。
- **线上验证（待做）**：需部署后按 FIX-PROCESS 第 5 节 d 档小额实盘——挂一笔远离盘口的 5 股单，等 WS 报 live，本地撤单，确认状态文件里 `reconciliationPending=true`、下一次对账后 `reservedUsd=0`、重启正常。部署会在你补完剩余 bug 后，和同批修复一起做。
- **连带影响**：本修复让收盘撤单会多拉一次账户恢复，放大了 P1-7 的触发面，已记在 P1-7 条目里，P1-7 需尽快修。

### P1-2 双 socket 合并会丢掉真实的价格变化，触发信号被延后 — 已修复 `614a747`

- **原问题**：`runPolymarketFeed` 的 `book()` 整帧判断"两边时间都不倒退"，socket B 先推进 DOWN 后，socket A 带着真实 UP 变化、但 DOWN 仍是旧时间的一帧被整帧丢掉。基线 UP 0.60 / DOWN 0.40，B 送 DOWN→0.31，A 送 UP→0.68（穿过 0.67 触发价），转发给策略的只有 `[0.6,0.4]、[0.6,0.31]`。
- **修法**：改成按边合并：各自保留两个 socket 里最新的 UP 和最新的 DOWN，任一边前进就转发。合并后的一对按实际携带的两边重算时间：`sourceAt` 取较新的一边，`expiresAt` 和 `marketAgeMs` 跟较旧的一边，陈旧的一边不会借用新鲜一边的时钟。
- **验证**：`backend/engine/scripts/check-redundant-feed.mjs` 新增 3d（本条场景），UP 0.68 立即转发并与 B 的 DOWN 0.31 配对。8 项检查全过；8 种故意改坏（包括恢复旧的整帧拒绝、把过期改成跟较新的一边）全部被抓到。已部署，采集器 7 币种健康、未重启。
