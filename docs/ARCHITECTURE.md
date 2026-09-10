# 系统架构

系统以都柏林节点作为在线数据和运行状态来源，分为行情证据、策略执行、账本投影、HTTP 服务和六页前端。paper 与 live 共用策略逻辑，但成交来源和资金含义不同。

## 数据与执行链路

```text
Polymarket 公开盘口/成交 + Binance BTC
        │
        ├─ Dublin collector → SQLite 原始证据
        │                         ├─ 增量行情投影 → 内存/原子 JSON 快照 → HTTP
        │                         └─ 历史回放/定时分析（pm-analysis.slice）
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
| `web/src/live-data.ts`、`forms.ts` | 接口刷新、错误与未知值显示、九项参数及账户表单 |
| `scripts/system-dashboard-server.py` | loopback HTTP 服务、账户与控制操作、版本化 API |
| `scripts/dashboard/config.py` | 非敏感配置校验、版本冲突和原子保存 |
| `scripts/dashboard/market_snapshot.py` | 常驻增量盘口、压缩块变更检测、行情快照及过期校验 |
| `scripts/dashboard/read_model.py`、`projection_worker.py`、`ledger.py` | 后台日志投影、空闲跳过、独立心跳、稳定事件 ID、SQLite 查询 |
| `_external/btc-5m-market-trading-bot/src/live/` | 行情发现、运行编排、策略、执行、订单核对和退出 |
| `pm_maker/` | 只读影子策略与证据回放，不提交交易所订单 |

HTTP 查询不在请求中摄取完整运行日志；后台读模型与请求线程分离。账本按运行组织，提供有界游标分页。账本 PnL 是引擎记录的结算兑付减成本、费用，不能替代钱包现金对账；缺少真实费用时保持未知。

行情后台约每秒刷新常驻投影。首次读取最近 180 秒盘口；以后比较窗口内压缩块的实际内容，只解压变化的块，普通追加只应用新事件。晚到、更改或删除触发已解码窗口的纠正回放；数据库日切、替换、截断或处理异常会重建状态。HTTP 读取内存结果，都柏林同时原子写入 `data/dashboard/market-snapshot.json`；本地开发预览通过 SSH 只读该文件，不在远端再次解压重建盘口。源快照超过 15 秒未更新时清空当前市场并标记离线；重复读取不改变源时间。

账本 worker 每约 250 毫秒检查来源，已追平且无摄取错误的日志在文件身份、大小及修改时间未变时跳过摄取事务。只有选择或数据状态变化才生成摘要和数据快照。schema 2 使用独立的每秒 heartbeat 绑定 run 与快照版本；超过 3 秒、版本不匹配或 worker 退出均保留 stale 语义。历史 run 仍轮询发现和增量摄取，pending 或错误状态继续检查。

## 部署边界

公网 `https://34-242-206-196.sslip.io/console/` 经 Nginx 转发到 `127.0.0.1:18766`，Python 服务拒绝非 loopback 监听。部署根目录 `/root/pm-system`，主服务 `pm-system-dashboard-dublin.service`。HTTP 80 跳转 HTTPS 443，公网页面登录认证关闭。

账户保存在 `/root/.config/pm-system/account.json`，仅服务器读取敏感内容。公网账户操作通过显式 origin 配置与代理检查进入；真实交易另有 control token、明确确认和 `PM_TRADING_LIVE_UNLOCK=1` 条件。前端模式保存不会绕过这些条件。直接使用引擎 CLI 是独立执行入口，不能把网页解锁状态误认为覆盖所有 CLI。

采集服务为 `pm-r25-dublin-collector.service`；证据目录 `data/pm-r25-live/days`，文件模式 `dublin-evidence-*.sqlite3`。分析由 `pm-r25-dublin-live-analyzer.service` 及其 timer 执行，并归入同机 `pm-analysis.slice`，不与在线控制台共用资源控制组。

## 能力边界与资源

实际页面保存映射为九项，与后台八个数值项加 mode 对齐；其余高级设计字段尚未实现。抵押余额、持仓、未完成委托、成交、关闭持仓和活动已有常驻只读缓存；完整可花资产/账单/付款凭证、其余交易遥测与实盘控制仍未完整接入。纸面控制和页面刷新测量已接线。详细接口见 [TECHNICAL.md](TECHNICAL.md)。

都柏林 `t3.small` 的云端 CPU 供给限制与应用开销是不同问题。在线侧用增量行情及账本空闲跳过减少重复工作；历史分析配置为 `CPUQuota=20%`（最多 0.2 个逻辑核）、`CPUWeight=10`、`IOWeight=10`，并使用低优先级调度及内存限制。这是同一台服务器上的资源隔离，并非独立分析服务器；配额限制不能增加云端 CPU 额度，也不能消除宿主机 steal。诊断依据见 [CPU 诊断](CPU-DIAGNOSIS-2026-09-10.md)。

`scripts/dashboard/account_data.py` 管理常驻 Node `dist/cli/account-data.js`，HTTP仅读按账户绑定的缓存，默认至少30秒刷新。上游查询只允许GET，账户变化销毁旧进程与缓存；来源分页并非原子快照，完整性和时间随每个板块返回。
