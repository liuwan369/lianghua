# 后端接口契约

下面是前端需要的最小接口集合。路径可以按现有服务命名调整，但语义和字段边界应保持一致。当前前端默认策略 ID 是 `btc-reversal`，只服务 BTC 五分钟反转策略。

## 当前联调前提

以下条件是前端进入真实交易联调的硬性接口前提，当前独立前端尚未连接真实账户和交易环境：

1. 市场目录必须返回真实的 `marketId` 和 `roundId`，运行池必须返回 `desiredIds`、`currentIds`、`nextRoundIds` 以及 `effectiveRoundId`。前端以 `marketId + roundId` 隔离盘口、持仓、订单和策略阶段。
2. `/api/v1/markets` 是旧的兼容接口，可能没有 `roundId`。如果只提供该接口，前端可以显示市场和报价，但不会使用空轮次查询持仓或订单，页面会显示等待后端提供当前轮次标识。
3. 实时行情、运行状态和订单事件分别通过独立流接入。只有配置了 `streams.markets`、`streams.runtime`、`streams.orders` 的地址后，前端才会建立对应 WebSocket；地址未配置时显示待接入并保留最近一次成功的 REST 快照。
4. 账户快照、账户检查和交易控制必须由真实后端提供。前端不接收或保存私钥、Token、签名材料或其他账户秘密；账户页面只显示服务器返回的配置状态、检查结果和只读摘要。

后端尚未提供上述能力时，前端应保持 `unavailable` 或 `stale`，不能把演示数据、空值或按钮文字当成真实交易状态。后端必须提供符合当前约定的市场目录、运行池、快照和 `marketId + roundId` 字段；旧 `/api/v1/markets` 缺少 `roundId` 时，前端只展示目录/报价并等待后端提供轮次标识。

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

## 当前 control-plane 实际接口矩阵

以下是本次前端接入审查时对 `backend/control-plane/scripts/system-dashboard-server.py` 的只读核对结果。它描述当前服务实际暴露的路由，不代表目标契约已经在后端落地。

| 当前路由 | 当前状态 | 前端用途 | 关键兼容点 |
|---|---|---|---|
| `GET /api/v1/status` | 可用 | 运行状态、配置版本、运行摘要 | 单运行模型；字段为 `running`、`run_id`、`config_revision`、`strategy_id` 等 |
| `GET /api/v1/markets` | 可用 | 旧市场目录/报价回退 | 返回 `current_markets[]`，没有可靠的 `marketId`/`roundId`；见下方 legacy DTO |
| `GET /api/v1/account-data` | 可用 | 只读账户数据 | 返回 `collateral`、`open_orders`、`trades`、`positions`、`closed_positions`、`activity` 分区，每个分区带 `available`、`complete`、`items` |
| `GET /api/account/status` | 可用 | 账户配置和最近检查状态 | 不提供资金余额；不得把配置完成解释成交易已连接 |
| `POST /api/account/check`、`POST /api/account/save` | 可用 | 服务器账户检查/保存 | 账户秘密只进入服务器受控接口，不进入前端 Store |
| `GET /api/v1/system-metrics` | 可用 | 资源和服务诊断 | 低频数据，不能与行情刷新共用状态分片 |
| `GET /api/v1/runs`、`GET /api/v1/events`、`GET /api/v1/summary`、`GET /api/v1/orders` | 可用 | 运行历史、事件、汇总、订单只读查询 | 以 `run_id` 查询，仍不是按 `marketId + roundId` 的实时读模型 |
| `GET /api/strategy-config`、`PUT /api/strategy-config` | 可用 | 读取/保存策略配置 | 使用 `expectedRevision` + `config`；没有独立 drafts/activate 路由 |
| `POST /api/trading/control` | 可用 | 启动、暂停、恢复、停止 | 使用 snake_case；`start` 的 `request_id` 必须是 UUID |
| `/api/bootstrap`、`/api/markets`、`/api/runtime/*`、`/api/rounds/*`、`/api/account/snapshot`、`/api/diagnostics/health`、`/api/metrics/summary` | 当前未发现 | 目标契约接口 | 前端不能把目标路径当成已部署能力；由 Adapter 明确选择回退或显示 `unavailable` |
| `/api/stream/markets`、`/api/stream/runtime`、`/api/stream/orders` | 当前未发现浏览器侧服务 | 三条独立实时流 | 引擎内部 WebSocket 不等于控制台可订阅流；未配置 URL 时不建立连接 |

