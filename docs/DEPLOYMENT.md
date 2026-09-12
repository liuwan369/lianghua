# 都柏林部署

当前自主发布与三端同步要求按 [交付规划 v2](STRATEGY-DELIVERY-PLAN-2026-09-13.md) 和 [Agent 协作约定](AGENT-WORKFLOW.md) 执行。用户已授权服务器维护、部署和问题修复，以下历史记录不构成重复等待授权的要求。每批核对本地/Git/服务器发布清单；版本回滚保留新交易、账本与风险状态。

核对日期：2026-09-13。正式入口：[https://34-242-206-196.sslip.io/console/](https://34-242-206-196.sslip.io/console/)。HTTP 80 跳转 HTTPS 443，后端仅监听 127.0.0.1:18766。最新增量版本见本文末尾。

历史发布：2026-09-11 账户财务与历史恢复修复 `b9880eb`，34个发布文件内容一致，公网JS与构建SHA-256一致，账户接口通过前端实际严格校验。账户文件未改变，只重启控制台以刷新常驻账户读取进程，采集器未重启；交易未运行且实盘锁关闭：[公网验证](evidence/2026-09-11/finance-release-check.json)。该批回滚备份位于 `/root/.local/share/pm-system-recovery/20260911-finance-b9880eb.tar.gz`，只备份被替换的文件。

## 当前组件

| 组件 | 位置/服务 |
| --- | --- |
| 项目 | /root/pm-system |
| 引擎 | /root/pm-system/_external/btc-5m-market-trading-bot |
| 控制台 | pm-system-dashboard-dublin.service |
| 采集 | pm-r25-dublin-collector.service |
| 历史分析资源组 | pm-analysis.slice，CPUQuota=20%（0.2 核），MemoryMax=512M |
| 小时研究分析 | pm-r25-dublin-live-analyzer.timer / .service |
| 日轮换重启 | pm-r25-dublin-daily-restart.timer / .service |
| 公网代理 | Nginx；config/pm-system-dashboard-dublin-public.conf |
| 账户配置 | /root/.config/pm-system/account.json（不进仓库） |
| 非秘密配置、账本与投影 | 引擎 results/dashboard/ |
| 日行情库 | data/pm-r25-live/days/dublin-evidence-YYYY-MM-DD.sqlite3 |

实例为 AWS eu-west-1 的 t3.small，2 vCPU、约 2 GB 内存。增量盘口和账本空闲跳过已上线，云端 CPU 等待仍偏高，见 [CPU 诊断](CPU-DIAGNOSIS-2026-09-10.md)。小时分析是研究任务，不是下单所必需的实时组件。

## 发布流程

1. 先运行 [回归与构建](TESTING.md)。源码提交不包含 node_modules、dist、docs/console、原始数据库或账户秘密。
2. 核对服务器当时运行状态。运行中的实盘引擎先停止新增委托并完成撤单/对账，再按具体故障处理进程；不能用文档中的历史 paper 状态代替上线前检查。
3. 备份本次将替换的非秘密运行文件，上传对应源码、引擎 dist 与前端 docs/console，并校验内容。重命名时清掉准确对应的旧产物，避免编译残留。
4. 服务单元使用 config 中的都柏林模板。账户公开来源/RPC/编译缓存 drop-in 来自 pm-system-dashboard-dublin-public-account.conf；秘密环境文件在服务器单独管理。单元变更执行 systemctl daemon-reload，仅重启涉及的服务。分析资源隔离需同步安装 pm-analysis.slice 和分析 service，并重新启动分析任务以迁入新 cgroup；不要重启未改动的采集器。
5. Nginx 配置变更先运行 nginx -t，再 reload。证书更新使用仓库 certbot hooks 与 renew-http 配置。
6. 核对公网 /console/、静态资源、status/config/markets/runs/account 状态接口和行情新鲜度，确认实际来源为都柏林。更改账户检查链路时验证错误处理，不能用覆盖正式账户或真实订单代替测试。

本仓库没有覆盖所有步骤的一键生产发布工具；不要把 Git 推送等同于服务器部署。当前公开控制台按已确定配置免登录，账户操作的暴露范围与独立交易限制见 [配置](CONFIGURATION.md)。

本轮回滚文件备份：`/root/.local/share/pm-system-recovery/20260910-072809-cpu`。账本 schema 2 的 ledger.py、projection_worker.py、read_model.py 必须成套部署；heartbeat.json 自动生成。

账户读取的 Python模块、Node入口和实现及前端构建需同步部署；后台自动启动常驻只读进程。当前备份：`/root/.local/share/pm-system-recovery/20260910-094339-account-data`。浏览器操作因工具不能识别URL而停止，公网API核验不能替代该项验收。

## 2026-09-13 增量发布

发布 `4a8a9c1` 已推送 `origin/master`，并将引擎源码与构建产物部署到 `/root/pm-system/_external/btc-5m-market-trading-bot`。线上备份为 `/root/.pm-system-release-4a8a9c1/engine-before-4a8a9c1.tar.gz`。部署前线上交易未运行，部署后未启动交易；控制台和采集器均保持 `active`，`/api/v1/status` 为 `running=false`、`mode=paper`、`live_unlocked=false`。

关键文件哈希（本地与线上一致）：`src/risk-store.ts` `fda4fb7596509de90c02b4575f20367e623db1b842b2649644dfeff471d7d6ed`；`dist/risk-store.js` `9694230ae8de080dd5baa73c53c73ff9dfbd49a94cc5e43d5670b90b89b053cc`；`dist/live/engine.js` `01500527c83db0bcadf02827a6056014f32db817fc52b48363c13d17dbdd1994`；`dist/live/orchestrator.js` `90d5859cec36a5e18582398d9fabcb74f6fe410ce2fe11db50e6a49d942a02f3`。这是引擎增量发布核对，不代表服务器全部项目文件与本地工作树无差异；前端用户改动和未归属服务仍未纳入本批发布。

随后 `c9075b9` 已推送远端，并同步 `docs/` 与 `scripts/` 到都柏林，归档 SHA-256 为 `a88ff231057eec78a10cbaa116805cf9b93e9003819a7ad14bfbca089ac89128`。线上回滚目录为 `/root/.pm-system-release-c9075b9`，两个服务仍为 `active`，状态仍为停止 paper。该次同步不重启服务；引擎代码仍对应已核对的 `4a8a9c1`，因此应理解为文档/研究脚本增量同步，非完整源树同 SHA 发布。

### 财务观测与回放修复发布

代码提交 `aff7d5378b56d96fcdedd5593bcebc757a628f60` 已推送远端。发布 `aff7d5378b56-finance-replay` 于 2026-09-13 04:00 北京时间完成 22 个文件的本地/服务器逐文件 SHA-256 核对：财务读取源码和编译产物、回放脚本、对应测试及文档。完整清单在本地 `.deploy/releases/aff7d5378b56-finance-replay/manifest.json` 和服务器 `/root/.pm-system-release-aff7d5378b56-finance-replay/manifest.json`。这是指定文件范围内的三端发布，不表示现有未提交前端改动或服务器全部历史文件已镜像。

回滚备份：`/root/.pm-system-release-aff7d5378b56-finance-replay/before.tar.gz`。清单同时记录原文件哈希和发布前不存在的文件；恢复仅处理这些路径，不覆盖账户、交易、账本、风险状态或行情数据库。已在隔离测试中验证发布成功、验证失败后停止新进程、恢复旧文件、重新启动旧进程，以及采集器异常不能误报成功。

只重启了控制台，采集器未重启。发布前后两个服务均为 `active`，交易状态均为 `running=false`、`mode=paper`、`live_unlocked=false`。公网账户接口随后返回新 `risk_contract`、占用估算和来源时间差，`available=true`、`stale=false`，`spendable_balance=null`、`execution_ready=false`。没有启动实盘或调整保存的前端配置。

本机直连 GitHub 失败后，本批通过已有都柏林 SSH 的临时 SOCKS 通道推送，Git 配置未永久修改；SSH 密钥、密码及账户凭据未进入发布文件。后续证据文档的提交单独以 docs 清单同步，不重启服务，也不替换上述已核对代码。
