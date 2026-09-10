# 云仓库备份规则

远程仓库：<https://github.com/liuwan369/lianghua>。

可提交源码、配置模板、测试、中文文档、公开研究来源和经过脱敏的最小验收证据。原始行情库、实际账户配置和秘密不属于代码备份。

禁止提交钱包私钥、API secret、服务器密码、SSH 私钥、真实 `.env`、依赖目录、虚拟环境、SQLite 原始采集库、行情压缩包和未审查运行日志。验收 JSON/JSONL 只能保留复核所需字段，不得含原始凭据或认证请求头。

推送前检查 `git status --short`、`git diff --check`、`git diff --cached --stat` 和暂存内容，确认提交范围及秘密排除。当前分支和发布版本应先用 `git branch --show-current`、`git log --oneline --decorate -10` 核实，不用文档中的示例替代实际分支。

Git 回滚只恢复源码，不能自动恢复业务数据库、资金、委托或服务器环境。部署回滚需同时匹配前端、接口、引擎和账本 schema；保留部署后新增事件与账户配置。存在未核对委托或持仓时，先完成停止与对账，再执行版本恢复，不能通过强杀进程冒充停止完成。

发布与恢复流程见 [部署说明](DEPLOYMENT.md)，测试要求见 [测试说明](TESTING.md)。