### `/api/v1/markets` 的 legacy DTO

当前市场响应的核心形状是：

```json
{
  "current_markets": [{
    "slug": "...",
    "name": "...",
    "start": 0,
    "end": 0,
    "up_token": "...",
    "down_token": "...",
    "up_bid": 0.0,
    "up_ask": 0.0,
    "down_bid": 0.0,
    "down_ask": 0.0,
    "ask_sum": 0.0,
    "quote_at": "..."
  }],
  "collector_online": true,
  "collector_connected": true,
  "cache_age_seconds": 0,
  "checked_at": "...",
  "source": "..."
}
```

`slug` 只能作为缺少 `assetId/symbol` 时的展示资产线索，不能映射为现代 `marketId`。`id`、`slug` 和旧 `round_id` 都不能填充现代身份；当前响应没有服务端确认的 `marketId + roundId` 时，Adapter 必须把两者保持为 `null`，页面只能显示目录和报价，不能请求本场持仓/订单，也不能猜测当前轮次。后端提供真正的 `marketId + roundId` 后，才允许启用按轮次读模型。

当前控制台只维护 BTC 五分钟反转策略的单实例执行约束；市场目录可以返回后端明确声明 `supported`/`canEnable` 的其他资产用于目录展示和联调，但前端不猜测资格，运行池写入只接受目录中且服务端明确可启用的 asset ID。单实例后端若只接受一个 desired asset，市场页提交 `[selectedAssetId]`，current/next 仍以服务器确认值为准。

### `/api/trading/control` 的字段约束

当前路由不接受页面层的 camelCase 兼容字段。Adapter 发送 legacy 请求时必须转换为：

```json
{
  "action": "start",
  "strategy_id": "btc-reversal",
  "revision": 12,
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "mode": "live"
}
```

`pause`、`resume`、`stop` 也使用 `action`、`strategy_id`、`request_id`。响应只表示服务端接收或拒绝命令；按钮的最终状态必须来自后续 status/event 数据，不能由页面点击结果直接改成“运行中”。

### 当前账户数据边界

`/api/account/status` 只描述钱包/签名/relayer/builder 配置和最近检查结果；`/api/v1/account-data` 才可能提供 `collateral`、订单、成交、持仓及活动的只读分区。余额摘要字段（例如 `totalUsd`、`availableUsd`）不是当前 status 路由的稳定字段，Adapter 没有来源时必须显示 `unavailable`，请求失败时保留最后一次成功快照并标记 `stale`。

### Adapter 模式选择

前端默认 `apiFlavor: "contract"`，表示优先调用目标契约。连接当前 control-plane 时必须显式使用 legacy adapter，或由 Adapter 做完整的 DTO 转换；仅靠 HTTP 404 回退无法解决字段名、请求方法和语义差异。页面不应直接读取 legacy 字段，也不应为了填满界面而在浏览器推导 `roundId`、运行池确认结果或账户余额。

## 当前联调连接配置

当前 control-plane 脚本默认监听 `127.0.0.1:8765`（部署地址以实际反向代理为准）。在目标契约尚未部署前，前端联调应显式使用 legacy 模式：

```js
window.__POLY_PREVIEW_CONFIG__ = {
  mode: "backend",
  apiBase: "http://127.0.0.1:8765",
  apiFlavor: "legacy",
  strategyId: "btc-reversal",
  // 当前后端没有浏览器侧三条 stream 路由。
  streams: {}
};
```

