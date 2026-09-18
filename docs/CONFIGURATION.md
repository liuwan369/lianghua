# 当前配置

更新时间：2026-09-18。当前只配置一套 `btc-reversal` 策略。服务器已保存值和当前运行值随时可能变化，统一从控制台和 [CURRENT-STATUS](CURRENT-STATUS.md) 读取，不在本文复制。

## 策略参数

| 页面参数 | API 字段 | 规则 |
| --- | --- | --- |
| 触发价 | `triggerPrice` | 0 到 1，不能高于最高买价 |
| 反转确认价 | `confirmationPrice` | 0 到 1，不能低于触发价 |
| 最高买入价 | `maxBuyPrice` | 0 到 1，订单价格上限 |
| 各阶段份额 | `stageShares` | 1 至 100 个正数；每项是该阶段新增份额 |
| 阶段上限 | `maxStages` | 1 至 `stageShares.length` |
| 单场资金上限 | `roundBudgetUsd` | 正数或留空；包含持仓成本和工作单预留 |
| 策略总资金上限 | `totalBudgetUsd` | 正数或留空；不能绕过真实余额 |
| 日内亏损停止线 | `dailyLossUsd` | 正数或留空；留空表示不启用该项停止线 |
| 运行时长 | `durationMinutes` | 非负数；0 表示持续运行 |
| 运行模式 | `mode` | 正式使用 `live` |
| 最大报价年龄 | `maxQuoteAgeSeconds` | 正数；默认 2 秒 |
| 两侧最大时间差 | `maxQuoteSkewSeconds` | 正数；默认 1.5 秒 |

70/75 按钮只填入参考值，仍是同一策略。保存采用完整对象和配置版本，当前场保留创建时参数，新值从下一场开始使用。系统不会按模板自动提高预算、替换阶段或清空已运行状态。

小额真实功能验收使用 `[5,5,5,5]`，只核对交易生命周期和真实速度，不替换正式参数。交易所最低份额、真实余额、费用、已有占用和用户填写的预算始终共同约束下单。

运行时长从引擎完成初始化后计算，15 分钟不是三个完整场次；中途启动等待下一场也占用运行时间。到时停止新增、撤余量并退出，已成交持仓保留；退出后不再启动新的结算轮询。若要继续等待已有场次结算，可用“暂停新增”保持进程运行。重新点击“启动”创建新运行并恢复新增，同一次运行明确设置的暂停保持有效。

## 账户配置

账户字段：

- `wallet`：资金钱包地址。
- `owner_key`：订单签名私钥。
- `relayer_key` 与 `relayer_address`：可选 Relayer 身份。
- `builder_api_key`、`builder_secret`、`builder_passphrase`：Builder 三项必须一起填写或一起留空。

只读检查不保存。保存前会验证地址、签名身份、API 和链上授权，并原子替换账户文件；保存账户会清除内存中的实盘解锁。相同钱包留空秘密字段表示保留旧值，更换钱包不能继承旧秘密。

账户文件不进入 Git，API 不回显秘密，前端不把秘密写入浏览器持久存储。账户数据是钱包级信息，不能用历史活动推断当前策略已经成交。

## 服务器环境

| 变量 | 用途 |
| --- | --- |
| `PM_ACCOUNT_PROFILE` | 私有账户 JSON 文件 |
| `POLYMARKET_WALLET_ADDRESS` | 资金钱包 |
| `POLYMARKET_OWNER_PRIVATE_KEY` | Owner 签名身份 |
| `POLYGON_RPC` | 交易、资金流和结算 RPC |
| `PM_ACCOUNT_RPC_URL` | 账户读取主 RPC |
| `PM_ACCOUNT_RPC_FALLBACK_URL` | 账户读取备用 RPC |
| `POLY_BUILDER_API_KEY` / `POLY_BUILDER_SECRET` / `POLY_BUILDER_PASSPHRASE` | Builder Relayer 认证 |
| `RELAYER_API_KEY` / `RELAYER_API_KEY_ADDRESS` | 可替代的 Relayer 认证 |
| `PM_TRADING_LIVE_UNLOCK` | 服务器实盘开关 |
| `PM_DASHBOARD_CONTROL_TOKEN` | 页面写操作控制令牌 |
| `PM_TRUST_ACCOUNT_PROXY` / `PM_ACCOUNT_PUBLIC_ORIGIN` | 账户操作的可信代理和来源 |
| `PM_MARKET_SNAPSHOT_PATH` | CLOB WebSocket 服务原子写入、后台只读的市场快照文件 |

正式服务模板为 `config/pm-system-dashboard-dublin.service`，工作目录 `/root/pm-system`，后端监听 `127.0.0.1:18766`。私有值放在服务器环境文件，不写进 service 模板、文档、日志或证据。

## 生效顺序

1. 保存账户，只改变持久账户配置。
2. 保存策略，生成新的 `savedRevision`。
3. 启动时明确指定 `btc-reversal` 和该 revision。
4. 后台核对实盘开关、账户、唯一运行进程和状态文件。
5. 当前场使用其冻结版本；后续场读取新的保存版本。

任一步失败都不得用默认值或旧进程冒充成功。
