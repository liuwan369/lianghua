# 配置契约 v1（控制台兼容配置）

实现：`scripts/dashboard/config.py` 与 `scripts/system-dashboard-server.py`。核对日期：2026-09-16。
本文件描述本批源码中的控制台版本化配置及平台观察接入，不代表已经部署，不是 `StrategyPlugin` 契约。策略接入已暂停；公共交易底座的接口边界以 [`docs/STRATEGY-INTERFACE.md`](../docs/STRATEGY-INTERFACE.md) 和 [`docs/TECHNICAL.md`](../docs/TECHNICAL.md) 为准。

## 读写与生效

`GET /api/v1/config` 返回 schemaVersion、revision、savedAt、params、capabilities 和 control_source。首次未保存时 revision=0、savedAt=null。

`POST /api/v1/config` 的外层字段必须恰为 `params` 与 `expected_revision`。params 是完整替换：省略的字段恢复对应模式默认值。前端须保留读到但页面没有编辑控件的参数。expected_revision 是非负整数，保存成功递增版本；版本冲突返回409及current_revision。

保存不启动、不热更新现有运行、不授权实盘。`POST /api/v1/trading/start` 接收已保存的 revision 和 UUID request_id，仅接受 paper；同一请求与同一版本返回已有运行状态，不重复启动。配置为单服务器存储，未按账户隔离。

启动目标为 `TradingPlatform`，本批 `execution=observation`、`strategy_id=null`，不传策略模块，不自动下单。仅 `mode` 与 `duration_min` 传给本次平台运行；其余七项校验并保留在配置中，但不转为平台 CLI 参数。平台 paper 使用默认 `$1000` 模拟现金和风险默认值，不代表真实账户资金或用户实盘预算。时长 `0` 不触发时长停止，但已订阅市场全部到期仍会停止，跨场轮换未接入。

## 参数

| 参数 | 默认 paper / live | 范围与单位 |
| --- | --- | --- |
| mode | paper | paper 或 live；保存 live 不允许版本化启动 |
| order_usd | 2 | 0.01–1000 USD/单 |
| pair_cost_max | 0.99 | 0.90–1.00 USD/配对 |
| max_orders | 50 | 1–10000，整数 |
| max_total_usd | 100 / 10 | 0.01–100000 USD 累计提交额 |
| duration_min | 5 / 15 | 0 或 0.1–1440 分钟 |
| maker_life_sec | 15 | 1–300 秒 |
| decision_interval_ms | 0 | 0–60000 毫秒 |
| defensive_cancel_bps | 0 | 0–1000 基点 |

数值必须为有限 JSON 数字，拒绝布尔值、字符串、null、超界及非有限值，不自动钳制或舍入。未知参数与秘密字段拒绝。max_total_usd 是累计提交保险丝，不等同于账户余额或成交额。

## 六页设置映射

九项保存映射：order→order_usd、life→maker_life_sec、mode→mode、duration→duration_min、submitted→max_total_usd、maxOrders→max_orders、pairCost→pair_cost_max、decisionInterval→decision_interval_ms、defensiveCancel→defensive_cancel_bps。其余目标成本、硬上限、库存、补仓等输入仅为本页草稿，不写配置。

capabilities 明确 `effectivePolicy=next_start`、`versionedStartModes=[paper]`、`accountScoped=false`、`separatePairTargetAndHardCap=false`、`pairCostMaxIsUniversalHardCap=false`，并声明：

- `executionTarget: platform`
- `executionMode: observation`
- `runtimeAppliedFields: [mode, duration_min]`
- `preservedLegacyFields: [order_usd, pair_cost_max, max_orders, max_total_usd, maker_life_sec, decision_interval_ms, defensive_cancel_bps]`（顺序无关）

前端为九项提供控件，将非应用项标明“旧引擎参数：可保存，平台观察不应用”，保存保留其值。`effectivePolicy` 不表示所有存储字段都会传给当前执行目标。

运行响应与配置分开：`/api/v1/status` 的 `execution_target` 表示新启动目标；`engine` 表示当前或最近运行来自 `platform`、`legacy` 或无运行。平台 `stats.runtime` 带 `source_at/expires_at/age_seconds/stale`，旧引擎为 null。前端只有在当前运行、匹配 run_id、投影就绪且快照未过期时展示当前平台资金与风险；停止后的最终快照保留历史标识，旧记录和重复读取不续期。真实账户余额不使用 paper runtime 数值替代。

`pair_cost_max` 是旧控制台/兼容引擎字段，不能解释为公共平台的统一风险上限，也不能作为新策略默认值。`stableLive`、`target_clone`、补仓和库存规则属于暂停的历史兼容路径；公共平台只执行策略插件返回的订单意图和统一风险校验。

## 存储与错误

写入先写同目录临时文件、flush/fsync 后原子替换。保存失败保留原文件。同一进程中按绝对路径共享线程锁，版本比较与写入在同一锁内；不支持多个服务进程共同写该文件。

持久化文件包含完整 params、schemaVersion、revision、savedAt；读取时拒绝缺字段、未知字段、重复键、非法时间与不支持版本。已知存在过的文件丢失不会静默恢复默认。首次启动无法区分首次安装与外部删除，因此需要独立备份。

模块异常分为 ConfigValidationError、ConfigConflictError、ConfigStoreError。HTTP 读取存储错误返回503；POST配置冲突409，其他被通用 RuntimeError 捕获的存储失败当前返回400。接口不能承诺所有配置存储失败统一503。

测试：`python -m pytest tests/test_dashboard_config_store.py tests/test_dashboard_integration_v1.py -q`。它验证配置及控制适配，不代表真钱交易闭环通过。
