# L0 实时行情输入 — 现状

这一层给策略提供"此刻能不能交易、盘口是什么"。是重构的最底层，上面所有层都依赖它的正确性。本文件记录**已经完成、经过验证的部分**，以及**待确认的问题**。

核对方式：读代码（`file:line`）+ 服务器实测（都柏林节点 `market-snapshot.json` 与运行中引擎）。核对时间 2026-09-29，版本 `123d942`。

引擎交易用的是它**自己进程内的行情 WS**（`runPolymarketFeed`），采集器进程（`market-snapshot.js`）是另一套同源代码，只喂前端展示和"发现兜底"。两者跑同一个 feed 实现，所以下面的行为对两者都成立。

---

## 1. 输出的数据结构

一帧行情的最终产物是一个**配对快照** `BookSnapshot`（[feeds/index.ts:5](backend/engine/src/live/feeds/index.ts#L5)），运行时侧对应 `MarketBookSnapshot`（[contracts.ts:70](backend/engine/src/platform/contracts.ts#L70)）。核心字段（服务器实盘取到的真实值）：

```
marketId  0xbd3ebdcdc2...c8474      条件 ID，每场都换
roundId   "1790705400"             5 分钟起始 Unix 秒，必是 300 的倍数
sequence  2230                     本场内单调递增；换场归 0
sourceAt  1790705556.71            两边交易所时间戳里较新的一个（秒）
expiresAt 1790705558.71            = min(场次结束, 较旧一边 + 2s)
YES / NO  见下                     配对的两个结果
```

`YES` / `NO` 各是一个 `MarketAssetSnapshot`（[feeds/index.ts:54](backend/engine/src/live/feeds/index.ts#L54)），实盘真实值：

```
YES: assetId 78089...790971  bid 0.62  ask 0.63
     sourceAt 1790705556.71  expiresAt ...558.71  sequence 2230
     depthSourceAt / depthExpiresAt  L2 深度自己的时钟（与顶档分开）
NO:  assetId 16758...933930  bid 0.37  ask 0.38   （其余同构）
```

- **YES=Up，NO=Down**：`parseMarket` 用 outcomes 标签 `up`/`yes` → YES，`down`/`no` → NO 匹配 token（[discovery.ts:111](backend/engine/src/live/discovery.ts#L111)）。
- **顶档价与深度分离**：`bid/ask` 来自快速 BBO 通道；`bidSize/askSize/bids/asks` 只有在 L2 深度顶档与 BBO **完全一致**时才带上，否则置空（[polymarket.ts:723](backend/engine/src/live/feeds/polymarket.ts#L723)）。实盘看到 `bidSize/askSize` 为 `null` 就是这个原因——顶档价可信，深度暂不匹配就不发。
- **两个时钟**：`sourceAt` 是顶档报价的交易所时钟，`depthSourceAt` 是 L2 深度的交易所时钟，各自独立过期。这是刻意的——快的顶档不能让慢的深度"蹭"上新鲜度。

## 2. 如何订阅 / 读取

**订阅（引擎内，热路径）** `runPolymarketFeed(sink, upToken, downToken, deadline, identity)`（[polymarket.ts:437](backend/engine/src/live/feeds/polymarket.ts#L437)）：
- WS `wss://ws-subscriptions-clob.polymarket.com/ws/market`（[polymarket.ts:11](backend/engine/src/live/feeds/polymarket.ts#L11)）。
- 订阅报文 `{ assets_ids: [upToken, downToken], type: "market", custom_feature_enabled: true }`（[polymarket.ts:505](backend/engine/src/live/feeds/polymarket.ts#L505)）——只订这两个结果 token。
- 每 5 秒发一次 `PING`（[polymarket.ts:555](backend/engine/src/live/feeds/polymarket.ts#L555)），`PONG` 只作传输保活，不重置任何数据看门狗。
- 消费方式：feed 把每帧 `sink({kind:"book", snapshot})` 推进 `FeedQueue`（[feeds/index.ts:216](backend/engine/src/live/feeds/index.ts#L216)），队列**每个市场只保留最新一帧**（旧帧被覆盖），消费循环 `tryPop` 优先弹状态事件、再弹最新盘口（[feeds/index.ts:298](backend/engine/src/live/feeds/index.ts#L298)）。这样慢消费者不会堆积陈旧报价。

**读取（前端 / 兜底）**：采集器把配对快照写进 `data/dashboard/market-snapshot.json`，每 250ms 原子替换，`--stale-after-ms 2000`。前端轮询、引擎发现失败时兜底读它。实盘 `collector_online: true`。

## 3. 消息类型 → 盘口

`ws.on("message")`（[polymarket.ts:586](backend/engine/src/live/feeds/polymarket.ts#L586)）识别：
- `book` / 初始全量帧 → `OrderBook.applySnapshot`（清空重建，过滤 `0<p<1`、`size>0`，[orderbook.ts:16](backend/engine/src/live/orderbook.ts#L16)）。
- `price_change` 增量 → `OrderBook.applyChange`（`size>0` 写入、`<=0` 删除，增量维护最优价，[orderbook.ts:26](backend/engine/src/live/orderbook.ts#L26)）。
- `best_bid_ask` + `price_change` 里的价位 → 快速 BBO 通道 `bestBidAskChanges`（[polymarket.ts:260](backend/engine/src/live/feeds/polymarket.ts#L260)）。
- `tick_size_change` → `{kind:"tickSize"}`；`last_trade_price` → `{kind:"marketTrade"}`。

## 4. sequence 与时间戳

- **sequence**：本场 feed 实例内 `++sequence`，起点 `sequenceBase`（引擎不传，默认 0），所以**每场从头计数**（[polymarket.ts:457](backend/engine/src/live/feeds/polymarket.ts#L457)、[779](backend/engine/src/live/feeds/polymarket.ts#L779)）。换场归零是预期行为——新场是新的 feed 进程，别当成回归 bug。消费端只在**同一 (marketId, roundId)** 内要求 sequence 严格递增（见 §6）。
- **时间戳三层**：`exchangeMs`（交易所时钟，排序与过期的基准）、`receivedAtUnix`（本机收到）、`processedAtMonoMs`（处理完）。`marketAgeMs = receivedAt - exchange`，取两边较差的一边（[polymarket.ts:826](backend/engine/src/live/feeds/polymarket.ts#L826)）。
- **未来时钟过滤**：`exchangeMs > receivedAt + 1000ms` 的帧直接丢（`PM_WS_MAX_CLOCK_SKEW_MS`，[polymarket.ts:611](backend/engine/src/live/feeds/polymarket.ts#L611)）。
- **时间戳不倒退**：跨场保留 `acceptedUp/DownSourceMs` 水位，重连后被重放的旧帧不能产生新序号（[polymarket.ts:464](backend/engine/src/live/feeds/polymarket.ts#L464)）。

## 5. 过期判断

- **报价过期** `expiresAt = min(场次结束, (较旧一边 exchangeMs + 2000ms))`（[polymarket.ts:780](backend/engine/src/live/feeds/polymarket.ts#L780)）。策略侧再要求 `expiresAt > now` 且 `marketAgeMs <= 2s`（[btc-reversal.ts:449](backend/engine/src/strategies/btc-reversal.ts#L449)）。
- **深度过期** `depthExpiresAt` 用 L2 自己的时钟单独算，与顶档分开（[polymarket.ts:791](backend/engine/src/live/feeds/polymarket.ts#L791)）。`FeedQueue` 弹出时会剥掉已过期的深度但保留仍新鲜的顶档（`omitExpiredDepth`，[feeds/index.ts:145](backend/engine/src/live/feeds/index.ts#L145)）。
- **发布门**：只有顶档变化 / 距上次 250ms / 健康翻转 / 深度可用性翻转，才发一帧（[polymarket.ts:774](backend/engine/src/live/feeds/polymarket.ts#L774)），避免刷屏。

## 6. 断线与过期数据处理

**看门狗**（每秒跑一次，[polymarket.ts:569](backend/engine/src/live/feeds/polymarket.ts#L569)），三种断线原因（`watchdogReason`，[polymarket.ts:47](backend/engine/src/live/feeds/polymarket.ts#L47)）：
- `message_timeout` 15s：完全没有可用行情事件 → socket 假活，重连。
- `bilateral_quote_timeout` 5s：有完整盘口但某一边静默 5 秒。实盘触发过 12 次，**全部落在已结束或未开始的场次**（那时场馆本就不推报价），交易中的场次从未触发。门槛不需要改（见 §6.1）。
- `source_age_timeout` 5s：帧还在来，但交易所时间戳持续陈旧（>2s）5 秒。

命中任一原因：`hasCompleteBook=false` → `setConnected(false)` → `ws.terminate()`，然后**全指数退避重连**：`250ms × 2^n` 上限 30s，带满抖动（[polymarket.ts:342](backend/engine/src/live/feeds/polymarket.ts#L342)）；连续稳定 30 秒后重连计数归零（[polymarket.ts:766](backend/engine/src/live/feeds/polymarket.ts#L766)）。

**断线时的旧数据**：每个 socket 的本地状态（快速顶档、已发布快照、深度）都在循环内重建，重连后丢弃，**不重发最后一帧**。跨场只保留交易所时间戳水位。

**消费端拒绝陈旧帧**（`snapshot-gate.ts`）：断线会发 `bookStatus{healthy:false}`，消费端把 `snapshotFreshAfter[场次]` 设成断线时刻，之后**只接收 `receivedAtUnix >= 断线时刻` 的帧**（[polymarket.ts:551](backend/engine/src/platform/polymarket.ts#L551)），断线前排在队列里的旧帧一律 `awaiting_fresh_snapshot` 拒掉。`validateMarketSnapshot`（[snapshot-gate.ts:71](backend/engine/src/platform/snapshot-gate.ts#L71)）逐条校验：marketId/roundId/assetId 身份、场次未结束、健康、sequence 有效且不回退、未过期、YES/NO 报价合法、深度合法、sourceAt 不回退。拒绝原因见 `SnapshotRejectReason`（13 种，[snapshot-gate.ts:3](backend/engine/src/platform/snapshot-gate.ts#L3)）。

**策略侧**：收到 `market_feed_unhealthy` / `account_recovery_started` 就清掉该场次的参考基线（[btc-reversal.ts](backend/engine/src/strategies/btc-reversal.ts)），断线期间不交易，恢复后重新建立基线再等跨价——**断线期间出现的反转会被跳过**。所以断线越少越值钱，见 §6.1。

### 6.1 场馆主动断开（1013）与双连接

**真正在交易场次里断线的，是场馆主动关 socket**，不是我们的看门狗。把实盘所有断线分类：

| 来源 | 次数 | 落在哪 |
|---|---|---|
| 我们的看门狗 `bilateral_quote_timeout` | 12 | 全在已结束/未开始的场次，不花钱 |
| **场馆主动关闭** | **11** | **全在交易中的场次**，最早开盘第 41 秒 |

场馆给的关闭码是 **`1013 slow consumer: send buffer full`**。实测（2026-09-29，都柏林）：
- 同一场开 4 个独立进程各一条连接，10 分钟里被关 6 次、**各断各的**（只有一对在 3 秒内撞上），1 号连接一次没断。说明不是场馆整体或网络整体故障，而是**场馆每条连接的发送缓冲各自在行情活跃时被挤满**。
- 服务器不忙（2 核、负载 0.4），而且空闲的纯接收进程也会被关，所以大概率不是我们读得慢。
- 场馆推送量：每秒 600–1200 条消息、370–800 KB。

**对策：每场开 2 条独立连接，合并成一路**（`runPolymarketFeed` 外包一层，[polymarket.ts](backend/engine/src/live/feeds/polymarket.ts) `PM_WS_REDUNDANT_SOCKETS = 2`；原单连接逻辑改名 `runSingleSocketFeed`，一行未改）：
- **盘口**：只转发在至少一边带来更新交易所时间、且没有一边倒退的帧——两条连接收到同一事件时丢掉后到的那份，慢连接迟到的旧帧也丢掉。转发时重新编号，保证 `sequence` 跨两条连接严格连续（每条连接各自从 0 计数，直接转发会回退）。
- **状态**：任一连接在线即 connected，任一连接有新鲜完整盘口即 healthy。**单条连接重连不再传到消费端**，策略不会清基线。两条都断才报 `transport_disconnected`。
- **tickSize / 成交**：按交易所时间和成交字段去重，只转发一次。
- 对外接口不变，引擎和采集器两个调用方都不用改。

**验证**：[check-redundant-feed.mjs](backend/engine/scripts/check-redundant-feed.mjs) 用本地 WebSocket 服务驱动真实代码，7 项全过：单条断不报断线且盘口继续、两条都断才报断线、无重复、sequence 连续、两条连接不同步时编号仍连续、慢连接的旧帧被丢、消费端校验全部接受、stop 关掉所有连接。**6 种故意改坏的写法全部被测试抓到**。服务器上同场 A/B 10 分钟：单连接在交易中场次断 1 次（开盘 238.9 秒），双连接 0 次。

## 7. 场次切换（重点）

引擎**不"切换"，而是叠加**：新场提前接上、旧场自然过期清理，两场在边界附近并存。

1. **发现**：`findFiveMinuteMarket`（[discovery.ts:239](backend/engine/src/live/discovery.ts#L239)）按 `floor(now/300)*300` 算 slug，先查采集器兜底、再直查 Gamma `?slug=`，边界预热时 `directOnly` 只探确定的下一个 slug。`roundId === String(startsAt)` 且 `endsAt-startsAt===300` 是硬校验（[polymarket.ts:99](backend/engine/src/platform/polymarket.ts#L99)、[112](backend/engine/src/platform/polymarket.ts#L112)）。
2. **预热**：引擎在边界前 **10 秒**开始，每 250ms 探一次下一个 slug 直到发现（`scheduleBoundaryDiscovery`，[cli/platform.ts:807](backend/engine/src/cli/platform.ts#L807)）；稳态每 15 秒一轮发现。采集器更早，边界前 **75 秒**开始预热（因为旧场盘口约在边界前 40 秒就转陈旧，[market-snapshot.ts:15](backend/engine/src/cli/market-snapshot.ts#L15)）。
3. **接上新场**：`addMarkets` → `startMarket`（[polymarket.ts:940](backend/engine/src/platform/polymarket.ts#L940)）：`warmMarket` 预热签名与元数据 → 建该场 `FeedQueue` → 起该场 book WS（deadline = 场次结束）→ 起用户 feed。新场在其行情报健康后即可下单。
4. **旧场停用**：`isActiveMarket` 要求 `startsAt <= now < endsAt`（[polymarket.ts:40](backend/engine/src/platform/polymarket.ts#L40)），过界后快照被 `round_ended` 拒；`cleanupExpiredFeeds` 每 5 秒把 `endsAt<=now` 的 book feed 停掉、清健康位，待无挂单/成交需要后停用户 feed 并回收队列（[polymarket.ts:1061](backend/engine/src/platform/polymarket.ts#L1061)）。
5. **绑定校验**：控制面启动时传 `--expected-market-id/--expected-round-id`，`assertInitialMarketIdentity` 要求首个发现的市场精确匹配，否则中止（[cli/platform.ts:288](backend/engine/src/cli/platform.ts#L288)）。
6. **策略侧场次纪律**：只在 `now <= startsAt` 时接一场（[btc-reversal.ts:415](backend/engine/src/strategies/btc-reversal.ts#L415)）——**中途启动会等下一场**。配置每秒热加载，但**下一场开始才生效**。

## 8. 已完成 vs 待确认

**已完成并验证**：数据结构、订阅/读取、消息→盘口映射、sequence（换场归零正确）、三层时间戳与未来时钟过滤、报价/深度双时钟过期、发布门、看门狗三原因 + 全抖动退避、消费端 `snapshotFreshAfter` 拒绝断线前旧帧、13 种拒绝原因校验、场次叠加式切换与硬身份校验。服务器实盘取到的快照字段与代码一致。

**已解决**：~~`bilateral_quote_timeout` 5 秒是否过严~~ —— 不严。它从未在交易中场次触发；真正的断线来源是场馆 1013 主动关闭，已用双连接处理（§6.1）。

**待确认**：
1. **行情单边缺失 `incomplete_book`**：A/B 里两路都在交易中场次出现过（开盘 171、254 秒），并且持续到场次结束。这是场馆本身某一边没有顶档，不是连接问题，双连接也修不了。要查的是：这时策略停着是对的（没有报价就不该交易），还是有一边其实可交易却被整场挡住。
2. 双连接的实盘样本只有 10 分钟、1 次对比。上线后要继续看交易中场次的断线次数。
3. `runPolymarketFeed` 未传 `sequenceBase`，换场 sequence 从 0 起；确认这在多币种并发下不会造成跨场 key 混淆（`FeedQueue` 用 token 对做 key，理论上安全，待实测）。
