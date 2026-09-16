# 自主做市：SDK 与参考来源更新

读取日期：2026-09-13；当前架构复核：2026-09-16。通过 GitHub 官方仓库 API 读取仓库元数据和 README 正文；原始 raw 域名访问超时后改用 API。本文是资料核对，不是 SDK 已迁移或策略已通过验证的证明。

## 官方 SDK

| 来源 | README blob SHA | 本次确认 |
| --- | --- | --- |
| [Polymarket/clob-client-v2](https://github.com/Polymarket/clob-client-v2) | `72434071d47754dde5ab9c08de1e00eb6451b81c` | README 顶部推荐新项目采用统一 `Polymarket/ts-sdk`；现有 V2 示例仍可作为当前适配比较对象 |
| [Polymarket/ts-sdk](https://github.com/Polymarket/ts-sdk) | `9401e4bf1a66219af67ae7983d17fde4b2393ea1` | 官方 TypeScript SDK，client/types/bindings 分包；要求 Node >=24；0.x 次版本可能有破坏性变更，experimental 接口需单独评估 |
| [Polymarket/py-clob-client](https://github.com/Polymarket/py-clob-client) | `47e527e26dcebb9afeb4e3d94daae553898f5696` | README 明确已归档、不再维护且不再可用，要求迁移至 py-sdk；不再列为新接入候选 |
| [Polymarket/py-sdk](https://github.com/Polymarket/py-sdk) | `2cd12b5e1979ea144cb2f2163c76d30223e5f2c1` | 官方统一 Python SDK，包名 polymarket-client，提供同步/异步客户端及数据、账户、交易、钱包相关流程 |
| [Binance Python Connectors](https://github.com/binance/binance-connector-python) | `5f1c0d84a4a41ff621f287db429679ae36476438` | 已按产品拆为多个 SDK，含 spot 等；当前项目先评估公共市场数据、连接管理和限流适配 |

以上仓库元数据返回 MIT 许可证。真正引入源码时仍需检查具体文件及其依赖授权。没有在本轮安装、升级、创建凭据或调用交易接口。

项目现有 Node 引擎同时使用 `@polymarket/clob-client-v2` 1.1.0 和 `@polymarket/client` ^0.9.0，不能把统一 SDK 当作项目完全未使用的新能力。SDK-01 要核对现有账户/交易调用面、签名类型、Deposit Wallet、订单生命周期、手续费字段、WebSocket 事件和回滚兼容性，再决定合并适配或保留成熟路径。

## 对当前系统的采用结论（2026-09-16）

官方 SDK 和开源机器人并没有替代公共交易底座。它们各自覆盖不同边界：

| 来源 | 可以借鉴 | 不应直接替代 |
|---|---|---|
| Polymarket `ts-sdk` / CLOB V2 client | 签名、请求类型、市场规则和官方事件字段 | 本地资金账本、风险停止、恢复核对和策略接口 |
| Polymarket `py-sdk` | 官方账户、交易和钱包 API 的语义对照 | 当前 Node 运行时的执行适配器 |
| `warproxxx/poly-maker` | WebSocket 行情、库存偏斜、报价生命周期、heartbeat 和 SQLite 状态思路 | 本项目的成交率、奖励参数和 BTC 五分钟策略结论 |
| NautilusTrader | 事件驱动状态机和遥测设计参考 | 当前项目的直接替换；许可证、规模和集成成本需要单独评估 |

新平台采用一个公共订单入口和多个职责模块：`TradingPlatform` 是公共入口，`TradingCore` 管资金和状态，`OrderGateway` 管交易所调用，`PaperGateway` 管模拟，行情/用户流/账户读取分别提供数据。新插件复用这些功能；更换 SDK 应限定在网关或账户适配层。独立平台 CLI 已接通，但现有控制台启停和旧 CLI 仍调用旧 Engine，不能据此宣称所有入口都已统一。

因此任务树中“提交、撤单、替换、成交”属于同一公共执行底座，但不会合并成一个巨大源文件。接口和 paper 能力已完成，真实异常生命周期、持续账户核对、五档/延迟展示仍按任务树保留为未完成项。

## 参考实现

[warproxxx/poly-maker](https://github.com/warproxxx/poly-maker) 本次读取 README blob `fcc721d23cc76548492e256c2f9d1955200416da`，仓库元数据为 MIT。README 描述其为面向政治市场的 V2 maker-only 机器人，包含 Gamma 发现、盘口 WebSocket、库存偏斜、波动/毒性估计、报价差异容忍、heartbeat 和 SQLite 状态。

可借鉴的是上述机制及对应实现；政治市场的持仓期限、奖励条件和跳价特征不能直接套入 BTC 五分钟市场。读取 README 只确认作者描述，尚未逐项证明其源码和收益，因此每项移植必须配本项目对照测试。

[NautilusTrader](https://github.com/nautechsystems/nautilus_trader) 本次只读取仓库元数据，其说明强调 Rust 事件驱动交易引擎，许可证标为 LGPL-3.0。作为后续状态机/架构研究候选，不表示已经审查其实现，也不作为本轮替换项目引擎的依据。

## 参考地址

地址：`0x3048d65321be3497164cdfc2996f94f98a2e7537`。

本轮读取 [本地参考账本审计](../evidence/2026-09-12/reference-ledger-audit.json)。已有历史样本中：成交批量中位数约 30 份、批次间隔中位数约 3 秒；77 笔匹配奖励中 Taker rebate 42,740.1913、Maker rebate 6,016.7037、Reward 774.9322 USDC。完整交易净损益和奖励日历对齐仍未证实，不能从奖励金额直接推导净利润。

下一步按本金归一化对照成交节奏、maker/taker 角色、库存与补仓、交易成本、返佣资格、资金周转和尾盘风险。复刻有效行为需要结合公开盘口及本账户执行结果，不推断不存在的未成交挂单或队列证据。

## 研究记录规则

每个候选记录问题、来源及版本、假设、适用性、许可证、实现位置、实验数据和增量效果。问题明确后优先官方协议与维护中的源码；失败实验同样记录。优先复用已有能力，避免反复安装同类框架或重写已稳定模块。

策略评价以交易及奖励后的总经济性为主；零奖励保留作压力分析，实际到账和官方估算分别列示。最新用户要求和交付顺序见 [交付规划](../STRATEGY-DELIVERY-PLAN-2026-09-13.md)。
