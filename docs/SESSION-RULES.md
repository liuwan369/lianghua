# 会话启动规则

所有会话都必须先读：

- `C:\Users\Administrator\Desktop\话术.txt`
- 当前 worktree 根目录的 `AGENTS.md`
- `docs/WORKSTREAMS.md`

## 共同铁律

- 交付优先，先修真实执行链路，再补说明。
- 不做过度工程化、流程主义、审计驱动开发、过早抽象。
- 不用安全门槛、历史数据或纸面验证阻挡当前功能交付。
- 只维护 BTC 五分钟反转策略；不恢复做市、paper、回测和研究链路。
- 优先借鉴并复用 `backend/engine` 和 `backend/reference/web` 的成熟实现，不凭空重写。
- 代码要快，实时路径不和低频统计、资源采样、历史查询混在一起。
- 只改自己负责的目录；不要重置、覆盖或回滚其他会话的修改。
- 不把密钥、密码、账户秘密写进代码、文档、日志或前端。
- 每次完成后只报告：改了什么、怎么验证、还有什么真实风险。

## 会话目录和任务

| 会话 | 分支 | worktree | 负责目录 |
|---|---|---|---|
| 前端 | `codex/frontend-console` | `C:\Users\Administrator\Desktop\polymarket\.worktrees\frontend-console` | `frontend/console/` |
| 行情 | `codex/market-data` | `C:\Users\Administrator\Desktop\polymarket\.worktrees\market-data` | `backend/engine/src/live/feeds/`、`discovery.ts`、`orderbook.ts` |
| 交易运行 | `codex/trading-runtime` | `C:\Users\Administrator\Desktop\polymarket\.worktrees\trading-runtime` | `backend/engine/src/strategies/`、`platform/`、`live/clob/` |
| 账本 API | `codex/ledger-api` | `C:\Users\Administrator\Desktop\polymarket\.worktrees\ledger-api` | `backend/control-plane/scripts/`、`shared/contracts/` |
| 集成 | `codex/integration` | `C:\Users\Administrator\Desktop\polymarket\.worktrees\integration` | 跨模块接线、部署和端到端验证 |

主工作文件夹始终是 `C:\Users\Administrator\Desktop\polymarket`。`.worktrees` 只是同一 Git 仓库的分支隔离目录，完成后由集成分支合并回主目录。Codex 左侧顶层会话需要用户在这个项目下点击“新对话”，不能用并行 worker 代替。

## 完成标准

- 模块可以独立运行或通过现有测试验证。
- 接口字段与 `shared/contracts` 一致。
- 错误、断线、过期数据不会伪造成功或清空成零。
- 没有无关的大规模重构。
- 集成会话只在模块交付后接线，不提前重写模块。

## 集成顺序

`行情 → 策略判断 → 下单执行 → 成交/结算 → 账本统计 → API → 前端`。

部署初期保持一个后端进程，前端独立静态部署；只有真实性能或运维问题出现后才拆进程。
