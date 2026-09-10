# 测试与验收

在仓库根目录执行：

```powershell
python -m pytest -q
npm --prefix _external/btc-5m-market-trading-bot test
npm --prefix _external/btc-5m-market-trading-bot run build
npm --prefix web test
npm --prefix web run build
```

2026-09-10 当前版本回归：Python 217 passed / 1 skipped（平台权限相关）；引擎 201 passed / 20 files、构建通过；前端 23 项及构建通过。六页原设计结构与样式回归通过。

## 测试覆盖

- Python：配置版本/类型/损坏恢复、账本增量摄取、API、账户错误分类与公开 HTTPS 来源规则、采集和历史分析。
- 引擎：真实 tick 量化、预算/费用/挂单占用、最低份数、部分及迟到成交、异常 ACK、盘口时序、停止撤单和最终对账。
- 前端：原设计结构/样式与导航、数据映射、设置草稿/版本冲突、账户交互和订单运行列表刷新。

账户/下单单元测试使用替身，不产生真实交易。历史 maker 回测必须有真实 tick 元数据；缺失或时间非法直接报错，见 [数据要求](BACKTEST-TICK-DATA.md)。

## 已有真实环境证据

公网 HTTP 接口、六页导航和账户只读操作完成核验；当前 V2 必需授权、签名和私有 CLOB 只读查询通过。相关证据见 [运行验收](LIVE-READINESS-AUDIT-2026-09-10.md)。

真实行情 paper 只验证模拟执行。一次 6 分钟运行出现单边模拟结算 -$4.60；最终代码的 90 秒运行读到两侧真实 tick，产生一笔 DOWN 20@0.18 模拟成交及成本拒绝，停止时尚未结算。它们不能证明成功对冲、真实队列成交或收益。

目前未通过的验收包括：网页实盘启停、真实下单/撤单/部分成交闭环、完整持仓/资金账单、收益到账、长期风险和负载稳定性。不得以测试数量替代这些验收，也不得用测试启动真实订单。
