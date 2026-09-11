# 公开做市机器人策略调研（2026-09-12）

## 参考源码

- [warproxxx/poly-maker](https://github.com/warproxxx/poly-maker)：纯函数报价核心，深度加权 microprice + signed-flow EWMA，库存 skew，波动率/毒性扩大价差，QUIET/TRENDING/EVENT/REDUCE_ONLY/HALTED 状态机，心跳 dead-man，SQLite 状态与原始 WS journal。
- 该项目现场经验明确：薄盘口采用奖励最低合格份数；大单会被价格跳空吃掉并难以退出。重报价过于频繁会丢排队位置和奖励资格；只依赖 positions API 会因延迟误判库存。
- 其退出逻辑强调分层限价、避免直接穿越盘口 gap；大仓位必须先证明可退出。

## 与本项目对照

已有：双边报价、组合成本门槛、动态补仓、库存上限、断线撤单、费用纳入风控、迟到成交与账本去重。

缺口：公平价值仍主要由 BTC 变化 + 固定 sigma；没有使用盘口深度加权 microprice、signed trade flow、实时波动率 EWMA、逐笔成交 markout 毒性、奖励带 watchdog；重报价/排队保护较弱；薄盘口与深盘口未分型；退出缺少按可见深度分层和 gap floor。

## 可落地改进（先离线回放）

1. **Fair value**：由 best mid 改为 microprice = (ask*bidSize + bid*askSize)/(bidSize+askSize)，再叠加有界 signed-flow EWMA（±0.5 tick）。
2. **Inventory skew**：用净 YES 等价库存/软上限归一化；多头 YES 时降低 YES bid、抬高 NO bid；库存接近软上限时缩量，超过硬上限只允许减仓。
3. **毒性过滤**：记录每次 maker fill 后 30/60 秒 markout；EWMA 毒性超过阈值时扩大半价差并减半 clip；检测 6 tick 级跳变进入 EVENT 冷却。
4. **排队与重报价**：可见同价位深度乘保守系数估计 queue；对 1 tick 以内 FV 抖动不撤单；设置最短挂单寿命/重报价间隔，避免 churn。
5. **市场分型**：深度不足或 gap 超阈值时使用奖励最低份数；禁止大额首腿。只有近端双边深度足以容纳补腿时才开新报价。
6. **退出**：REDUCE_ONLY 时按每个 bid level 可见数量分层卖出，遇到 gap 停止，不用 market dump；尾盘提前进入 reduce-only。
7. **风险预算**：单市场最大现金暴露、单边最长时间、日损失 kill switch 必须是硬门槛；maker rebate/reward 未观察到账前按 0 计。
8. **验证顺序**：把五日 CLOB 按市场切 train/holdout；比较当前策略、microprice+flow、toxicity+inventory、薄盘口 min-size 四个版本。指标必须含费用后 PnL、最坏结算、paired ratio、one-sided markets、最大裸仓、fill markout、quote churn。

## 关键结论

公开机器人普遍靠“奖励/返佣 + 低库存风险”赚钱，而不是单纯价差。当前五日回放三种配置最坏结算均为负，主因是 71–75% 市场仍单边或补腿不足；应先减少首腿和薄盘口暴露，再谈扩大交易量。任何参数进入生产前需在留出集费用后非负且最坏单场损失受限；实盘锁保持关闭。
