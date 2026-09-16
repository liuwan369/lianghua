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
| Codex 开发接续 | 本机 `btc` heartbeat，每 30 分钟接续当前任务；配置已启用，首个定时完成结果待核验 |

实例为 AWS eu-west-1 的 t3.small，2 vCPU、约 2 GB 内存。增量盘口和账本空闲跳过已上线，云端 CPU 等待仍偏高，见 [CPU 诊断](CPU-DIAGNOSIS-2026-09-10.md)。小时分析是研究任务，不是下单所必需的实时组件。

Codex 自动化需要本机开机且 app 运行，调度配置不部署到都柏林。2026-09-13 已将原东京预测维护任务原位改为当前做市任务 heartbeat，避免重复维护目标。任务职责、通知和冲突规避见 [协作约定第 7 节](AGENT-WORKFLOW.md#7-数据ai-与运行自动化)；配置成功不代表首轮已运行，也不表示交易已启动。

发布 `81d0f4c`（部署归档沿用发布脚本标识 `b327fa1`）已完成引擎三端同步。部署前备份位于 `/root/.pm-system-release-b327fa1/engine-before-b327fa1.tar.gz`；远端重新构建后 `src/live/orchestrator.ts`、`dist/live/orchestrator.js` 与本地 SHA-256 一致。此次包含签名 L2 账户查询与 WebSocket 用户频道证据分离、composite 日初基线校验器、北京时间午夜窗口校验和对应回归测试。两个服务均为 `active`，状态接口核对为 `mode=paper`、`running=false`、`live_unlocked=false`；未提交真实订单。composite 基线尚未采到真实日初完整 cut，因此实盘门禁继续锁定。

发布 `74db9d3` 将 live 认证探针的市场发现固定为官方 Gamma，避免服务器缺少本地 collector 时误阻塞。服务器实际探针证据：`5 shares @ 0.01`、名义金额 `$0.05`，order ACK、cancel ACK、真实用户频道撤单事件、无成交、无开放订单、余额变化 0，退出码 0；证据文件为 `docs/evidence/2026-09-14/live-auth-maker-probe-20260914.json`。随后发布 `4a2c476` 加入只读账户基线采集器，`541f673` 修正 Node 路径并启用 `pm-account-baseline.timer`。定时器下一次触发为 UTC 16:00（北京时间次日 00:00），试运行已生成 `/root/pm-system/results/account-baseline/beijing-2026-09-14.json`，因采集时为北京时间 09:37 且确认区块扫描起点未配置，文件明确标记 `eligible_for_live_bootstrap=false`。服务与交易状态仍为 `active`、`paper`、`stopped`、`live_unlocked=false`。

## 发布流程

### `hotpath-20260916-r1` durability and cold-path split (2026-09-16)

本批在完整测试和构建通过后发布到都柏林 `/root/pm-system/_external/btc-5m-market-trading-bot`。发布前状态为 `running=false`、`mode=paper`、`live_unlocked=false`；发布目录为 `/root/.pm-system-release-hotpath-20260916-r1`，旧引擎回滚包为 `engine-before-hotpath-20260916-r1.tar.gz`。下单前账户预留改为同步原子落盘，盘口/成交后的风险快照继续异步合并；热刷新失败会 fail-closed，关闭路径始终清理锁。发布后 dashboard 与 collector 均为 `active`，状态仍为停止 paper、实盘锁定，未启动真实交易。

本批本地/线上关键文件 SHA-256 一致：`account-control.ts` `618d46f7c17cd887c9f9743632c21d258d8eb656f431825f5fc26eed65e68bb3`、`account-state-store.ts` `888df07108201677edd3e650007d57733f921d8be5a1a7b651259572de4ed68e`、`risk-store.ts` `73ed3311d3174f70082a9986c520ed30a0d6210ab5fb567ded5a442ea334456b`，以及对应 dist 文件 `46f6c8f91b5cbc9654b23e19a108a65c18c293f1f4690252bd4e2386d7d37b82`、`065b3e4607a97a8a95b7c947258788cfaf2e50e9413610201a29befb1887790b`、`634281a6cd8a302bb9789b4723f8f5a08642253378350c426a8d0afe75968560`。本次最新归档 SHA-256 为 `2cfec6866f110ca9124465924147cb319551135a771beb1b1521af6090b0ac91`。

最终重建后再次发布同一批次，修正并确认的本地/线上哈希为：`src/live/account-control.ts` `1194dba9b36f1219d7dc7dcbe6cad2e786aa99f86f7473e71e480906342762c1`、`src/live/account-state-store.ts` `8694e3071b2a587503c45be2c0f0c6e2db9fbcd4dd89d70573f8d3bd2bedc320`、`src/risk-store.ts` `73ed3311d3174f70082a9986c520ed30a0d6210ab5fb567ded5a442ea334456b`；对应 dist 为 `884fadc0e62683f27f9e0c9103a1f8b48ec29fcb04f8fc2fa1aef34c3cb29fe6`、`9990abc7e1548e4a520056363074bfd712b5148945d39b3382646a697d67f61c`、`634281a6cd8a302bb9789b4723f8f5a08642253378350c426a8d0afe75968560`。最终归档 SHA-256 为 `b6e9e5580f7455ccae7172154e19d726474aaac4ef9b0fa0cfa237cedb541da7`，回滚包为 `/root/.pm-system-release-hotpath-20260916-r1/engine-before-hotpath-20260916-r1.tar.gz`；远端 dashboard 与 collector 均为 `active`，状态接口仍为 `running=false`、`mode=paper`、`live_unlocked=false`。

### `d517119` account event continuity ledger (2026-09-14)

本批已部署到都柏林 `/root/pm-system/_external/btc-5m-market-trading-bot`，并生成回滚包 `/root/.pm-system-release-2ad45d0/engine-before-2ad45d0.tar.gz`。远端完成 `npm run build`，并核对事件账本、认证用户流和编排器源码/产物哈希；`pm-system-dashboard-dublin.service` 与 `pm-r25-dublin-collector.service` 均为 `active`。状态接口复核为 `mode=paper`、`running=false`、`live_unlocked=false`，未提交真实订单。

本批运行路径改为事件流优先：认证/订阅证据、持久化事件序列、断线 marker、成交与开放订单双 REST 补偿、周期对账；原子账户 provider 仍只用于高保证启动/恢复。GitHub `origin/master` 推送在本机连续两次因远端连接重置失败，不能把该次失败误报为 GitHub 已同步；服务器发布和本地提交已核对，待网络恢复后补推 `2ad45d0`、`d517119`。

### `c61f82b` atomic source transport hardening (2026-09-14)

`c61f82b` 已发布并构建成功。权威账户 URL 现在只允许 HTTPS；配置 provider 时 live 编排延迟普通 CLOB reader，避免无关凭据或网络故障阻塞权威 bootstrap。发布回滚包位于 `/root/.pm-system-release-c61f82b/engine-before-c61f82b.tar.gz`。远端两个服务均为 `active`，状态接口复核 `mode=paper`、`running=false`、`live_unlocked=false`，未提交真实订单。

后续本地改动还要求 `PM_ATOMIC_ACCOUNT_BEARER_TOKEN` 才能调用 provider；该配置尚未写入服务器，因为 provider endpoint 尚未交付。

### `b221ee1` provider authentication hardening (2026-09-14)

`b221ee1` 已发布并构建成功。`PM_ATOMIC_ACCOUNT_URL` 现在必须使用 HTTPS 且同时配置受保护的 `PM_ATOMIC_ACCOUNT_BEARER_TOKEN`，否则 live bootstrap 直接拒绝。回滚包位于 `/root/.pm-system-release-b221ee1/engine-before-b221ee1-srcdist.tar.gz`；两个服务 `active`，状态接口仍为 `mode=paper`、`running=false`、`live_unlocked=false`。

### `d03a179` account scan hardening (2026-09-14)

本地提交 `d03a179` 已发布到都柏林 `/root/pm-system`。发布前短暂停止 dashboard 以生成一致的引擎回滚包 `/root/.pm-system-release-d03a179/engine-before-d03a179.tar.gz`，替换后重新构建并启动服务。远端源码/产物哈希已在发布输出核对：`account-finance.ts` `3de7bbe0173b45ecdf2acd3b8cf160aa407ed006deb2d7e2fd6a0404d1e1b4f5`、`account-control.ts` `0b67a7d711b49f0e115642299bd6a80b6d617510dc69e9974aa07bc670cca062`、`orchestrator.ts` `d87048633cb6418b2110ff531b0d773b50f32321617b27ece3998f63bdd1949c`。两个 systemd 服务恢复为 `active`，状态接口确认 `mode=paper`、`running=false`、`live_unlocked=false`。发布过程中没有提交真实订单。

本批新增区块资金流扫描仍是只读证据：都柏林当前已配置保留窗口起点 `PM_FINANCE_SCAN_FROM_BLOCK=93716480`、`12` 个确认和按钱包索引过滤；最近一次双读覆盖到确认头 `93769856` 并发现 90 条转账。扫描完整只代表该窗口已覆盖，不等于钱包自创建以来的历史账本、opening 基线或权益 reconciliation 完整，因此不会改变实盘门禁。PublicNode 对钱包合约创建点 `93280522` 之前的历史已裁剪，完整生命周期仍需归档 RPC 或 provider-owned 原子账户源。

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

### 875b488 EXEC-02 bootstrap hardening 发布

提交 `875b488` 已推送 `origin/master`，并将账户 bootstrap 证据校验、来源时间戳、异步状态保护和对应测试发布到都柏林引擎。发布归档 `.deploy/engine-875b488.tar.gz` SHA-256 为 `6214748084f1e556487a82f48d90f4b7f3dfc0aac91b3b295b447b383524ddf7`；线上回滚备份为 `/root/.pm-system-release-875b488/engine-before-875b488.tar.gz`。本地与线上关键文件 SHA-256 一致：`account-control.ts` `f70ebbfdc2d87b2a1b4384736b7c885e8992f310cd912c9a63ad721ffe34503d`、`dist/live/account-control.js` `cc34e97a920c9a83f57101fa3ae68e1fdd07ca6a0a9ea7a3aa36f0bc85d2f4ee`、`dist/live/orchestrator.js` `b08558d6d862573504afa654639fc9498c67d4f4e9f4945b3d2dc05af20e585d`、`dist/live/account-equity.js` `e4c099a4ccfa0f3228f086441834ed85e98355c6d3dab1274bdde6b0e165340b`。

发布前后控制台和采集器均为 `active`，API 均核对 `running=false`、`mode=paper`、`live_unlocked=false`、projection `ready`。该发布没有启用真实交易；由于线上 `connectAccountReader` 仍不提供原子资金流和 opening/current bootstrap evidence，live 继续 fail-closed。

文档补充提交 `ae73618` 已单独同步 `docs/` 和 `scripts/`，归档 SHA-256 为 `8d8bfe0081ba68ee7380aca633b11ac2e6cf1cc4ddc5503dfb06e251e584617c`，回滚目录为 `/root/.pm-system-release-ae73618`；该批不重启服务、不替换引擎和运行数据。

### ebbab58 EXEC-02/replay 集成发布

提交 `ebbab58e7a00f4bd53e5ee456d341216ec72bab4` 已推送 `origin/master`，并于 2026-09-13 16:00 左右（北京时间）将本批引擎、回放诊断和证据文档发布到都柏林。发布归档 `.deploy/release-ebbab58.tar.gz` 的本地 SHA-256 为 `c4b64622c013cc8be7460129ef7815fbe99359f70419fc01f499d4f6eadb21a3`；线上回滚备份为 `/root/.pm-system-release-ebbab58/before.tar.gz`，备份 SHA-256 为 `19761fb3bd8d40a0efe55a564da563bb5ccca5f601d5990d821f3f26dd963079`。发布脚本在替换前确认交易已停止、paper 模式和实盘锁关闭，失败路径保留恢复备份。

随后文档提交 `d4e8c37` 已单独同步 `docs/` 和 `scripts/`，归档 SHA-256 为 `d1d6f1e2cfaf8d43b63fc7f3c107789f59a56067aa2ff9199ebf03cd2e376e83`，线上回滚目录为 `/root/.pm-system-release-d4e8c37`（备份 `/root/.pm-system-release-d4e8c37/docs-and-scripts-before.tar.gz`）。补充记录提交 `ead5f09` 又同步一次，归档 SHA-256 为 `9f6fb8d303056695c3539a4a37399583e3516755565e0650404b845e1d341f40`，仍使用该发布目录并更新备份。两批均不重启服务，不替换引擎、账本、行情库或账户文件；同步后两个服务仍为 `active`，状态和投影再次核对为 stopped paper / `ready`。

发布后只重启了控制台，采集器未重启；两个服务均为 `active`。线上引擎重建哈希与本地重建一致。公网状态核对为 `running=false`、`mode=paper`、`live_unlocked=false`。发布不代表 EXEC-02 已满足实盘条件：当前账户 reader 仍为非原子快照，执行门禁继续拒绝 live。

发布后发现 dashboard 选择的历史 run `20260911-054956-e30715299735` 日志已被替换为空文件，投影层按设计报告 `incomplete`，未删除账本或历史数据。使用已保存的 paper 配置（`revision=1`、`duration_min=0.1`、`max_total_usd=2`）完成一次约 6 秒的只读/模拟 smoke run，生成 run `20260913-082538-b7262e8e56aa`；自动停止后投影为 `ready`，0 fills，376 个行情年龄/盘口处理样本和 462 个策略决策样本，`stats.error=null`。该修复未启用真实交易、未改动账户或风险额度；旧损坏 run 保留在 `/api/v1/runs` 供历史审计。

研究提交 `837f3a3` 已完成 Git 推送，并以 docs/scripts-only 方式同步到服务器；归档 SHA-256 为 `52836945ed54c35d5ddbcd0830acf2dc7ea44932860bb13f84502ecd8ec429af`，回滚目录为 `/root/.pm-system-release-837f3a3`。该批新增价格/方向/队列/报价生命周期诊断，仅更新离线研究脚本和证据，不重启服务、不改变线上引擎、账户、账本或交易状态。

### 52b1d68 执行门禁发布尝试

本地提交 `52b1d68` 已完成引擎全量测试、构建和统一验证，生成 `.deploy/engine-52b1d68.tar.gz`。2026-09-13 尝试向都柏林服务器发布两次，均在 Paramiko SSH 握手阶段以 `SSHException: No existing session` 失败；远端未执行上传、解压、重启或交易操作，线上仍保持此前版本、两个服务 active、`running=false`、`mode=paper`、`live_unlocked=false`。发布包和本地回滚证据保留，网络恢复后重新运行 `.deploy/deploy-engine.py`，成功后补充远端哈希清单；当前不能报告三端同步完成。

提交 `029948d` 增加离线 EXEC-02 权益核算契约和 23 项回归。它只包含引擎源码/测试和证据文档，尚未接入运行入口或执行器，因此没有部署到都柏林；部署前后线上仍以已核对的 `cbbdcee` 文档/回放版本和 stopped paper 状态为准。接入权威账户适配、持久化预留和下单门禁后，必须作为新的代码发布批次重新构建、备份和核对。

随后提交 `f4d96f4` 增加离线原子预留契约、5 项回归及相关交付证据。文档发布 `f4d96f4125b7-docs` 已于 2026-09-13 06:56（北京时间）完成本地/服务器逐文件校验；线上状态为 `running=false`、`mode=paper`、`live_unlocked=false`，两个服务均 `active`。该发布仍只同步文档，未部署未接入运行入口的预留源码，也未重启服务。

发布 `4a8a9c1` 已推送 `origin/master`，并将引擎源码与构建产物部署到 `/root/pm-system/_external/btc-5m-market-trading-bot`。线上备份为 `/root/.pm-system-release-4a8a9c1/engine-before-4a8a9c1.tar.gz`。部署前线上交易未运行，部署后未启动交易；控制台和采集器均保持 `active`，`/api/v1/status` 为 `running=false`、`mode=paper`、`live_unlocked=false`。

关键文件哈希（本地与线上一致）：`src/risk-store.ts` `fda4fb7596509de90c02b4575f20367e623db1b842b2649644dfeff471d7d6ed`；`dist/risk-store.js` `9694230ae8de080dd5baa73c53c73ff9dfbd49a94cc5e43d5670b90b89b053cc`；`dist/live/engine.js` `01500527c83db0bcadf02827a6056014f32db817fc52b48363c13d17dbdd1994`；`dist/live/orchestrator.js` `90d5859cec36a5e18582398d9fabcb74f6fe410ce2fe11db50e6a49d942a02f3`。这是引擎增量发布核对，不代表服务器全部项目文件与本地工作树无差异；前端用户改动和未归属服务仍未纳入本批发布。

随后 `c9075b9` 已推送远端，并同步 `docs/` 与 `scripts/` 到都柏林，归档 SHA-256 为 `a88ff231057eec78a10cbaa116805cf9b93e9003819a7ad14bfbca089ac89128`。线上回滚目录为 `/root/.pm-system-release-c9075b9`，两个服务仍为 `active`，状态仍为停止 paper。该次同步不重启服务；引擎代码仍对应已核对的 `4a8a9c1`，因此应理解为文档/研究脚本增量同步，非完整源树同 SHA 发布。

### 财务观测与回放修复发布

代码提交 `aff7d5378b56d96fcdedd5593bcebc757a628f60` 已推送远端。发布 `aff7d5378b56-finance-replay` 于 2026-09-13 04:00 北京时间完成 22 个文件的本地/服务器逐文件 SHA-256 核对：财务读取源码和编译产物、回放脚本、对应测试及文档。完整清单在本地 `.deploy/releases/aff7d5378b56-finance-replay/manifest.json` 和服务器 `/root/.pm-system-release-aff7d5378b56-finance-replay/manifest.json`。这是指定文件范围内的三端发布，不表示现有未提交前端改动或服务器全部历史文件已镜像。

回滚备份：`/root/.pm-system-release-aff7d5378b56-finance-replay/before.tar.gz`。清单同时记录原文件哈希和发布前不存在的文件；恢复仅处理这些路径，不覆盖账户、交易、账本、风险状态或行情数据库。已在隔离测试中验证发布成功、验证失败后停止新进程、恢复旧文件、重新启动旧进程，以及采集器异常不能误报成功。

只重启了控制台，采集器未重启。发布前后两个服务均为 `active`，交易状态均为 `running=false`、`mode=paper`、`live_unlocked=false`。公网账户接口随后返回新 `risk_contract`、占用估算和来源时间差，`available=true`、`stale=false`，`spendable_balance=null`、`execution_ready=false`。没有启动实盘或调整保存的前端配置。

本机直连 GitHub 失败后，本批通过已有都柏林 SSH 的临时 SOCKS 通道推送，Git 配置未永久修改；SSH 密钥、密码及账户凭据未进入发布文件。后续证据文档的提交单独以 docs 清单同步，不重启服务，也不替换上述已核对代码。
发布 `724f80f` 已完成执行引擎批次同步。归档 `.deploy/engine-724f80f.tar.gz` SHA-256 为 `8236148adf90945559e5a78d5d3cc4cd60b1163e7746a15148032fae552b2243`，线上回滚备份为 `/root/.pm-system-release-724f80f/engine-before-724f80f.tar.gz`。发布前后两个服务均为 `active`，公网 `/api/v1/status` 均核对 `running=false`、`mode=paper`、`live_unlocked=false`，projection 为 `ready`。本批新增 provider-owned 原子账户源适配器，但线上未配置 `PM_ATOMIC_ACCOUNT_URL`，因此没有解锁真实交易。
发布 `b7bca8d` 已加入订单生命周期证据字段并完成都柏林部署。引擎归档 SHA-256 为 `8da9e66b00f07e58cac17d66c32a0303532e3af82debc344a8ca169ab2deb4a2`，线上回滚备份为 `/root/.pm-system-release-b7bca8d/engine-before-b7bca8d.tar.gz`；文档/证据同步归档 SHA-256 为 `c645f7f6f55a0e6a6c9beb8a84896f2e6ae94b11854320bc0235b8264e7d1389`。发布后服务均 `active`，`running=false`、`mode=paper`、`live_unlocked=false`，projection `ready`。
# 2026-09-16 功能架构与策略接口增量发布

`8463da3` 已推送 Git；发布 `architecture-20260916T014221Z-59093f` 已部署 85 个差异文件并逐文件验证 SHA-256。备份目录为 `/root/.pm-releases/architecture-20260916T014221Z-59093f/`，其中 `before/` 与 `manifest.json` 记录旧文件和原先不存在的新增文件。前端状态文案后续提交为 `1a653aa`。

本批不重启服务、不启动交易；控制台和 collector active，paper stopped、live locked。回退仅恢复清单中的旧文件和移除本批新增文件，保留账户、交易和行情状态。详见 [发布记录](evidence/2026-09-16/architecture-strategy-release.md)。
