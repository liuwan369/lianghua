# BTC 5 分钟交易系统

这是当前唯一维护的主线：Polymarket BTC Up/Down 5 分钟市场的真实公开数据采集、历史回放、纸面模拟和受保护交易引擎。

## 当前状态

- 主节点：AWS 都柏林 `eu-west-1`；东京仅保留历史数据和线路对照。
- 都柏林采集器、页面服务、小时分析和每日轮换均已部署并启用。
- 页面可运行真实行情驱动的纸面模拟；纸面订单、成交和盈亏不是账户真实结果。
- 真钱交易仍锁定：`trade_authorization=false`、`live_unlocked=false`；账户签名已配置，但授权验收尚未完成。
- 当前裁决：`NOT_READY_FOR_LIVE_TRADING`。
- 云仓库：[liuwan369/lianghua](https://github.com/liuwan369/lianghua)，只保存源码、配置模板、测试和文档。

## 打开页面

公网入口（需要登录）：

```text
https://34-242-206-196.sslip.io:80/system-dashboard.html
```

备用 SSH 隧道入口：

```text
http://127.0.0.1:18765/system-dashboard.html
```

本地开发页面可运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-dashboard.ps1
```

本地地址：`http://127.0.0.1:8765/system-dashboard.html`。

## 用户功能

1. **交易**：查看实时盘口、模拟挂单、成交、撤单、成交额和结算盈亏。
2. **配置**：设置配对成本上限、单笔金额、资金上限、订单上限和运行时间。
3. **订单**：按市场查看成交额、持仓和结算结果。

## 策略白话版

系统在 Up/Down 两边寻找合适买价。一边成交后，按当前赔率计算另一边需要补多少；只有预计配对成本不超过上限、资金和库存风险允许时才继续。价格无法修复、数据过期、临近结束或风险超限时停止或撤单。

这不是保证盈利的无风险套利。纸面模拟不知道真实排队位置，返佣、奖励和真实手续费在没有账户证据时按 0 处理。

## 代码结构

```text
_external/btc-5m-market-trading-bot/  TypeScript 主交易引擎
pm_maker/                              Python 动态补仓与影子回放
scripts/                               采集、分析、页面服务和回测
config/                                都柏林/东京服务配置模板
docs/                                  当前说明和历史证据
tests/                                 Python 回归测试
data/                                  小型核验报告；原始数据库不进 Git
```

完整入口见 [START-HERE.md](START-HERE.md)，架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，进度见 [docs/PROGRESS.md](docs/PROGRESS.md)。
