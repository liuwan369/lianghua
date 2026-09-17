# 当前接手上下文

更新时间：2026-09-18。当前入口是 [当前状态](CURRENT-STATUS.md)、[BTC反转开发规划 v1.7](REVERSAL-DELIVERY-PLAN-2026-09-17.md)、[技术评估](REVERSAL-TECHNICAL-ASSESSMENT-2026-09-17.md) 和 [Agent协作约定](AGENT-WORKFLOW.md)。

## 当前主线

用户已终止做市。一个可配置的 BTC 五分钟反转策略已经接入 `TradingPlatform` 和 `StrategyPlugin`，策略、执行底座、配置 API、订单分页和前端已实现。当前推进三个真实闭环：真实费用/收益/到账核对，最小真实 ACK/成交/撤单/重启恢复，正式参数运行/自动换场/结算到账。取消新回测、多日 paper、第三日期与午夜等待前置。

服务器控制台为 `https://34-242-206-196.sslip.io/console/`。2026-09-18 01:08 检查时公网行情在线，现金 `106.313425` 美元、开放订单 `0`，`running=false`、`strategy_id=null`、`live_unlocked=false`。策略 `savedRevision=3`，单场预算 `14.5` 美元只能覆盖 `[5,18,54,130]` 的较低阶段。不要从页面、历史 run 或旧证据推断当前正在交易。

## 当前代码边界

- 新平台位于 `_external/btc-5m-market-trading-bot/src/platform/`。
- 控制台新启动、进程身份恢复和日志已接入 `platform.js`，默认无策略观察；旧 `live.js run` 仅保留显式兼容入口。当前只应用 mode/duration，其余旧配置保留。
- 旧 `src/live/engine.ts`、`MakerSession`、`PairCost` 是兼容路径，不是公共平台默认策略。
- Paper 网关只用盘口和公开成交模拟，不伪造真实队列；真实成交只认认证用户事件或明确补偿结果。
- 策略只能返回 `submit/cancel/replace`，不能访问 CLOB client 或修改账本。

## 当前剩余工作

本批预算成本提示、撤单 ACK 遥测和结算到账证明已经完成定向本地测试；并发撤单竞态修复已通过独立复核，随后进行选定版本完整测试、提交、服务器发布和公网只读验收。再由用户发起最小真实金融操作，Agent 核对 ACK、成交、费用、撤单、重启恢复和到账；最后验证正式参数连续运行、自动换场和结算。

服务器使用用户保存的每场预算，不恢复旧 `$50/$30` 假设，不自动修改额度。备份记录已明确数据范围，程序回退不能覆盖之后发生真实成交的账本。

## 不应恢复的旧结论

历史paper PnL、参考地址、stableLive/target_clone参数、provider原子快照阻塞和旧“策略已完成”都不是当前状态。旧规划P4-P6已失效，当前按反转规划R0-R4推进；反转不撤旧单，但真实成交不能按未来更低卖一伪造。
