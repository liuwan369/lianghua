# 已知错误清单

所有 agent 开工前先看这里：动到相关代码时顺手修掉，修好后把条目移到"已修复"，写上提交号。

严重度：**P0** 会停摆或亏钱 · **P1** 改变真钱行为 · **P2** 显示错或数据不及时 · **P3** 体验。
每条都在线上服务器或用编译后的真实代码复现过，不是只看代码推断。

最后核对：2026-09-30，版本 `72f5205`。

---

## 未修复

### P0-1 出现一次被拒的订单后，引擎可能再也启动不了

- **位置**：`backend/engine/src/strategies/btc-reversal.ts` 的 `restore()`（约 548、564 行）和创建阶段的逻辑（约 357、372、376 行）。
- **原因**：创建新阶段时，份数按"已用级数"取（被拒的阶段不算），编号按 `stages.length + 1` 取；恢复状态时的校验却要求第 N 阶段份数等于 `stageShares[N-1]`，并且阶段数不超过 `maxStages`。两条规则互相矛盾。
- **复现**（用编译后的 dist 代码）：阶段 1 UP 5 份被拒 → UP 再次穿越 → 阶段 2 UP 5 份。落盘内容是 `[1 UP 5 REJECTED], [2 UP 5 CREATED]`，恢复时抛错 `invalid persisted reversal stage`。一次被拒再加上满阶梯时，阶段数超过 `maxStages`，恢复时抛错 `invalid persisted reversal round`。
- **影响**：状态文件每个账户一份（`scripts/system-dashboard-server.py` 约 1582 行，`btc-reversal-<钱包哈希>.platform-state.json`），每次启动都会恢复（`cli/platform.ts` 665-668 行）。坏数据写进去以后，之后的每次启动都会在 `state_open` 阶段失败，只能手动改或删状态文件，删掉就丢了订单和持仓的恢复信息。交易所拒单、预留落盘失败、签名前进程中断都会产生被拒订单（`core.ts` 108、885、956 行）。
- **线上**：9 个 journal 里被拒订单为 0，还没触发过。零成交撤单不会触发（已测）。
- **修法**：恢复校验改用和创建阶段相同的"已用级数"规则；另加回归测试。

### P0-2 本地撤单后仍占着资金，下一次对账和重启都抛错

- **位置**：`backend/engine/src/platform/core.ts` 1048 行 `order.reconciliationPending ??= true`。
- **原因**：`??=` 只在值是 `undefined` 时才赋值。订单只要先收到过 user WS 的 `live` 状态（614 行置 `false`），或先有部分成交（1177 行附近），`reconciliationPending` 就已经是 `false`，本地撤单时这一行不会改它。结果订单状态是 `CANCELLED`、`reconciliationPending=false`，却还占着资金（`reservedUsd > 0`）。`validateAccount`（185 行）规定"非待定订单不能有预留"，于是抛 `invalid account order`。
- **复现**（改自项目自带的 `scripts/check-order-path.mjs`，真实 TradingPlatform/Core/Store/Strategy，只假造网关）：
  - ACK → user WS 推 `live` → 本地撤单：`CANCELLED reconciliationPending=false reservedUsd=3.55`；`reconcile()` 抛 `invalid account order`，**重启也抛同样的错**。
  - ACK → 部分成交 2 股 → 本地撤单：`CANCELLED reconciliationPending=false reservedUsd=2.13`；对账和重启同样抛错。
  - 对照：ACK 后直接撤单（中间没有 live）正常，`reconciliationPending=true`。
- **为什么是 P0**：user WS 推 `live` 是常态，线上两笔撤单的历史里都有它（`venue_status=live, source=user_ws`）。策略收盘撤掉未成交挂单（`btc-reversal.ts` 251-268 行）走的就是这条本地撤单路径。线上那两笔恰好是交易所先撤的（`cancellation_source=user_ws`），走了另一条路才没出事。只要有一次由我们自己在收盘时撤掉一笔已经 `live` 的挂单，账户对账就一直失败；状态文件每个账户一份，之后每次启动都在恢复阶段抛错，引擎起不来。
- **修法**：1048 行改为 `order.reconciliationPending = true`（本地撤单一律待定，直到 WS 或账户读数证明没有成交抢在撤单前）。加回归测试覆盖上面两个场景。

### P0-3 策略状态只增不减，连续运行约 17 小时后引擎自停，之后每次启动即停

