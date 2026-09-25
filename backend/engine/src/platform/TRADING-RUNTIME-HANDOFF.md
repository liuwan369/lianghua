# BTC 五分钟反转交易运行对接

本文档只描述 `codex/trading-runtime` 负责的运行层，以及它和行情底座、控制面、账本之间的接缝。策略始终只有 BTC 五分钟反转一套；旧做市、paper、回测和研究链路不属于本运行时。

## 运行链路

```text
codex/market-data
  findFiveMinuteMarket("btc", { allowCollectorFallback: false, directOnly: true })
  runPolymarketFeed(..., { marketId, roundId })
      -> FeedEvent(kind="book", snapshot)
      -> TradingPlatform.ingestSnapshot(snapshot)
      -> BTCReversalStrategy.onEvent(book)
      -> Core submit/cancel/fill/recovery
      -> journal + durable state + settlement
```

行情快照必须是同一 `marketId + roundId` 的完整 YES/NO paired snapshot。运行时只接受经过身份、时间戳、过期时间、sequence、sourceAt、价格和 book health 校验的快照。行情失败时保留展示用的最后快照，但关闭执行门控，不清零价格，也不产生新订单。

## 已接受快照状态接口

`TradingPlatform.market.snapshots()` 是低频状态读取接口，返回经过 freshness gate
接受、并同时发送给策略的 paired snapshot。CLI 会将它放入
`platform_status.runtime.snapshots`，并在状态 JSON 顶层输出 `snapshots`。每项保留完整
的 `marketId`、`roundId`、`sequence`、`sourceAt`、`expiresAt`，以及 `YES/NO` 的
`assetId`、best bid/ask、size、排序后的五档 `bids/asks`、各自时间戳、过期时间和
sequence。`books` 只是单 token 兼容视图，不能用来重新拼 paired snapshot。

`TradingPlatform.ingestBooks()` 和没有身份的旧 `book` 事件仍只属于旧平台适配兼容面，
不会产生现代 accepted snapshot，也不能作为 BTC 实盘策略的行情入口。生产运行必须由
`codex/market-data` 接线到 identity-aware `runPolymarketFeed` 和 `FeedQueue`；交易运行时
自身的旧兼容入口不能替代该接线。

策略回调与状态接口通过上述身份、sequence、时间戳、过期时间和两边 asset/depth
字段确认来自同一个已接受快照。平台在 API 边界会 clone 数据，因此这里的“同一个”
指同一份已接受数据和序列，不是共享可变 JavaScript 引用。

## 接入要求

行情底座必须提供以下能力：

- `findFiveMinuteMarket("btc", { now, allowCollectorFallback: false, directOnly: true, signal })`。
- 返回的 `MarketInfo` 必须原样保留 `marketId` 和明确的 `roundId`；当前 BTC 五分钟 roundId 是发现结果中的 Unix 起始时间字符串，例如 `"1800000000"`。运行时不从当前时间或 slug 猜轮次。
- `runPolymarketFeed(sink, upToken, downToken, market.end, { marketId, roundId })`。
- `FeedEvent.kind === "book"` 中的 `snapshot`，字段为 `marketId`、`roundId`、`sequence`、`sourceAt`、`expiresAt`、`YES`、`NO`。
- YES/NO 的 `assetId`、`bid`、`ask`、`bidSize`、`askSize`、`bids`、`asks`、`sourceAt`、`expiresAt`、`sequence`。
- 若行情底座提供 L2 深度时钟，YES/NO 还可带 `depthSourceAt` 和 `depthExpiresAt`（Unix 秒）。它们必须来自原始 L2 基线，不能用较快的 best bid/ask 时间替代；缺失或过期时，`market.depth()` 不可用，但 paired best quote 仍按普通快照门控。
- 断线后发送 `market_feed_disconnected` 或 `stale_book`，并在恢复后等待新的完整 YES/NO paired snapshot。

运行时不再回退到旧的 `findMarket` 列表发现路径。错误地只部署交易运行分支时，应在启动或发现阶段失败，而不能用缺少 `marketId/roundId` 的旧行情继续交易。

## 交易运行负责的内容

- BTC 五分钟反转阶段、跨价判断和参数化配置。
- 单场和总资金预留、同方向限制、阶段顺序和订单意图。
- `clientOrderId` 经济订单幂等、提交超时恢复和 venue order 对账。
- 撤单、停止时活动订单处理、迟到成交和资金释放等待。
- User WebSocket 成交、重复成交和 `tradeId` 冲突保护。
- 持久化订单/成交/策略状态，重启恢复和场次切换隔离。
- 场次结束后的结算触发和结算状态持久化。

运行时事件也携带身份：订单和成交包含 `marketId/roundId`，结算请求和结果包含 `marketId/roundId`。账本/API 应原样保存这些字段；缺少身份时保持空值或拒绝需要身份的操作，不能根据 slug 或接收时间回填。

CLI journal 的 `order`、`fill` 和 `platform_settlement` 事件直接写入
`market_id`、`round_id` 和 `created_at`。订单/成交优先使用运行时事件顶层身份，
结算优先使用结算结果身份；slug 只用于展示，不是身份来源。

## 启动前结算凭据检查

`account-check` 的只读 JSON 必须包含 `settlement_credentials_ready`。它只返回 `true`、`false` 或错误时的 `null`，不返回私钥、API Key、Secret 或 Passphrase。

