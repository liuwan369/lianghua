# UI 模块

## 共享模块

- AppShell / Sidebar：统一导航、品牌、当前连接来源。
- HeaderStatus：版本、连接、账户、运行状态。
- DataStateBadge：loading/ready/stale/error。
- MetricCard：只显示已确认的聚合数据。
- ActivityList：运行事件，实时事件和历史事件分开。

## 总览

交易统计、服务器状态、运行日志三块保持独立。统计来自 metrics，资源来自 diagnostics，日志来自 runtime events，不用一个刷新动作同时重绘三块。

## 市场

MarketCatalog、MarketPool、MarketDetail。选择币种只改变查看对象；启用改变 desired pool；当前场次继续由服务器决定。空目录要显示空态，不能访问第一个元素导致崩溃。

## 自动交易

RuntimeControls、MarketSelector、OrderBook、RoundPosition、OrderTable、RuntimeActivity。盘口、持仓、订单和日志按 `marketId + roundId` 隔离，多币种不能合并成“BTC + N 个”后继续显示 BTC 数据。

## 策略

StrategyEditor、PresetList、ActivationNotice。阶段数应真实增删，价格和资金边界先做前端提示，再由服务器二次校验。当前页面只保存策略草稿，不启动交易；激活是独立的服务端动作，必须带 `effectiveRoundId`，并等待 runtime 状态确认后才显示生效。

## 设置

Diagnostics 和账户状态只读。账户由服务器环境变量或部署系统管理，前端只显示 configured/check status 和最近检查时间，不保存、不提交、不回显秘密。