legacy 模式实际使用的 DTO 边界如下：

- 市场：`GET /api/v1/markets` → 读取 `current_markets[].slug/name/start/end/up_token/down_token/up_bid/up_ask/down_bid/down_ask/quote_at`；`marketId`、`roundId` 缺失时保持 `null`。
- 运行：`GET /api/v1/status` → 读取 `running/run_id/config_revision/strategy_id/stats`；这是单运行状态，不是市场运行池确认。
- 控制：`POST /api/trading/control` → Adapter 发送 `action`、`strategy_id`、`request_id`（UUID）、`revision`，可带 `mode: "live"`。响应仅表示接收，最终状态仍需重新读取 status 或由后端事件确认。
- 策略：`GET /api/strategy-config`、`PUT /api/strategy-config`，保存体为 `{ expectedRevision, config }`；当前没有独立的 draft/activate endpoint。
- 账户：`GET /api/account/status` 读取配置/检查状态；`GET /api/v1/account-data` 读取 `collateral/open_orders/trades/positions/closed_positions/activity` 分区。余额摘要没有来源时保持不可用。
- 低频数据：`GET /api/v1/system-metrics`、`/api/v1/runs`、`/api/v1/events`、`/api/v1/summary`、`/api/v1/orders`，不能与高频行情共用刷新状态。

现代控制请求的页面输入可以使用任意 request ID 字符串，但 Adapter 在发送前统一规范为 UUID：

