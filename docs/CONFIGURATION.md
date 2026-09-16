# 配置说明

核对日期：2026-09-16。配置实现见 `scripts/dashboard/config.py`、账户实现见 `scripts/dashboard_account.py`；公共交易平台配置见 `_external/btc-5m-market-trading-bot/src/platform/`。

当前策略接入暂停。本批源码将控制台启停接入无策略 `TradingPlatform` 观察；本说明不表示已部署。现有前端配置入口保留，页面字段不能被解释为新策略默认参数或自动调参已经接线。实盘资金边界仍为本金 `$50`、北京时间单日损失 `$30`；平台 paper 默认 `$1000` 是独立模拟现金，不是实盘额度。

## 页面与引擎参数

当前策略页的运行与引擎设置中已接入保存的字段共九项：

| 页面字段 | API 字段 | 含义 | 本批平台观察 |
| --- | --- | --- | --- |
| order | order_usd | 旧单笔名义金额上限 | 保留，可保存；不应用 |
| life | maker_life_sec | 旧 maker 挂单有效秒数 | 保留，可保存；不应用 |
| mode | mode | paper / live 配置模式 | 应用；前端与版本化启动仅支持 paper |
| duration | duration_min | 运行分钟数，0 不按时长退出 | 应用 |
| submitted | max_total_usd | 旧累计提交金额保险丝 | 保留，可保存；不应用 |
| maxOrders | max_orders | 旧累计订单次数上限 | 保留，可保存；不应用 |
| pairCost | pair_cost_max | 旧引擎配对/加仓成本参数 | 保留，可保存；不应用 |
| decisionInterval | decision_interval_ms | 旧最短决策间隔 | 保留，可保存；不应用 |
| defensiveCancel | defensive_cancel_bps | 旧 BTC 逆向波动撤单阈值 | 保留，可保存；不应用 |

九个控件都有保存映射。平台观察依照 capabilities 标出 `runtimeAppliedFields=[mode,duration_min]`，其余七项归入 `preservedLegacyFields`，仍可编辑保存且保留原值，但不传入新平台。其余成本目标、库存、补仓和退出设置仅为本页草稿，不保存、不执行。

默认值、数值范围和原子保存语义见 [配置契约](../contracts/config-v1.md)。保存以 `expected_revision` 防止覆盖并发修改；只把模式、时长应用于下次平台观察启动，不热更新、不加载策略。当前为单服务器配置，不按账户隔离。本批固定订阅的市场全部到期会自动停止，即使 `duration_min=0` 也不表示跨场永久运行。

平台初始模拟现金和风险参数使用平台 CLI 默认值，不能用旧 `order_usd/max_total_usd` 推断当前平台限额。当前真实值取 `stats.runtime.cash_usd/risk/limits`。页面将模拟现金、持仓和活跃委托与真实账户分开；来源时间、运行编号与有效期不匹配时不显示为当前值，旧引擎记录另标“旧引擎纸面”。

历史兼容路径中的 `pair_cost_max` 不应解释为所有预设的统一硬上限。旧 `target_clone` 的 `hedgeLimit()` 说明只用于历史代码核对，当前策略暂停，不能把它当作新平台生产参数。完整公共执行语义见 [技术实现](TECHNICAL.md)。

## 部署环境

