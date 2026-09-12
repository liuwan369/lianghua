# 测试与验收

统一入口在仓库根目录执行 `python scripts/verify-project.py`。它生成 `.planning/tmp/verification/<run_id>/manifest.json`，包含各步结果及日志哈希。模块单独验证：

```powershell
python -m pytest -q
npm --prefix _external/btc-5m-market-trading-bot test
npm --prefix _external/btc-5m-market-trading-bot run build
npm --prefix web test
npm --prefix web run build
```

2026-09-13 本批统一验证通过，manifest 为 `20260912T193457Z-f1a5cb36`：Python 286 passed / 1 skipped、引擎 264 passed / 25 files、前端 49 passed，双方构建通过。随后完整消息解码修复的 Python 全量复跑为 289 passed / 1 skipped；回放定向 12 项通过。前端结果包含本地已有用户修改，这些修改不属于本批部署。以上时间戳为 UTC，风险日仍按 Asia/Shanghai。

随后报价最优价扫描优化：Python 全量 **293 passed / 1 skipped**，其中 shadow 定向 **37 passed**；独立审查另做 25,000 次对原 `345dc21` 源码的报价差分，结果一致且输入未修改。200 档深度微基准约提速 1.40 倍，只表示报价函数耗时变化，不能代表整段回放或实盘延迟。证据及复现方法见 [自动接续与回放优化](evidence/2026-09-13/automation-replay-progress.md)。本批不涉及 TypeScript 或前端代码，没有重复双方构建。

## 测试覆盖

- Python：配置版本/类型/损坏恢复、账本增量摄取、API、账户错误分类与公开 HTTPS 来源规则、采集和历史分析。新增覆盖盘口同键修订、日切/替换、异常恢复及无效变更不续鲜；账本空闲跳过、日志追加/替换与心跳失效。
- 引擎：真实 tick 量化、预算/费用/挂单占用、最低份数、部分及迟到成交、异常 ACK、盘口时序、停止撤单和最终对账。
- 前端：原设计结构/样式与导航、数据映射、设置草稿/版本冲突、账户交互和订单运行列表刷新。

账户/下单单元测试使用替身，不产生真实交易。历史 maker 回测必须有真实 tick 元数据；缺失或时间非法直接报错，见 [数据要求](BACKTEST-TICK-DATA.md)。

## 已有真实环境证据

本轮部署后六个页面/状态接口均为 HTTP 200，31 次行情采样跨两市场全部在线，账户只读检查 23.817 秒返回 HTTP 200/ok=true，详见 [CPU 验收](CPU-DIAGNOSIS-2026-09-10.md)。此前公网 HTTP 接口、六页导航和账户只读操作完成核验；当前 V2 必需授权、签名和私有 CLOB 只读查询通过。相关证据见 [运行验收](LIVE-READINESS-AUDIT-2026-09-10.md)。

真实行情 paper 只验证模拟执行。一次 6 分钟运行出现单边模拟结算 -$4.60；最终代码的 90 秒运行读到两侧真实 tick，产生一笔 DOWN 20@0.18 模拟成交及成本拒绝，停止时尚未结算。它们不能证明成功对冲、真实队列成交或收益。

目前未通过的验收包括：网页实盘启停、真实下单/撤单/部分成交闭环、完整持仓/资金账单、收益到账、长期风险和负载稳定性。不得以测试数量替代这些验收，也不得用测试启动真实订单。

账户链路新增：跨账户/过期清空、分页与只读协议、Maker归属与未知方向、CSV公式转义、纸面控制不解锁实盘、重复点击/不确定请求复用与版本冲突恢复。服务器独立只读查询已成功；Windows Computer Use 的网址安全检查停止了操作，本轮不得标记真实浏览器验收通过。

本批增加失败/待确认成交口径、奖励期间筛选、表格空闲复用、观察订单撤单与失效状态、分页重叠去重、九项参数保存回归。90秒独立无凭据 paper 运行取得真实行情和1笔模拟成交，因配对成本拒绝补仓，到时未结算退出；未完成双边对冲。证据见 [模拟检查](evidence/2026-09-10/repair-paper-check.json)。本轮浏览器连接工具返回 Transport closed，未完成真实点击验收。
