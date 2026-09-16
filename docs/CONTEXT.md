# 当前接手上下文

更新时间：2026-09-17。当前入口是 [当前状态](CURRENT-STATUS.md)、[BTC反转开发规划](REVERSAL-DELIVERY-PLAN-2026-09-17.md)、[技术评估](REVERSAL-TECHNICAL-ASSESSMENT-2026-09-17.md) 和 [Agent协作约定 v8](AGENT-WORKFLOW.md)。

## 当前主线

用户已终止做市，要求复用`TradingPlatform`和`StrategyPlugin`实现桌面BTC五分钟反转方案。当前备份、技术评估、开发规划完成，新策略代码及前端改造尚未实现；接下来策略、执行、前端并行开发，主Agent集成。取消新回测、多日paper、第三日期与午夜等待前置，使用短时功能测试和小额真实验证。

服务器控制台为 `https://34-242-206-196.sslip.io/console/`。当前交易进程停止，模式 `paper`，`live_unlocked=false`。不要从网页存在、历史 run 或旧证据推断当前正在交易。

## 当前代码边界

- 新平台位于 `_external/btc-5m-market-trading-bot/src/platform/`。
- 控制台新启动、进程身份恢复和日志已接入 `platform.js`，默认无策略观察；旧 `live.js run` 仅保留显式兼容入口。当前只应用 mode/duration，其余旧配置保留。
- 旧 `src/live/engine.ts`、`MakerSession`、`PairCost` 是兼容路径，不是公共平台默认策略。
- Paper 网关只用盘口和公开成交模拟，不伪造真实队列；真实成交只认认证用户事件或明确补偿结果。
- 策略只能返回 `submit/cancel/replace`，不能访问 CLOB client 或修改账本。

## 当前剩余工作

实现70/75互斥四阶段插件、配置/场次恢复、签名订单身份和未知ACK查回、MATCHED后FAILED补偿、跨场健康与token对账、自动换场、真实费用及赎回到账。前端删除做市专属内容，接普通参数页、反转状态和10/20/50订单分页。具体责任文件以协作规则为准。

旧50美元本金/30美元日损仅可做接口验证，不能覆盖原版约147.94/257.94美元的四阶段参考成本。开发与额度问题分开推进，完整原版启动不能擅自改变预算。备份记录已明确数据范围，回退程序不能覆盖之后发生新成交的账本。

## 不应恢复的旧结论

历史paper PnL、参考地址、stableLive/target_clone参数、provider原子快照阻塞和旧“策略已完成”都不是当前状态。旧规划P4-P6已失效，当前按反转规划R0-R4推进；反转不撤旧单，但真实成交不能按未来更低卖一伪造。
