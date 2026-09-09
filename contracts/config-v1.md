# 配置契约 v1（第一批）

服务端模块：`scripts/dashboard/config.py`。只保存现有启动接口能接收的非敏感策略参数；保存不启动、不改变运行中参数、不授权实盘。当前配置是单服务器配置，未实现按账户隔离；不得宣称账户配置闭环完成。

## 模块与路由接线

`ConfigStore(path).get()` 返回快照；`save(params, expected_revision)` 校验、比较当前版本并原子替换，返回新快照。所有快照独立复制，调用者修改不会改变存储。`validate_params(params)` 可单独调用；`default_params()` 返回明确纸面默认值。`capabilities()` 返回能力说明。

实际第一批路由 `GET /api/v1/config` 返回同一快照；`POST /api/v1/config` 接收 `{"params": {...}, "expected_revision": 0}`。路由须拒绝未知请求外层字段、重复 JSON 键、非对象请求。不能把整个请求直接送入 `save`。

首次无文件时返回 `revision: 0`、`savedAt: null`，代表未保存的服务器默认值。第一次显式保存生成版本 1。正常保存（即使值相同）递增版本。请求是完整替换语义：省略的参数恢复所选模式默认值，不继承旧版本；前端应提交读到并修改后的完整 `params`。

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "savedAt": "2026-09-09T01:00:00Z",
  "params": {
    "mode": "paper",
    "order_usd": 2,
    "pair_cost_max": 0.99,
    "max_orders": 50,
    "max_total_usd": 100,
    "duration_min": 5,
    "maker_life_sec": 15,
    "decision_interval_ms": 0,
    "defensive_cancel_bps": 0
  },
  "capabilities": {
    "supportedFields": ["mode", "order_usd", "pair_cost_max", "max_orders", "max_total_usd", "duration_min", "maker_life_sec", "decision_interval_ms", "defensive_cancel_bps"],
    "unsupportedDemoFields": ["capital", "market", "target", "cap", "inventoryMode", "inventory", "hedgeWait", "stopOpen", "stopHedge", "layers", "spacing", "fallback", "slippage", "hedgeLoss", "dailyLoss", "concurrency", "disconnect", "stale", "stopPolicy", "effective"],
    "effectivePolicy": "next_start",
    "versionedStartModes": ["paper"],
    "separatePairTargetAndHardCap": false,
    "pairCostMaxIsUniversalHardCap": false,
    "accountScoped": false
  }
}
```

上例 `capabilities` 省略了实际响应中的 `fields`（单位、边界、是否整数）和 `demoFieldMappings`。后者仅说明页面字段如何映射；API 不接收演示别名。

| 参数 | 单位 | 默认（纸面 / 实盘） | 允许值 |
| --- | --- | --- | --- |
| mode | 枚举 | paper | paper、live；保存 live 不代表允许启动 |
| order_usd | USD 名义委托额 | 2 | 0.01–1000 |
| pair_cost_max | USD / 配对 | 0.99 | 0.90–1.00 |
| max_orders | 累计提交订单数 | 50 | 1–10000，整数 |
| max_total_usd | USD 累计提交金额 | 100 / 10 | 0.01–100000 |
| duration_min | 分钟 | 5 / 15 | 0（不按时间自动停止）或 0.1–1440 |
| maker_life_sec | 秒 | 15 | 1–300 |
| decision_interval_ms | 毫秒 | 0 | 0–60000 |
| defensive_cancel_bps | 基点 | 0 | 0–1000 |

数值须为有限 JSON 数字，拒绝字符串、空值、布尔值、NaN、Infinity；不截断、不钳制、不四舍五入。第一批保持旧引擎数值行为，尚未完成跨前端与引擎的定点精度迁移。`max_total_usd` 是累计提交保险丝，不是现金余额、单场预算或成交额。由于本批保留旧参数范围，金额与保险丝之间不增加旧接口没有的关系校验；运行前余额、市场最小量及费用检查仍属于后续验收。

`pair_cost_max` 仅表示旧 CLI 输入。当前引擎的目标、补仓与强制补仓路径未统一，因此不能把它显示为所有路径共用的硬上限。`target` 与 `cap` 必须保持未支持；不得自动合并或映射为同一个参数。目标与硬上限分离，以及其余演示字段，均不在第一批支持范围。

配置读接口的 `savedAt` 是该版本写入时刻，非实时行情时间。此模块不知账户或当前运行，因此不伪造 `accountId`、`runId` 或运行实际生效版本；接口/控制模块负责附加真实运行上下文。新版本启动当前仅允许 paper，必须绑定被校验的版本及其参数快照。运行中保存用于下次启动，不得覆盖本次生效版本。

## 错误与恢复

| 模块异常 | 接口含义 |
| --- | --- |
| `ConfigValidationError` | 400：字段/类型/范围/预期版本类型错误 |
| `ConfigConflictError` | 409：版本冲突；`current_revision` 为服务器当前版本 |
| `ConfigStoreError` | 503：存储读取或保存失败，配置不可用于启动 |

`expected_revision` 是大于等于 0 的整数，布尔值和浮点数均不接受。错误消息不回显用户值或未知字段名，防止误提交密钥后从响应泄漏。全部未知字段（包含私钥、令牌、账户和 `confirm_live`）拒绝保存；账户仍使用原账户模块。

文件只持久化 schemaVersion、revision、savedAt、完整 params。重启严格校验 schema、版本、时间和全量参数；损坏、缺字段、重复 JSON 键、未知版本、敏感字段不会自动重置默认值或被下一次保存覆盖。同一实例发现曾存在的文件丢失后同样拒绝运行。全新进程无法区分首次安装和被外部删除的文件；上线备份/恢复需保障配置文件存在。

临时文件与目标处于同一目录，写入后 flush/fsync，再 `os.replace`；替换失败保留原版本。线程锁按绝对路径共享，比较与写入在同一锁内，多实例/多线程同版本保存只有一个成功。部署边界是一个接口服务进程；不支持多个独立进程同时写同一配置。若将来增加多工作进程，须先引入跨进程事务/锁。此文件不是跨版本历史账本，运行时配置快照由业务账本记录。

验证：`python -m pytest tests/test_dashboard_config_store.py -q`。覆盖参数全边界、默认值、持久化重启、快照隔离、并发冲突、损坏文件拒绝、原子替换失败保留旧数据、能力说明。
