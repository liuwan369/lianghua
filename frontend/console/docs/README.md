# 独立前端设计稿

预览服务当前使用 `http://127.0.0.1:5175/`，入口是 `overview.html`、`market.html`、`auto-trade.html`、`strategy.html` 和 `settings.html`。

页面脚本保留现有深海视觉稿，`shared/preview-core.js` 提供最小共享边界。localStorage 只用于市场运行池的预览草稿，不能作为后端交易状态。

当前真实联调状态：后端必须提供带 `marketId + roundId` 的市场目录、运行池和市场快照；旧 `/api/v1/markets` 缺少 `roundId` 时，前端只展示目录/报价，不查询持仓和订单。实时流只有在配置 `streams.markets`、`streams.runtime`、`streams.orders` 地址后才建立，未配置时保留最近成功快照并显示待接入。真实账户和交易环境尚未接入，账户页只保留服务器状态对接边界。

后端接入先阅读：

1. `FRONTEND-ARCHITECTURE.md`
2. `DATA-MODEL.md`
3. `API-CONTRACT.md`
4. `UI-MODULES.md`
5. `LAYOUT-SPEC.md`
6. `INTEGRATION-CHECKLIST.md`

当前生产目录没有被本次整理修改。
