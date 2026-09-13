# RESEARCH-01 / REPLAY-01 价格、方向、生命周期与队列诊断

日期：2026-09-13（Asia/Shanghai）。本实验是只读影子回放，交易授权保持关闭，不能生成生产默认参数。

## 固定输入

- CLOB：`data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-10.sqlite3`（1,106,173,952 bytes，2026-09-12 01:14:39）
- 官方终态：`data/research/r33/report.json`，SHA-256 `9369CCD56A7BB1F34C7AD82F4D6799D7295C1C45426EFA1839D86B4CA76AB434`
- 窗口：最近 4 个市场，3 个完整盘口窗口；订单大小 10、`pair_cap=0.97`、`max_inventory_imbalance=10`、taker 费率 0.07、启动延迟 15 s。
- 代码指纹：`pm-r26` SHA-256 `8ED567DC1CD2D41B6E3F768A444F27CCF04550FB580D5597D9998BE420F73B33`；`pm-r29` SHA-256 `683D4EF1B834A476AD4DCE0E592B94DCB953CFE5EE326D559F82191DE4AC3CE6`；`pm_maker/shadow.py` SHA-256 `87C28A9113B86675CAD1A2BCD9BD64DC662A32D18FA01A2E1CCD9E961C61F0F5`。

命令模板：

```powershell
python scripts/pm-r29-safe-sweep.py --sqlite data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-10.sqlite3 --history-dir data/research/r33 --out data/research/r33/r29-price-diagnostic-20260913.json --max-markets 4 --max-combinations 2 --experiment price_mode --resolution-labels data/research/r33/report.json
```

`queue_factor` 与 `order_live_ms` 使用相同输入和独立实验名；r29 每组由独立 Python 子进程执行，无随机采样，事件顺序由 collector `received_at_ns` 固定。

## 结果（candidate_r19）

| 实验 | 条件 | fills / shares | 关键拒绝计数 | 解释 |
| --- | --- | ---: | --- | --- |
| direction_mode | observed | 0 / 0 | no working 3,641；taker 非 SELL 135；not eligible 8 | 真实方向下没有成交 |
| direction_mode | force_sell | 0 / 0 | forced 3,432；no working 3,641；not eligible 141；price mismatch 2 | 解除方向门槛仍被报价/价格阻塞 |
| price_mode | observed + force_sell | 0 / 0 | no working 3,641；not eligible 141；price mismatch 2 | 真实价格路径无成交 |
| price_mode | force_order + force_sell | 10 / 50 | price forced 138；queue_only 17；pair cap cancel 4 | 仅作为价格匹配上界；不代表真实成交 |
| queue_factor | 0.0 / 0.25 / 0.5 / 1.0 + force_sell | 0 / 0（各档） | no working 3,641；not eligible 141；price mismatch 2 | 可见队列假设未被触发，不能解释零成交 |
| order_live_ms | 0 + force_sell | 6 / 45 | price mismatch 1,205；queue_only 2；pair cap cancel 4 | 取消最小存活门槛后有少量上界成交 |
| order_live_ms | 250 / 1000 / 5000 + force_sell | 0 / 0（各档） | no working 3,641；not eligible 141-143；price mismatch 2 | 250 ms 以上存活门槛在该窗口挡住了可用事件 |

完整原始输出保留在：

- `data/research/r33/r29-direction-diagnostic-20260913.json`
- `data/research/r33/r29-price-diagnostic-20260913.json`
- `data/research/r33/r29-queue-diagnostic-20260913.json`
- `data/research/r33/r29-live-diagnostic-20260913.json`

## 判定与下一步

1. 方向识别是必要条件，但不是唯一主因；强制 SELL 仍然零成交。
2. 价格匹配是当前最强阻塞证据：把公开成交价格改写为订单价才出现成交，属于反事实上界，不能用于盈利或默认参数。
3. 队列因子在本窗口未进入有效成交分支；`queue_factor=0` 不能被解释为真实队列位置。
4. `min_order_live_ms=0` 的少量成交说明报价生命周期值得继续研究；需要下一批独立留出窗口和真实订单/撤单时间戳验证。
5. 所有策略仍标记 `INSUFFICIENT_ACTIVITY`/研究状态；不晋级任何生产默认值，不启用 live。后续优先采集逐报价生命周期、订单方向和交易所确认价格，再评估参数。

## 独立留出复核（09-09）

为排除单日采集偏差，使用未参与上表实验的 `dublin-evidence-2026-09-09.sqlite3`，按同一
`received_at_ns` 回放，最多 8 个市场（其中 6 个盘口窗口完整，2 个因覆盖不足排除）。官方标签仍来自
同一份已校验的 `data/research/r33/report.json`，不把目标地址活动当成交标签。

| 实验 | 条件 | fills / shares | 关键拒绝计数 | 解释 |
| --- | --- | ---: | --- | --- |
| holdout baseline | observed direction + observed price，`min_order_live_ms=250` | 0 / 0 | no working SELL 6,142；no working order 5,857；taker 非 SELL 285 | 真实方向/价格在独立日仍无成交 |
| lifecycle upper bound | force SELL + observed price，`min_order_live_ms=250` | 4 / 22.8169（candidate_r19） | forced direction 5,533；no working SELL 5,976；not eligible 156；price mismatch 16 | 只解除方向门槛，仍是诊断上界 |
| lifecycle relaxed upper bound | force SELL + observed price，`min_order_live_ms=0` | 18 / 140.0（candidate_r19） | forced direction 5,533；no working SELL 5,067；price mismatch 1,056 | 放宽存活门槛增加反事实成交，不能证明真实可成交 |

原始输出：`data/research/r33/r26-holdout-0909-baseline-20260913.json`、
`data/research/r33/r29-holdout-0909-live-sweep-20260913.json`。

链上交叉核对补充：同一 09-09 数据库中，按六个完整市场的 token 和
`maker=0x3048...94f98a2e7537` 过滤到 310 条 `order_filled(role=maker)`（逐市场
60、50、70、56、49、25）。这些记录能提供交易所确认的成交时间和成交价范围，
但采集物没有对应的 `order_placed/order_cancelled` 生命周期事件，且历史活动哈希未能与
链上哈希关联；因此它们只能作为身份/价格核对，不能直接改写影子成交或推导队列位置。

跨日判定：报价生命周期会改变“强制方向”上界的成交量，但观察方向下仍为零；
`force_sell` 与 `min_order_live_ms=0` 继续禁止进入生产默认值。下一实验必须采集交易所确认的逐订单
`placed_at / cancel_at / trade_at / matched_price`，并在第三个独立日期验证真实 maker 成交，否则保持
`INSUFFICIENT_ACTIVITY` 和 live 锁定。

验证：`python -m py_compile scripts/pm-r26-historical-shadow-replay.py scripts/pm-r29-safe-sweep.py` 通过。
