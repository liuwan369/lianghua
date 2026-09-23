# 前端数据模型

页面消费统一 ViewModel，后端原始 DTO 由 adapter 转换。

## 核心模型

### AppStatusViewModel

`{ mode, version, source, asOf, stale, error }`

### MarketAssetViewModel

`{ assetId, symbol, name, marketId, roundId, cycle: "5m", startAt, endAt, yesBid, yesAsk, noBid, noAsk, volume, liquidity, quoteAt, enabled, current, nextRound }`

市场目录的报价字段统一使用 `yesBid/yesAsk/noBid/noAsk`。页面显示层可以把 `yes/no` 作为方向标签，但不能直接使用没有映射说明的 UP/DOWN 字段。

生产环境的 `marketId` 和 `roundId` 都是必填的服务器标识。旧 `/api/v1/markets` 若只返回市场 ID 而没有轮次 ID，adapter 仍可展示目录和报价，但必须把 `roundId` 保持为空，并阻止依赖轮次的持仓、订单查询。页面需要明确显示“当前轮次标识待后端提供”。

### MarketPoolViewModel

`{ desiredIds, currentIds, nextRoundIds, effectiveRoundId, updatedAt, source, stale }`

desired 是用户选择，current/next 是服务器确认结果。停用当前币种只影响下一场，不删除当前场次订单。

### OrderBookViewModel

`{ marketId, roundId, yes: { bids, asks }, no: { bids, asks }, sequence, sourceAt, expiresAt, stale }`

五档是独立的高频快照；不能用定时器或演示数值生成。行情帧只允许更新相同 `marketId + roundId` 的盘口节点。

### RoundPositionViewModel

`{ marketId, roundId, stage, confirmations, yesShares, noShares, averagePrice, occupiedUsd, outcomePnl, updatedAt }`

### StrategyConfigViewModel

`{ strategyId, revision, triggerPrice, confirmationPrice, maxBuyPrice, stageShares, roundBudgetUsd, totalBudgetUsd, dailyLossUsd, durationMinutes, effectiveRoundId }`

价格单位固定为 USD 概率（0 到 1）或固定为 cents，二者不能混用。当前设计稿输入是 cents、预览显示 USD，接入时必须在 adapter 统一成一种。

### SystemHealthViewModel / AccountViewModel / ActivityEventViewModel

系统健康包含行情节点、控制台、采集、交易、账本投影、CPU、内存、磁盘和负载。账户只返回钱包摘要、配置状态和最近检查结果，不返回私钥。事件必须有 id、time、kind、marketId、roundId、severity 和 message。

账户 ViewModel 的真实数据源是服务器账户快照、账户状态和账户检查接口。当前前端只完成 adapter 和展示层，尚未连接真实后端账户或交易环境；因此没有快照时应显示 `unavailable`，请求失败后保留上一次快照并显示 `stale`。

## 页面状态

每个模块都要能表达 `loading`、`ready`、`stale`、`empty`、`error`、`unavailable`。错误时保留最后成功快照，同时在标题处显示来源和更新时间。

## Store 分片

浏览器中的 `PolyPreviewStore` 不存放秘密，只保存可展示状态：

- `marketCatalog`：支持币种、当前场次、报价元数据、选中币种。
- `marketPool`：desired/current/nextRound 三种运行池状态。
- `runtime`：运行状态、来源、过期标记和按市场摘要。
- `strategy`、`account`、`diagnostics`、`metrics`、`events`：各自独立更新。

一个接口响应只更新对应分片；行情帧不会触发账户、统计或整页重绘。
