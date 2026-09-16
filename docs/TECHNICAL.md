# 技术实现与执行语义

更新时间：2026-09-16。本文以 `_external/btc-5m-market-trading-bot/src/platform/` 当前源码为准；旧 `src/live/engine.ts` 的策略参数不属于公共底座默认值。

## 公共接口

`contracts.ts` 定义 `Instrument`、`Book`、`AccountSnapshot`、`OrderRequest`、`OrderRecord`、`TradeFill`、`RiskView`、`TradingEvent` 和 `StrategyAction`。`TradingPlatform` 对外暴露 market/account/orders/portfolio/risk/history/settlement/telemetry 八类能力。

独立 `trading-platform` CLI 已接入平台。控制台 `/api/v1/trading/start` 仍启动旧 `live.js run`，进程恢复和读模型也使用旧日志契约；这部分迁移是当前未完成工作。

`Book` 可以包含完整 `bids/asks`，档位必须按 best-first 排列：买方降序、卖方升序；平台拒绝重复或倒序深度。价格不再固定按 `0.001` 取整，行情保留交易所支持的 `0.0001/0.001/0.0025/0.005/0.01/0.1` 等合法精度。

## 订单状态和资金

订单状态为 `SUBMITTING`、`OPEN`、`PARTIAL`、`FILLED`、`CANCELLED`、`REJECTED` 或 `UNKNOWN`。BUY 预留名义金额加费用，SELL 预留份额和费用。成交按 `tradeId + orderId` 去重，成交先更新现金、持仓和成本，再通知策略。

撤单 ACK 可能与已发生但尚未到达的成交竞态。收到真实撤单确认后，订单变为 `CANCELLED` 但保留 `reconciliationPending` 和剩余预留；直到账户核对确认没有开放订单，才释放预留。paper 的网关在已排队成交全部交付后可明确释放。未知提交、未知撤单和持久化失败保持风险停机。

恢复核对只允许同账户、无在途请求进行，并拒绝早于上一次已接受时间的账户快照。活动订单缺少账户或明确撤单证据会失败关闭；断线恢复拿到稳定的撤单证据时先标记待核对，下一次账户读取确认不存在后才释放预留。取消单的账户快照不能静默推进成交数量，成交必须由去重的成交事件补入；已终态订单出现在新的开放订单快照中会报错，不能被覆盖成 `OPEN/PARTIAL`。停止 live 平台时先冻结用户事件，再做最终账户读取；无法证明最终状态就保持失败关闭。

## 行情与延迟

账户核对在候选副本上完成验证，通过后才替换账本；缺少成交或终态冲突等验证失败不会提前更新余额、持仓、快照时间或释放预留。

实盘新单门禁同时要求每个市场的 Up/Down 完整 L2 盘口新鲜、认证用户 WebSocket 健康连续。快速 `best_bid_ask` 只用于短时顶价显示，不刷新完整深度的健康时间；WebSocket 已连接本身不是健康证据，超过新鲜度阈值时 `isHealthy()` 返回 false。

延迟必须分段记录：本地决策、签名、HTTP ACK、用户订单事件、REST 首次可见、成交事件和补偿查询。成交事件直接进入内存账本和策略事件队列，REST 读模型不能作为补单或撤单触发条件。

## Paper 与真实网关

`PaperGateway` 使用当前显示深度完成主动成交，公共成交按价格/时间分配被动订单并消耗对应显示流动性；没有公开成交不会因为报价存在而自动成交。它支持 GTC/FOK/FAK、部分成交和关闭时的取消回报，但不模拟真实队列优先级。

`PolymarketGateway` 只负责 CLOB 请求和用户事件适配；账户、订单、成交和结算到账仍需通过各自来源核对。接口成功不能替代真实资金验收。

## 配置和策略

现有六页配置仍可保存九项后台字段，但策略暂停期间不把它们当作新策略默认参数。新策略必须实现 `StrategyPlugin`，不能导入 CLOB client、写账本或修改风险上限。策略研究和参数冻结等公共底座通过后再恢复。

## 持久化与结算

`PlatformStore` 按账户/模式使用独占锁、临时文件、`fsync` 和原子替换；启动时若存在完整 `.next` 恢复快照，优先读取它，避免丢失资金预留。当前结算适配器明确只接受两个不同 token 的二元市场请求；广播交易回执不是到账，最终余额必须重新核对。

## 当前限制

真实部分成交、撤改竞态、断线中成交、异常恢复、持续账户联合对账、连续结算和网页五档/完整延迟展示仍未完成。当前服务器交易停止，实盘锁关闭。
