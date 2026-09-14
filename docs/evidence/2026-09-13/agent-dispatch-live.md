# Agent 派工状态

更新时间：2026-09-14 14:58 Asia/Shanghai。此表是当前自动做市任务的工作入口；状态以源码、证据和交接结果为准。

| Agent | 当前任务 | 文件范围 | 交付物 | 状态 |
| --- | --- | --- | --- | --- |
| 主 Agent | 集成、验收、版本、服务器发布和风险边界 | 规划、共享契约、发布清单 | 集成提交、验收状态、回滚记录 | RUNNING |
| 执行 Agent | EXEC-02：把账户读取、`AccountExecutionGate`、用户流确认和 reservation coordinator 接入 live 编排 | `_external/btc-5m-market-trading-bot/src/live/{account-data,account-equity-adapter,account-control,account-state-store,executor,engine,orchestrator}.ts` | live 入口门禁、来源时间戳、资金流证据和异步状态保护 | REVIEW（paper/live 身份隔离和退出单 per-order/累计额度修复已通过；provider 原子源仍是增强项；真实用户频道确认和停止/恢复核对继续补齐，live 保持 fail-closed） |
| 量化 Agent | REPLAY-01/RESEARCH-01：价格、方向、队列和报价生命周期诊断；维护参考地址假设 | `scripts/pm-r26*`、`pm_maker/`、策略与回放报告 | 固定数据实验表、失败原因、候选参数包 | REVIEW（09-10 固定窗口 + 09-09 独立留出共 12 个完整市场；观察方向/价格均 0 fills，强制方向仅形成生命周期上界；队列未触发；回放相关测试通过，默认参数继续冻结） |
| 数据 Agent | DATA-01/REF-01：结算、费用、奖励和账户快照来源核对 | `scripts/dashboard/`、数据清单、奖励/结算证据 | 来源版本、覆盖率、快照完整性报告 | REVIEW（已交付零成交原因诊断） |
| 产品/API Agent | UI-01：只读检查现有前端实际字段和默认值接入缺口 | `web/src/`、dashboard read model | 不重构页面的防误配/状态展示补丁 | REVIEW（自动库存联动、跨字段金额校验，51 tests/build passed；任务页状态拆分和接口字段复核继续） |
| QA/发布 Agent | 每批独立审查、全量验证、三端 hash、失败回滚 | `scripts/verify-project.py`、`.deploy/`、证据文档 | REVIEW、测试清单、发布/回滚结论 | DONE（上一发布已核对；本轮 paper 配置 revision 5 与新 run 已由主 Agent 单独核验，后续文档/前端变更再走发布清单） |

并行规则：同一文件只有一个 Agent 写入；主 Agent 统一合并和提交；关键交易代码由独立 QA 审查。Agent 完成后状态转为 REVIEW，主 Agent 集成后才转 DONE。任务失败不会静默结束，必须留下原因、复现命令和下一次可执行动作。

当前硬条件持续有效：总投入 50 美元、北京时间单日最大亏损 30 美元；真实交易保持关闭，策略默认值未因 paper 样本自动生成。旧额度耗尽的 paper run 保留为历史修正证据；当前 run `20260914-084336-6831da9cc88c` 正在有效采样，首检已有 1 quote/2 fills。账户全历史、provider 原子快照和真实成交恢复仍是明确的后续项，不再作为所有 Agent 的统一等待理由。
