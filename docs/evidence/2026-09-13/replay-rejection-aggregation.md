# 回放拒绝原因聚合诊断

日期：2026-09-13（Asia/Shanghai）。责任域：量化回放。

## 目的

将 r26 逐市场快照中的 `diagnostic_rejections` 聚合到策略级和 r29 单变量实验级，区分成交方向、订单生命周期、价格、可见队列和市场停止等门槛。该计数描述影子模型的决策路径，不是交易所拒单或真实成交证明。

## 计数定义

`trade_skipped:no_working_order` 表示该 token 没有当前工作订单；`trade_skipped:taker_side_not_sell` 表示公开成交方向不是 SELL（当前 maker 影子模型只接受 SELL）；`trade_skipped:nonpositive_size` 表示成交数量无效。`trade_rejected:not_eligible`、`expired`、`market_stopped`、`price_mismatch` 和 `queue_only` 分别对应订单存活、市场窗口、价格 tick 和可见队列门槛。引擎产生的 `quote_cancelled:*` 保留为报价生命周期信号；`quote_cancelled:execution_pair_cap` 表示执行配对上限阻止成交。

## 基线

输入、市场选择和参数见下方命令。输出应以 `summary.<strategy>.diagnostic_rejections` 为策略级聚合，以 `markets.<strategy>[].snapshot.diagnostic_rejections` 为逐市场明细。基线仍是影子回放，禁止据此生成生产默认参数。

```powershell
python scripts/pm-r26-historical-shadow-replay.py --sqlite data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-10.sqlite3 --history-dir data/research/r33 --out data/research/r33/r26-diagnostic-20260913.json --max-markets 12 --order-size 10 --pair-cap 0.97 --queue-factor 0.25 --max-inventory-imbalance 10 --taker-fee-rate 0.07 --resolution-labels data/research/r33/report.json
```

## 单变量实验

`pm-r29-safe-sweep.py` 的 `pair_cap` 和 `quote_start_delay` 实验现在把每个 replay 的 `diagnostic_rejections` 复制到结果行，固定其他假设后可直接比较原因变化。实验输出仍需同时报告覆盖率、完整市场数和 simulated fills；零成交不等于策略失效或零风险。

## 结果

patched r26 基线（12 个市场、11 个完整、1,406,579 条 CLOB 消息）聚合如下：

| 策略 | 无工作订单 | taker 非 SELL | not eligible | price mismatch | quote pair cost gate | fills |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| strict_pair | 14,698 | 805 | 42 | 1 | 4 | 0 |
| calibrated_3048 | 14,698 | 805 | 42 | 1 | 4 | 0 |
| candidate_r19 | 15,076 | 443 | 27 | 0 | 1 | 0 |

同一回放中未出现 `expired`、`market_stopped`、`queue_only` 或
`execution_pair_cap` 计数；这表示这些分支在当前影子订单生命周期里未被触发，不能解释零成交。主要阻塞是没有工作订单，其次是公开成交方向为非 SELL；方向计数必须结合交易所成交方向语义继续核对，不能直接当作可成交量。

`r29` 输出行现同时包含 `diagnostic_rejections`，可用以下命令重跑四档报价启动延迟或 pair cap 单变量实验并比较原因变化：

```powershell
python scripts/pm-r29-safe-sweep.py --sqlite data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-10.sqlite3 --history-dir data/research/r33 --out data/research/r33/r29-quote-delay-diagnostic-20260913.json --max-markets 4 --max-combinations 4 --experiment quote_start_delay --resolution-labels data/research/r33/report.json
```

本次 4 市场报价启动延迟实验（3 个完整市场）中，三种策略均为 0 fills。`strict_pair` 和 `calibrated_3048` 的计数在 0/5/15/30 秒延迟下保持不变（无工作订单 3,600、taker 非 SELL 174、not eligible 10）；`candidate_r19` 的无工作订单为 3,631/3,638/3,641/3,653，taker 非 SELL 为 145/138/135/123，not eligible 为 8，仍没有成交。该单变量结果表明启动延迟只改变候选策略的少量订单可用性，不能单独解释零成交。

同一窗口的 `pair_cap` 实验（0.95 对比 0.97）也保持 0 fills。0.95 档的 strict/calibrated 为无工作订单 3,717、非 SELL 64、not eligible 3；0.97 档为 3,600、174、10。候选策略分别为 3,727/54/3 与 3,641/135/8。计数变化反映报价生命周期变化，不能把它解释成成交改善。

以上结果只用于模型诊断；当前不晋级任何生产参数。

patched r26 12 市场基线（11 个完整、1,406,579 条消息）也已完成。三组策略仍为 `0 fills`。`candidate_r19` 的主要计数为 `trade_skipped:no_working_order=15,076`、`trade_skipped:taker_side_not_sell=443`、`trade_rejected:not_eligible=27`、`quote_cancelled:pair_cost_gate=1`；没有 `queue_only`、`expired` 或 `market_stopped`。这说明影子模型的主要瓶颈是没有工作中的报价，其次是成交方向识别；不能据此仅放宽 `pair_cap` 或启动延迟，也不能生成生产默认参数。
