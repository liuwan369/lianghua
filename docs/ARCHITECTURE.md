# 系统架构

更新时间：2026-09-17。当前结构以公共交易平台和可替换策略为两层，策略暂不运行。

## 数据流

```text
Polymarket WS/REST + BTC 参考行情
          │
          ▼
    Feed / Market adapter
          │  Book、深度、时间和健康状态
          ▼
      TradingPlatform
       ├─ TradingCore：现金、份额、订单、风险和持久化
       ├─ Gateway：PaperGateway 或 PolymarketGateway
       ├─ Account：读取、恢复核对、结算结果
       ├─ StrategyPlugin：可选，只读事件 -> 订单意图
       └─ Telemetry / journal -> SQLite 投影 -> 控制台状态/日志

当前控制台启停路径
总览/自动交易/策略/收益/设置/任务视图 -> dashboard API -> platform.js -> 无策略 TradingPlatform
中文任务树 -> task-view.json（独立展示交付状态）
```

## 公共底座

| 模块 | 位置 | 责任 |
|---|---|---|
| 契约 | `src/platform/contracts.ts` | 市场、盘口、订单、成交、账户、风险、策略动作类型 |
| 账本 | `src/platform/core.ts` | BUY/SELL 预留、部分成交、撤单、替换、去重、风险和恢复 |
| 平台 | `src/platform/platform.ts` | 市场/事件分发、策略隔离、动作权限、结算和遥测 |
| 纸面网关 | `src/platform/paper.ts` | 独立模拟盘口和公开成交执行，不伪造真实队列 |
| Polymarket 网关 | `src/platform/polymarket.ts` | CLOB 签名、用户流、真实账户读取和结算适配 |
| 存储 | `src/platform/store.ts` | 账户/模式锁、临时文件、`fsync`、原子替换和崩溃锁处理 |
| 行情 | `src/live/feeds/`、`src/live/orderbook.ts` | 完整 L2、真实 tick、交易所时间、本机接收和新鲜度 |
| 控制台 | `web/`、`scripts/system-dashboard-server.py` | 六个入口展示、配置保存、纸面启停、账户只读和功能树；行情与订单分别嵌入自动交易页 |

## 策略边界

策略通过 `StrategyPlugin` 接收事件和只读上下文，返回 `submit/cancel/replace`。平台补入策略身份，验证价格、tick、最小数量、资金、风险和订单归属。策略不能导入 CLOB client、写账本、释放预留或绕过风险。

旧 `src/live/engine.ts`、`MakerSession`、`PairCost` 和历史策略入口保留为兼容路径，不是新平台默认实现。新的策略接入需单独登记、回放和验收；当前阶段不接入。

## 统一交易底座

控制台新启动和平台 CLI 使用 `TradingPlatform`；旧 CLI 保留显式兼容路径：

| 层 | 负责内容 | 不能负责的内容 |
|---|---|---|
| `TradingPlatform` | 对外暴露市场、账户、订单、组合、风险、结算和遥测接口；接收策略动作 | 不选择策略价格和方向 |
| `TradingCore` | BUY/SELL 预留、订单状态、成交记账、去重、风险和恢复 | 不签名、不直接调用 CLOB |
| `OrderGateway` / `PolymarketGateway` | 交易所签名、提交、撤单、ACK 和用户事件适配 | 不修改本地资金账本 |
| `PaperGateway` | 独立模拟撮合和回报顺序 | 不代表真实队列和真实成交率 |
| 行情 / 用户流 / 账户读取 | L2、公开成交、认证订单事件和账户核对 | 不绕过平台核心产生订单 |

新插件只返回订单意图，前端通过后台调用。控制台已适配启停、运行身份恢复和状态/日志投影。每轮独立状态文件、纯 JSONL 日志和控制台输出；后台按确切可执行文件及日志路径识别存活进程。Windows 隐藏进程通过控制文件正常关闭，Linux 使用 SIGTERM。systemd 重启默认终止同组子进程，不承诺自动保活或重启交易。

## 热路径与慢路径

成交和用户 WebSocket 事件先进入内存账本并触发事件分发。REST 账户读模型、历史资金流、账本投影和归档在后台合并。下单前的预留需要同步持久化；未知 ACK、未知撤单或持久化失败保持停机状态。

真实网关只有在每个市场的盘口完整且新鲜、认证用户流健康连续时才允许新单。盘口健康不能只看 WebSocket 已连接；超过新鲜度阈值会关闭新单门禁。

## 当前边界

代码和模拟回归覆盖 BUY/SELL、多订单、部分成交、撤单、替换和重复成交。真实适配器的部分成交、撤改竞态、断线中成交、异常恢复、持续资金核对和长期运行仍未完成。当前服务器交易停止且实盘锁关闭。
