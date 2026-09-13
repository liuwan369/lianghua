# 回放零成交诊断

日期：2026-09-13，Asia/Shanghai。责任域：数据与回放。

## 观测

最新 `r26-followup-20260913.json` 使用修正后的 `per-token-book-v2` 和
`compact-atomic-message-v2`：选取 12 个市场，11 个完整，回放
1,406,579 条源消息；三个配置均为 `0 simulated_fills`、`0 paired_shares`、
`0 simulated settlement PnL`。所有 11 个完整市场都有官方结算标签，因此零值
不是由结算标签缺失造成的。

## 可证实原因

1. 影子成交必须同时满足：盘口报价仍存在、订单已过 `eligible_at_ms`、公开成交
   价格与挂单 tick 相同，并且成交方向被识别为 `SELL`。公开成交但方向不满足时，
   模型不会把它计为 maker 成交。这是成交模型的明确门槛，不是收益为零的证明。
2. `calibrated_3048` 配置有 15 秒报价启动延迟、240 秒对齐窗口和 270 秒停止新
   报价；短生命周期市场中这些时段会直接减少可成交时间。
3. `pair_cap=0.97`、库存/安全对冲门槛和 `queue_factor=0.25` 会在成交时再次限制
   可执行数量。回放报告只记录最终成交计数，尚未按原因聚合 quote reset、过期、
   价格不匹配和 execution pair cap 的拒绝次数，因此当前不能量化每个门槛的贡献。
4. 参考地址的链上成交没有与这些市场的活动哈希匹配（`activity_hashes_matched=0`），
   不能用参考地址成交反推本次影子订单应该成交。

## 不能从本次结果推出的结论

- 不能宣布策略无效、盈利或可设置默认参数。
- 不能把零成交当作零风险；它也可能表示报价从未进入可成交状态。
- 不能把参考地址的历史成交、奖励或链上费用当成本账户收益。

## 下一项可复现实验

在同一 SQLite、同一 12 市场选择和同一解码版本上，先增加拒绝原因计数，随后只
改变一个变量：`quote_start_delay_ms` 从 15,000 改为 0；保持 `pair_cap=0.97`、
`queue_factor=0.25`、订单大小、库存限制和成交方向规则不变。并行记录每个市场的
报价有效毫秒数、quote resets、过期取消、price mismatch、queue/`execution_pair_cap`
拒绝以及最终 fills。若仍为零，再单独比较 `pair_cap` 0.97/0.99，禁止同时放宽
多个门槛。该实验只诊断活动与模型敏感性，不产生生产默认值。

复现基线命令：

```powershell
python scripts/pm-r26-historical-shadow-replay.py --sqlite data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-10.sqlite3 --history-dir data/research/r33 --out data/research/r33/r26-followup-20260913.json --max-markets 12 --order-size 10 --pair-cap 0.97 --queue-factor 0.25 --max-inventory-imbalance 10 --taker-fee-rate 0.07 --resolution-labels data/research/r33/report.json
```

状态：`INSUFFICIENT_ACTIVITY`。本报告不改变策略晋级状态。
