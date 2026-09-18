# 当前系统架构

更新时间：2026-09-18。系统由一套可配置反转策略和一套公共真实交易底座组成。生产部署仍位于 `/root/pm-system`，交易引擎源码和构建仍在 `_external/btc-5m-market-trading-bot`，尚未迁移目录。

## 生产数据流

```text
Polymarket Market WebSocket
  └─ book / price_change / best_bid_ask / tick_size_change
       └─ 同一消息内 UP、DOWN 原子更新
            └─ BtcReversalStrategy（纯决策）
                 └─ submit / cancel / replace 意图
                      └─ TradingPlatform
                           └─ TradingCore
                                ├─ 预算、现金、份额和工作单预留
                                ├─ 单订单串行、跨订单并行
                                └─ 最小耐久提交
                                     └─ PolymarketGateway
                                          ├─ 签名与 CLOB HTTP 提交/撤单
                                          └─ User WebSocket ACK/成交/撤单事件

REST / RPC 慢路径
  ├─ 市场发现与 tick/元数据
  ├─ 启动、重连和未知订单恢复
  ├─ 账户、成交、资金流和结算核对
  └─ 后台投影 -> SQLite / JSON -> 控制台 API
```

行情触发不使用固定 1 秒采样、debounce 或 REST 盘口轮询。`--timer-ms` 只产生定时维护事件，不能代替或阻塞 Market WebSocket 事件。

## 模块与职责

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| 行情连接 | `src/live/feeds/polymarket.ts` | Market WebSocket、完整 L2、最优价、交易所时间和重连 |
| 用户连接 | `src/live/feeds/user.ts` | 认证订单与成交事件 |
| 平台编排 | `src/platform/platform.ts` | 市场事件、策略隔离、订单/结算服务和遥测 |
| 交易核心 | `src/platform/core.ts` | 资金/份额预留、订单状态、成交记账、并发和恢复 |
| 真实适配器 | `src/platform/polymarket.ts` | CLOB client、账户恢复、User WS、资金流与结算接线 |
| 持久化 | `src/platform/store.ts` | 账户隔离锁、原子替换、恢复快照和策略状态 |
| 反转策略 | `src/strategies/btc-reversal.ts` | 每场触发、反转确认、阶段推进和重启状态 |
| 运行入口 | `src/cli/platform.ts` | 市场发现、连续换场、策略加载、控制文件和进程生命周期 |
| 控制台后台 | `scripts/system-dashboard-server.py`、`scripts/dashboard/` | 配置、账户、控制、账本投影、系统指标和 HTTP API |
| 控制台前端 | `web/src/` | 总览、自动交易、策略、收益、设置和任务视图 |

上表中的 `src/` 均相对于 `_external/btc-5m-market-trading-bot/`。

## 策略与底座边界

策略接收只读市场事件和平台上下文，只返回交易意图。策略不能直接使用 CLOB client、修改账户余额、释放预留、写订单终态或绕过风险检查。平台不决定反转方向和阶段参数。

当前生产只注册 `btc-reversal`。底层 `StrategyPlugin` 契约仍允许后续策略复用同一行情、账户、订单、恢复、结算和遥测能力，但新增策略必须有独立配置 schema 和状态迁移，不能把字段塞进当前反转配置。

## 并发与一致性

- 一个 WebSocket 消息中的两侧变更先完整应用，再触发一次策略判断，避免读取半更新盘口。
- `best_bid_ask` 和 L2 保留独立时序；无交易所时间戳的快事件不进入决策。
- 同一订单使用 in-flight 去重和串行状态变换；不同订单不共享 HTTP ACK 等待锁。
- 等待签名/持久化短锁后会重新检查余额、预算、开放订单、可卖份额和费用，避免排队期间状态过期。
- 发单前只把阶段、预留和签名身份做一次关键耐久提交；未知结果保持占用并进入恢复，不能猜测失败后复用资金。

## 运行与状态

控制台后台启动 `dist/cli/platform.js --live --strategy btc-reversal --strategy-config ...`。每次运行有独立 journal、console、stop/control 文件；账户对应的 platform state 跨运行复用，保存订单、预留、持仓、策略阶段和恢复信息。

配置保存、账户保存、实盘解锁和交易运行是四个不同状态。控制台的 `running` 来自实际进程身份，策略状态来自当前 `run_id` 的投影，历史钱包数据不得冒充本轮策略订单或当前有效持仓。

## 控制台投影

后台读取平台 JSONL，增量写入 `results/dashboard/ledger.sqlite3`，并提供固定快照分页。系统资源指标由后台缓存采集，页面读取不会触发高成本系统扫描。延迟只绑定当前 `run_id`，过期或没有样本时显示未知。

当前有效持仓、待到账、待核对、已结算零价值历史残留分别投影。只有明确 `redeemable=true` 且 `currentValue=0` 的项可以排除出活动风险；分类不明的项继续保留。

## 当前未完成边界

本地候选版通过自动测试不等于服务器已发布，也不等于真实订单完成。真实 ACK、成交、撤单、重启恢复、费用、自动换场和结算到账仍按 [CURRENT-STATUS](CURRENT-STATUS.md) 判断。生产瘦身必须先解除运行依赖，再删除旧源码和服务，不能仅凭目录名称判断无用。
