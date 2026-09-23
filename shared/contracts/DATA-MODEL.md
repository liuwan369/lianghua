# 前端数据模型

页面消费统一 ViewModel，后端原始 DTO 由 adapter 转换。

当前只支持 `assetId="btc"` 和 `cycle="5m"`。`marketId` 为 Polymarket conditionId，未知时是 `null`，不能填场次 slug；`roundId` 为运行时明确提供的 BTC 五分钟场次起始 Unix 边界字符串，未知时是 `null`，不能从 slug 或当前时间推导。现代 DTO 的所有规范时间字段统一为 UTC Unix 秒数或 `null`，旧接口及原始兼容字段保留原格式。

交易运行时是市场身份的唯一来源。账本投影按 `platform_status.runtime.markets` 保存 `marketId -> roundId` 映射，并把它应用到缺少身份字段的 `order`、`fill` 和 `platform_settlement` 事件。`roundId` 必须由运行时明确提供；`market.name`/`market_slug` 只作显示和兼容别名，不能代替 roundId。映射缺失时保留 `null`，不按时间戳推断轮次；事件到达顺序改变时，后到的运行状态可以回填之前的投影。重启后的成交汇总以账户范围内的 `trade_id + order_id` 作为经济成交身份，不能只依赖单次运行的 `event_id`，不同账户始终隔离。

## 核心模型

### AppStatusViewModel

`{ schemaVersion, mode, version, source, asOf, stale, error }`

### MarketAssetViewModel

`{ assetId, symbol, name, marketId, roundId, cycle: "5m", startAt, endAt, yes, no, volume, liquidity, quoteAt, sourceAt, expiresAt, source, stale, error, eligibility, enabled, effectiveRoundId, runtimeState }`

`yes/no` 统一表示 YES/NO；自动交易页面不能再用没有映射说明的 UP/DOWN。

### MarketPoolViewModel

`{ assets, desiredIds, currentIds, nextRoundIds, updatedAt, source }`

当前是固定 BTC 的只读状态，`desiredIds/currentIds` 来自服务器，不能将浏览器选择当作已确认配置。运行池编辑尚未提供，`capabilityDetails.editMarketPool=false`。

### OrderBookViewModel

`{ marketId, roundId, yes: { bids, asks }, no: { bids, asks }, sequence, sourceAt, expiresAt, stale }`

这是预留深度模型。当前 REST 市场快照只提供已有 bid/ask，不能将最优报价伪造成五档；实时流能力尚未提供。未来五档应使用独立高频快照，并携带来源时间及过期状态。

### RoundPositionViewModel

`{ runId, marketId, roundId, available, stage, confirmations, yesShares, noShares, averagePrice, occupiedUsd, outcomePnl, updatedAt, expiresAt, source, asOf, stale, error }`

运行时快照过期、投影不完整或仍在追赶日志时，保留上次有效持仓并标记 stale；缺少匹配场次时为 unavailable，份额和金额为 `null`。只有来源明确确认空仓才能返回零份额。`occupiedUsd/averagePrice/outcomePnl` 缺少真实成本、费用或结算依据时保持 `null`。

### StrategyConfigViewModel

`{ strategyId, revision, triggerPrice, confirmationPrice, maxBuyPrice, stageShares, roundBudgetUsd, totalBudgetUsd, dailyLossUsd, durationMinutes, effectiveRoundId }`

价格单位固定为 USD 概率（0 到 1）或固定为 cents，二者不能混用。当前设计稿输入是 cents、预览显示 USD，接入时必须在 adapter 统一成一种。

草稿单独持久化并带 `draftId`；保存草稿不改变运行版本。激活请求使用 `expectedRevision/draftId`，成功发布返回 `activationScope="future_uncreated_round"`，仅影响尚未创建的未来场次。当前及已预热场次继续使用冻结版本。`effectiveRoundId` 只能省略或为 `null`，指定场次激活尚未提供。旧 `PUT /api/strategy-config` 仍是保存即发布。

### SystemHealthViewModel / AccountViewModel / ActivityEventViewModel

系统健康包含行情节点、控制台、采集、交易、账本投影、CPU、内存、磁盘和负载。账户只返回钱包摘要、配置状态和最近检查结果，不返回私钥；账户检查结果必须绑定当前钱包并有新鲜度，结算凭据未被运行时明确验证时保持 `null`。事件必须有 id、time、kind、marketId、roundId、severity 和 message。

诊断同时检查行情新鲜度、交易运行时、账本投影和资源快照；其中任何必需来源异常都不能报告全局 `ok`。有意停止的交易进程不等于故障，进程存活也不等于运行快照有效。事件 `kind` 对应账本事件类型，`severity` 使用 `info/warning/error`，未知标识和时间使用 `null`；原始 journal 字段可保留以兼容旧调用方。

## Ledger response metadata

现代成功和错误响应必须带 `schemaVersion`、`source`、`asOf`、`stale`、`error`。账本投影进程负责从运行日志生成订单、成交、结算、持仓和统计；HTTP 请求只读 SQLite/原子快照和已有缓存，不解析日志、不触碰实时下单链路。`stale` 或 `error` 时保留上一次有效字段及原始来源时间，不用请求时间刷新快照；从未成功取得数据时 `asOf=null`，未知金额和盈亏使用 `null`。

`/api/fills` 分页返回成交 journal 状态记录，同一经济成交可能有后续修订，前端不能直接按记录求和。`/api/settlements` 分页返回每场最新结算状态，包含 `state/payout_verified/pnl/accounting_state/pnl_error`。只有 `platform_settlement.state="confirmed"` 且 `payout_verified=true` 的结算计入确认统计；完整的已确认成交、实际手续费、核实到账及可核对成交成本的平台持仓快照缺一时，结算净盈亏为 `null`，并说明尚未核实的原因。

资金投影要区分可用余额、预留资金、持仓成本、估算手续费和已确认手续费。撤单请求或进程停止不是资金已释放的证明；结算必须同时有 `payout_verified`、交易回执和到账金额才能进入确认盈亏。未决订单、未确认结算或费用缺失不能进入最终胜率。

统计区分 `settled_wins/settled_losses/settled_draws/pending_settlements`；`abs(pnl) <= 1e-9` 为平局，胜率仅计算 `wins / (wins + losses)`，分母为零时为 `null`。`range=run` 为当前运行；`today/all` 汇总同一账户已投影的实盘运行，账户标识未知时仅统计当前运行，`today` 按 UTC 当日事件时间过滤。汇总不能宣称为账户完整历史。

## 页面状态

每个模块都要能表达 `loading`、`ready`、`stale`、`empty`、`error`、`unavailable`。错误时保留最后成功快照，同时在标题处显示来源和更新时间。

## Store 分片

浏览器中的 `PolyPreviewStore` 不存放秘密，只保存可展示状态：

- `marketCatalog`：BTC 当前场次、报价元数据。
- `marketPool`：服务器确认的固定 BTC 运行状态。
- `runtime`：运行状态、来源、过期标记和按市场摘要。
- `strategy`、`account`、`diagnostics`、`metrics`、`events`：各自独立更新。

一个接口响应只更新对应分片；行情帧不会触发账户、统计或整页重绘。
