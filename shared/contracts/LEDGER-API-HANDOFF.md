# 账本与 API 交接说明

更新时间：2026-09-24

本文件描述 `codex/ledger-api` 当前可交接的真实边界。账本/API 只消费交易运行时事件和已接受的行情投影，不连接 Polymarket WebSocket，不执行策略判断、资金预留、下单、撤单、成交恢复、结算触发或链上 redeem。

## 当前提交

- 账本、控制面和共享契约：`ae1820c`
- 结算凭据三态回归测试：`2c3d9fd`
- 当前交接审查修复：`b56ef6c`（accepted snapshot、market-pool 持久化、bootstrap 来源时间和旧行情回退语义）
- 当前分支：`codex/ledger-api`
- 当前工作区已验证无未提交修改。

交易运行时和行情分支不在本工作区。当前运行时状态快照已提供 `roundId` 和结算身份；但运行时 CLI 的 order/fill/settlement journal 仍需要直接写 `market_id/round_id`，账本保留晚到映射作为兼容路径。组合部署提交号需要集成会话在合并各分支后产生。

## 数据流

```text
交易运行时 platform.js
  -> JSONL journal、state-file、platform_status
  -> 控制面启动/停止/暂停/恢复状态
  -> 独立 projection_worker
  -> Ledger SQLite + snapshot.json + heartbeat.json
  -> 只读 REST API / 前端

行情底座/运行时已接受快照
  -> 控制面缓存和市场 DTO
  -> 前端市场目录/单市场快照
```

控制面启动交易子进程时继续传递：

- `--journal-file`
- `--state-file`
- `--control-file`
- `--stop-file`

运行日志路径模式为 `TRADING_ROOT/results/live/dashboard-<run_id>.jsonl`；运行时 state/control/stop 文件位于同一 `results/live` 目录，控制面恢复状态实际位于 `TRADING_ROOT/results/dashboard-state.json`。账本 SQLite 位于 `TRADING_ROOT/results/dashboard/ledger.sqlite3`，异步投影快照位于同目录的 `snapshot.json` 和 `heartbeat.json`。

HTTP 请求只读取 SQLite、原子 JSON 快照或已有缓存。投影 worker 才打开 journal 并批量消费，查询不会在行情回调或下单线程中解析日志，也不会执行历史统计、资源采样或账户 RPC。

## Journal 输入和账本投影

至少消费以下事件：

| 运行时事件 | 账本用途 |
|---|---|
| `order` | 同一订单生命周期投影，保留状态、已成交数量、预留资金和市场身份 |
| `fill` | 同一成交生命周期投影，支持状态推进、失败修正和实际费用回补 |
| `platform_settlement` | 结算状态、交易回执、到账金额、成本核对和最终盈亏 |
| `platform_status` | 运行状态、市场映射、策略轮次、持仓覆盖和暂停确认 |
| `platform_stopped` | 停止事件和运行日志历史 |
| error 事件 | 运行错误和事件列表中的错误状态 |

`order_abandoned` 会归一为 `kind=error`，并保留 `source_event=order_abandoned`；运行时提供的安全 `message` 会进入事件 DTO，原始异常和凭据不会进入投影。

`marketId`/`market_id` 是运行时提供的 Polymarket condition ID；`roundId`/`round_id` 是运行时明确提供的 BTC 五分钟场次边界字符串。账本从 `platform_status.runtime.markets[]`、`strategy_runtime.currentRound` 和 `strategy_runtime.rounds[]` 建立映射，并可回填先到达的订单、成交和结算。

缺少映射时字段保持 `null`，不根据 slug、name、当前时间或事件时间猜轮次。单次 journal 的 `event_id` 只负责事件去重；跨运行统计在同一账户内按 `trade_id + order_id` 去重，不同账户隔离。

成交规则与运行时生命周期一致：`CONFIRMED` 是终态，旧时间戳不能覆盖新状态；较新的确认可以修复先前失败记录；费用从估算升级为报告值时只更新费用字段，保留原市场、数量、价格和成本字段。

## 现代 API DTO

所有现代响应都带：

```text
schemaVersion, source, asOf, stale, error
```

时间字段使用 UTC Unix 秒数；未知时间、金额、身份和盈亏使用 `null`。错误或断线时保留最后一次成功快照及原始来源时间，并设置 `stale=true`；从未成功时返回 `available=false` 或字段为 `null`，不能返回伪造的零仓位、零盈亏或成功状态。

主要接口和字段：

