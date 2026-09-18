# 当前控制台 API

更新时间：2026-09-18。实现位于 `scripts/system-dashboard-server.py`。正式基址为 `https://34-242-206-196.sslip.io`，所有 JSON 响应禁用缓存。本文只描述当前反转系统实际使用的接口；部署状态见 [CURRENT-STATUS](CURRENT-STATUS.md)。

## 当前主接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/strategy-config` | 读取单一反转策略的保存版本、当前场版本和下一场版本 |
| PUT / POST | `/api/strategy-config` | 以 `expectedRevision` 全量保存策略配置 |
| POST | `/api/trading/control` | `start`、`pause`、`resume`、`stop` |
| GET | `/api/v1/status` | 实际进程、当前运行、策略、盘口、持仓、风险和延迟 |
| GET | `/api/v1/orders` | 当前运行的固定快照订单分页 |
| GET | `/api/v1/account-data` | 账户余额、开放订单、成交、持仓和账户活动的后台缓存 |
| GET | `/api/v1/system-metrics` | CPU、内存、磁盘、负载和关键进程 |
| GET | `/api/v1/markets` | 后台缓存的市场发现与采集健康状态 |
| GET | `/api/v1/runs` | 历史运行分页 |
| GET | `/api/v1/events` | 指定运行的事件分页 |
| GET | `/api/v1/summary` | 指定运行摘要 |
| GET | `/api/account/status` | 账户配置存在性和最近检查，不返回秘密 |
| POST | `/api/account/check` | 只读检查已保存账户或输入的候选账户 |
| POST | `/api/account/save` | 校验并原子保存账户；同时清除进程内实盘解锁 |

`/api/v1/config`、`/api/v1/trading/start|stop`、`/api/trading/start|stop`、`/api/trading/status` 和 `/api/trading/log` 仍是旧控制端兼容接口，不是当前页面主路径。生产瘦身前不能删除仍被部署脚本或恢复工具引用的兼容路由。

## 策略配置

保存请求：

```json
{
  "expectedRevision": 3,
  "config": {
    "triggerPrice": 0.67,
    "confirmationPrice": 0.70,
    "maxBuyPrice": 0.70,
    "stageShares": [5, 18, 54, 130],
    "maxStages": 4,
    "roundBudgetUsd": null,
    "totalBudgetUsd": null,
    "dailyLossUsd": null,
    "durationMinutes": 0,
    "mode": "live",
    "maxQuoteAgeSeconds": 2,
    "maxQuoteSkewSeconds": 1.5
  }
}
```

字段必须完整且不能有未知项。`expectedRevision` 不等于服务端当前版本时返回 409，客户端必须重新读取，不能静默覆盖。价格单位为 0 到 1；可选预算为 `null` 时不增加该项限制，真实余额和交易所规则仍生效。保存不会启动交易。

## 交易控制

启动请求需要：

```json
{
  "action": "start",
  "strategy_id": "btc-reversal",
  "revision": 3,
  "request_id": "UUID"
}
```

暂停、恢复和停止使用相同接口及相应 `action`。`request_id` 用于控制幂等。接口接受不等于进程已经达到目标状态，最终以 `/api/v1/status` 的实际进程和运行投影为准。停止后的 `process_stopped=true` 也不能单独证明远端开放订单已经撤完。

写操作使用 `X-PM-Control-Token`。公网页面免登录不等于交易控制免认证，也不等于实盘解锁。账户接口还校验 Origin/Host、JSON Content-Type 和可信 HTTPS 代理。

## 订单分页

请求参数：

| 参数 | 说明 |
| --- | --- |
| `run_id` | 必填，订单所属运行 |
| `limit` | 页面使用 10、20 或 50 |
| `offset` | 当前快照内偏移 |
| `status` | `active`、`failed` 或精确状态 |
| `market` | market slug |
| `as_of` | 首次请求返回的快照时间 |
| `snapshot_event_id` | 首次请求返回的事件上限 |

后续页同时带回 `as_of` 和 `snapshot_event_id`，避免新事件导致翻页重复或遗漏。服务端按 `client_order_id` 聚合生命周期。`order_notional` 是委托额，`amount` 是有真实证据的成交额，无证据时为 `null`；`fills` 展开真实成交。

撤单字段 `cancel_requested_at`、`cancel_ack_at`、`cancel_ack_latency_ms` 可为空。只有交易所确认撤单时才填写 ACK 时间和耗时，撤单失败或未知不得伪造。

## 状态与口径

`/api/v1/status` 的 `running` 来自实际进程，`run_id` 标识当前运行，`strategy_id` 标识实际加载策略。`stats.runtime` 提供策略状态、活动持仓、风险、市场盘口和延迟；数据包含来源时间、新鲜度和过期标记。无可靠值返回 `null` 或缺省，前端显示未知。

`/api/v1/account-data` 是钱包级只读缓存，不等于当前策略订单。它将当前有效持仓、待到账、待核对和已结算零价值残留分开。上游余额、订单、成交、持仓和活动是分离查询，不宣称跨接口原子快照。

`/api/v1/system-metrics` 返回主机和关键进程的缓存值。它用于展示服务器健康，不进入订单热路径。

## 结算与收益字段

`platform_settlement` 中只有 `state=confirmed` 且 `payout_verified=true` 才能把 `credited_usd` 显示为真实到账。`expected_payout_usd` 是预计值，`cash_before_usd` 与 `cash_after_usd` 只用于辅助核对，不能单独替代回执。

费用字段同时给出来源。`estimate` 或 `rate-derived` 只显示估算；只有交易所报告或可核验链上证据才归入已核实费用。

## 错误语义

- `400`：请求结构、字段或参数不合法。
- `403`：控制令牌、来源或实盘条件拒绝。
- `404`：路由、运行或证据不存在。
- `409`：配置版本冲突或运行状态冲突。
- `415`：账户操作 Content-Type 不合法。
- `429`：账户检查或证据读取忙碌。
- `502/503/504`：上游响应、存储/服务或超时错误。

错误响应必须脱敏，不返回私钥、API secret、签名请求头或完整账户配置。
