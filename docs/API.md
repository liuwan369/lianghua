# 控制台 API

更新时间：2026-09-16。实现：`scripts/system-dashboard-server.py`。正式来源为 `https://34-242-206-196.sslip.io`；API 返回 JSON，并禁用响应缓存。`control_source` 用于标识实际数据/控制来源。策略暂停，本文只描述平台和控制台能力。

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

状态新增 `execution_target`、`engine`、`execution`、`strategy_id`，区分当前平台和旧引擎记录。`stats.runtime` 包含平台模拟现金、订单/持仓数量、风险、市场及五档快照，并带 `source_at/expires_at/age_seconds/stale`；10 秒失效，API 刷新不续鲜。`stats.orders` 最多返回最新 50 单，同时提供总数和截断标记；未知值为 null。五档数据已投影，完整页面和延迟分布尚未全部接入。

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

公网登录认证按当前部署配置关闭。账户操作要求 Origin/Host、JSON 类型、可信 HTTPS 代理及所配置公开来源匹配；此来源规则不识别用户身份。交易控制令牌与实盘解锁是另一组条件，公开访问不等于允许真实交易。控制台新启动统一调用 `platform.js`，不传策略模块；版本化启动仅支持 paper，模拟运行 `account_id=null`。只有 mode 和 duration_min 应用于观察运行，其余配置保留但未应用。旧历史记录仍可读取。

## 错误语义

常见错误为 400 输入不合法、403 来源/控制拒绝、404 路由/运行不存在、409 配置冲突、415 账户 Content-Type 不合法、429 账户检查忙碌。账户检查另有 502 无效响应、503 查询/检查服务不可用、504 超时，返回脱敏 error_code 和 retryable。读取存储异常可返回 503；POST 的普通 RuntimeError 当前映射为 400，不能统一声称所有存储失败都为 503。
