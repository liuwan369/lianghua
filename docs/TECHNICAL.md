# 参数、接口与执行语义

本文描述六页控制台、Python 服务与 TypeScript 引擎的实际连接边界。金额、费用、持仓和运行状态必须携带所属运行及数据来源；未知值不能默认为零。

## 页面保存与后台参数

页面 `web/src/forms.ts` 只提交以下六项映射：

| 页面字段 ID 后缀 | 后台参数 | 含义 |
|---|---|---|
| `order` | `order_usd` | 单笔金额上限 |
| `life` | `maker_life_sec` | 挂单寿命，秒 |
| `mode` | `mode` | paper/live，保存不启动 |
| `duration` | `duration_min` | 运行时长，分钟 |
| `submitted` | `max_total_usd` | 累计提交名义金额上限，不是当前净持仓 |
| `maxOrders` | `max_orders` | 订单数上限 |

其他高级输入仅保留本页草稿，不持久化、不生效。后台完整配置模式另支持以下范围；后台支持不代表存在相应正式页面绑定：

| 参数 | 默认值 | 校验范围 |
|---|---|---|
| `order_usd` | 2 | 0.01–1000 |
| `pair_cost_max` | 0.99 | 0.90–1.00 |
| `max_orders` | 50 | 整数 1–10000 |
| `max_total_usd` | paper 100 / live 10 | 0.01–100000 |
| `duration_min` | paper 5 / live 15 | 0 表示不限时，否则 0.1–1440 |
| `maker_life_sec` | 15 | 1–300 |
| `decision_interval_ms` | 0 | 0–60000 |
| `defensive_cancel_bps` | 0 | 0–1000 |
| `mode` | paper | paper/live |

数值必须是有限 JSON number，字符串、布尔值、NaN、未知字段均拒绝。配置保存采用 `{params, expected_revision}`，版本冲突返回 409；成功后下次启动生效。损坏或已保存后丢失的配置会报错，不静默恢复可运行默认值。省略字段按明确的模式默认值补齐，前端保存则携带已有参数全量快照。

## HTTP 接口

| 方法与路径 | 用途及边界 |
|---|---|
| GET `/api/v1/config` | 参数、版本及能力说明 |
| POST `/api/v1/config` | 非敏感配置保存 |
| GET `/api/v1/status` | 运行状态及数据来源 |
| GET `/api/v1/markets` | 市场与盘口状态 |
| GET `/api/v1/runs?limit=50&before_id=...` | 运行列表游标分页 |
| GET `/api/v1/events?run_id=...&limit=50&before_id=...` | 指定运行事件游标分页 |
| GET `/api/v1/summary?run_id=...` | 运行账本摘要，不是钱包账单 |
| GET `/api/account/status` | 脱敏账户状态 |
| POST `/api/account/check` | 只读账户检查，不保存 |
| POST `/api/account/save` | 检查后持久化账户；失败不覆盖配置 |
| GET `/api/live` | 采集行情/分析适配数据 |
| POST `/api/v1/trading/start` | 按版本化配置启动，仅支持 paper |
| POST `/api/v1/trading/stop` | 停止请求及退出状态 |
| POST `/api/trading/start`、`/api/trading/stop` | 底层控制接口；live 使用独立解锁及授权 |

前端普通请求超时 8 秒，按约 5 秒刷新并检查行情/事件新鲜度；账户操作超时 55 秒。账户只读后端主要 RPC 尝试 25 秒，失败时备用尝试 20 秒；并发检查返回 429，校验、上游或超时错误按情况返回 400/502/503/504。HTTP 成功只证明此次接口请求结果，不能代替业务端到端验收。

公网页面登录关闭。账户写入要求正确公网 origin/代理配置；真实交易控制另外要求 control token、明确确认及 `PM_TRADING_LIVE_UNLOCK=1`。账户检查或保存不创建交易所订单、不自动进行链上授权。

## 账户 V2

真实执行适配使用 `@polymarket/clob-client-v2` 1.1.0，版本端点必须返回原始数值 `2`。账户检查使用 `@polymarket/client` 0.9.0，但 readiness 只评估实际 V2 标准和 neg-risk 路径所需的 allowance/operator，不把其他产品授权纳入本系统门槛。

2026-09-10 私有只读验证完成已有 API key 派生、未结订单、成交和 collateral 查询；未创建新 key、未提交订单或链上交易。凭据仅在检查内存使用，不能把私有查询通过写成资金执行验收通过。账户检查编译缓存与 RPC 配置见 [QUICK_REF.md](QUICK_REF.md)。

## 策略与风险约束

在线 `Engine` 默认 `target_clone`，不是 `stableLive` 锁定预设。默认启用 `dynamicHedgeSizing`；`target_clone` 的补仓配对最终上限 `hedgePairCostCeiling=0.99`。CLI `--pair-cost-max` 改变 `pairCostMax` 与 `pairAddCostMax`，不是所有风险阈值的通用替换。

每边 maker 价格先按该 token 的真实 tick 向下量化；缺少有效 tick 则拒绝挂单，不使用 0.01 猜测值。数量经过预算、单边限制、最坏结算亏损及挂单未成交负债检查，至少满足策略 5 份门槛；执行器再校验市场真实最小数量，不能扩大已批准数量。估算手续费计入成本，返佣奖励不抵扣下单成本。

缺边修复有两层门槛：maker 候选门槛随裸露时长从约 0.99 放宽至最多 0.999；裸露达 30 秒或距结束不超过 75 秒的强制候选分支检查含费 taker 成本不超过 `pairCostEmergencyStop=1.05`。但当前启用的动态补仓构建仍检查最终 0.99 上限。因此候选通过 1.05 并不意味着允许以 1.05 最终提交，更不保证补齐。

例如已持 DOWN 均价 0.18，UP ask 为 0.95，模型费用为 `0.07 × 0.95 × 0.05 = 0.003325`，候选总成本 1.133325，超过 1.05 会拒绝。这是模型估计，不是交易所真实费用凭证。小于最小数量的残余、预算不足或缺边过贵均可能留有未配对库存；尚无已验证的强制亏损平仓政策或盈利保证。

部分成交只扣减匹配订单的剩余负债；撤单请求发出后必须等确认才释放。订单替换使用身份匹配，迟到事件不能清除新挂单。live taker 在途期间冻结新提交，固定份数 FOK 避免更优价格导致数量膨胀。拒绝原因变化记录为 `decision_rejected`。

退出先排空提交、撤单并核对剩余订单和稳定成交，记录迟到成交且只处理本运行所属订单。Python 等待 8 秒未完成时返回 pending，不强杀引擎；重复停止不反复向同一 PID 发信号。这些路径有模拟测试覆盖，真实资金退出仍需验收。

## 存储与回放

引擎根目录下 `results/dashboard/config.json` 存非敏感配置，`results/dashboard/ledger.sqlite3` 存投影账本。证据库位于部署根目录 `data/pm-r25-live/days`。日志、证据与账本各自保留来源，不把模拟 fill 当作真实交易所回报。

回测快照必须包含两边 token 当时真实 `tick_size` 或 `tickSize`；无效或冲突元数据直接报错。时间戳保留显式时区，无时区按 UTC；非法时间报错。详见 [BACKTEST-TICK-DATA.md](BACKTEST-TICK-DATA.md)。