| 变量 | 都柏林用途 |
| --- | --- |
| PM_NODE_LABEL | 页面采集来源标签 |
| PM_LIVE_LOCAL | 1 表示控制台本机读取采集数据库 |
| PM_LIVE_DATA_DIR / PM_EVIDENCE_GLOB | 日库目录及 dublin-evidence 文件匹配 |
| PM_MARKET_SNAPSHOT_PATH | 本机增量行情投影输出；默认项目根目录下 data/dashboard/market-snapshot.json |
| PM_COLLECTOR_SERVICE | pm-r25-dublin-collector.service |
| PM_LIVE_URL | 引擎 paper 使用的控制台行情快照 URL |
| PM_REMOTE_HOST / PM_REMOTE_SSH_KEY | 本地开发预览通过 SSH 读取都柏林快照；不在远端重新分析证据库 |
| PM_REMOTE_PORT / PM_REMOTE_CONNECT_TIMEOUT | SSH 端口及连接超时 |
| PM_REMOTE_SNAPSHOT_PATH | SSH 读取文件；默认 /root/pm-system/data/dashboard/market-snapshot.json |
| PM_ACCOUNT_PROFILE | 服务器账户 JSON 路径 |
| PM_ACCOUNT_RPC_URL / PM_ACCOUNT_RPC_FALLBACK_URL | 只读账户检查的主备 Polygon RPC |
| PM_ACCOUNT_NODE_COMPILE_CACHE | 只缓存账户检查 Node 编译产物，不缓存凭据/检查结果 |
| PM_TRUST_ACCOUNT_PROXY / PM_ACCOUNT_PUBLIC_ORIGIN | 可信 HTTPS 代理及已配置的公开账户操作来源 |
| PM_DASHBOARD_CONTROL_TOKEN | 独立交易控制令牌 |
| PM_TRADING_LIVE_UNLOCK | 实盘解锁开关；当前关闭 |

准确部署值使用 `config/pm-system-dashboard-dublin.service` 与 `config/pm-system-dashboard-dublin-public-account.conf`。公开来源检查不是登录认证；当前部署允许访问该公开来源的人检查/保存账户，交易控制仍有独立限制。

`PM_LIVE_LOCAL=1` 时控制台后台持有增量盘口并原子发布快照；非本机采集模式只通过 SSH 读取已发布文件。读取动作不会更新快照内的 `checked_at`。快照超过 15 秒或源时间向未来偏移超过 5 秒时显示离线和空市场，不能靠加快前端刷新续鲜。

## 历史分析资源预算

`config/pm-r25-dublin-live-analyzer.service` 通过 `Slice=pm-analysis.slice` 进入同机专用资源组，配置文件为 `config/pm-analysis.slice`。

| 配置 | 值与含义 |
| --- | --- |
| CPUQuota | 20%，相当于最多 0.2 个逻辑核，不是整台服务器 CPU 的 20% |
| CPUWeight / IOWeight | 均为 10，争用时降低分析任务权重 |
| MemoryHigh / MemoryMax | 384M / 512M |
| TasksMax | 32 |
| Nice / IOSchedulingClass | 服务使用 19 / idle |

分析仍按 timer 运行，配额可能延长完成时间。采集、控制台和交易进程不加入分析 slice；这不是新增服务器，也不会提高云端 CPU 配额。在线行情接口读取行情投影，不等待历史分析完成。

## 账户与凭据

页面账户字段为 `wallet`、`owner_key`、`relayer_key`、`relayer_address`、`builder_api_key`、`builder_secret`、`builder_passphrase`。Builder 三项必须同时填写或同时留空。同一钱包的空密钥输入保留已有值；更换钱包不会继承原钱包密钥。检查成功不等于保存，保存成功也不启动交易。

资金钱包、Owner 签名、Relayer、Builder、Session Key 各有独立用途。当前路线使用 Owner 为 CLOB V2 订单签名；Builder 和 Session Key 不是下单必需项，但 Deposit Wallet 赎回等免 Gas Relayer 操作需要 Builder 认证。官方 SDK 对其他产品的授权缺项不能用于阻止下单路线。

账户文件不进 Git；Linux 限制为所属用户读写，检查/保存响应不返回密钥。前端不把秘密字段写入浏览器持久存储。完整实盘就绪结论见 [交付状态](DELIVERY.md)。

账户数据缓存默认至少30秒刷新；不受浏览器刷新次数放大。CLOB抵押余额不表示扣除挂单占用后的可花资金。纸面启动要求先保存配置（revision > 0），提交保存版本与唯一请求编号；实盘保存不自动开启交易。
