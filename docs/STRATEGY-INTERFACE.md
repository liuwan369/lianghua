# 策略接口与可复用功能

日期：2026-09-16。支持范围：Polymarket BTC 五分钟、BUY outcome 决策插件。

## 已分开的部分

行情采集、市场发现、账户查询、CLOB 签名与请求、订单执行、资金预留、运行日志和控制台不需要调用现有配对策略即可复用。模块可复用不代表所有异常场景已完成，具体状态以任务页功能架构为准。

引擎通过 `src/strategies/types.ts` 的 `BuyStrategy` 接口读取同步决策。`MakerSession` 接受策略工厂，不再直接构造 `PairCostMarketMaker`。策略读取内存行情与库存，执行器负责下单、撤单和回报；不向报价或补仓路径增加 REST、计时器或磁盘查询。

| 策略 ID | 行为 | 使用范围 |
| --- | --- | --- |
| `pair-cost` | 保留现有配对成本策略 | 原有 paper / 受控 live 路径 |
| `observe` | 不产生订单意图，仍接收行情和生成运行记录 | 仅 paper；live 参数在网络连接前报错 |

`--passive-budget` 是同一算法的参数预设。默认仍为 `pair-cost`，不会修改已保存配置或切换正在运行的策略。

## 使用入口

在 `_external/btc-5m-market-trading-bot` 目录构建后：

```sh
node dist/cli/live.js run --paper --strategy observe --duration-min 1
node dist/cli/live.js run --paper --strategy pair-cost
```

也支持 `PM_STRATEGY_ID`；未知 ID 会报错。网页配置暂不新增策略参数，避免选择值与后台启动契约不一致。

新 BUY 策略实现 `BuyStrategy`，通过代码注入 `new Engine({ strategyFactory: config => new MyStrategy(config) })`；需要 CLI 选择时加入 `src/strategies/registry.ts`。实现须维护风险生命周期，不得自行签名或发送订单。当前仍共用 `StrategyConfig` 与 `RiskState`，不是任意交易方向的通用插件系统。

## 尚未分开的部分

- 成交事件缺少完整 BUY / SELL 方向，库存执行主要按买入增加份数。
- Executor 普通挂单为 BUY，现有 SELL 是退出入口，不等于普通 maker SELL 策略。
- 每个 outcome 的待单槽位、挂单寿命、尾盘和微观结构过滤仍在当前 BUY 做市运行时。
- 可替换选边、报价和买入份数；普通买卖、多挂单、不同持仓模式还不能直接接入。

下一阶段先增加带 outcome、direction、价格、数量和流动性方式的订单意图，贯通成交方向、现金流、库存和按订单 ID 的跟踪，再迁出策略专属退出与过滤规则。保留认证成交立即触发决策、无需下一盘口或 REST 的回归。

## 验证

注册表与注入测试覆盖默认兼容、自定义 BUY 策略、未知 ID、观察无订单和拒绝 live。编排用例验证拒绝观察实盘发生于执行器创建和网络请求前。引擎 353 项测试、类型检查和构建通过；离线测试不替代真实部分成交、恢复或收益验证。
