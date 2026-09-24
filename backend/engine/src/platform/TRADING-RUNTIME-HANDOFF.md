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

## 接入要求

行情底座必须提供以下能力：

- `findFiveMinuteMarket("btc", { now, allowCollectorFallback: false, directOnly: true, signal })`。
- 返回的 `MarketInfo` 必须原样保留 `marketId` 和明确的 `roundId`；当前 BTC 五分钟 roundId 是发现结果中的 Unix 起始时间字符串，例如 `"1800000000"`。运行时不从当前时间或 slug 猜轮次。
- `runPolymarketFeed(sink, upToken, downToken, market.end, { marketId, roundId })`。
- `FeedEvent.kind === "book"` 中的 `snapshot`，字段为 `marketId`、`roundId`、`sequence`、`sourceAt`、`expiresAt`、`YES`、`NO`。
- YES/NO 的 `assetId`、`bid`、`ask`、`bidSize`、`askSize`、`bids`、`asks`、`sourceAt`、`expiresAt`、`sequence`。
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
- `snapshot-gate.test.ts`
- `runtime-snapshot.test.ts`
- `runtime-lifecycle.test.ts`
- 服务器临时组合最新行情底座和交易运行代码后，行情测试与交易运行测试通过。
- BTC 行情探针验证了 paired snapshots、五档 YES/NO、sequence/sourceAt 无回退和断线恢复。

这些测试证明代码契约和门控逻辑，不能代替真实账户下的 CLOB 订单、User WebSocket 成交和链上结算验收。

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
