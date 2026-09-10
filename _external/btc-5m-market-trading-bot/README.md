# BTC 5 分钟 TypeScript 交易引擎

本目录负责 Polymarket BTC Up/Down 5 分钟市场的行情驱动策略、paper 模拟和 V2 CLOB 交易执行。正式页面和服务位于仓库其他目录；公网控制台是 **https://34-242-206-196.sslip.io/console/**，在线节点为都柏林。

当前状态为 **NOT_READY_FOR_LIVE_TRADING**：实际 V2 账户授权与私有只读请求通过，但真实订单全生命周期、完整资金对账和全部前端功能仍需验收。代码和模拟测试通过不代表真实成交、成功对冲或盈利。

## 安装与验证

需要 Node.js 24+。在本目录运行：

```powershell
npm ci
npm test
npm run build
```

2026-09-10 记录为 201 个测试通过、20 个测试文件通过，TypeScript 构建通过。依赖使用 `package-lock.json` 固定安装；执行适配为 `@polymarket/clob-client-v2` 1.1.0，账户检查使用 `@polymarket/client` 0.9.0 并限定实际 V2 授权范围。

## 显式纸面运行

下面命令使用真实公开行情和模拟订单，不需要提交真实订单：

```powershell
node dist/cli/live.js run --paper --duration-min 6 --order-usd 5 --pair-cost-max 0.99 --max-total-usd 150 --max-orders 30 --maker-life-sec 15 --log-file results/paper/acceptance.jsonl
node dist/cli/live.js analyze results/paper/acceptance.jsonl
node dist/cli/live.js monitor results/paper/acceptance.jsonl --once
```

每轮使用新的日志文件名，保存命令、开始/结束时间和数据来源。显式 `--paper` 优先于 `LIVE=true`，避免环境误选运行模式。不要把纸面结果写为真实订单或账户损益。

CLI 的默认值与后台配置默认值不同：单笔 2 USD，配对参数 0.99，订单上限 200，时长 0（不限时）；paper 未传累计金额上限时不能视为自动具有前端默认的 100 USD 上限。因此验收应明确传入时长、累计金额和订单上限。

`npm run paper` 是便捷六分钟模拟；`npm run live` 是真实资金入口，不属于本节验收命令。CLI 与网页服务解锁是不同边界，直接 CLI 不受网页是否显示禁用按钮保护。账户配置保存不会自动执行任一 CLI。

## 代码入口

| 位置 | 职责 |
|---|---|
| `src/cli/live.ts` | 命令参数、显式 paper/live 选择 |
| `src/live/orchestrator.ts` | 行情、运行周期、订单回报、退出编排 |
| `src/live/engine.ts` | 在线策略入口与运行状态 |
| `src/live-maker.ts`、`src/strategy.ts` | maker 候选、库存补仓和风险约束 |
| `src/live/executor.ts` | 执行、挂单和成交状态 |
| `src/live/clob/client.ts` | V2 CLOB 适配、真实市场约束 |
| `src/live/feeds/` | Polymarket、BTC、oracle 与 `collector.ts` 采集器适配 |
| `src/cli/backtest.ts`、`backtest-snapshots.ts` | 快照回测及 tick/时间戳验证 |

Polymarket 公开盘口/成交、Binance BTC 和 Chainlink RTDS 构成行情来源。paper 可以使用都柏林采集器数据；live 使用经认证的用户 WebSocket 接收账户订单回报。每次运行必须核实来源与新鲜度。

## 实际策略行为

在线 `Engine` 默认 `target_clone`，启用 `dynamicHedgeSizing`；不是 `stableLive` 锁定预设。`target_clone` 默认 clip 20，关闭 edge scaling，`pairAddCostMax=0.98`、`hedgePairCostCeiling=0.99`、目标不平衡 0.02、硬不平衡限制 0.04。CLI 默认 `--pair-cost-max 0.99` 会把 `pairCostMax` 和 `pairAddCostMax` 设为 0.99，不修改所有其他门槛。

两边挂单必须各用真实 token tick 向下量化价格；元数据缺失则拒绝，不猜测 0.01。最终数量受预算、单边数量、最坏结算亏损、费用模型及尚未成交订单负债限制。策略至少 5 份，执行器再校验市场真实最小数量，不能为满足最小量扩大已批准订单。

动态修复不是无限制补齐。候选 maker 门槛随裸露时长从约 0.99 放宽至最多 0.999；裸露达 30 秒或距结束不超过 75 秒的候选 taker 分支以含费成本 1.05 为门槛。然而当前动态补仓最终构建仍受 `hedgePairCostCeiling=0.99` 限制。候选日志的 1.05 或 0.9903 不表示最终执行突破 0.99，也不能保证缺边平仓。

例如 DOWN 库存均价 0.18 加 UP ask 0.95，模型费用 `0.07 × 0.95 × 0.05 = 0.003325`，候选含费成本 1.133325，超过 1.05 因而拒绝。费用是估算，不是交易所账单；返佣和奖励不能预先抵扣成本。预算不足、最小份数残余和昂贵缺边均可能造成未配对库存。

部分成交扣减对应挂单剩余量；撤单请求直到确认才释放负债。迟到订单事件不能清除替换单。live taker 在途冻结新提交，固定份数 FOK 不因更优价格扩量。拒绝原因变化写入 `decision_rejected`。退出会排空提交、撤单、核对订单和稳定成交并记录迟到回报；仅处理本运行所属订单。这些真实资金路径尚待端到端验收。

## 回测与延迟工具

快照回测使用外部数据，实时 paper 不依赖这些文件。每条 UP/DOWN 快照必须含当时该 token 的真实 `tick_size` 或 `tickSize`，数值在 0 与 1 之间；冲突或缺失直接报错。时间戳保留 Z/offset，无时区按 UTC，非法值报错。不要补默认 tick 后报告零成交。格式和限制见 [回测 tick 文档](../../docs/BACKTEST-TICK-DATA.md)。

```powershell
node dist/cli/backtest.js --help
npm run latency:probe
npm run latency:compare -- report-a.json report-b.json
```

比较命令的两个 JSON 路径应替换为实际采样报告。独立延迟脚本不等于前端八项遥测已经接入。回测的撮合模型不能复原真实排队位置、全部滑点或账户到账。

系统参数/API 见 [TECHNICAL.md](../../docs/TECHNICAL.md)，纸面及实盘验收方法见 [LIVE_FILLRATE_TEST.md](LIVE_FILLRATE_TEST.md)，交付缺口见 [DELIVERY.md](../../docs/DELIVERY.md)。
