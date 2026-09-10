# 配置契约 v1

实现：`scripts/dashboard/config.py` 与 `scripts/system-dashboard-server.py`。核对日期：2026-09-10。

## 读写与生效

`GET /api/v1/config` 返回 schemaVersion、revision、savedAt、params、capabilities 和 control_source。首次未保存时 revision=0、savedAt=null。

`POST /api/v1/config` 的外层字段必须恰为 `params` 与 `expected_revision`。params 是完整替换：省略的字段恢复对应模式默认值。前端须保留读到但页面没有编辑控件的参数。expected_revision 是非负整数，保存成功递增版本；版本冲突返回409及current_revision。

保存不启动、不热更新现有运行、不授权实盘。`POST /api/v1/trading/start` 接收已保存的 revision 和 UUID request_id，仅接受 paper；同一请求与同一版本返回已有运行状态，不重复启动。配置为单服务器存储，未按账户隔离。

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

仅 order→order_usd、life→maker_life_sec、mode→mode、duration→duration_min、submitted→max_total_usd、maxOrders→max_orders 六项可提交。其余目标成本、硬上限、库存、补仓等输入仅为草稿。

capabilities 明确 effectivePolicy=next_start、versionedStartModes=[paper]、accountScoped=false、separatePairTargetAndHardCap=false、pairCostMaxIsUniversalHardCap=false。API 支持的九项字段不等于页面九项都有对应控件。

成本目标、普通补仓和紧急候选参数有不同语义。当前 target_clone 开启 dynamicHedgeSizing，单边补腿最终受 hedgePairCostCeiling=0.99 约束；候选放宽并不保证可下单或一定对冲。

## 存储与错误

写入先写同目录临时文件、flush/fsync 后原子替换。保存失败保留原文件。同一进程中按绝对路径共享线程锁，版本比较与写入在同一锁内；不支持多个服务进程共同写该文件。

持久化文件包含完整 params、schemaVersion、revision、savedAt；读取时拒绝缺字段、未知字段、重复键、非法时间与不支持版本。已知存在过的文件丢失不会静默恢复默认。首次启动无法区分首次安装与外部删除，因此需要独立备份。

模块异常分为 ConfigValidationError、ConfigConflictError、ConfigStoreError。HTTP 读取存储错误返回503；POST配置冲突409，其他被通用 RuntimeError 捕获的存储失败当前返回400。接口不能承诺所有配置存储失败统一503。

测试：`python -m pytest tests/test_dashboard_config_store.py tests/test_dashboard_integration_v1.py -q`。它验证配置及控制适配，不代表真钱交易闭环通过。
