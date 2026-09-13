# Agent 派工状态

更新时间：2026-09-13 18:05 Asia/Shanghai。此表是当前自动做市任务的工作入口；状态以源码、证据和交接结果为准。

| Agent | 当前任务 | 文件范围 | 交付物 | 状态 |
| --- | --- | --- | --- | --- |
| 主 Agent | 集成、验收、版本、服务器发布和风险边界 | 规划、共享契约、发布清单 | 集成提交、验收状态、回滚记录 | RUNNING |
| 执行 Agent | EXEC-02：把权威账户快照、`AccountExecutionGate` 和 reservation coordinator 接入 live 编排 | `_external/btc-5m-market-trading-bot/src/live/{account-data,account-equity-adapter,account-control,account-state-store,executor,engine,orchestrator}.ts` | live 入口门禁、ACK/unknown/partial/reconcile/exit 故障用例 | REVIEW（代码已合入；当前只读源为非原子，适配器 fail-closed；需原子账户源和北京日初基线） |
| 量化 Agent | REPLAY-01/RESEARCH-01：价格、方向、队列和报价生命周期诊断；维护参考地址假设 | `scripts/pm-r26*`、`pm_maker/`、策略与回放报告 | 固定数据实验表、失败原因、候选参数包 | REVIEW（固定 4 市场窗口完成；价格匹配和生命周期是主阻塞，队列未触发；54 项相关测试通过，默认参数继续冻结） |
| 数据 Agent | DATA-01/REF-01：结算、费用、奖励和账户快照来源核对 | `scripts/dashboard/`、数据清单、奖励/结算证据 | 来源版本、覆盖率、快照完整性报告 | REVIEW（已交付零成交原因诊断） |
| 产品/API Agent | UI-01：只读检查现有前端实际字段和默认值接入缺口 | `web/src/`、dashboard read model | 不重构页面的防误配/状态展示补丁 | REVIEW（自动库存联动、跨字段金额校验，51 tests/build passed） |
| QA/发布 Agent | 每批独立审查、全量验证、三端 hash、失败回滚 | `scripts/verify-project.py`、`.deploy/`、证据文档 | REVIEW、测试清单、发布/回滚结论 | DONE（`ebbab58` 已推送并发布；远端备份、服务状态、paper smoke 投影 `ready` 已核对；live 仍因非原子账户源 fail-closed） |

并行规则：同一文件只有一个 Agent 写入；主 Agent 统一合并和提交；关键交易代码由独立 QA 审查。Agent 完成后状态转为 REVIEW，主 Agent 集成后才转 DONE。任务失败不会静默结束，必须留下原因、复现命令和下一次可执行动作。

当前硬条件持续有效：总投入 50 美元、北京时间单日最大亏损 30 美元；真实交易保持关闭，策略默认值未因零成交 smoke 自动生成。旧损坏 paper run 未删除，新 smoke run `20260913-082538-b7262e8e56aa` 已作为当前可核对投影。
