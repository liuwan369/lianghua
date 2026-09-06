# 东京服务器清理记录

执行日期：2026-09-06（北京时间）

## 保留

- `/root/pm-system`
- `pm-r25-tokyo-collector.service`
- `pm-system-dashboard-tokyo.service`
- `pm-r25-live-analyzer.timer`
- `pm-r25-daily-restart.timer`
- `/root/pm-system/data/pm-r25-live` 及其中的历史数据库

## 已停止并删除

- `pm-r22-risk-gated.service`
- `pm-r22-maker-dashboard.service`
- `polymarket-maker-shadow.service`
- `polymarket-maker-dashboard.service`
- `pm-r25-history-backfill.service`
- `polymarket-spread-monitor.service`
- 旧目录 `/root/pm-r14`、`/opt/polymarket-monitor`、`/root/hyperliquid-whale-dashboard`

## 复核结果

- 当前 4 个保留服务/定时任务均为 active。
- 没有旧模拟进程、旧 Hyperliquid 进程或旧 maker 进程。
- 采集器现在直接运行 `/root/pm-system/scripts/pm-r25-tokyo-evidence-collector.py`，不再依赖旧目录。
- `trade_authorization=false`，本次没有签名、下单或撤单。
- 东京页面和 `/api/live` 已恢复，实时采集器继续写入当前项目数据。

## 说明

旧实时数据库没有删除，因为它是当前项目的历史证据；只删除了旧代码、旧服务和旧模拟运行目录。
