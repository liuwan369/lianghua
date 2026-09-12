# REPLAY-01 / RESEARCH-01 标注回放

日期：2026-09-13（Asia/Shanghai）。输入为 2026-09-10 都柏林采集库的 30 个最近市场，28 个完整窗口；官方标签报告为 `data/research/r33/report.json`，1,235 个市场全部已确认终态。每组使用影子成交、队列因子和 0.07 taker fee 假设，未加入返佣或 LP 奖励。

历史口径说明：本报告采用旧的双边合并覆盖判定，并跳过外层 token 为空的多 token 增量消息。2026-09-13 后续已定位并修复；下表仅保留为修复前证据，不作为现行策略参数或完整盘口覆盖的依据。修复后的扫描另附证据。

结果如下，金额为模拟 USDC：

| order size | pair cap | queue | strict official / worst | calibrated official / worst | candidate official / worst |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 0.97 | 0.25 | +4.500 / -5.500 | -0.274 / -0.274 | +1.353 / +1.353 |
| 10 | 0.99 | 0.50 | -12.161 / -130.996 | -16.614 / -16.614 | -4.689 / -4.689 |
| 20 | 0.97 | 0.25 | +6.246 / -7.634 | -0.380 / -0.380 | +1.878 / +1.878 |
| 20 | 0.99 | 0.50 | -37.694 / -364.459 | -20.316 / -20.316 | -7.864 / -7.864 |

低参与的候选方案只产生 2 笔模拟成交，不能作为默认值；高参与配置在无奖励压力下明显亏损。严格方案的正模拟结算也伴随极低参与或较大的最坏单边损失。该 28 市场样本用于验证官方标签接线和风险方向，不构成独立留出晋级，也不证明真实队列、账户净收益或奖励收益。

复现：

```powershell
python scripts/pm-r29-safe-sweep.py --sqlite data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-10.sqlite3 --history-dir data/research/r33 --out data/research/r33/r29-label-sweep-30.json --max-markets 30 --max-combinations 4 --resolution-labels data/research/r33/report.json
```

下一步是冻结时间切分、扩大有效活动样本、校准成交/队列与成本，并在真实奖励到账前保持推荐默认值为空或沿用当前已验证配置。
