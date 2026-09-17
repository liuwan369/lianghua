# 反转系统部署与回退

更新：2026-09-17。当前主线：[反转交付规划](REVERSAL-DELIVERY-PLAN-2026-09-17.md)。实时交付状态见[CURRENT-STATUS](CURRENT-STATUS.md)，历史发布记录不代表当前版本。

入口 https://34-242-206-196.sslip.io/console/ 。服务器项目 `/root/pm-system`，后端 `127.0.0.1:18766`，控制台服务 `pm-system-dashboard-dublin.service`，采集服务 `pm-r25-dublin-collector.service`。

## 发布内容

- 引擎 `_external/btc-5m-market-trading-bot/src` 及 `dist`，策略显式选择 `btc-reversal`。
- `scripts/system-dashboard-server.py` 与 `scripts/dashboard/` 配置、账本和投影。
- `web/src` 与构建后的 `docs/console/`，当前规划、状态和 `docs/task-view.json`。
- 不上传或覆盖账户凭据、运行账本、原始数据、状态文件和用户保存的策略参数。

## 验证和发布

1. 实际读取服务器状态，若已有真实进程先按本轮变更安排停止新增与工作单处理；不能拿文档中的旧状态替代查询。
2. 运行受影响测试、Python集成、引擎与前端构建，独立复核发现的问题修复后再发布。软件功能用例不等于策略回测；无需多日观察。
3. 提交本批源码/测试/文档并推送Git。把本批替换文件备份到服务器私有发布目录，记录缺失的新文件，上传清单与sha256。
4. 核对归档路径，再同步源码和构建，仅重启受影响控制台。采集器未变更不重启。
5. 核对网页、静态资源、配置/运行/订单接口及服务器实际版本。真实金融操作由用户执行；随后只读核对真实结果和未覆盖事项。

## 配置和运行

独立配置保存在 `engine/results/dashboard/btc-reversal-config.json`，含版本与非秘密参数。UI参数保存不自动启动交易。启动命令使用 `dist/cli/platform.js --live --strategy btc-reversal --strategy-config <文件>`，必须传账户隔离的持久状态、日志及控制文件。

同账户同模式重复启动复用状态锁；新run只更换日志，不重新创建空账本。配置热更只影响新场。暂停新增保留旧单；停止撤余量后已成交持仓仍属于账户，不能声称停止等于平仓。

真实控制接口沿用部署控制密码和同源检查。控制密码不进入策略JSON、日志或Git。服务器交易开关和账户签名就绪必须真实读取；没有成功启动回执不能把页面按钮状态当作运行。

## 回退

改造前完整备份见[备份记录](evidence/2026-09-17/pre-reversal-backup.md)。程序回退只恢复本批替换的程序与配置模板，保留之后所有订单、成交、余额与策略状态。需要查看旧数据时恢复到独立目录，不用旧账本覆盖新交易。回退不自动启动旧做市。
