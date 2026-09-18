# BTC 五分钟反转交易底座

本目录是 Polymarket BTC Up/Down 五分钟反转策略的实时交易底座。生产入口只有 `dist/cli/platform.js`，策略通过 `StrategyPlugin` 接口接入，行情使用 Polymarket CLOB Market WebSocket，账户订单和成交使用认证 User WebSocket；REST 只用于市场发现、规则预热、异常恢复、账户对账和结算。

当前生产状态由仓库根目录的 `docs/CURRENT-STATUS.md` 和 `docs/REVERSAL-DELIVERY-PLAN-2026-09-17.md` 维护。公网控制台为 https://34-242-206-196.sslip.io/console/。真实交易进程必须由用户在控制台明确启动，源码和自动化测试不会代替真实订单证据。

## 本地开发

需要 Node.js 24+。在本目录运行：

```powershell
npm ci
npm test
npm run typecheck
npm run build
```

平台命令要求显式 `--live`，没有模拟执行入口：

```powershell
node dist/cli/platform.js --live --strategy btc-reversal --strategy-config results/dashboard/btc-reversal-config.json --duration-sec 0
```

策略配置由控制台保存。修改参数只影响下一场，当前订单继续按创建时的版本管理。关闭网页不会停止运行，停止和暂停通过控制台发起。

## 运行结构

| 模块 | 职责 |
| --- | --- |
| `src/strategies/btc-reversal.ts` | 可配置跨价、确认价、阶段份额和场次状态机，只产生订单意图 |
| `src/platform/core.ts` | 策略无关的资金预留、订单状态、成交账本和风险状态 |
| `src/platform/polymarket.ts` | 认证 CLOB 执行、Market/User WebSocket、账户恢复和费用读取 |
| `src/platform/live-settlement.ts` | 官方结果、赎回回执和到账核对 |
| `src/live/feeds/polymarket.ts` | CLOB 实时盘口、最佳买卖一和多档深度 |
| `src/live/feeds/user.ts` | 认证订单、成交和撤单事件；断线后补读未结订单与近期成交 |
| `src/platform/store.ts` | 原子保存场次、订单、成交、持仓和策略状态 |
| `src/cli/platform.ts` | 唯一实时进程入口和控制文件 |

不同订单可以并行提交；同一经济订单的提交、查回、撤单和重试保持串行。交易决策由 WebSocket 事件直接触发，不使用固定秒级采样、debounce 或 REST 盘口轮询。页面展示消息年龄、本地处理、签名、HTTP ACK、用户回报和撤单 ACK 的分段延迟，缺少真实样本时显示未知。

## 真实验证

用户可在策略页面填入 `[5,5,5,5]` 做最小真实验证。Agent 只读核对 ACK、成交、部分成交、撤单、断线恢复、重启、费用、换场和结算到账，并将证据写入当前文档；没有发生的真实事件保持未完成。代码测试验证状态机和故障分支，不把模拟成交当成账户收益。

账户秘密、真实订单/成交/资金/结算数据不放入发布包。程序发布采用本地源码、Git 提交、服务器发布目录三段校验，并保留可回退版本；回退程序不会覆盖之后产生的交易账本。