- **位置**：`backend/engine/src/strategies/btc-reversal.ts` 426 行 `discover` 只 push，全仓没有裁剪 `state.rounds`；`platform/platform.ts` 的 markets/books/snapshots 四个 Map 也只 set 不 delete。`cli/platform.ts` 581-641 行每 2 秒把它们全部写进一条 `platform_status`；`platform/journal.ts` 60 行关键写单行超过 1MB 就失败；657-658 行失败即 `requestStop("journal_failed")`。
- **复现**（dist 里的真实 PlatformJournal，按真实状态行结构放大）：
  - 只看 rounds：约 740 场时单行 1,062,798 字节，`write()` 返回 false，引擎停机。
  - 连同 markets/snapshots/books 一起增长（真实 journal 里 12 分钟内 markets 2→4、books 0→6，已结束的场仍在列表里）：约 **205 场（连续约 17 小时）** 超限。
- **更早的连锁**：账本投影每次只读 256KB（`projection_worker.py` 67 行）。单行超过 256KB 后，`ledger.py` 1254-1260 行把 `source_error` 写死，这个 run 之后的成交、订单、结算全部不再投影。实测累计约 175 场、或连续运行约 4 小时，控制台统计就冻结了，引擎却还在实盘交易。
- **为什么是 P0**：状态文件每个账户一份、跨运行复用（`system-dashboard-server.py` 1582 行），超限之后每次启动的第一条 running 状态行就超限，一启动就停，只能"清空数据"。`maxRounds=0` 的连续模式下一天之内必到；P1-1 又会把 `maxRounds` 悄悄改成 0。
- **修法**：summary 只输出当前场和最近 K 场（K≥8，账本只用 `rounds[-8:]`），加上仍有活动订单或未结算的场；markets/snapshots/books 只输出未结束和需要结算恢复的场，让每条状态行远小于 256KB。裁剪 `state.rounds` 时，只能删"已结束、无活动订单、无成交或结算已 confirmed"的场，否则会丢赎回。

### P1-7 成交后几秒内的一次对账，用落后的账户快照把刚成交的现金和持仓抹掉

- **位置**：`backend/engine/src/platform/core.ts` 1322 行 `reconcile` 用账户快照整体替换 `cashUsd`/`positions`；1326-1329 行按 `fill.ts <= cashAt` 给成交标 `accountingCashSuperseded`，不看成交状态。上游唯一的防护 `platform/polymarket.ts` 781-791 行只比较订单 `updatedAt` 和快照时间，拦不住"场馆余额还没反映 MATCHED"的情况。
- **线上实证**（最近一次运行唯一的一笔成交）：`recv 238.402` 成交 5@0.7（MATCHED），本地现金应为 204.54、持仓 5 股；`239.863` 启动账户恢复；`239.963` 状态变回现金 208.04（成交前的值）、持仓为空、可用 10、占用 0；之后同一笔的 MINED、CONFIRMED 都到了，状态不变，一直错到本场结束（超过 258 秒）。结算记录的 `cash_before_usd=204.54` 证明成交后的真实余额。
- **复现**（真实 dist，只假造网关，资金上限 10）：成交后用落后 1.5 秒的快照对账 → 现金回到 208.04、持仓空、可用 10；随后 CONFIRMED 也补不回来；再发一笔 8.40 美元的探测单被**接受**，加上已持有的 3.5，合计 11.9 美元，**越过了 10 美元的资金上限**。
- **影响**：这段时间 core 认为账户没有持仓、资金全部空闲，资金上限、单场预算占用、日内亏损盯市全部算错。线上当时 `maxStages=1`，没有多下单；阶梯配置下同一场后面的阶段会按错误的可用资金下单。P1-8 的 halt 会让 5 秒清理定时器在每次成交后立刻跑恢复，所以这是正常下单路径必然经过的窗口。
- **修法**：`recoverAccount` 在调用 `reconcile` 前，如果还有非终态成交（MATCHED/MATCHED_NOT_BROADCASTED/RETRYING/MINED），就跳过这一次对账，等它 CONFIRMED 或 FAILED 再跑，和结算路径（`cli/platform.ts` 892 行）同一规则。不要用 throw 实现延后（会置 `recoveryFailureGlobal`）。`accountingCashSuperseded` 只对 CONFIRMED 成交置位。

### P1-8 每次下单都会把整个账户短暂置成 halt，并逼出一次立即对账

