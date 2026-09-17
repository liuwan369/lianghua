# 当前反转策略接口（2026-09-18）

以下是现行接口，后文旧配置仅作兼容说明。配置保存与启动分开，未知值不显示为0。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/strategy-config` | 单一反转策略配置、savedRevision、activeRevision、nextRoundRevision |
| PUT / POST | `/api/strategy-config` | `{expectedRevision, config}` 全量保存，冲突409；可带strategyId |
| POST | `/api/trading/control` | `{action: start/pause/resume/stop,strategy_id,revision,request_id}`；start需已保存版本和UUID |
| GET | `/api/v1/orders` | run_id、limit=10/20/50、offset、status、market=slug、as_of、snapshot_event_id；返回orders/total/has_more/asOf/snapshotEventId |
| GET | `/api/v1/status` | 真实进程与stats.runtime.strategy_runtime/positions/books |

config价格用0..1，stageShares数组，maxStages整数，roundBudgetUsd/totalBudgetUsd/dailyLossUsd可空null，durationMinutes=0为持续运行，mode=live/paper，maxQuoteAgeSeconds/maxQuoteSkewSeconds为报价时效。历史70/75仅可编辑参数模板。

订单状态过滤 active=SUBMITTING/OPEN/PARTIAL/UNKNOWN，failed=REJECTED，也支持精确状态。首次分页返回asOf与snapshotEventId，后页同时传as_of及snapshot_event_id冻结当时快照；新单和迟到采集的旧事件不会改变历史页。服务端按client_order_id汇总一次生命周期，订单有ACK后包含order_id。amount是实际成交额（缺证据为null），order_notional是委托额，fills展开各笔成交。

订单投影新增以下可空字段；旧账本没有这些字段时保持 `null`：

| 字段 | 语义 |
| --- | --- |
| `cancel_requested_at` | 执行核心开始向交易所发送撤单请求的墙钟秒时间 |
| `cancel_ack_at` | 交易所确认撤单的墙钟秒时间；撤单失败或结果未知时不能填写 |
| `cancel_ack_latency_ms` | 从开始撤单请求到收到交易所确认的单调时钟耗时；不包含撤单前的持久化、页面刷新或后续成交对账 |

撤单 ACK 可能与已经在途的成交竞态，`CANCELLED` 不能单独证明没有迟到成交。撤单失败只记录请求时间及未知/失败状态，不伪造 `cancel_ack_at` 或 `cancel_ack_latency_ms`。

结算事件 `platform_settlement` 新增以下可空字段：

| 字段 | 语义 |
| --- | --- |
| `payout_verified` | 只有真实赎回操作已有成功回执，且回执能给出到账金额时为 `true` |
| `credited_usd` | 回执确认的本次赎回到账金额；确认的零到账为 `0`，未知保持 `null` |
| `expected_payout_usd` | 根据待赎回赢家份额计算的预计返还，用于与到账核对，不等同已到账 |
| `cash_before_usd` | 提交赎回前读取的现金余额；可能受同时发生的其他钱包活动影响 |
| `cash_after_usd` | 赎回确认后读取的现金余额；不能单独以余额差替代回执到账金额 |

前端只有在结算 `state=confirmed` 且 `payout_verified=true` 时显示 `credited_usd` 为真实到账。没有剩余持仓可以结束结算流程，但该结果的 `payout_verified=false`，不能显示成已到账。上述字段已随软件基线 `70d2b55` 发布；本轮真实赎回证据仍未完成。

控制和保存使用既有 `X-PM-Control-Token`（部署配置时要求）。暂停响应control_pending不等于引擎已暂停，最终以运行投影paused为准。成交trade_status按trade_id+order_id更新，FAILED冲正，CONFIRMED/FAILED终态不能被旧消息倒退。fee_source=estimate/rate-derived时只显示估算，不归入已核实手续费。

# 控制台 API

更新时间：2026-09-18 01:44。实现：`scripts/system-dashboard-server.py`。正式来源为 `https://34-242-206-196.sslip.io`；API 返回 JSON，并禁用响应缓存。`control_source` 用于标识实际数据/控制来源。本文描述软件发布基线 `70d2b55` 的平台和控制台 API；真实验收范围以 [当前状态](CURRENT-STATUS.md) 为准。

## 读取

