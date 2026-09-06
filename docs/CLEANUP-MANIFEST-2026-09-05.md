# 工作区净化清单

## 保留

- `_external/btc-5m-market-trading-bot`
- `pm_maker`
- `scripts/system-dashboard-server.py`
- `scripts/start-dashboard.ps1`
- `scripts/start-tokyo-dashboard-tunnel.ps1`
- `scripts/sync-pm-r25-tokyo-days.ps1`
- `scripts/pm-r25-*` 采集/分析脚本、`pm-r26`/`pm-r27`/`pm-r28` 核心回放脚本和 `pm-r32` 奖励核验脚本
- `config/pm-r25-*`、`config/pm-system-dashboard-tokyo.service`、`config/paper-grid.server.conf`
- `data/pm-r25-live`、`data/pm-r25-history-30d-verified`
- 最新仍保留的验证结果：`pm-r25`、`pm-r32`
- 五个外部参考仓库：`Polymarket__py-sdk`、`warproxxx__poly-maker`、`CZA1006__Poly-Maker-RS`、`thxthanxwe__polymarket-btc-5m-hedge-ladder-bot`、`crazygirl437__Polymarket-5min-bot`
- `tests/test_pm_r25_*.py`、`tests/test_maker*.py` 及其当前依赖

## 删除

- 旧 Python 路线：`pm_altcoin`、`pm_btc`、`pm_history`、`pm_shadow`、`pm_options`、`pm_negrisk`
- 旧天气、期权、山寨币、NegRisk 配置和 r02-r24 脚本/服务
- `docs/research`、旧阶段重复报告和旧钱包监控页面
- `data/altcoin`、`data/btc`、`data/history`、`data/maker`、`data/negrisk`、`data/options`、`data/shadow`
- 没有现行脚本对应的 `pm-r32-deep-strategy`、`pm-r32-incentive-accounting` 和 `pm-r51-receipts` 中间结果
- 旧 `pm-r14` 到 `pm-r57` 中间脚本和结果，只保留当前回放所需的核验结果
- `_external` 中除五个参考仓库和主交易引擎外的仓库
- 根目录 `gpdocs.html`、`gpdocs.js`、`gpspec.yaml`
- 空的 `references/` 目录、Python/pytest 缓存目录

删除理由：这些内容不再被当前页面、东京采集器或 BTC 5 分钟引擎使用，保留会造成重复入口和误读。

## 本次执行结果

- 已删除工作区缓存：根目录 `.pytest_cache`，以及 `pm_maker`、`scripts`、`tests` 下的 `__pycache__`。
- 已确认没有残留 Python/pytest 缓存目录。
- 未删除 `data/` 历史数据库、Binance 历史压缩包、主引擎 `dist`/`node_modules` 或五个外部参考仓库；它们仍被回放、部署或审计使用。
- 当日清理时验证：TypeScript 构建通过；Vitest `41/41` 通过；Python `8/8` 通过；当时东京 `/api/live` 和 `/api/trading/status` 均返回 HTTP `200`。这不是 2026-09-06 的实时状态证明；本次本地核对中 `/api/live` 超时，`/api/trading/status` 仍返回纸面状态。
- 当前文档、页面和服务仍以 BTC 5 分钟主线为准；真钱交易继续保持锁定。

## 当前页面口径

- “挂单”在页面显示为“挂单尝试”，因为纸面模式没有交易所排队确认。
- 没有成交的市场显示“无成交”，不计入收益，也不显示 `$0.00` 假收益。
- 页面只有“交易、配置、订单”三个入口；旧高级地址只做兼容跳转。
- 当前模式仍锁定为模拟交易，实盘接口未开放。