- EOA 直接链上赎回：Owner signer 与钱包地址匹配即可，不要求 Builder/Relayer 凭据。
- Deposit Wallet：Owner signer 必须匹配，并且 Builder 三元凭据或 Relayer API Key 与地址必须完整。
- 未知合约钱包、Owner 不匹配、凭据缺失：返回 `false`。
- RPC 或钱包类型无法读取：保留 `null`，不能猜测为已就绪。

实盘策略启动时会重复执行同一套非秘密检查；结算凭据不是等到五分钟结束才第一次检查。检查未通过时平台启动失败，避免先成交后才发现 redeem 不能提交。最终到账仍必须等待链上回执和余额核对，`settlement_credentials_ready=true` 只代表凭据和钱包身份已具备提交条件。

策略参数保存在 `BtcReversalConfig`，前端或控制面应传入配置文件；不要在前端复制一套阈值或阶段计算。

可配置字段包括：

- `instanceId`、`revision`：策略实例和配置版本身份。
- `triggerPrice`、`confirmationPrice`、`maxBuyPrice`：跨价、确认和最高买入价。
- `stageShares`、`maxStages`：阶段数量和每阶段份额。
- `roundBudgetUsd`、`totalBudgetUsd`、`dailyLossUsd`：单场、总资金和日亏损限制。
- `maxQuoteAgeSeconds`、`maxQuoteSkewSeconds`：行情最大年龄和 YES/NO 时间偏差。

代码中的默认配置目前是 `triggerPrice=0.67`、`confirmationPrice=0.70`、`maxBuyPrice=0.70`、`stageShares=[5,18,54,130]`、`maxStages=4`、`maxQuoteAgeSeconds=2`、`maxQuoteSkewSeconds=1.5`。这些是缺少外部配置时的启动默认值，不是写死的交易条件；控制面提交的有效配置会在启动时校验并持久化到场次状态。BTC 五分钟周期属于策略定义；策略内部的 UP/DOWN 方向标签来自快照 YES/NO 的 token 映射，不能通过前端随意改成其他资产或另一套行情字段。

## 已完成的自动验证

- `npm run typecheck`
- `npm run build`
- 真实 feed 函数带默认第五参数的启动接缝、无顶层 underlying asset 的 paired snapshot、断线后旧帧拒绝和可选 L2 深度过期门控。
- 服务器只读行情探针已验证 paired snapshot、五档 YES/NO、sequence/sourceAt 无回退和断线恢复；交易运行时仍需在集成分支部署后再做服务器验证。
- BTC 行情探针验证了 paired snapshots、五档 YES/NO、sequence/sourceAt 无回退和断线恢复。

行情模块的 Node 24 模块 mock 探针需要显式启用测试 mock：

```text
node --experimental-test-module-mocks --test src/live/feeds/polymarket.test.mjs
```

类型检查、构建和行情探针不能代替真实账户下的 CLOB 订单、User WebSocket 成交和链上结算验收。

## 尚未完成的真实验收

以下事项必须在服务器注入交易账户配置后完成：

- 真实 CLOB 下单 ACK，以及超时重试仍保持单一 `clientOrderId`。
- 真实撤单 ACK、停止撤单和资金释放。
- User WebSocket 成交、部分成交、重复成交和重连补偿。
- 真实账户资金预留、释放和账户对账。
- 使用同一状态文件重启并恢复真实订单、成交和策略阶段。
- 旧 round 到新 round 的连续运行隔离。
- 有真实获胜持仓时的 redeem 和链上回执。

账户密钥由 `backend/control-plane` 注入 live 子进程；不要把私钥、Token 或 Builder/Relayer Secret 写入本仓库或日志。交易运行消费 `POLYMARKET_WALLET_ADDRESS`/`POLY_FUNDER` 和 `POLYMARKET_OWNER_PRIVATE_KEY`，结算还需要受支持的 Builder 或 Relayer 凭据。

## 下游模块待办与回接条件

### 行情底座（`codex/market-data`）

- [ ] 生成包含最新行情代码和本分支交易运行代码的部署提交或集成分支。
- [ ] 在服务器部署该组合提交，并记录实际 `marketId/roundId`。
- [ ] 提供一段包含断线恢复和场次边界的 paired snapshot 日志，确认恢复后没有使用旧快照。

当前服务器只读探针所在分支为 `codex/market-data`；尚未启动交易运行时，也没有提交真实订单。

行情底座完成以上事项后，交易运行会话继续做真实账户下单、撤单和成交验收。

### 控制面 / 部署模块

- [ ] 通过受保护的账户配置入口注入 Owner signer、funder/wallet 和必要的 RPC。
- [ ] 开启实盘解锁并启动 `dist/cli/platform.js --live`，不得把秘密写入命令行、日志或 Git。
- [ ] 提供只包含字段存在性、钱包地址和 signer 地址匹配结果的非敏感启动证据。

控制面完成后，交易运行会话负责检查真实订单生命周期和重启恢复。

### 账本 / 结算模块

- [ ] 提供成交、费用、资金变动和链上回执的真实查询结果。
- [ ] 确认结算查询和 redeem 使用同一个 `marketId + roundId`，不跨轮次读取。

账本和结算完成后，交易运行会话负责把结果与本地订单、成交和持仓状态对账。

## 交接输出

每次真实验收只需回传：实际 `marketId/roundId`、接受/拒绝行情及原因、过期行情是否阻断下单、断线后是否等待新 paired snapshot、场次切换是否串数据、订单/撤单/成交/结算证据，以及是否提交过真实订单。不要回传任何秘密值。
