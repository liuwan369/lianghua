# Polymarket 五分钟反转系统

真钱实盘系统：在 Polymarket 的加密货币 5 分钟涨跌盘（`<币>-updown-5m-<roundId>`）上跑 `btc-reversal` 反转策略。一边卖一价从下往上穿过触发价时，用限价买入这一边；方向反转时加仓另一边，按阶梯最多 N 级。收盘后自动结算。

## 控制台

https://34-242-206-196.sslip.io/console/ （nginx basic auth）。四个页面，都在 `frontend/console/`：

- 自动交易 `auto-trade.html`（首页，`index.html` 跳转到这里）：启动/暂停/停止、当前场盘口、本场持仓与订单、历史订单（按场次）、交易统计、服务器状态、清空数据。
- 市场 `market.html`：币种目录，选一个币进运行池。
- 策略 `strategy.html`：策略参数，保存草稿、发布。
- 设置 `settings.html`：连接诊断、账户检查与保存、控制密码、运行日志。

## 服务器

AWS 都柏林单机 `root@34.242.206.196`，运行目录 `/root/pm-system`。nginx 443 做 basic auth，反代到只监听 `127.0.0.1:18766` 的控制面。交易引擎只能在控制台由人启动。账户秘密只在服务器上。

## 目录

- `backend/engine/`：TypeScript 交易引擎、行情采集器、账户读取器（Node ≥ 24）。
- `scripts/`：Python 控制面 `system-dashboard-server.py`、`dashboard/` 读模型、部署脚本。
- `frontend/console/`：静态控制台，由控制面托管。
- `config/`：systemd 单元和 nginx 配置。

## 部署

```
python scripts/deploy-reversal-release.py
```

不带参数，只部署已提交的 HEAD（未提交的改动不会上线）。交易必须处于停止状态，否则拒绝。详见 [ARCHITECTURE.md](ARCHITECTURE.md#部署与回滚)。

## 测试

```
cd backend/engine && npm run typecheck && npm run build
node backend/engine/scripts/regress/<名字>.mjs     # 先 build；另有 scripts/check-*.mjs
python scripts/regress/<名字>.py
node frontend/console/regress/<名字>.mjs
```

没有测试框架，每个回归脚本单独运行，退出码 0 即通过。

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：进程、模块、数据流、策略、风控、结算、文件、部署、已知限制。
- [API.md](API.md)：控制面 HTTP 接口和推送。
- [AGENTS.md](AGENTS.md)：铁律和工作方式。
