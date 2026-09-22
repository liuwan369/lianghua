# 前端数据模型

页面消费统一 ViewModel，后端原始 DTO 由 adapter 转换。

## 核心模型

### AppStatusViewModel

`{ mode, version, source, asOf, stale, error }`

### MarketAssetViewModel

`{ assetId, symbol, name, marketId, roundId, cycle: "5m", startAt, endAt, yes, no, volume, liquidity, quoteAt, eligibility, enabled, effectiveRoundId, runtimeState }`

`yes/no` 统一表示 YES/NO；自动交易页面不能再用没有映射说明的 UP/DOWN。

### MarketPoolViewModel

`{ assets, desiredIds, currentIds, nextRoundIds, updatedAt, source }`

desired 是用户选择，current/next 是服务器确认结果。停用当前币种只影响下一场，不删除当前场次订单。

### OrderBookViewModel

`{ marketId, roundId, yes: { bids, asks }, no: { bids, asks }, sequence, sourceAt, expiresAt, stale }`

五档是独立的高频快照；不能用定时器正弦波生成。

### RoundPositionViewModel

`{ marketId, roundId, stage, confirmations, yesShares, noShares, averagePrice, occupiedUsd, outcomePnl, updatedAt }`

### StrategyConfigViewModel

`{ strategyId, revision, triggerPrice, confirmationPrice, maxBuyPrice, stageShares, roundBudgetUsd, totalBudgetUsd, dailyLossUsd, durationMinutes, effectiveRoundId }`

价格单位固定为 USD 概率（0 到 1）或固定为 cents，二者不能混用。当前设计稿输入是 cents、预览显示 USD，接入时必须在 adapter 统一成一种。

### SystemHealthViewModel / AccountViewModel / ActivityEventViewModel

系统健康包含行情节点、控制台、采集、交易、账本投影、CPU、内存、磁盘和负载。账户只返回钱包摘要、配置状态和最近检查结果，不返回私钥。事件必须有 id、time、kind、marketId、roundId、severity 和 message。

## Ledger response metadata

账本、运行状态和诊断响应必须带 `source`、`asOf`、`stale`、`error`。账本投影进程负责从运行日志生成订单、成交、结算、持仓和统计；HTTP 请求只读 SQLite/原子快照，不触碰实时下单链路。`stale` 或 `error` 时保留上一次有效字段，未知金额和盈亏使用 `null`。

## 页面状态

每个模块都要能表达 `loading`、`ready`、`stale`、`empty`、`error`、`unavailable`。错误时保留最后成功快照，同时在标题处显示来源和更新时间。

## Store 分片

浏览器中的 `PolyPreviewStore` 不存放秘密，只保存可展示状态：

- `marketCatalog`：支持币种、当前场次、报价元数据、选中币种。
- `marketPool`：desired/current/nextRound 三种运行池状态。
- `runtime`：运行状态、来源、过期标记和按市场摘要。
- `strategy`、`account`、`diagnostics`、`metrics`、`events`：各自独立更新。

一个接口响应只更新对应分片；行情帧不会触发账户、统计或整页重绘。
