# Polymarket 五分钟币安领先系统

真钱实盘系统：在 Polymarket 的 btc 5 分钟涨跌盘（`btc-updown-5m-<roundId>`）上跑 `binance-lead` 策略。Bybit / 币安 / OKX 任一家 BTC 永续成交价 250 ms 内涨跌 ≥ 2 bp，且离开盘前 60 秒均价在 ±5 bp 内时，买同方向那一边，限价 = 卖价 + 0.08；一场一次，持有到结算。规则见 [STRATEGY.md](STRATEGY.md)。

## 控制台

https://3-254-138-119.sslip.io/console/ （nginx basic auth）。四个页面，都在 `frontend/console/`：

- 实盘 `auto-trade.html`（首页，`index.html` 跳转到这里）：启动/暂停/继续/停止、今日盈亏与止损余量、信号源（三家交易所 × 爱尔兰直连/东京转发）、当前场盘口、本场信号与下单。
- 统计 `stats.html`：漏斗、没买到的单、挂单与限价单、模拟记录（反向信号卖出、行情太乱就暂停）、晚了多少毫秒、速度分解、按信号源、跳过原因、按小时。
- 历史 `history.html`：每一笔领先单，点开看全部时间。
- 设置 `settings.html`：策略参数（保存即发布）、账户（只读）、系统状态、运行日志、清空统计数据。

## 服务器

- 爱尔兰 AWS eu-west-1（`ssh pm-ire`，3.254.138.119，2 vCPU 2 GB）：控制台和交易引擎，运行目录 `/root/pm-system`。nginx 443 做 basic auth，反代到只监听 `127.0.0.1:18766` 的控制面。交易引擎只能在控制台由人启动。账户秘密只在这台机器上。
- 东京 AWS ap-northeast-1（`ssh pm-tokyo`）：只跑转发 `pm-relay`，把三家交易所的成交签名后发给爱尔兰。
- 都柏林旧机器（`ssh pm-new`）：不交易，只做研究下载（predict.fun 历史）。

## 目录

- `backend/engine/`：TypeScript 交易引擎、东京转发、账户读取器、行情录制器（现不运行）（Node ≥ 24）。
- `scripts/`：Python 控制面 `system-dashboard-server.py`、`dashboard/` 读模型、部署脚本、录制行情读取与赢家判定 `backtest.py`（前向验证脚本 import 它，在本机跑）。
- `frontend/console/`：静态控制台，由控制面托管。
- `config/`：systemd 单元和 nginx 配置。

## 部署

```
python scripts/deploy.py [ireland|tokyo|all]
```

默认 all（爱尔兰控制台 + 引擎、东京转发），只部署已提交的 HEAD（未提交的改动不会上线）。交易必须处于停止状态，否则拒绝。部署后在控制台点启动。详见 [ARCHITECTURE.md](ARCHITECTURE.md#部署与回滚)。

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
- [AGENTS.md](AGENTS.md)：铁律和工作方式；[HANDOFF.md](HANDOFF.md)：当前状态、服务器操作、行情录制。
- [STRATEGY.md](STRATEGY.md)：策略规则和前向验证口径。
- [ROADMAP.md](ROADMAP.md)：还缺什么、按什么顺序做、做到哪了。
