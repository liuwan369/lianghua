# 运维与开发速查

## 入口和路径

| 项目 | 值 |
|---|---|
| 正式控制台 | `https://34-242-206-196.sslip.io/console/` |
| 公网节点 | `34.242.206.196`，都柏林 `eu-west-1` |
| 实例 | `t3.small`，2 vCPU，约 2 GB RAM |
| 部署根目录 | `/root/pm-system` |
| Python 上游 | `127.0.0.1:18766`，仅 loopback |
| 主服务 | `pm-system-dashboard-dublin.service` |
| 采集服务 | `pm-r25-dublin-collector.service` |
| 定时分析 | `pm-r25-dublin-live-analyzer.service` / `.timer` |
| 证据 | `/root/pm-system/data/pm-r25-live/days/dublin-evidence-*.sqlite3` |
| 账户配置 | `/root/.config/pm-system/account.json`，敏感，不输出内容 |
| 非敏感配置 | 引擎根目录 `results/dashboard/config.json` |
| 投影账本 | 引擎根目录 `results/dashboard/ledger.sqlite3` |
| 正式前端构建产物 | 仓库 `docs/console/` |

HTTP 80 跳转 HTTPS 443；Nginx `auth_basic off`。服务环境模板为 `config/pm-system-dashboard-dublin.service`，可加载 `config/dashboard-secret.env`，勿输出该文件内容。公网账户 origin 配置为 `PM_ACCOUNT_PUBLIC_ORIGIN=https://34-242-206-196.sslip.io`。

## 只读排查

登录都柏林服务器后：

```bash
systemctl status pm-system-dashboard-dublin.service --no-pager
systemctl status pm-r25-dublin-collector.service --no-pager
systemctl status pm-r25-dublin-live-analyzer.service --no-pager
systemctl list-timers pm-r25-dublin-live-analyzer.timer --all --no-pager
curl --fail --max-time 15 http://127.0.0.1:18766/api/v1/status
curl --fail --max-time 15 http://127.0.0.1:18766/api/v1/markets
```

分析器是 oneshot，`activating/start` 可能正在执行；不能只看 running 服务列表判断它停了。日志排查只摘取脱敏错误与时间戳，不复制账户密钥、请求体或 secret env。

无有效盘口时依次检查市场 token、双边报价、时间戳、采集服务和负载。账户检查 429 先等待已有请求；502/503/504 同时检查 RPC 和 CPU，不重复密集提交。

账户检查主要 RPC 为 `https://polygon.drpc.org`，备用为 `https://polygon-bor-rpc.publicnode.com`；编译缓存配置 `PM_ACCOUNT_NODE_COMPILE_CACHE=/root/.cache/pm-system/account-node-compile`。缓存只减少冷启动成本；CPUWeight=1000 不是 CPU 保留量。完整资源事实见 [CPU 诊断](CPU-DIAGNOSIS-2026-09-10.md)。

## 开发命令

仓库根目录，需要 Python 3.11+、Node.js 24+：

```powershell
python -m pip install pytest requests websocket-client
python -m pytest
npm --prefix web ci
npm --prefix web test
npm --prefix web run build
npm --prefix _external/btc-5m-market-trading-bot ci
npm --prefix _external/btc-5m-market-trading-bot test
npm --prefix _external/btc-5m-market-trading-bot run build
python scripts/system-dashboard-server.py --host 127.0.0.1 --port 8765
```

本地地址 `http://127.0.0.1:8765/console/` 仅作开发。Vite 热更新用 `npm --prefix web run dev`，代理到本地 8765。线上服务和本地服务使用不同进程、数据和配置，验收必须注明来源。

引擎显式 paper 命令与日志检查见 [引擎 README](../_external/btc-5m-market-trading-bot/README.md)。不要用未经验证的真实订单命令替代只读排查。保存配置、检查账户及页面选择 live 都不会自动完成实盘解锁。
