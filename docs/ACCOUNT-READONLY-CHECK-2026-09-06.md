# 账户只读核对记录

最近核对：2026-09-08（北京时间）。
核对方式：官方 `@polymarket/client 0.9.0` 公开接口、Polygon 链上读取和本地配置字段检查；未读取或输出密钥值、未签名、未下单。

## 已核对

| 项目 | 结果 |
| --- | --- |
| 页面公开/API 地址 | `0xA693a0E0e40BDeC3d9d4a40bD4D087A5cECFD7cd` |
| 钱包类型 | Deposit Wallet 合约，签名类型 3，不是 EOA |
| 链上 Owner | `0xDa6F73818Af63191633D8c8025508CD703780CD0` |
| 现金 | `$15.71`（2026-09-07 网页只读核对） |
| 组合总额 | `$15.71`（2026-09-07 网页只读核对） |
| 当前持仓 | 无 |
| 登录方式 | 邮箱登录 |
| 链上 pUSD | 约 `$14.66`（2026-09-08） |
| Relayer API 字段 | 本地文件存在有效格式的 Key 和 Key Address；它们不能签交易订单 |
| Owner / Session 签名 | 均未配置 |
| 官方完整交易授权 | 未完成：缺 1 项 ERC-20、2 项 ERC-1155 授权 |
| 真实订单 | 无 |

2026-09-08 本地文件 `C:\Users\Administrator\Desktop\量化密钥\Relayer API 密钥已创建.txt` 仅检查字段名、是否占位和长度：资金地址、Relayer Key、Relayer Key Address 存在；Owner 和 Session Key 不存在；严格环境变量格式尚未识别 Builder 三个字段。原文件未复制到仓库、未上传服务器、未在日志中输出。

## 未完成

- Deposit Wallet 与 Owner 的链上关系已确认，但没有 Owner 或 Session 签名凭据，不能做认证账户查询。
- 都柏林只配置公开资金地址；本地 Relayer/Builder 凭据未复制到服务器。
- 缘由不是“缺 API 地址”：订单必须由 Owner 或获授权 Session Key 签名，Relayer Key 只负责免 Gas 钱包操作。
- 真实 maker/taker 费用、返佣、奖励、订单回报和排队位置尚未产生账户证据。

## 放行顺序

1. 官方批准 Session Key 管理权限后，在服务器本地生成/授权 Session Key；Owner 私钥不长期留在服务器。
2. 用认证账户查询补齐缺失授权并复核余额、空挂单和空仓位。
3. 使用 post-only 极小额限价单，人工确认已挂出后立即撤单。
4. 核对订单回报、撤单回报、费用和账户余额变化；全部通过后仍保持低额观察。

当前裁决：`NOT_READY_FOR_LIVE_TRADING`。
