# Agent 派工状态

更新时间：2026-09-16 Asia/Shanghai。当前批次为功能架构网页与策略接口，状态以源码、证据和交接结果为准。

| 本批角色 | 文件归属 | 结果 |
| --- | --- | --- |
| 产品 Agent | `web/src/pages/tasks.*`、layout 与 API 契约 | DONE：功能架构、筛选、详情、旧任务兼容，62 项前端测试通过 |
| 执行 Agent | 引擎 `strategies/`、MakerSession、Engine、CLI | DONE：BUY 策略注入、注册和观察模式，353 项引擎测试通过 |
| 主 Agent | 架构数据、规划、集成和发布 | 首批 85 文件部署并验证哈希；收尾同步文案与发布记录 |

本批没有运行新策略或发出真实订单。后续优先修复账户持续刷新与完整资金占用；通用 SELL / 多挂单接口单列待完成。以下为此前工作流的交接记录，不代表全部角色此刻仍在运行。

| Agent | 当前任务 | 文件范围 | 交付物 | 状态 |
| --- | --- | --- | --- | --- |
| 主 Agent | 集成、验收、版本、服务器发布和风险边界 | 规划、共享契约、发布清单 | 集成提交、验收状态、回滚记录 | RUNNING |
| 执行 Agent | EXEC-02：把账户读取、`AccountExecutionGate`、用户流确认和 reservation coordinator 接入 live 编排，并维护真实校准探针 | `_external/btc-5m-market-trading-bot/src/live/{account-data,account-equity-adapter,account-control,account-state-store,executor,engine,orchestrator}.ts`、`scripts/live-calibration-probe*` | live 入口门禁、来源时间戳、资金流证据、订单生命周期和异步状态保护 | REVIEW（paper/live 身份隔离和退出单 per-order/累计额度修复已通过；已有真实成交/结算及用户流撤单证据；连续校准和部分成交/断线恢复样本继续补齐，live 保持 fail-closed） |
| 量化 Agent | REPLAY-01/RESEARCH-01/02：价格、方向、队列、报价生命周期和单边退出诊断；维护参考地址假设；消费真实校准样本生成参数包 | `scripts/pm-r26*`、`pm_maker/`、策略与回放报告、校准样本 | 固定数据实验表、失败原因、退出成本/markout、真实成交概率/延迟/寿命参数包 | REVIEW（09-10 固定窗口 + 09-09 独立留出共 12 个完整市场；观察方向/价格均 0 fills；退出上界触发 1 次但最坏情景仍负；默认参数等待真实校准样本，不再把 paper 盈利结论作为真实采样前置） |
| 数据 Agent | DATA-01/REF-01：结算、费用、奖励和账户快照来源核对 | `scripts/dashboard/`、数据清单、奖励/结算证据 | 来源版本、覆盖率、快照完整性报告 | REVIEW（已交付零成交原因诊断） |
| 产品/API Agent | UI-01：只读检查现有前端实际字段和默认值接入缺口 | `web/src/`、dashboard read model | 不重构页面的防误配/状态展示补丁 | REVIEW（自动库存联动、跨字段金额校验，51 tests/build passed；任务页状态拆分和接口字段复核继续） |
| QA/发布 Agent | 每批独立审查、全量验证、三端 hash、失败回滚 | `scripts/verify-project.py`、`.deploy/`、证据文档 | REVIEW、测试清单、发布/回滚结论 | REVIEW（已发现并修复回放 helper diagnostics 回归；50 项定向测试通过；待本批完整回归后再发布 docs/scripts） |

并行规则：同一文件只有一个 Agent 写入；主 Agent 统一合并和提交；关键交易代码由独立 QA 审查。Agent 完成后状态转为 REVIEW，主 Agent 集成后才转 DONE。任务失败不会静默结束，必须留下原因、复现命令和下一次可执行动作。

当前硬条件持续有效：总投入 50 美元、单日最大亏损 30 美元；完整自动策略保持关闭，真实校准探针使用独立的微额限额。旧额度耗尽的 paper run 保留为历史修正证据；run `20260914-084336-6831da9cc88c` 已完成 37 个市场/69 次模拟成交。当前并行产生 paper 首腿/补腿/退出样本和真实 maker 校准样本；账户全历史、provider 原子快照和自然发生的完整异常生命周期仍是增强/持续覆盖项，不再作为真实校准探针的统一等待理由。
