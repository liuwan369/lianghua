# 从这里开始

## 现在能做什么

当前系统可以读取都柏林服务器采集的真实公开行情，并运行纸面模拟。钱和交易所订单是模拟的，不会动账户资金。

访问步骤：

1. 打开公网地址 `https://34-242-206-196.sslip.io:80/system-dashboard.html` 并输入访问账号密码。
2. 公网不可用时，运行 `scripts/start-dublin-dashboard-tunnel.ps1`，再打开 `http://127.0.0.1:18765/system-dashboard.html`。
3. 在“配置”填写资金和策略参数并保存。
4. 回到“交易”点击“开始模拟”。
5. 查看当前盘口、模拟挂单、成交、撤单、成交额和盈亏。

公网由 Nginx HTTPS 和登录保护反向代理到服务器 `127.0.0.1:18766`。由于 Lightsail 当前只开放 22/80，HTTPS 暂时使用显式端口 `:80`；开放 443 后可改为普通 HTTPS 地址。

## 账户与真钱状态

- 最近一次只读网页核对：API/公开地址 `0xA693a0E0e40BDeC3d9d4a40bD4D087A5cECFD7cd`，该地址不能用于充值。
- 最近一次页面记录的现金/组合约 `$17.13`、无持仓；这只是当时页面状态，不是实时账户余额。
- Deposit Wallet 的链上 Owner/Relayer 地址：`0xDa6F73818Af63191633D8c8025508CD703780CD0`；Relayer API Key 只用于官方 Relayer API，不是订单签名。
- 自建 bot 不需要 Builder Key；Session Key 目前只对官方选定合作方 Beta 开放。
- 系统当前没有 Owner 签名私钥；Relayer Key 不能代替订单签名，`account_configured=false`。Session Key 不是必需项。
- 系统当前没有实盘解锁，`live_unlocked=false`、`trade_authorization=false`。

所以现在不能点击页面就进行真钱交易。

## 真钱前还差什么

1. 在服务器本地安全配置 Owner 签名方式，不在网页或聊天中传私钥；没有 Session Key 也可以走这条路径。
2. 完成只读账户预检和地区/API 接单核验。
3. 用极小额 post-only 挂单、撤单验证真实订单回报。
4. 验证部分成交、断线撤单、状态不明后的仓位重建和单边止损。
5. 逐笔对账真实手续费、做市返佣、流动性奖励和结算。
6. 处理剩余低危依赖并完成官方新版交易路径迁移。

完成上述验收前，状态保持 `NOT_READY_FOR_LIVE_TRADING`。

## 维护规则

- 只维护 BTC 5 分钟主线。
- 当前运行事实以 [docs/CONTEXT.md](docs/CONTEXT.md) 和 [docs/PROGRESS.md](docs/PROGRESS.md) 为准。
- 所有代码变更先通过 Python 和 TypeScript 测试，再推送 GitHub。
- 原始数据库、密钥、密码、依赖目录和运行日志不上传云仓库。
