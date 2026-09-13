# R29 单变量报价门槛诊断

日期：2026-09-13（Asia/Shanghai）。本次实验固定订单大小 10、队列因子 0.25、最大库存偏差 10、taker 费率 0.07，只改变 `pair_cap`（0.95 与 0.97）；每组使用同一份都柏林 CLOB 数据和官方终态标签。运行窗口取最近 4 个市场，其中 3 个盘口窗口完整。

复现命令：

```powershell
python scripts/pm-r29-safe-sweep.py --sqlite data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-10.sqlite3 --history-dir data/research/r33 --out data/research/r33/r29-pair-cap-diagnostic-20260913.json --max-markets 4 --max-combinations 2 --experiment pair_cap --resolution-labels data/research/r33/report.json
```

| pair_cap | 完整市场 | 三种引擎成交 | 配对份数 | 官方模拟结算 |
| ---: | ---: | ---: | ---: | ---: |
| 0.95 | 3 | 0 / 0 / 0 | 0 | 0 |
| 0.97 | 3 | 0 / 0 / 0 | 0 | 0 |

结论：在这个有界窗口里放宽报价门槛没有改变成交，不能把零成交归因于 `pair_cap` 过严。更可能的阻塞点是报价生命周期/事件时序（例如 15 秒启动延迟、盘口刷新后的可成交方向）或真实成交队列证据不足。该结果不证明策略无效，也不产生默认参数；下一项实验应固定 `pair_cap=0.97`，只改变最小存活时间或队列因子，并继续使用独立留出窗口。奖励、返佣和目标地址活动均未计入盈利。

实验输出：`data/research/r33/r29-pair-cap-diagnostic-20260913.json`。交易授权保持关闭。
