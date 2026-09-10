# 系统架构

系统以都柏林节点作为在线数据和运行状态来源，分为行情证据、策略执行、账本投影、HTTP 服务和六页前端。paper 与 live 共用策略逻辑，但成交来源和资金含义不同。

## 数据与执行链路

```text
Polymarket 公开盘口/成交 + Binance BTC
        │
        ├─ Dublin collector → SQLite 原始证据 → 回放/定时分析
        │
        └─ TypeScript feeds ← Chainlink RTDS
                     │
                     └─ orchestrator → Engine → maker/strategy
                                                   │
                          paper 模拟执行或 V2 CLOB executor
                                                   │
                                          JSONL 运行日志
                                                   │
                            后台 projection → SQLite ledger
                                                   │
                           HTTP 只读接口 → 六页正式控制台
```

`scripts/pm-r25-dublin-evidence-collector.py` 保存真实公开消息。TypeScript `src/live/feeds/collector.ts` 提供采集器数据适配，paper 可以读取都柏林采集数据；live 的用户订单事件来自经认证的用户 WebSocket。缺失、单边或过期行情必须保留无效状态。

## 组件责任

| 位置 | 职责 |
|---|---|
| `web/src/approved-layout.html`、`layout.ts` | 保留总览、自动交易、市场、订单、收益、设置六页设计 |
| `web/src/live-data.ts`、`forms.ts` | 接口刷新、错误与未知值显示、六项参数及账户表单 |
| `scripts/system-dashboard-server.py` | loopback HTTP 服务、账户与控制操作、版本化 API |
| `scripts/dashboard/config.py` | 非敏感配置校验、版本冲突和原子保存 |
| `scripts/dashboard/read_model.py`、`projection_worker.py`、`ledger.py` | 后台日志投影、增量偏移、稳定事件 ID、SQLite 查询 |
| `_external/btc-5m-market-trading-bot/src/live/` | 行情发现、运行编排、策略、执行、订单核对和退出 |
| `pm_maker/` | 只读影子策略与证据回放，不提交交易所订单 |

HTTP 查询不在请求中摄取完整运行日志；后台读模型与请求线程分离。账本按运行组织，提供有界游标分页。账本 PnL 是引擎记录的结算兑付减成本、费用，不能替代钱包现金对账；缺少真实费用时保持未知。

## 部署边界

公网 `https://34-242-206-196.sslip.io/console/` 经 Nginx 转发到 `127.0.0.1:18766`，Python 服务拒绝非 loopback 监听。部署根目录 `/root/pm-system`，主服务 `pm-system-dashboard-dublin.service`。HTTP 80 跳转 HTTPS 443，公网页面登录认证关闭。

账户保存在 `/root/.config/pm-system/account.json`，仅服务器读取敏感内容。公网账户操作通过显式 origin 配置与代理检查进入；真实交易另有 control token、明确确认和 `PM_TRADING_LIVE_UNLOCK=1` 条件。前端模式保存不会绕过这些条件。直接使用引擎 CLI 是独立执行入口，不能把网页解锁状态误认为覆盖所有 CLI。

采集服务为 `pm-r25-dublin-collector.service`；证据目录 `data/pm-r25-live/days`，文件模式 `dublin-evidence-*.sqlite3`。分析由 `pm-r25-dublin-live-analyzer.service` 及其 timer 执行。

## 能力边界与资源

实际页面保存映射为六项，后台参数模式为八个数值项加 mode；两者不可混同。完整钱包资产、真实账单、到账凭证、延迟遥测和页面交易控制尚未完整接入。详细接口见 [TECHNICAL.md](TECHNICAL.md)。

2026-09-10 都柏林 `t3.small`（2 vCPU、约 2 GB RAM）采样存在高 steal，后台盘口重复重建和定时分析也消耗 CPU。进程拆分与 CPUWeight 不增加云端 CPU 额度。资源优化应保持行情完整性、页面设计和交易语义，详见 [CPU 诊断](CPU-DIAGNOSIS-2026-09-10.md)。
