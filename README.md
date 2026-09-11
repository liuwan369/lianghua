# BTC 5 分钟对冲量化系统

本项目用于 Polymarket BTC Up/Down 5 分钟市场的公开行情采集、证据回放、纸面模拟及受控交易执行。主节点位于 AWS 都柏林 `eu-west-1`，公网控制台为：

**https://34-242-206-196.sslip.io/console/**

公网页面登录认证已按用户要求关闭。账户保存、配置保存与真实交易解锁是不同操作；保存账户或选择 live 模式不会启动真钱交易。

## 当前能力

- 正式控制台保留总览、自动交易、市场、订单、收益、设置六页设计；行情、运行状态、模拟账本及账户检查接口已连接。
- 九个设置项可保存并在下次启动时生效：单笔金额、挂单寿命、运行模式、运行时长、累计提交金额上限、订单数上限、配对成本上限、决策间隔和防御撤单阈值。其他高级输入目前仅为页面草稿。
- TypeScript 引擎支持真实行情驱动的 paper、V2 CLOB 执行适配、真实 tick 校验、挂单负债管理、动态补仓和退出核对。Python `pm_maker` 是只读影子/回放组件。
- 2026-09-10 账户只读验证通过实际 V2 所需授权、签名地址匹配及私有订单、成交、抵押余额查询；账户订单观察记录现可持久化，开放买单占用可计算，链上回执核对模块已加入。该结果不等于真钱下单或完整前端接入完成。

## 尚未完成

页面纸面交易启停已接线，实盘控制仍锁定。受控真实下单、成交、撤单和一笔 Deposit Wallet 零兑付赎回已取得证据；自然部分成交、断线中成交、正兑付赎回、完整资金基线与奖励到账尚未验收。前端已连接挂单名义占用、按期间的已知链上费用、奖励付款核对和回执进度；完整账单、可花余额（含在途与费用预留）、高级参数及完整延迟展示仍未完成。

2026-09-10 都柏林负载诊断发现高 CPU steal，账户检查在 paper 负载下仍出现超时；CPU 积分及实例 credit mode 因 IAM 权限不足未核实。系统仍为 **NOT_READY_FOR_LIVE_TRADING**。模拟成交和结算不代表真实账户收益，也没有已验证的盈利保证。

## 开发验证

需要 Python 3.11+、Node.js 24+。在仓库根目录运行：

```powershell
python -m pip install pytest requests websocket-client
python -m pytest
npm --prefix web ci
npm --prefix web test
npm --prefix web run build
npm --prefix _external/btc-5m-market-trading-bot ci
npm --prefix _external/btc-5m-market-trading-bot test
npm --prefix _external/btc-5m-market-trading-bot run build
```

前端构建产物位于 `docs/console/`。本地预览仅用于开发，运行方式见 [START-HERE.md](START-HERE.md)；都柏林运行状态以公网服务和带时间戳的服务器证据为准。

## 文档入口

- [使用入口](START-HERE.md) · [六页操作说明](docs/WEB_GUIDE.md)
- [系统架构](docs/ARCHITECTURE.md) · [参数与接口](docs/TECHNICAL.md)
- [项目范围与进度](docs/PROJECT.md) · [验收交付状态](docs/DELIVERY.md)
- [运维速查](docs/QUICK_REF.md) · [引擎说明](_external/btc-5m-market-trading-bot/README.md)
- [2026-09-10 实盘就绪审计](docs/LIVE-READINESS-AUDIT-2026-09-10.md) · [CPU 诊断](docs/CPU-DIAGNOSIS-2026-09-10.md)

源码、配置模板、测试和脱敏证据可以纳入版本控制。账户密钥、密码、原始运行数据库、依赖目录及敏感运行日志不得提交。
