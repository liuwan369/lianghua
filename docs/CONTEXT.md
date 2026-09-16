# 当前接手上下文

更新时间：2026-09-16。当前入口是 [当前系统状态](CURRENT-STATUS.md)、[交付规划 v6](STRATEGY-DELIVERY-PLAN-2026-09-13.md) 和 [Agent 协作约定 v6](AGENT-WORKFLOW.md)。

## 当前主线

公共交易底座已经从旧做市策略中抽出：`TradingPlatform` 统一市场、盘口、账户、订单、持仓、风险、结算、持久化和遥测；`StrategyPlugin` 是后续策略唯一扩展入口。策略、参数和收益研究暂停，当前只审查底座和文档。

服务器控制台为 `https://34-242-206-196.sslip.io/console/`。当前交易进程停止，模式 `paper`，`live_unlocked=false`。不要从网页存在、历史 run 或旧证据推断当前正在交易。

## 当前代码边界

- 新平台位于 `_external/btc-5m-market-trading-bot/src/platform/`。
- 控制台启停/恢复和日志仍走旧 `live.js run` / Engine，独立平台 CLI 才使用新入口；UI-00 负责迁移，不能宣称所有入口已统一。
- 旧 `src/live/engine.ts`、`MakerSession`、`PairCost` 是兼容路径，不是公共平台默认策略。
- Paper 网关只用盘口和公开成交模拟，不伪造真实队列；真实成交只认认证用户事件或明确补偿结果。
- 策略只能返回 `submit/cancel/replace`，不能访问 CLOB client 或修改账本。

## 当前剩余工作

继续审查真实部分成交、撤改竞态、断线恢复、账户联合核对、结算到账、持续延迟和控制台五档深度。发现问题先写测试、修复、验证，然后更新任务树和本页。

## 不应恢复的旧结论

历史 paper PnL、参考地址行为、`stableLive`/`target_clone` 参数、provider 原子快照阻塞和旧的“策略已完成”说明都不是当前状态。带日期证据只用于复盘，策略恢复必须经过新规划的 P4-P6。