```json
{
  "action": "start",
  "marketIds": ["btc-market-id"],
  "strategyId": "btc-reversal",
  "revision": 12,
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

当前浏览器侧没有可确认的 `/api/stream/markets`、`/api/stream/runtime`、`/api/stream/orders` 服务地址。配置这些 URL 前，页面不会创建 WebSocket；配置后每个行情/订单帧必须同时提供 `marketId`、`roundId`、递增 `sequence`、可解析的 `sourceAt`、未来的 `expiresAt` 和 `stale: false`。重连后旧 sequence 会按 `marketId + roundId` 拒绝；过期、stale、缺字段或断线只保留最后成功快照并显示 stale。

## REST

| 用途 | 方法 | 路径 | 频率/说明 |
|---|---|---|---|
| 应用能力与版本 | GET | `/api/bootstrap` | 页面首次加载 |
| 加密货币五分钟目录 | GET | `/api/markets?asset=crypto&duration=5m` | 市场页约 1 秒一次；自动交易页约 10 秒一次重解析轮次；均为单请求完成后再排下一次，页面隐藏时暂停 |
| 单市场快照 | GET | `/api/markets/{marketId}/snapshot` | 自动交易页可见时约 1 秒一次；单请求完成后才排下一次，隐藏时暂停；`marketId + roundId` 变化时重新读取轮次数据；同一身份不重建 WebSocket |
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
| 系统诊断 | GET | `/api/diagnostics/health` | 总览约 15 秒，设置页手动刷新 |
| 汇总统计 | GET | `/api/metrics/summary?range=today` | 总览约 15 秒/手动刷新；legacy 使用当前 run 汇总回退 |
| 事件历史 | GET | `/api/events?cursor=...` | 分页，低频 |

市场目录返回 `assetId/symbol/name/marketId/roundId/cycle/startAt/endAt/yesToken/noToken/yesBid/yesAsk/noBid/noAsk/volume/liquidity/quoteAt/enabled/nextRound`。`marketId` 和 `roundId` 在生产数据中都必须是非空字符串；不要让页面直接使用旧的 `up_bid/down_bid` 字段。

如 `/api/markets` 同时返回可展示盘口，盘口字段使用以下形状；Adapter/ViewModel 会原样保留 `orderBook` 和来源元数据：

```json
{
  "marketId": "btc-market-id",
  "roundId": "btc-round-id",
  "orderBook": {
    "yes": { "bids": [[0.48, 10]], "asks": [[0.49, 8]] },
    "no": { "bids": [[0.51, 9]], "asks": [[0.52, 11]] }
  },
  "sequence": 42,
  "sourceAt": "2026-09-24T12:00:00.000Z",
  "expiresAt": "2026-09-24T12:00:02.000Z",
  "stale": false,
  "depthUnavailable": false
}
```

`bids`/`asks` 也可使用 `{ price, size }` level 对象。`depthUnavailable: true`、`stale: true`、缺少身份或缺少 sequence/sourceAt/expiresAt 时，前端保留上一份盘口并显示待接入/过期，不显示实时已连接。stale 市场目录没有新条目时，Store 保留最后一次成功目录。

运行池 GET/PUT 的语义如下：

- `desiredIds` 是用户希望启用的资产 ID，由市场页提交。
- `currentIds` 是服务器确认正在运行的资产 ID。
- `nextRoundIds` 是服务器确认下一场生效的资产 ID。
- `effectiveRoundId` 是这次变更计划生效的轮次。

前端 PUT 只提交 `desiredIds` 和可选的 `effectiveRoundId`，不能用客户端状态覆盖服务器的 `currentIds` 或 `nextRoundIds`。当前单实例运行池要求始终保留一个 desired asset；市场页因此会禁用最后一个已启用币种的停用操作，停止交易使用 runtime stop 命令。

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

没有配置某个流的 URL 时，该流不会创建连接，不会用定时器或演示数值补齐实时数据。相同 `marketId + roundId` 的目录/运行池轮询只更新 REST 数据，不关闭现有流；主动关闭旧流不会标记新流断线。断线重连期间页面保留最近成功数据并标记 `stale`。

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

响应只代表命令是否接收；最终结果由 runtime stream 返回。状态建议：`stopped/starting/running/pausing/paused/stopping/error`。停止响应中的 `remoteOrdersState`/`remote_orders_state` 可能为 `unconfirmed`；前端必须明确显示远端挂单撤销尚未确认，不能把停止请求接收解释为撤单已完成。控制台只在当前市场有服务器确认的可停止状态时开放停止；运行状态 stale/unavailable 或缺少市场身份时保持禁用并等待刷新，避免对未知运行发送控制命令。

## 前端调用方式

页面不直接调用 `fetch`。统一使用 `window.PolyPreviewAdapter`：

```js
await PolyPreviewAdapter.loadMarkets();
await PolyPreviewAdapter.commandRuntime({ action: "start", marketIds, strategyId, requestId });
await PolyPreviewAdapter.saveStrategy(draft);
```

adapter 完成 DTO 转换后写入 `PolyPreviewStore`，页面只订阅对应分片。后端未接入时返回明确的 `unavailable/stale` 状态，不模拟成功，也不把浏览器本地状态当成服务器运行状态。

策略保存和激活是两个动作：策略页先向 `/api/strategy/drafts` 提交完整 config（包括 `maxStages`）并保存 `draftId`/`expectedRevision`，不会自动发布或启动；随后向 `/api/strategy/activate` 提交 `{strategyId,draftId,expectedRevision}`。当前服务端只支持未来未创建场次生效，`effectiveRoundId` 非空会返回 501；只有激活确认正 revision 并重新读取已发布配置后，启动命令才可提交该 revision。只有明确配置 `apiFlavor: "legacy"` 时才使用旧 `PUT /api/strategy-config`，旧接口的保存语义是直接发布，页面会隐藏单独激活按钮并明确提示。

后端联调时需要先提供：市场目录、运行池、runtime status、单市场快照和带 `roundId` 的持仓/订单查询；随后接入 markets/runtime/orders 三条实时流。若暂时只有现有策略接口，部署配置必须明确使用 `apiFlavor: "legacy"`，不能让现代草稿接口静默降级为直接发布。账户秘密不经过浏览器接口，账户页面只读取服务器保存状态；如需更换账户，由服务器环境配置或部署系统完成。真实账户和交易链路完成联调前，不能把页面的“已连接”“运行中”解释为真实下单成功。
