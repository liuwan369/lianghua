# 平台生命周期与任务页发布

日期：2026-09-16，北京时间 18:10 完成代码批核验。

## 发布结果

- 源码提交：`3c69167ea6857ed9d81e9b7ef75d548f5f40ed8b`，已推送 `origin/master`。
- 发布目录：`/root/.pm-releases/architecture-20260916T100559Z-e5a5b5/`，包含替换前备份及逐文件 `manifest.json`。
- 本次替换 101 个文件，上传后逐一核对 SHA-256。范围为平台、必要行情依赖、任务页和当前文档，未包含其他研究、原始数据、账户文件或服务配置。
- Dashboard 和 collector 逐个检查均为 active。发布前后 `running=false`、`mode=paper`、`live_unlocked=false`，运行 ID 保持 `20260915-121431-42579deb1a1a`，配置 revision 7。
- 未重启服务，未启动策略，未产生真实订单。平台代码已发布不等于控制台已迁入新平台。

## 修复及验证

账户核对先验证候选状态再提交，失败时不修改余额、持仓、订单预留和快照时间。Paper FAK 的待撤剩余量停止撮合，撤单/关闭通过同一异步投递队列交付，避免其他订单的成交先于提交 ACK 到达核心。

独立复核确认三项 HIGH 复现均已解决；额外修复发布脚本多服务状态判断。引擎 43 文件 / 418 项、前端 8 文件 / 64 项通过，类型检查与构建通过。本批未修改 Python，沿用前次 546 passed / 1 skipped 记录。

Playwright 在本地和公网的 1440px、390px 视口检查任务页：40 个功能条目、未完成筛选 24 项、PAUSED 中文详情、刷新与标签切换均通过，无横向溢出或页面脚本错误。仅进行只读页面操作。

| 构建产物 | SHA-256 |
|---|---|
| `dist/platform/core.js` | `94575dbc81ce76c9f80711b32e78025a16313efcce23a7267afd75c1f1aa4fa5` |
| `dist/platform/paper.js` | `a116843dd66ed131e83a319f128e66cf74a921c6d4036611a88bef7bcacf77f1` |
| `docs/console/assets/index-dx4keC1_.js` | `d75c7d01ff20284f498845043833e71a998f8cf8fd3b35dc8b6bb00cbd8fabea` |
| `docs/console/assets/index-CTPw7mvv.css` | `c159b3f9438e71a66de17604209bab3125ce4a0e34db929c10cb1b99350d1986` |

## 未完成与下一步

优先迁移控制台的启动、停止、进程恢复和状态/日志投影。现有按钮仍调用旧 `live.js run` / Engine；独立平台 CLI 已就绪，但不是现有控制台默认入口。任务树 EXEC-00 已纠正为部分完成，新增 WEB-06、WEB-07、UI-00，策略阶段明确显示已暂停。

真实部分成交、断线中成交、异常恢复、持续资金对账和五档/分段延迟展示继续保留未完成状态。本次未做生产断线回退故障注入；回退只恢复清单文件，不能覆盖账户、账本、订单或未纳入发布的研究内容。