| 接口 | 关键字段和语义 |
|---|---|
| `GET /api/markets` | 运行时 accepted `snapshots[]` 优先；采集器 `current_markets[*].snapshot`（兼容 `paired_snapshot`）也可无损展示 `marketId/roundId/YES/NO/assetId/bids/asks/sequence/sourceAt/expiresAt`，但固定 `strategyEligible=false`；仅 legacy row 时 `depthAvailable=false`、`strategyEligible=false`、`stale=true` |
| `GET /api/markets/{marketId}/snapshot` | 市场 DTO 加同一份 `orderBook`；accepted snapshot 可提供五档和 freshness 字段，旧采集器回退不伪造深度 |
| `GET /api/runtime/status` | `status/state/serviceState/commandStatus/remoteOrdersState/runId/strategyId/execution/markets/projection/asOf/stale/error` |
| `GET/PUT /api/runtime/market-pool` | 服务器持久化 BTC 五分钟运行池；读取 `market_pool.json` 的 `desired/current/next/effective/updatedAt`，写入只接受 `btc`，当前/下一场仍由运行时确认 |
| `GET /api/rounds/{roundId}/position` | `available/runId/marketId/roundId/yesShares/noShares/averagePrice/occupiedUsd/outcomePnl/updatedAt/expiresAt/stale/error` |
| `GET /api/rounds/{roundId}/orders` | 分页订单、`clientOrderId/orderId/marketId/roundId/status/filledShares/updatedAt/fills`，支持快照游标避免分页漂移 |
| `GET /api/fills?runId=...` | 成交生命周期事件；同一经济成交可能有修订，前端不能直接逐行累加 |
| `GET /api/settlements?runId=...` | 每场最新结算；`state/payoutVerified/accountingState/pnl/pnlError/marketId/roundId` |
| `GET /api/metrics/summary?range=run\|today\|all` | 账户隔离的 `fill_count/fill_notional/fees/estimated_fees/settled_pnl/win_rate/pending_settlements` 等慢统计 |
| `GET /api/events?runId=...` | 按账本事件 ID 游标分页；事件含 `id/time/kind/marketId/roundId/severity/message` |
| `GET /api/account/status` | 非秘密账户配置和检查摘要，兼容旧入口 |
| `GET /api/account/snapshot` | 独立只读账户余额/抵押品快照，不返回密钥 |
| `POST /api/account/check` | 服务器执行只读账户检查；不会保存账户，响应不含私钥或 Token |

`fees` 只表示已确认费用；`estimated_fees` 单独表示估算费用。未决订单、未确认结算、费用或成本缺失不进入最终盈亏和胜率。结算必须同时满足确认状态、`payout_verified`、有效交易回执、到账金额和可核对成交成本。

## 运行命令接口

现代入口是 `POST /api/runtime/commands`，请求至少包含：

```json
{
  "action": "start|pause|resume|stop",
  "strategyId": "btc-reversal",
  "revision": 12,
  "requestId": "uuid"
}
```

响应中的 `accepted=true` 只表示控制面接收请求，不表示交易所动作已经完成。`commandStatus` 使用 `accepted|executing|confirmed|failed`；最终运行状态以 `/api/runtime/status` 和 journal 的运行事件为准。暂停最终以 `strategy_runtime.paused=true` 确认；停止后的远端订单和资金释放默认是 `remoteOrdersState=unconfirmed`，不能从进程退出或 HTTP 200 推断交易所已经撤单。

策略草稿、激活、旧 `PUT /api/strategy-config` 和旧 `/api/trading/control` 保持兼容，但现代策略只允许 `btc-reversal`。指定历史场次激活、运行池编辑、单笔撤单和 flatten 当前仍返回不支持，不伪造成功。

## 账户状态三态

交易运行时 `account-check` 如提供 `settlement_credentials_ready`，账本/API 只按以下规则展示：

- `true` 原样返回 `true`；
- `false` 原样返回 `false`；
- 缺失、显式 `null` 或无法识别的值返回 `null`。

该字段不由账本根据 Builder/Relayer 字段猜测，也不把任何凭据写入 SQLite、快照、日志、DTO 或浏览器。当前字段同时保留 snake_case 和 camelCase 兼容名称：`settlement_credentials_ready`、`settlementCredentialsReady`。实盘启动门控要求该字段明确为 `true`；`false` 或 `null` 只能展示为未就绪，不能启动实盘。

## 兼容和剩余风险

1. 旧 `/api/v1/markets` 保留旧 `round_id` slug 字段；现代 `roundId` 不使用该兼容字段，也不会据此给历史订单归属。
2. 前端必须使用现代 `marketId`/`roundId`、YES/NO 字段和 `stale/error` 状态，不能把旧 `up_bid/down_bid` 或 slug 当成现代身份。
3. 运行时必须持续输出显式 `roundId`；若旧运行时仍缺字段，账本会安全返回 `null`，相关按场次查询会 unavailable。
4. `account-check` 的 `settlement_credentials_ready` 需要由交易运行时 CLI 输出；账本只透传三态，控制面实盘启动要求明确为 `true`。交易运行时仍负责根据钱包类型验证 Builder/Relayer，并在 redeem 前结合真实回执确认。
5. 运行时 CLI 仍需直接在 order/fill/settlement journal 写入 `market_id/round_id` 和订单 `created_at`；在此之前账本依赖状态映射回填，前端可能看不到完整的首条事件身份。
6. 尚未完成服务器实测：真实下单、撤单、成交回报、资金释放、重启恢复、连续场次切换和链上 redeem。
7. `/api/stream/markets` 本轮仍未接通，bootstrap 保持 `capabilityDetails.streams=false`；集成会话不能把 404 当成已提供流。
8. 行情会话仍需在 collector serializer 写入 `current_markets[*].snapshot` canonical 对象；控制面已兼容 `snapshot`、`paired_snapshot` 和直接 canonical row，未提供该对象时只能使用 legacy 展示回退。
9. 集成会话需要组合最新 `codex/market-data`、`codex/trading-runtime` 和本分支最新提交，生成组合部署提交号并执行真实联调；本会话没有权限伪造该提交号。

## 验证

当前分支已通过：

```text
41 dashboard tests passed
python -m compileall -q backend/control-plane/scripts
git diff --check
```
