# 后端接口契约草案

下面是前端需要的最小接口集合。路径可以按现有服务命名调整，但语义和字段边界应保持一致。

## 现有服务可复用接口

生产前端已经有这些只读接口，可以先作为 adapter 的第一版数据源：

- `GET /api/v1/status`：运行状态、策略版本、当前运行摘要。
- `GET /api/v1/markets`：采集器当前市场和报价快照。
- `GET /api/account/status`：账户配置状态，不应回显秘密。
- `GET /api/v1/runs?limit=50`、`GET /api/v1/events?run_id=...`：运行和事件记录。
- `GET /api/v1/summary?run_id=...`：当前运行汇总。
- `GET /api/v1/system-metrics`：CPU、内存、磁盘、负载和服务进程。
- `GET /api/strategy-config`、`PUT /api/strategy-config`：策略读取和保存。

这些接口目前仍是单运行/单当前市场模型，不能直接满足多币种运行池；需要新增市场目录、运行池和按 marketId/roundId 的运行数据契约。现有交易控制接口的最终状态应统一为 runtime command response + status/event stream，避免页面猜测按钮结果。

## REST

所有现代只读响应都带 `schemaVersion`、`source`、`asOf`、`stale` 和 `error`（无错误时为 `null`）。`stale=true` 时客户端应保留最后一次成功数据，并显示数据来源和时间；不能把不可用数据当作零。

| 用途 | 方法 | 路径 | 频率/说明 |
|---|---|---|---|
| 应用能力与版本 | GET | `/api/bootstrap` | 页面首次加载 |
| 加密货币五分钟目录 | GET | `/api/markets?asset=crypto&duration=5m` | 15 秒或手动刷新 |
| 单市场快照 | GET | `/api/markets/{marketId}/snapshot` | 首次加载/断线恢复 |
| 运行池 | GET/PUT | `/api/runtime/market-pool` | desired enabled + effectiveRoundId |
| 运行状态 | GET | `/api/runtime/status` | 首次加载、断线恢复 |
| 交易控制 | POST | `/api/runtime/commands` | start/pause/stop，带 requestId |
| 策略当前版本 | GET | `/api/strategy/config` | 页面加载 |
| 保存策略草稿 | POST | `/api/strategy/drafts` | 校验后保存，不自动启动 |
| 激活策略 | POST | `/api/strategy/activate` | `effectiveRoundId` |
| 策略参考参数 | GET/POST/DELETE | `/api/strategy/presets` | 用户可增删 |
| 本场持仓 | GET | `/api/rounds/{roundId}/position` | 首次加载/切场 |
| 本场订单 | GET | `/api/rounds/{roundId}/orders` | 分页历史 |
| 撤单/清余量 | POST | `/api/orders/{orderId}/cancel`、`/api/runtime/flatten` | 明确返回 command 状态 |
| 账户快照 | GET | `/api/account/snapshot` | 15 秒；不返回秘密 |
| 账户检查 | POST | `/api/account/check` | 仅检查，不保存 |
| 系统诊断 | GET | `/api/diagnostics/health` | 15 秒，资源和进程 |
| 汇总统计 | GET | `/api/metrics/summary?range=today` | 页面加载/手动刷新 |
| 事件历史 | GET | `/api/events?cursor=...` | 分页，低频 |

账本统计响应还提供 `fills`、`fill_notional`、`fees`、`settled_markets`、`pnl`、`pnl_semantics`、`settled_wins`、`settled_losses` 和 `win_rate`。`pnl` 是引擎结算净盈亏，不是钱包现金对账；缺少成交、手续费或结算字段时返回 `null`。订单 DTO 包含订单状态及其 `fills`，持仓 DTO 包含 `yesShares`、`noShares`、`averagePrice`、`occupiedUsd` 和按结果的 `outcomePnl`。

市场目录返回 `assetId/symbol/name/marketId/roundId/cycle/startAt/endAt/yesToken/noToken/yesBid/yesAsk/noBid/noAsk/volume/liquidity/quoteAt/enabled/nextRound`。不要让页面直接使用旧的 `up_bid/down_bid` 字段。

## WebSocket / SSE

- `/api/stream/markets`：报价、五档 depth、场次切换；按 marketId 订阅。
- `/api/stream/runtime`：启动/暂停/停止状态、策略阶段、错误、服务事件。
- `/api/stream/orders`：订单状态、成交、撤单、结算。

高频行情不能和账户、系统资源、历史统计共用一个轮询。每个消息必须带 sequence 和来源时间。

## 控制命令

```json
{
  "action": "start",
  "marketIds": ["btc-5m-..."],
  "strategyId": "reversal-5m",
  "revision": 12,
  "requestId": "uuid"
}
```

响应只代表命令是否接收；最终结果由 runtime stream 返回。状态建议：`stopped/starting/running/pausing/paused/stopping/error`。

## 前端调用方式

页面不直接调用 `fetch`。统一使用 `window.PolyPreviewAdapter`：

```js
await PolyPreviewAdapter.loadMarkets();
await PolyPreviewAdapter.commandRuntime({ action: "start", marketIds, strategyId, requestId });
await PolyPreviewAdapter.saveStrategy(draft);
```

adapter 完成 DTO 转换后写入 `PolyPreviewStore`，页面只订阅对应分片。预览模式返回明确的“待接入”结果，不模拟成功，也不把本地草稿当成服务器运行状态。

后端联调时需要先提供：市场目录、运行池和 runtime status；随后接入 markets/runtime/orders 三条实时流。若暂时只有现有策略接口，adapter 会把策略草稿转换成 `{ expectedRevision, config }` 并回退到 `PUT /api/strategy-config`。账户秘密不经过浏览器接口，账户页面只读取服务器保存状态；如需更换账户，由服务器环境配置或部署系统完成。
