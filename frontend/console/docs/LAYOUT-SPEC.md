# 布局与刷新规则

## 视觉

保留当前确认的深海渐变、圆角卡片和高亮状态。侧栏负责页面切换，主区按“控制/实时核心/慢数据”排序。YES/NO 颜色在所有页面保持一致。

## 信息优先级

1. 运行控制和全局状态。
2. 当前选中市场的报价、五档和场次倒计时。
3. 当前场次持仓、订单和策略阶段。
4. 汇总统计、诊断和历史事件。

## 更新频率

生产环境 `capabilityDetails.streams=false`，服务器没有 WebSocket/SSE，**当前唯一生效的方式是 REST 轮询**。`ws-client.js` 仅在 `PolyPreview.config.streams` 显式配置了地址时才建连；未配置就直接跳过，不影响功能。

实际间隔（以代码为准，每个定时器独立、各自带在途去重）：

| 数据 | 间隔 | 位置 |
|---|---|---|
| 盘口快照 | 1 秒 | `auto-trade-block.js` |
| 运行状态 | 2 秒 | `auto-trade-block.js` |
| 总览快状态 | 3 秒 | `overview-block.js` |
| 事件、汇总统计 | 5 秒 | `auto-trade-block.js` |
| 市场上下文、运行池 | 10 秒 | `auto-trade-block.js` / `market-block.js` |
| 账户快照、总览慢数据 | 15 秒 | 两页 |
| 账户状态 | 30 秒 | 两页 |
| 市场目录 | 1 秒 | `market-block.js` |
| 策略 | 保存或手动刷新 | `strategy-block.js` |

高频行情不与账户、系统资源、历史统计共用一个轮询。浏览器不可见时暂停（`document.hidden` 早退 + `visibilitychange` 监听），回到页面先取一次快照。

## 防闪烁规则

保留上次成功 DOM，数据帧过期时只加 stale 标记。页面骨架用一次性 `innerHTML` 挂载，之后**只更新单个文本节点和 CSS class**，不得在刷新时重建骨架。不要为实时数字加同步 layout thrash 动画，不要用 setInterval/Math.sin 伪造行情。

本地过期倒计时只能使用服务器测量的寿命（`expiresAt - sourceAt`），不能把服务器时间戳与浏览器时钟比较——时钟偏移会让有效快照被误判过期并堵死启动。
