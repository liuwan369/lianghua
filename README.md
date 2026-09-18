# Polymarket BTC 五分钟反转交易系统

本仓库只维护一套可配置的 BTC 五分钟反转策略，以及它依赖的实时行情、订单执行、账户、恢复、结算、遥测和控制台底座。做市、奖励优化、回测和长期 paper 观察不再属于生产主线。

正式控制台：<https://34-242-206-196.sslip.io/console/>

## 当前边界

- 行情由 Polymarket CLOB Market WebSocket 驱动；REST 只用于市场发现、元数据、启动恢复和后台核对。
- `BtcReversalStrategy` 只判断触发、反转和阶段份额；`TradingPlatform` 与 `TradingCore` 负责资金、订单、成交、恢复和结算。
- 不同订单可以并行，同一经济订单的提交、查回、撤单和重试严格串行并去重。
- 控制台显示当前有效持仓、账户历史、订单生命周期、盘口、真实延迟和服务器 CPU/内存/磁盘/负载。
- 保存配置、保存账户或选择 live 模式都不会自行启动交易。真实交易必须由用户在控制台发起。

当前服务器版本、运行状态、验证结果和未完成项只看 [当前系统状态](docs/CURRENT-STATUS.md)。本地代码已完成但尚未发布的内容不得写成服务器已上线。

## 源码位置

| 范围 | 位置 |
| --- | --- |
| 实盘交易底座与反转策略 | `_external/btc-5m-market-trading-bot/src/` |
| 控制台后台与投影 | `scripts/system-dashboard-server.py`、`scripts/dashboard/` |
| 控制台前端 | `web/src/` |
| 当前计划和状态 | `docs/REVERSAL-DELIVERY-PLAN-2026-09-17.md`、`docs/CURRENT-STATUS.md` |
| 历史证据与研究原文 | `docs/evidence/`、`docs/research/` |

服务器仍从 `/root/pm-system` 运行，交易引擎仍位于该目录下的 `_external/btc-5m-market-trading-bot`。目录名是现状，不表示引擎已经迁移成独立服务。

## 开始使用

- [从这里开始](START-HERE.md)
- [文档索引](docs/README.md)
- [系统架构](docs/ARCHITECTURE.md)
- [技术实现](docs/TECHNICAL.md)
- [API](docs/API.md)
- [配置](docs/CONFIGURATION.md)
- [开发](docs/DEVELOPMENT.md)
- [测试与验收](docs/TESTING.md)
- [部署与回退](docs/DEPLOYMENT.md)

## 本地验证

要求 Python 3.11+、Node.js 24+。统一验证入口：

```powershell
python scripts/verify-project.py
```

该命令只运行离线测试和构建，不连接真实账户，不会下单、撤单或转账。详细命令见 [测试与验收](docs/TESTING.md)。