- **位置**：`backend/engine/src/platform/core.ts` 348-351 行 `refreshReconciliationRisk`：只要存在 SUBMITTING 订单，就置 `halted=true`、原因 `restored orders require reconciliation`，不区分这张单是不是本进程正在提交的。入口是 `observeVenueStatus`（624 行）。解除条件 355-356 行在还有活动订单时不清；`updateRisk`（687 行）只在 `blockedMarketIds` 非空时清。`polymarket.ts` 1052 行因为原因里含 `reconciliation`，每 5 秒触发一次 `recoverAccount`。
- **线上实证**：user WS 的 `live` 先于 HTTP ACK 到达是常态，线上两次下单都是这样（`238.146` 仍是 SUBMITTING 却已收到 live，`238.15` 才变 OPEN）。旧 run 里订单 `…c15:4` 在 SUBMITTING 时收到 live 后，每 5 秒一次恢复，直到撤单。
- **复现**（真实 core）：SUBMITTING 期间收到 live → `halted=true`；ACK 变 OPEN、成交变 FILLED 之后仍然 halted；另一个市场的新单被拒，错误是 `restored orders require reconciliation`。
- **影响**：每次下单后整个账户都处于 halt，同一场后面的阶梯单、其他市场的单都会被拒，直到一次恢复成功。它还是 P1-7 那次"成交后立即对账"的触发源。
- **修法**：删掉 348-351 行这个分支。磁盘恢复出来的 SUBMITTING 已在构造函数（104-117 行）转成 UNKNOWN 或 REJECTED，并由 120 行设同名 halt，所以这个分支在运行期只会误伤本进程在途的订单。保守做法是条件里加 `&& !this.submissions.has(candidate.clientOrderId)`。

### P1-9 `--max-rounds` 把不能交易的场也算进去，设 1 场一场都跑不了

- **位置**：`backend/engine/src/cli/platform.ts` 451-475 行 `scheduleMarketEnd`：任何一场只要结束就加进 `marketEndsProcessed`，再和 `maxRounds` 比较。779 行对 `selectedMarkets` 全量调度，其中包含 731-733 行从状态文件回灌的已结束旧市场。策略对中途启动的那一场（`now > startsAt`）直接标 `waiting_next_round`、不交易（`btc-reversal.ts` 421-425 行），但它结束时照样计数。
- **线上实证**：run `174516` 设 `maxRounds=3`。启动时 markets=[1790703900（中途）、1790691600（3.3 小时前就结束的旧场）]，1790703900 全场 0 阶段，只有 1790704200 交易了，然后 `round_limit_reached` 停止。**要 3 场，实际可交易 1 场。**
- **复现**（从 dist 抽出编译后的 `scheduleMarketEnd`，喂真实市场和发现时间）：`maxRounds=3` 停在 1790704500、可交易 1 场，与线上完全一致；`maxRounds=2` 可交易 0 场；`maxRounds=1` 启动即停、可交易 0 场；干净状态下 `maxRounds=1` 也是 0 场。
- **影响**：设 N 场，实际最多 N-1 场；每有一个回灌的旧市场再少 1 场。只会少跑，不会多跑。
- **修法**：`marketEndsProcessed` 保持不变（它负责去重和定时器事件），另加一个只计"本次运行能交易的场"的计数：`if (market.startsAt >= startedAt) roundsCounted += 1`，用它和 `maxRounds` 比较。

### P2-19 一个查不到的旧场会被永久回灌，每 15 秒重试一次，每次启动还吃掉一个场次计数

- **位置**：`backend/engine/src/cli/platform.ts` 78 行 `settlementRecoveryCandidates` 只把 `status==="confirmed"` 当终态，52 行只有时间下界没有上界；713-733 行据候选回灌 markets；902-909 行非终态结果进 pending 每轮重试。`live-settlement.ts` 290/440 行 `market()` 在建记录之前就抛 `settlement_market_not_found`，345 行捕获后不落任何记录。
- **线上实证**：上次运行的 46 条结算事件里有 39 条是场次 1790691600，全部 `unsupported / settlement_market_not_found`，从启动到停止约每 15 秒一条。
- **根因**（复核员补充）：这一场其实早在 run `141802` 里就 confirmed 过（"持仓已由平台自动赎回"），但那次走的是零余额分支，confirmed 没有落盘，就是 P1-5。落盘缺失导致它永远是候选，Gamma 又已经查不到它。
- **影响**：每次启动把死市场灌回 markets，每 15 秒一次 Gamma 请求和一条结算事件；和 P1-9 叠加，每次启动当场吃掉一个 `--max-rounds` 计数。没有资金风险，shutdown drain 不会被它拖住。
- **修法**：先修 P1-5（零余额分支也要写 `state.records` 并 `save()`）。`settlement_market_not_found` 时先查这组 token 的链上余额：全零就按 confirmed 落盘；非零才继续重试。不要只加年龄上界，那会丢掉仍有可赎回代币的场。

### P2-20 部分成交的浮点累加和场馆份额严格比较，订单还挂着时每次对账都失败

