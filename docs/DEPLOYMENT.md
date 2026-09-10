# 都柏林部署

核对日期：2026-09-10。正式入口：[https://34-242-206-196.sslip.io/console/](https://34-242-206-196.sslip.io/console/)。HTTP 80 跳转 HTTPS 443，后端仅监听 127.0.0.1:18766。

本次源码与构建已同步，采集器/控制台服务 active；07:12 UTC 公网页面及五个状态接口 HTTP 200，采集在线、实盘锁关闭，账户文件未改变：[发布核对记录](evidence/2026-09-10/dublin-release-check.json)。

## 当前组件

| 组件 | 位置/服务 |
| --- | --- |
| 项目 | /root/pm-system |
| 引擎 | /root/pm-system/_external/btc-5m-market-trading-bot |
| 控制台 | pm-system-dashboard-dublin.service |
| 采集 | pm-r25-dublin-collector.service |
| 小时研究分析 | pm-r25-dublin-live-analyzer.timer / .service |
| 日轮换重启 | pm-r25-dublin-daily-restart.timer / .service |
| 公网代理 | Nginx；config/pm-system-dashboard-dublin-public.conf |
| 账户配置 | /root/.config/pm-system/account.json（不进仓库） |
| 非秘密配置、账本与投影 | 引擎 results/dashboard/ |
| 日行情库 | data/pm-r25-live/days/dublin-evidence-YYYY-MM-DD.sqlite3 |

实例为 AWS eu-west-1 的 t3.small，2 vCPU、约 2 GB 内存。CPU 等待及重复计算问题尚未解决，见 [CPU 诊断](CPU-DIAGNOSIS-2026-09-10.md)。小时分析是研究任务，不是下单所必需的实时组件。

## 发布流程

1. 先运行 [回归与构建](TESTING.md)。源码提交不包含 node_modules、dist、docs/console、原始数据库或账户秘密。
2. 核对服务器运行状态。运行中的实盘引擎不得用普通进程强杀或重启来替代撤单/对账；当前实际运行模式为 paper，实盘锁关闭。
3. 备份本次将替换的非秘密运行文件，上传对应源码、引擎 dist 与前端 docs/console，并校验内容。重命名时清掉准确对应的旧产物，避免编译残留。
4. 服务单元使用 config 中的都柏林模板。账户公开来源/RPC/编译缓存 drop-in 来自 pm-system-dashboard-dublin-public-account.conf；秘密环境文件在服务器单独管理。单元变更执行 systemctl daemon-reload，仅重启涉及的服务。
5. Nginx 配置变更先运行 nginx -t，再 reload。证书更新使用仓库 certbot hooks 与 renew-http 配置。
6. 核对公网 /console/、静态资源、status/config/markets/runs/account 状态接口和行情新鲜度，确认实际来源为都柏林。更改账户检查链路时验证错误处理，不能用覆盖正式账户或真实订单代替测试。

本仓库没有覆盖所有步骤的一键生产发布工具；不要把 Git 推送等同于服务器部署。当前公开控制台按已确定配置免登录，账户操作的暴露范围与独立交易限制见 [配置](CONFIGURATION.md)。
