# 后端接口契约

下面是前端需要的最小接口集合。路径可以按现有服务命名调整，但语义和字段边界应保持一致。当前前端默认策略 ID 是 `btc-reversal`，只服务 BTC 五分钟反转策略。

## 当前联调前提

以下条件是前端进入真实交易联调的硬性接口前提，当前独立前端尚未连接真实账户和交易环境：

1. 市场目录必须返回真实的 `marketId` 和 `roundId`，运行池必须返回 `desiredIds`、`currentIds`、`nextRoundIds` 以及 `effectiveRoundId`。前端以 `marketId + roundId` 隔离盘口、持仓、订单和策略阶段。
2. `/api/v1/markets` 是旧的兼容接口，可能没有 `roundId`。如果只提供该接口，前端可以显示市场和报价，但不会使用空轮次查询持仓或订单，页面会显示等待后端提供当前轮次标识。
3. 实时行情、运行状态和订单事件分别通过独立流接入。只有配置了 `streams.markets`、`streams.runtime`、`streams.orders` 的地址后，前端才会建立对应 WebSocket；地址未配置时显示待接入并保留最近一次成功的 REST 快照。
4. 账户快照、账户检查和交易控制必须由真实后端提供。前端不接收或保存私钥、Token、签名材料或其他账户秘密；账户页面只显示服务器返回的配置状态、检查结果和只读摘要。

后端尚未提供上述能力时，前端应保持 `unavailable` 或 `stale`，不能把演示数据、空值或按钮文字当成真实交易状态。

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

市场目录返回 `assetId/symbol/name/marketId/roundId/cycle/startAt/endAt/yesToken/noToken/yesBid/yesAsk/noBid/noAsk/volume/liquidity/quoteAt/enabled/nextRound`。`marketId` 和 `roundId` 在生产数据中都必须是非空字符串；不要让页面直接使用旧的 `up_bid/down_bid` 字段。

运行池 GET/PUT 的语义如下：

- `desiredIds` 是用户希望启用的资产 ID，由市场页提交。
- `currentIds` 是服务器确认正在运行的资产 ID。
- `nextRoundIds` 是服务器确认下一场生效的资产 ID。
- `effectiveRoundId` 是这次变更计划生效的轮次。

前端 PUT 只提交 `desiredIds` 和可选的 `effectiveRoundId`，不能用客户端状态覆盖服务器的 `currentIds` 或 `nextRoundIds`。

## WebSocket 实时流

- `/api/stream/markets`：报价、五档 depth、场次切换；按 marketId 订阅。
- `/api/stream/runtime`：启动/暂停/停止状态、策略阶段、错误、服务事件。
- `/api/stream/orders`：订单状态、成交、撤单、结算。

高频行情不能和账户、系统资源、历史统计共用一个轮询。每个消息必须带 `sequence`、`sourceAt`、`expiresAt`、`marketId` 和 `roundId`。运行流中不含市场上下文的全局状态帧可以只带运行状态，但订单和行情帧必须带完整的市场和轮次标识。

前端流配置示例：

```js
window.__POLY_PREVIEW_CONFIG__ = {
  mode: "backend",
  apiBase: "",
  apiFlavor: "contract",
  strategyId: "btc-reversal",
  streams: {
    markets: { url: "wss://example.invalid/api/stream/markets" },
    runtime: { url: "wss://example.invalid/api/stream/runtime" },
    orders: { url: "wss://example.invalid/api/stream/orders" }
  }
};
```

没有配置某个流的 URL 时，该流不会创建连接，不会用定时器或演示数值补齐实时数据。断线重连期间页面保留最近成功数据并标记 `stale`。

## 控制命令

```json
{
  "action": "start",
  "marketIds": ["btc-5m-..."],
  "strategyId": "btc-reversal",
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

策略保存和激活是两个动作：当前策略页只保存草稿，不会自动启动或激活；要让配置在指定下一场生效，调用方必须单独提交 `/api/strategy/activate` 和 `effectiveRoundId`，并等待 runtime 流确认。

后端联调时需要先提供：市场目录、运行池、runtime status、单市场快照和带 `roundId` 的持仓/订单查询；随后接入 markets/runtime/orders 三条实时流。若暂时只有现有策略接口，adapter 会把策略草稿转换成 `{ expectedRevision, config }` 并回退到 `PUT /api/strategy-config`。账户秘密不经过浏览器接口，账户页面只读取服务器保存状态；如需更换账户，由服务器环境配置或部署系统完成。真实账户和交易链路完成联调前，不能把页面的“已连接”“运行中”解释为真实下单成功。