- **位置**：`backend/engine/src/platform/core.ts` 1171 行 `order.filledShares += fill.shares` 浮点累加；1309、1334 行和 `polymarket.ts` 881 行用 `!==` 严格比较本地与场馆的 `filledShares`。
- **线上实证**：状态文件里订单 `…c15:4` 的 `filledShares=101.94999999999999`，由两笔 CONFIRMED 成交 97.85 和 4.1 累加而来，场馆给的是 101.95。
- **复现**（真实 core + 真实快照解析）：两笔成交后用场馆快照 `size_matched="101.95"` 对账，抛 `apply missing fills before reconciliation`；对照组一笔 101.95 成交正常。线上那张单挂着的约 17.7 秒里每 5 秒一次恢复，全部失败，撤单后才停。
- **影响**：恢复必然失败，该市场留在 `failedRecoveryMarkets` 里被封；和 P1-8 叠加时全局 halt 解不开（同一条链见 P1-7）。
- **修法**：三处严格比较改为 `Math.abs(a - b) > EPS`（core 已定义 EPS=1e-8）。可另把 1171 行累加结果按 6 位小数取整，但单靠取整不够，已落盘的 101.94999999999999 仍会失败。

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

### P1-11 部署清理会删掉 config/ 下未纳入 git 的运行时密钥文件（当前潜伏，服务器上暂无该文件）

- **位置**：`scripts/deploy-reversal-release.py` 远端脚本 143-162 行 `cleanup_prefixes` 含 `'config/'`，会把 config/ 下所有不在 manifest 的文件并入 `obsolete`，264-265 行逐个 `unlink`；manifest 只含 git 跟踪文件。单元 `config/pm-system-dashboard-dublin.service` 19 行 `EnvironmentFile=-/root/pm-system/config/dashboard-secret.env` 引用它。
- **现状（已核实）**：服务器 `/root/pm-system/config/` 下**目前没有** `dashboard-secret.env`，只有 git 跟踪的那几个文件，所以当前每次部署没有东西可删，控制令牌来自 `account.json`。这条是潜伏风险，不是正在发生的故障。
- **触发**：一旦运维在服务器 `config/` 放任何未被 git 跟踪的文件（单元明确引用的 `dashboard-secret.env`，或其他运维文件），下一次成功部署就会删掉它；`before.tar.gz` 只在部署异常时回滚，成功部署不恢复。
- **影响**：该文件被永久删除；靠它提供的控制令牌等 env 丢失，控制面鉴权可能失效或回退到 `account.json` 里保存的那份。
- **修法**：清理白名单排除已知运行时/密钥文件，或把 config/ 清理限定到发布真正管理的扩展名/清单集合内。

### P1-5 场馆自动赎回在"无持仓"路径上被识别，却没有保存

- **位置**：`backend/engine/src/platform/live-settlement.ts`，无持仓分支里通过 `externalPayout` 识别到场馆已自动赎回并得到确认到账后，没有调用 `save()` 落盘。
- **现象**（审查员用真实 dist 复现、复核员确认）：确认到账的结果只存在于这次调用的返回值里；下一次结算轮询重新计算，返回不同的结果，已确认的到账被丢掉。
- **影响**：赢的场次结算状态来回变，和 P1-4 叠加，让已到账的赢利更难进统计。
- **修法**：无持仓路径识别出外部赎回后，与主路径一样写入 `state.records` 并 `save()`。

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

### P1-2 双 socket 合并会丢掉真实的价格变化，触发信号被延后 — 已修复 `614a747`

- **原问题**：`runPolymarketFeed` 的 `book()` 整帧判断"两边时间都不倒退"，socket B 先推进 DOWN 后，socket A 带着真实 UP 变化、但 DOWN 仍是旧时间的一帧被整帧丢掉。基线 UP 0.60 / DOWN 0.40，B 送 DOWN→0.31，A 送 UP→0.68（穿过 0.67 触发价），转发给策略的只有 `[0.6,0.4]、[0.6,0.31]`。
- **修法**：改成按边合并：各自保留两个 socket 里最新的 UP 和最新的 DOWN，任一边前进就转发。合并后的一对按实际携带的两边重算时间：`sourceAt` 取较新的一边，`expiresAt` 和 `marketAgeMs` 跟较旧的一边，陈旧的一边不会借用新鲜一边的时钟。
- **验证**：`backend/engine/scripts/check-redundant-feed.mjs` 新增 3d（本条场景），UP 0.68 立即转发并与 B 的 DOWN 0.31 配对。8 项检查全过；8 种故意改坏（包括恢复旧的整帧拒绝、把过期改成跟较新的一边）全部被抓到。已部署，采集器 7 币种健康、未重启。
