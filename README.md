# BTC 5 分钟交易平台

本项目用于 Polymarket BTC Up/Down 5 分钟市场的行情、订单、账户和策略执行。2026-09-17 主线切换为 BTC 五分钟反转策略，停止做市方向，复用公共交易底座。当前已实现反转插件、配置/控制API与新页面，正在独立复核和实盘接入，部署事实见 docs/CURRENT-STATUS.md。主节点位于 AWS 都柏林 `eu-west-1`，公网控制台为：

**https://34-242-206-196.sslip.io/console/**

公网页面登录认证已按用户要求关闭。账户保存、配置保存与真实交易解锁是不同操作；保存账户或选择 live 模式不会启动真钱交易。

## 当前能力

- 正式控制台已有总览、自动交易、策略、收益、设置、任务视图，订单归入自动交易页；反转布局及10/20/50服务端快照分页已实现。
- 反转参数保存到服务端，当前场按原版本执行；下一场应用修改。单一可编辑策略替换旧JSON会话草稿。
- TypeScript 平台支持真实行情驱动的 paper、V2 CLOB 执行适配、真实 tick 校验、BUY/SELL 订单账本、部分成交、撤单、替换和退出核对。策略通过 `StrategyPlugin` 接入；Python `pm_maker` 是只读影子/回放组件。
- 2026-09-10 账户只读验证通过实际 V2 所需授权、签名地址匹配及私有订单、成交、抵押余额查询；账户订单观察记录现可持久化，开放买单占用可计算，链上回执核对模块已加入。该结果不等于真钱下单或完整前端接入完成。

## 尚未完成

控制台启停、进程恢复和日志已接入独立平台 CLI；可显式加载 btc-reversal，未选择策略时只观察行情。旧 `live.js run` 仅保留显式兼容入口。

反转插件、自动换场、状态恢复和前端已实现；费用预算、未知提交身份与成交终态恢复正在复核，自动赎回接线及最低金额真实验证尚未完成。历史真实下单、撤单和成交不等于新策略已验收。采用短时功能测试和小额真实接口验证，不新增回测、连续paper、多日观察、第三日期或午夜等待前置。

历史讨论中的 `$50` 本金和 `$30` 日损不是当前系统的固定额度、测试上限或上线门槛。正式策略只有一套可配置逻辑，70/75 仅是可以继续编辑的历史参数模板；资金检查按用户当前填写的预算、交易所最低数量、实时费用和未结算占用计算。真实接口验证先使用允许的最低有效金额，逐项验证订单生命周期，结果不代表盈利保证。

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

- [BTC反转开发规划](docs/REVERSAL-DELIVERY-PLAN-2026-09-17.md) · [技术评估](docs/REVERSAL-TECHNICAL-ASSESSMENT-2026-09-17.md) · [Agent分工](docs/AGENT-WORKFLOW.md)
- [当前系统状态](docs/CURRENT-STATUS.md) · [使用入口](START-HERE.md) · [六页操作说明](docs/WEB_GUIDE.md)
- [系统架构](docs/ARCHITECTURE.md) · [参数与接口](docs/TECHNICAL.md)
- [项目范围与进度](docs/PROJECT.md) · [验收交付状态](docs/DELIVERY.md)
- [运维速查](docs/QUICK_REF.md) · [引擎说明](_external/btc-5m-market-trading-bot/README.md)
- [2026-09-10 实盘就绪审计](docs/LIVE-READINESS-AUDIT-2026-09-10.md) · [CPU 诊断](docs/CPU-DIAGNOSIS-2026-09-10.md)

源码、配置模板、测试和脱敏证据可以纳入版本控制。账户密钥、密码、原始运行数据库、依赖目录及敏感运行日志不得提交。
