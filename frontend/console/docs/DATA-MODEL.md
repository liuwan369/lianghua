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

desired 是用户选择，current/next 是服务器确认结果。单实例运行池至少保留一个 desired asset；切换已启用币种只影响下一场，不删除当前场次订单。停止交易使用 runtime stop 命令，并以服务器回执确认远端挂单状态。

### OrderBookViewModel

`{ marketId, roundId, yes: { bids, asks }, no: { bids, asks }, sequence, sourceAt, expiresAt, stale }`

### RuntimeViewModel

`{ assetId, marketId, roundId, status, state, processRunning, runId, asOf, stale, error }`

`processRunning: true | false | null` 是服务器独立控制事实，表示交易进程是否明确运行，不受运行投影 `stale` 影响。前端只有收到 `true` 才开放暂停/停止，只有收到明确 `false` 才允许启动；缺失、`null` 或无法解析时显示进程状态未知并禁止启动。运行投影、行情新鲜度和命令最终确认仍分别处理。

运行控制必须先匹配当前场次的 `assetId + marketId + roundId`。stale 投影只保留匹配上下文的 stop 事实，不能用于 start 或 pause/resume；场次身份变化时清空上一场的持仓、订单和活动事件，身份不变的断线继续保留最近成功数据并标记 stale。

五档是独立的高频快照；不能用定时器或演示数值生成。行情帧只允许更新相同 `marketId + roundId` 的盘口节点。

### RoundPositionViewModel

`{ marketId, roundId, stage, confirmations, yesShares, noShares, averagePrice, occupiedUsd, outcomePnl, updatedAt }`

### StrategyConfigViewModel

`{ strategyId, revision, triggerPrice, confirmationPrice, maxBuyPrice, stageShares, roundBudgetUsd, totalBudgetUsd, dailyLossUsd, durationMinutes, effectiveRoundId }`

价格单位固定为 USD 概率（0 到 1）或固定为 cents，二者不能混用。策略页输入使用 cents，adapter 提交前统一转换为 USD 概率。

### SystemHealthViewModel / AccountViewModel / ActivityEventViewModel

系统健康包含行情节点、控制台、采集、交易、账本投影、CPU、内存、磁盘和负载。账户只返回钱包摘要、配置状态和最近检查结果，不返回私钥。事件必须有 id、time、kind、marketId、roundId、severity 和 message。

账户 ViewModel 的真实数据源是服务器账户快照、独立账户状态和账户检查接口。账户状态单独存储为 `accountStatus`，不会被余额快照覆盖；账户快照中的根 `available` 是分区可用性布尔值，不能当作余额金额，金额应读取 `collateral.value` 或服务器明确的金额字段。没有快照时显示 `unavailable`，请求失败后保留上一次快照并显示 `stale`。账户检查分为表单候选检查和服务器已保存账户检查，后者发送 `{}`。

## 共享判定函数

这些函数是单一来源，页面不要重抄判断链：

- `PolyPreviewViewModel.accountStartBlockReason(accountStatusSlice)`：账户启动门禁，按序检查 `status!=="ready"||stale||error` → `account_check_ready` → `settlement_credentials_ready` → `server_live_enabled` → `live_start_ready`，通过时返回空字符串。总览页和自动交易页共用；此前两页各存一份逐字副本，正是错误字典分叉的来源。
- `PolyPreviewViewModel.hasFreshBbo(market)`：盘口是否可用于启动。只检查身份、`sequence`、服务器 `stale` 和四价范围，**不使用浏览器时钟**。
- `PolyPreviewViewModel.runtimeStartBlockReason` / `catalogItemStartReason` / `strategyAssetStartReason`：运行状态、目录行、策略币种三级门禁。
- `PolyPreview.format.accountError(code, fallback)` 与 `accountErrorLabels`：12 个账户错误码的中文映射，是账户错误文案的唯一来源（此前散落在三页，分别只有 7/8/12 个键）。注意 `format.readableError` 另有一份通用错误词典，两者有重叠键；账户就绪类错误统一用 `accountError`。

成交统计优先使用服务器明确的唯一成交计数字段。若响应包含 `fills`、`trades`、`executions` 或 `fill_records` 数组，前端按 `tradeId`/`fillId`、`orderId`、`marketId`、`roundId` 组合去重；缺少 `marketId` 或 `roundId` 的记录不会计入，避免把不同轮次合并。原始成交记录和 `tradeStatus`、费用、时间等生命周期字段保留在 metrics 数据中，计数逻辑不会覆盖详情。

## 页面状态

每个模块都要能表达 `loading`、`ready`、`stale`、`empty`、`error`、`unavailable`。错误时保留最后成功快照，同时在标题处显示来源和更新时间。

## Store 分片

浏览器中的 `PolyPreviewStore` 不存放秘密，只保存可展示状态：

- `marketCatalog`：支持币种、当前场次、报价元数据、选中币种。
- `marketPool`：desired/current/nextRound 三种运行池状态。
- `runtime`：运行状态、来源、过期标记和按市场摘要。
- `strategy`、`accountStatus`、`account`、`diagnostics`、`metrics`、`events`：各自独立更新。

一个接口响应只更新对应分片；行情帧不会触发账户、统计或整页重绘。策略预览、延迟、倒计时和下一笔交易在没有服务器字段时显示 `--`/待接入，不使用静态演示值；运行事件按当前 `marketId + roundId` 独立低频读取，不阻塞盘口刷新。
