# 策略接口与可复用功能

日期：2026-09-16
状态：接口已交付，策略接入暂停

## 1. 设计边界

公共底座和策略是两个独立层。底座不选择价格、不决定方向、不计算配对规则；策略不访问交易所客户端、不改账户账本、不释放资金预留。任何策略只要实现同一接口，就可以调用相同的行情、账户、订单、持仓、风险、结算和遥测能力。

公共入口：

```ts
import type { StrategyPlugin } from "./contracts.js";

export interface StrategyPlugin {
  readonly id: string;
  onEvent(event: TradingEvent, context: StrategyContext): readonly StrategyAction[];
  onStop?(): void;
}
```

新平台的订单公共入口是 `platform.orders.submit/cancel/replace`，由 `TradingCore` 做资金、份额、身份和风险校验，新插件不能直接调用 CLOB SDK。当前独立 `trading-platform` CLI 已使用这条路径；现有控制台仍启动旧 `live.js run`，其启停、恢复及状态/日志投影迁移尚未完成，不能把“统一入口”描述为所有入口的现状。

策略通过 `onEvent` 接收市场、盘口、参考价、订单、成交、账户、结算、定时器和错误事件；`context` 只读，包含模式、时间、市场、完整盘口和当前账户投影。

允许返回三类动作：

- `submit`：提交一个带 token、方向、价格、数量、TIF 和 post-only 的订单意图；平台补入 `strategyId` 并执行所有校验。
- `cancel`：撤销本策略拥有的订单。
- `replace`：确认旧单撤销后，以新的 `clientOrderId` 提交替代订单。

## 2. 底座提供的功能

| 功能 | 公共接口 | 说明 |
|---|---|---|
| 市场和规则 | `platform.market.discover/list` | 市场、token、tick 和最小委托量 |
| 行情 | `platform.market.book/depth/books` | 完整 L2 盘口，策略自行选择前五档或全部档位 |
| 账户 | `platform.account.current/refresh/reconcile` | 只读快照和明确的恢复核对 |
| 订单 | `platform.orders.submit/cancel/replace/list/get` | BUY/SELL、多订单、TIF、post-only |
| 组合 | `platform.portfolio.positions/fills` | 持仓、成本、已实现损益和去重后的成交 |
| 风险 | `platform.risk.current/limits` | 本金、日损失、订单数和占用资金 |
| 结算 | `platform.settlement.redeem` | 只返回适配器结果，到账仍需账户核对 |
| 持久化 | `PlatformStore` | 账户/模式隔离、独占锁、原子替换和恢复 |
| 遥测 | `platform.telemetry/history` | 事件数量、策略列表、停止状态和事件历史 |

这些接口存在不等于所有真实异常场景已经验收。当前真实适配器的部分成交、撤改竞态、断线恢复、结算连续性和长期运行仍在公共底座验收范围。

## 3. 策略不能做的事

策略不能导入 `ClobWrapper`、直接发 HTTP、写 `CoreState`、修改风险上限、伪造成交、释放未知订单预留或把慢 REST 查询当作成交事件。策略错误会被隔离、记录，并触发该策略订单清理；不能影响其他观察者的账本。

## 4. 当前实现和状态

- `TradingPlatform`、`TradingCore`、`PaperGateway`、Polymarket 适配器和通用 CLI 已存在并有回归测试。
- `example-strategy.ts` 是最小可加载观察插件，不产生订单，用来验证插件加载和隔离。
- 旧 `Engine/MakerSession/PairCost` 保留为兼容旧路径，不属于新接口的默认策略。
- `pair-cost`、`stableLive`、`target_clone` 和其他策略参数当前暂停，不进入新平台的生产默认值。

## 5. 恢复策略开发的条件

先完成平台状态机、资金守恒、真实订单生命周期、账户核对、异常恢复和控制台数据边界审查；然后用观察插件和固定输入完成接口验收；最后才恢复策略回放、paper、真实校准和参数冻结。策略收益不能替代底座验收，也不能反向改变公共接口。
