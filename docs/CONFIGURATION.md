# 配置说明

核对日期：2026-09-10。配置实现见 `scripts/dashboard/config.py`、账户实现见 `scripts/dashboard_account.py`，引擎预设见 `_external/btc-5m-market-trading-bot/src/config.ts`。

## 页面与引擎参数

新版六页设置中已接入保存的字段只有六项：

| 页面字段 | API 字段 | 含义 |
| --- | --- | --- |
| order | order_usd | 单笔名义金额上限 |
| life | maker_life_sec | maker 挂单有效秒数 |
| mode | mode | paper / live 配置模式 |
| duration | duration_min | 运行分钟数，0 表示不限时 |
| submitted | max_total_usd | 累计提交金额保险丝 |
| maxOrders | max_orders | 累计订单次数上限 |

API 还支持 `pair_cost_max`、`decision_interval_ms`、`defensive_cancel_bps`，当前页面保存时保留读到的这些字段；其余成本目标、库存、补仓和退出设置仅为草稿。不能把控件可输入当成引擎生效。

默认值、数值范围和原子保存语义见 [配置契约](../contracts/config-v1.md)。保存以 `expected_revision` 防止覆盖并发修改，作用于下次启动；版本化启动仅支持 paper。当前为单服务器配置，不按账户隔离。

`pair_cost_max` 不应解释为所有预设的统一硬上限。本次 `target_clone` 的动态补腿最终受 `hedgePairCostCeiling=0.99` 约束，候选放宽及紧急阈值不保证能完成对冲。

## 部署环境

| 变量 | 都柏林用途 |
| --- | --- |
| PM_NODE_LABEL | 页面采集来源标签 |
| PM_LIVE_LOCAL | 1 表示控制台本机读取采集数据库 |
| PM_LIVE_DATA_DIR / PM_EVIDENCE_GLOB | 日库目录及 dublin-evidence 文件匹配 |
| PM_COLLECTOR_SERVICE | pm-r25-dublin-collector.service |
| PM_LIVE_URL | 引擎 paper 使用的控制台行情快照 URL |
| PM_REMOTE_HOST / PM_REMOTE_SSH_KEY | 本地开发预览读取都柏林行情的 SSH 配置 |
| PM_ACCOUNT_PROFILE | 服务器账户 JSON 路径 |
| PM_ACCOUNT_RPC_URL / PM_ACCOUNT_RPC_FALLBACK_URL | 只读账户检查的主备 Polygon RPC |
| PM_ACCOUNT_NODE_COMPILE_CACHE | 只缓存账户检查 Node 编译产物，不缓存凭据/检查结果 |
| PM_TRUST_ACCOUNT_PROXY / PM_ACCOUNT_PUBLIC_ORIGIN | 可信 HTTPS 代理及已配置的公开账户操作来源 |
| PM_DASHBOARD_CONTROL_TOKEN | 独立交易控制令牌 |
| PM_TRADING_LIVE_UNLOCK | 实盘解锁开关；当前关闭 |

准确部署值使用 `config/pm-system-dashboard-dublin.service` 与 `config/pm-system-dashboard-dublin-public-account.conf`。公开来源检查不是登录认证；当前部署允许访问该公开来源的人检查/保存账户，交易控制仍有独立限制。

## 账户与凭据

页面账户字段为 `wallet`、`owner_key`、`relayer_key`、`relayer_address`。同一钱包的空密钥输入保留已有值；更换钱包不会继承原钱包密钥。检查成功不等于保存，保存成功也不启动交易。

资金钱包、Owner 签名、Relayer、Builder、Session Key 各有独立用途。当前路线使用 Owner 为 CLOB V2 订单签名；Builder 和 Session Key 并非该路线必需项。官方 SDK 对其他产品的授权缺项不能用于阻止当前路线。

账户文件不进 Git；Linux 限制为所属用户读写，检查/保存响应不返回密钥。前端不把秘密字段写入浏览器持久存储。完整实盘就绪结论见 [交付状态](DELIVERY.md)。
