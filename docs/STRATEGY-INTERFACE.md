# 策略接口与可复用功能

日期：2026-09-16。支持范围：通用交易底座，当前提供 Polymarket BTC 五分钟适配器。

## 已分开的部分

行情采集、市场发现、账户查询、CLOB 签名与请求、订单执行、资金预留、持仓记账、风险、结算、运行日志和控制台由平台底座提供。策略不需要导入 venue client、MakerSession 或 PairCost；只实现 `StrategyPlugin`，通过平台事件返回订单动作。模块可复用不代表所有异常场景已完成，具体状态以任务页功能架构为准。

通用入口是 `_external/btc-5m-market-trading-bot/src/platform/index.ts`。`TradingPlatform` 暴露 `market`、`account`、`orders`、`portfolio`、`risk`、`settlement`、`history` 和 `telemetry`。事件链先更新底座持仓与订单，再同步调用插件；成交后的策略动作不等待 REST、下一次盘口或磁盘查询。旧 `Engine` / `MakerSession` 通过单独兼容路径保留，不能代表通用底座的边界。

| 策略 ID | 行为 | 使用范围 |
| --- | --- | --- |
| `pair-cost` | 旧系统配对成本策略 | 兼容的旧 paper / 受控 live 路径 |
| `observe` | 不产生订单意图，仍接收行情和生成运行记录 | 通用 CLI 示例，默认 paper |

`--passive-budget` 是同一算法的参数预设。默认仍为 `pair-cost`，不会修改已保存配置或切换正在运行的策略。

## 使用入口

在 `_external/btc-5m-market-trading-bot` 目录构建后：

```sh
node dist/cli/platform.js --paper --strategy-module ./dist/platform/example-strategy.js --duration-sec 60
node dist/cli/live.js run --paper --strategy observe --duration-min 1
```

也支持 `PM_STRATEGY_ID`；未知 ID 会报错。网页配置暂不新增策略参数，避免选择值与后台启动契约不一致。

新策略实现 `StrategyPlugin`：

```ts
import type { StrategyPlugin } from "./platform/contracts.js";
export const strategy: StrategyPlugin = {
  id: "my-strategy",
  onEvent(event, context) { return []; },
};
```

动作使用 `submit`、`cancel`、`replace`，订单包含 token、`BUY|SELL`、价格、份数、TIF 和 post-only。平台统一做资金/份额预留、订单幂等、成交记账和风险停止；策略不得自行签名、调用 venue API 或绕过硬条件。CLI 用 `--strategy-module` 加载 `createStrategy()` 或默认插件。

## 当前适配器限制

- 当前 Polymarket 连接器要求显式二元市场列表；任意 venue 需要实现 `OrderGateway` 和市场/账户适配器。
- 账户普通读取是后台刷新；未知订单、重连缺口和不完整对账会保持风险停止，不能用慢 REST 替代成交事件。
- 结算接口只在注入已确认的 wallet/relayer adapter 时可用；广播交易不会直接增加现金。
- PaperGateway 是显示盘口与公开成交驱动的可重复模型，不代表真实队列位置或成交率已校准。
- 旧 `BuyStrategy`、PairCost 的选边、挂单寿命、微结构和尾盘规则仍属于兼容策略，不会自动进入通用插件。

后续策略只需依赖 `StrategyPlugin` 和只读 `StrategyContext`；增加新交易场所时实现适配器，不修改平台账本。任何影响订单、资金或风险语义的改动都要重新运行公共契约测试。

## 验证

公共平台测试覆盖 BUY/SELL、多订单、部分成交、撤单/替换、重复成交、份额预留、共享资金、插件隔离和 paper 关闭；CLI 测试覆盖参数、策略模块、持久化、信号和清理。引擎原有测试继续验证旧兼容路径；离线测试不替代真实部分成交、恢复或收益验证。
