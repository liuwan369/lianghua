# 反转系统部署与回退

更新：2026-09-18。当前程序基线为 `1c304ebd21476d17a031c188b18d9d2def47b092`，主线为 [反转交付规划](REVERSAL-DELIVERY-PLAN-2026-09-17.md) v2.6。实时交付状态见 [CURRENT-STATUS](CURRENT-STATUS.md)，历史发布记录不代表当前版本。

入口 https://34-242-206-196.sslip.io/console/ 。服务器项目 `/root/pm-system`，后端 `127.0.0.1:18766`，控制台服务 `pm-system-dashboard-dublin.service`，公共行情服务 `pm-clob-market-snapshot.service`。旧 pm-r25 采集、分析、重启服务及 timer 已从生产主机删除，状态为 `not-found/inactive`；历史数据和程序回退包保留。

当前发布目录为 `/root/.pm-releases/reversal-1c304eb-20260918T112829Z`，归档 SHA-256 为 `8744df3f1a64219b9965fbbb391b7e5fdb6d8e7c123ae9177f737e63789aece3`。manifest 校验 `495` 个文件，本批实际更新 `9` 个、删除 `14` 个。发布后自动交易保持 `running=false`、`mode=null`、`strategy_id=null`、`live_unlocked=false`，开放订单和当前有效持仓均为 `0`；真实生命周期、实际费用、结算到账和正式运行仍未完成。

## 发布内容

- 引擎 `_external/btc-5m-market-trading-bot/src` 及 `dist`，策略显式选择 `btc-reversal`。
- `scripts/system-dashboard-server.py` 与 `scripts/dashboard/` 配置、账本和投影。
- 独立只读 CLOB 行情投影 `src/cli/market-snapshot.ts`、`src/dashboard/market-projection.ts` 和 `pm-clob-market-snapshot.service`。
- `web/src` 与构建后的 `docs/console/`，当前规划、状态和 `docs/task-view.json`。
- 不上传或覆盖账户凭据、运行账本、原始数据、状态文件和用户保存的策略参数。

## 验证和发布

以下为可复现流程；当前发布结果见上文。唯一规范发布入口（canonical）为版本化脚本 `python scripts/deploy-reversal-release.py`，脚本不接受 revision 参数，以执行目录的 Git `HEAD` 为目标 commit。

1. 实际读取服务器状态；若已有真实进程，先安排停止新增与工作单处理。脚本要求部署前 `running=false`、`live_unlocked=false`，不能拿文档中的旧状态替代查询。
2. 运行受影响测试、Python 集成、引擎与前端构建，独立复核发现的问题修复后再发布。最近定向 Python 为 `93` 项通过，较广 Python 保留范围为 `541` 项通过、`1` 项跳过（排除 3 个既有研究文件）；前端沿用最近 `81` 项通过结果。软件功能用例不等于策略回测；无需多日观察。
3. 提交并推送待发布的程序变更，确认 `HEAD` 为目标 commit。脚本通过 Git archive 创建独立干净源码目录，在该目录重新构建引擎与前端；依赖使用本地已安装的 `node_modules`。共享工作区中未提交的源码和现有构建产物不进入发布包。
4. 脚本生成版本化归档和逐文件 SHA-256 manifest，并在发布结果中记录归档 SHA-256。服务器校验归档成员、路径白名单和文件哈希；根据 manifest 计算需要更新的文件、已删除源码、不再使用的构建产物和旧 systemd 单元。
5. 写入前保存替换/删除文件的 `before.tar.gz`、部署前缺失文件的 `missing-before.json`、受影响 unit 的原文件及 `unit-states-before.json`。随后原子替换程序，清理 manifest 中的旧源码和产物，停止、禁用并删除退休的 pm-r25 service/timer，安装当前 unit 并执行 `daemon-reload`。
6. 脚本按变更重启控制台或公共行情服务，重新校验全部文件哈希、旧文件已删除、退休 unit 未安装且未启用，并读取状态接口确认交易仍停止且未解锁。发布结果保存在服务器版本目录和本地 `.deploy` 中；脚本不会启动真实交易。
7. 核对网页、静态资源、配置/运行/订单接口及服务器实际版本。真实金融操作由用户执行；随后只读核对真实结果和未覆盖事项。

## 配置和运行

独立配置保存在 `engine/results/dashboard/btc-reversal-config.json`，这里的 `engine/` 仍指 `_external/btc-5m-market-trading-bot/`，目录迁移尚未执行。配置含版本与非秘密参数，UI 参数保存不自动启动交易。启动命令使用 `dist/cli/platform.js --live --strategy btc-reversal --strategy-config <文件>`，必须传账户隔离的持久状态、日志及控制文件。

同账户同模式重复启动复用状态锁；新run只更换日志，不重新创建空账本。配置热更只影响新场。暂停新增保留旧单；停止撤余量后已成交持仓仍属于账户，不能声称停止等于平仓。

真实控制接口沿用部署控制密码和同源检查。控制密码不进入策略JSON、日志或Git。服务器交易开关和账户签名就绪必须真实读取；没有成功启动回执不能把页面按钮状态当作运行。

## 回退

应用或发布后检查失败时，脚本删除本次新增文件，从 `before.tar.gz` 恢复替换/删除前的文件，恢复原 unit 文件，执行 `daemon-reload`，再恢复部署前 unit 的启用方式和运行状态。

改造前完整备份见 [备份记录](evidence/2026-09-17/pre-reversal-backup.md)。程序回退只替换程序、静态资源及必要的 unit 配置，不能用旧备份覆盖新订单、成交、持仓、资金、运行账本或结算状态。需要查看旧数据时恢复到独立目录。回退不自动启动旧做市或真实交易。
