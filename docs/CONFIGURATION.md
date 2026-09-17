# 当前配置说明

更新：2026-09-18 02:02（北京时间）。软件基线 `70d2b55` 已部署；当前服务器策略配置 `savedRevision=3`：价格 `0.67/0.70/0.70`、阶段份额 `[5,18,54,130]`、单场预算 `14.5` 美元，总预算和日损为 `null`。交易控制密码已配置；交易未运行、`strategy_id=null`、实盘锁未开启。最新发布与验收状态以 [当前状态](CURRENT-STATUS.md) 为准。

## 策略页

选择顶部 **BTC 五分钟反转**，按“策略参数 / 运行设置”填写。70/75 参考按钮只填入价格和份额，仍可修改，不改动已有预算和运行时间。

| 页面参数 | API 字段 | 生效与含义 |
| --- | --- | --- |
| 触发价 / 确认价 / 最高买入价 | `triggerPrice` / `confirmationPrice` / `maxBuyPrice` | 页面单位为美分，API 使用 0–1；确认计数不延迟下单 |
| 每阶段份额 / 阶段数 | `stageShares` / `maxStages` | 每阶段新增份额，数量须符合实际市场约束 |
| 单场资金上限 / 策略总资金上限 | `roundBudgetUsd` / `totalBudgetUsd` | 包含持仓成本及工作单预留；留空不加额外上限，真实余额仍约束交易 |
| 每日亏损停止线 | `dailyLossUsd` | 可选，留空不启用该停止线 |
| 运行时长 | `durationMinutes` | 0 表示持续运行；修改时长在下次启动生效 |

保存使用 `PUT /api/strategy-config`，提交完整 `config` 和 `expectedRevision`，服务器返回 `savedRevision`。并发版本冲突会提示重新核对，不静默覆盖。配置存于交易引擎目录的 `results/dashboard/btc-reversal-config.json`。

价格、阶段和预算修改在下一场生效，当前场保留原版本；保存本身不会启动交易。当前页面运行模式为真实交易。配置还保存行情新鲜度参数 `maxQuoteAgeSeconds=2`、`maxQuoteSkewSeconds=1.5`，页面不需要日常修改。

当前 `14.5` 美元不能覆盖 `[5,18,54,130]` 的全部阶段名义成本，通常只能执行较低阶段。系统按每一场实际生效版本逐阶段检查预算，不会自动提高、清空或替换用户填写的额度。每阶段和全部阶段名义成本及预算不足提示已发布，并通过桌面和手机视口检查。

`POST /api/trading/control` 处理 `start/pause/resume/stop`。启动携带已保存版本、`strategy_id=btc-reversal` 和唯一 `request_id`；服务器读取该版本，检查账户、实盘开关和已有进程。暂停只停止新增，停止则处理本系统工作单并退出；持仓和恢复状态继续保留。

## 账户与凭据

账户设置字段为 `wallet`、`owner_key`、`relayer_key`、`relayer_address`、`builder_api_key`、`builder_secret`、`builder_passphrase`。Builder 三项须一起填写。同钱包留空密钥保留旧值；更换钱包不继承旧密钥。检查为只读，保存才写入服务器，均不会自动启动交易。

资金钱包存放资产，Owner 签名订单。Deposit Wallet 赎回使用 Builder 三项或 Relayer key/address 认证；Session Key 不是本策略下单必需项。当前结算 sender 支持 EOA 和 Deposit Wallet，其他钱包会返回具体不支持原因。

账户文件不进 Git，响应不返回私钥，前端不将秘密字段写入浏览器持久存储。账户缓存至少 30 秒刷新；CLOB 抵押余额不是已扣除工作单预留的可用余额，实际新增订单由底座检查。

## 服务器配置

| 变量 | 用途 |
| --- | --- |
| `PM_ACCOUNT_PROFILE` | 服务器账户 JSON 路径 |
| `POLYMARKET_WALLET_ADDRESS` / `POLYMARKET_OWNER_PRIVATE_KEY` | 资金钱包与 Owner 签名身份 |
| `POLYGON_RPC` | 交易及赎回使用的 Polygon RPC |
| `PM_ACCOUNT_RPC_URL` / `PM_ACCOUNT_RPC_FALLBACK_URL` | 账户检查主备 RPC |
| `POLY_BUILDER_API_KEY` / `POLY_BUILDER_SECRET` / `POLY_BUILDER_PASSPHRASE` | Builder Relayer 认证 |
| `RELAYER_API_KEY` / `RELAYER_API_KEY_ADDRESS` | 可替代 Builder 的 Relayer 认证 |
| `PM_TRADING_LIVE_UNLOCK` | 服务器实盘开关；本次检查关闭 |
| `PM_DASHBOARD_CONTROL_TOKEN` | 交易控制认证；当前服务器已配置，值只保存在私有环境文件 |
| `PM_TRUST_ACCOUNT_PROXY` / `PM_ACCOUNT_PUBLIC_ORIGIN` | 可信 HTTPS 代理及账户操作来源 |
| `PM_LIVE_LOCAL` / `PM_LIVE_DATA_DIR` / `PM_EVIDENCE_GLOB` | 本机控制台行情数据源 |
| `PM_MARKET_SNAPSHOT_PATH` | 增量行情投影文件 |
| `PM_REMOTE_HOST` / `PM_REMOTE_SSH_KEY` / `PM_REMOTE_SNAPSHOT_PATH` | 开发预览读取服务器行情投影 |

部署服务见 `config/pm-system-dashboard-dublin.service`。快照刷新不会更改原始来源时间；过期数据显示不可用。策略预算由用户填写，不存在固定 `$50/$30` 或历史模板资金门槛。

资金流扫描沿用 `POLYGON_RPC`、`PM_ACCOUNT_RPC_URL`、`PM_ACCOUNT_RPC_FALLBACK_URL` 的顺序，并有公开只读备用。节点裁剪历史日志或活动分页不完整时只把日内结果标为暂估，不伪造完整覆盖，也不新增实盘锁。
