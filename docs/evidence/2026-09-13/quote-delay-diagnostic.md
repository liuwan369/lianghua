# 报价启动延迟单变量诊断

日期：2026-09-13 Asia/Shanghai。实验由量化 Agent 执行，主 Agent 集成。

固定输入：`dublin-evidence-2026-09-10.sqlite3`、`r33/report.json`、最多 4 个市场（其中 3 个完整）、订单大小 10、`pair_cap=0.97`、`queue_factor=0.25`、最大库存偏差 10、taker 费率 0.07。唯一变量是候选策略 `quote_start_delay_ms`。

| 启动延迟 | 完整市场 | simulated fills | paired shares | official simulated PnL |
| ---: | ---: | ---: | ---: | ---: |
| 0 ms | 3 | 0 | 0 | 0 |
| 5,000 ms | 3 | 0 | 0 | 0 |
| 15,000 ms | 3 | 0 | 0 | 0 |
| 30,000 ms | 3 | 0 | 0 | 0 |

结果文件：`data/research/r33/r29-quote-delay-20260913.json`。四档均为离线影子回放，没有账户连接、真实订单或奖励收入。

结论：在本数据和成交模型下，零成交不能归因于 15 秒启动延迟。仍不能据此宣布策略无效或盈利。下一项固定启动延迟和 `pair_cap`，拆分成交方向识别、价格匹配、可见队列消耗和报价存活时间的拒绝计数；只有活动和成交模型可解释后才继续参数验证。
