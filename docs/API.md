# 控制台 API

实现：`scripts/system-dashboard-server.py`。正式来源为 `https://34-242-206-196.sslip.io`；API 返回 JSON，并禁用响应缓存。`control_source` 用于标识实际数据/控制来源。

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

运行事件不等于完整真实委托生命周期；当前 `order_lifecycle_available=false`。进程重启后账户 `last_check` 可以为空，不能把它当成授权失效。

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

公网没有登录认证。账户操作要求 Origin/Host、JSON 类型、可信 HTTPS 代理及所配置公开来源匹配；此来源规则不识别用户身份。交易控制令牌与实盘解锁是另一组条件，公开访问不等于允许真实交易。当前六页启停按钮仍未接通。

## 错误语义

常见错误为 400 输入不合法、403 来源/控制拒绝、404 路由/运行不存在、409 配置冲突、415 账户 Content-Type 不合法、429 账户检查忙碌。账户检查另有 502 无效响应、503 查询/检查服务不可用、504 超时，返回脱敏 error_code 和 retryable。读取存储异常可返回 503；POST 的普通 RuntimeError 当前映射为 400，不能统一声称所有存储失败都为 503。
