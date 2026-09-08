# 2026-09-08 凭据暴露与授权暂停

前序本地密钥检查的输出脱敏失败：Owner 私钥及 Relayer API Key 原值曾进入工具输出。本文不复制秘密或其可逆编码。此前“未输出密钥”“安全配置已完成”的表述不能作为这些凭据仍安全的证明。

已确认 Owner 地址与资金钱包的链上关系，但现有凭据必须按已暴露处理。服务器已有配置不能据此进入实盘。没有证据表明资金已被盗，也不能据此断言凭据没有被第三方获取。

本次仅通过官方 @polymarket/client 的 fetchTradingApprovalsState 重新查询公开授权状态，未签名或广播。缺项如下：

| 类型 | Token | Spender / Operator | SDK 建议范围 |
| --- | --- | --- | --- |
| ERC-20 | 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB | 0xDCa4af75705dbB50f62437045afF9921947917d2 | uint256 最大值（无限额度） |
| ERC-1155 | 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045 | 0x1000008dD9001B968442c1000017eaE6E0dA00Ba | setApprovalForAll |
| ERC-1155 | 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045 | 0x200000900045e3B6259600682756002200028933 | setApprovalForAll |

后续先撤销并重建 Relayer Key；Owner 私钥无法通过更改登录密码轮换。必须核实官方是否支持当前 Deposit Wallet 更换 Owner，否则通过用户确认的安全钱包和官方流程迁移资产。尚未验证 Owner 更换功能，不得宣称可直接执行。

禁止因 account_configured=true 将其视为已通过安全或实盘验收。本次未扩大授权、未执行资产转移、未开启自动交易。
