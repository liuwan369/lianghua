# 文档索引

更新日期：2026-09-13。当前目标、权限、动态参数和交付顺序以最新交付规划为入口；运行能力以源码、部署清单和带日期的验收证据为准。历史研究与测量不能直接视为实时状态。

| 文档 | 用途 |
| --- | --- |
| [自动做市交付规划 v2](STRATEGY-DELIVERY-PLAN-2026-09-13.md) | 当前主线、50/30 硬条件、奖励经济性、动态参数和三端同步 |
| [Agent 协作约定 v2](AGENT-WORKFLOW.md) | 分工、独立验证、自主纠错、发布回滚和文档更新 |
| [本轮 SDK 与参考来源](research/autonomous-market-making-sources-2026-09-13.md) | 官方统一 SDK、参考源码与参考地址的最新核对 |
| [开始使用](../START-HERE.md) | 公网入口、使用顺序与当前限制 |
| [项目范围](PROJECT.md) | 产品目标与交付边界 |
| [页面操作](WEB_GUIDE.md) | 六页操作及字段状态 |
| [参数速查](QUICK_REF.md) | 参数、单位与状态含义 |
| [配置说明](CONFIGURATION.md) | 服务、引擎与账户配置 |
| [开发说明](DEVELOPMENT.md) | 本地开发与代码组织 |
| [测试说明](TESTING.md) | 回归命令与验收层次 |
| [接口说明](API.md) | 当前 API 与数据边界 |
| [部署说明](DEPLOYMENT.md) | 都柏林服务、发布与恢复 |
| [系统架构](ARCHITECTURE.md) | 组件与数据流 |
| [技术实现](TECHNICAL.md) | 策略、执行与数据实现 |
| [交付清单](DELIVERY.md) | 已交付和仍未完成的能力 |
| [当前进展](PROGRESS.md) | 当前完成度及后续工作 |
| [接手上下文](CONTEXT.md) | 节点、设计约束与关键事实 |
| [版本状态](UPGRADE-STATUS.md) | 当前系统各层状态 |
| [前端接入清单](FRONTEND-INTEGRATION-PLAN.md) | 尚需闭环的功能与验收条件 |
| [设置设计契约](DEMO-SETTINGS-2026-09-09.md) | 原六页设置设计与正式接线边界 |
| [策略模型研究](STRATEGY-MODEL-RESEARCH.md) | 当前数学模型、参考来源与未验证假设 |
| [奖励规则](REWARDS-RULES-2026-09-09.md) | 2026-09-09 官方来源核对及到账口径 |
| [实盘准备度验收](LIVE-READINESS-AUDIT-2026-09-10.md) | 账户、回归、纸面结果及实盘缺口 |
| [CPU 诊断](CPU-DIAGNOSIS-2026-09-10.md) | 采样结果、重复计算与待核实云端因素 |
| [历史 tick 数据要求](BACKTEST-TICK-DATA.md) | maker 回测输入规范 |
| [云仓库备份](GIT-BACKUP.md) | 可提交内容、秘密排除与回滚边界 |

脱敏验收数据按日期保存在 `evidence/`，历史官方研究正文位于 [research/rewards-2026-09-09](research/rewards-2026-09-09)。历史文档中的重复授权等待和零奖励统一否决条件已由 v2 规划替代；尚未重新核验的历史功能/测试数字保留日期，不标为当前通过。

- [账户数据接入与剩余验收](ACCOUNT-DATA-INTEGRATION-2026-09-10.md)