| 方法与路径 | 内容 |
| --- | --- |
| GET /api/v1/status | 运行模式、运行编号、配置版本、实盘锁、投影状态和统计 |
| GET /api/v1/config | 参数、revision、savedAt、capabilities |
| GET /api/v1/markets | 缓存的都柏林行情、采集健康度、新鲜度 |
| GET /api/v1/runs?limit=50&before_id=… | 分页运行列表 |
| GET /api/v1/events?run_id=…&limit=50&before_id=… | 指定运行的事件分页 |
| GET /api/v1/summary?run_id=… | 指定运行摘要 |
| GET /api/account/status | 账户配置存在性、公开钱包、最近内存中检查结果，不返回密钥 |
| GET /api/live | 引擎 paper/兼容客户端使用的行情快照 |
| GET /api/trading/status | 兼容运行状态 |
| GET /api/trading/log | 有上限的引擎事件与控制台日志尾部 |

运行事件不等于完整真实委托生命周期。新平台日志出现实际订单事件后，摘要的 `order_lifecycle_available` 才为 true；无策略观察运行没有订单。进程重启后账户 `last_check` 可以为空，不能把它当成授权失效。

状态新增 `execution_target`、`engine`、`execution`、`strategy_id`，区分当前平台和旧引擎记录。`stats.runtime` 包含当前运行的真实或模拟现金、订单/持仓数量、风险、市场及最多十档快照，并带 `source_at/expires_at/age_seconds/stale`；10 秒失效，API 刷新不续鲜。`stats.orders` 最多返回最新 50 单，同时提供总数和截断标记；未知值为 null。反转页面已展示5/10档深度和分段延迟；无有效来源时显示未知。

`stats.runtime.risk` 还包含 `dailyPnlUsd`、`dailyLossStatus`、`cashFlowComplete`、`cashFlowCoverageFrom/Until`、`netExternalFlowUsd` 和 `pnlVerified`。`pnlVerified=false` 表示较新的充值提现或现金观察尚未落入完整确认覆盖，页面显示“暂估”；它不会单独阻止交易。用户未配置日内停止线时 `dailyLossStatus=disabled`。

通用 `/api/v1/account-data` 不再返回旧 `risk_contract`（固定50/30及原子快照门槛）。`occupancy.observed.capital_headroom_estimate_usd` 为null：账户读取器不知道当前策略预算，不能用历史常量推算。当前预算读取策略配置或运行时limits，账户观测估算不代表实际可下单额度。

## 写入与检查

| 方法与路径 | 请求/行为 |
| --- | --- |
| POST /api/v1/config | 完整 params 与 expected_revision，版本化保存 |
| POST /api/v1/trading/start | 接收 revision 与 UUID request_id，启动指定已保存版本的 paper；同一请求幂等，不是新版网页实盘入口 |
| POST /api/v1/trading/stop | 请求停止，检查返回的确认状态 |
| POST /api/account/check | 空对象检查已保存账户，或检查所填候选；不保存 |
| POST /api/account/save | 校验候选并原子保存账户；清除进程内实盘解锁 |
| POST /api/trading/start、/api/trading/stop | 兼容交易控制接口，受独立控制校验和实盘门槛约束 |

请求须为 JSON 对象，最大 32,000 字节。配置完整替换和边界见 [配置契约](../contracts/config-v1.md)。账户字段只接受 wallet、owner_key、relayer_key、relayer_address、builder_api_key、builder_secret、builder_passphrase；Builder 三项必须同时填写或同时留空。服务运行交易期间拒绝检查/更换账户。

公网登录认证按当前部署配置关闭。账户操作要求 Origin/Host、JSON 类型、可信 HTTPS 代理及所配置公开来源匹配；此来源规则不识别用户身份。交易控制令牌与实盘解锁是另一组条件，公开访问不等于允许真实交易。旧版 `/api/v1/trading/start` 保留无策略 paper 观察兼容。新版 `/api/trading/control` 显式选择内置 btc-reversal，读取保存版本并支持真实运行；不接收任意代码路径。旧历史记录仍可读取。

## 错误语义

常见错误为 400 输入不合法、403 来源/控制拒绝、404 路由/运行不存在、409 配置冲突、415 账户 Content-Type 不合法、429 账户检查忙碌。账户检查另有 502 无效响应、503 查询/检查服务不可用、504 超时，返回脱敏 error_code 和 retryable。读取存储异常可返回 503；POST 的普通 RuntimeError 当前映射为 400，不能统一声称所有存储失败都为 503。
