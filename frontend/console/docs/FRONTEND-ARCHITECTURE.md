# 独立前端架构

## 范围

这是 `Desktop/Polymarket-自动交易设计稿` 的独立预览和后端接入边界。它不修改生产前端，也不把浏览器本地状态当成交易系统真相。当前页面仍可用静态演示数据预览，但演示状态都应标记为“设计稿/待接入”。

## 页面

- `overview.html`：运行总览、统计、服务资源、运行事件。
- `market.html`：平台支持的加密货币五分钟市场、YES/NO 行情和市场运行池。
- `auto-trade.html`：运行控制、盘口深度、本场持仓、订单和事件。
- `strategy.html`：通用五分钟反转策略参数、阶段份额、运行边界。
- `settings.html`：连接和版本诊断；账户只显示后端保存状态。

## 共享层

`shared/preview-core.js` 是轻量边界：

- `config`：API 前缀、模式、固定市场周期。
- `request`：超时、无缓存、同源请求和统一错误。
- `storage`：仅用于预览的版本化运行池草稿，并兼容旧草稿。
- `createResource`：`data/error/loading/stale/receivedAt` 状态。
- `navigate`、`format` 和简单事件总线。
- `api`：按页面划分的 REST adapter；预览默认不调用，接入时替换实现即可。

实际共享文件：

- `shared/demo-data.js`：仅预览用的单一币种目录，页面不再各自复制币种数组。
- `shared/view-model.js`：把新接口和现有 `/api/v1/*` 字段转换成统一的 Market/Pool/Runtime 模型。
- `shared/preview-store.js`：按 `marketCatalog`、`marketPool`、`runtime`、`strategy`、`account`、`diagnostics`、`metrics`、`events` 分片；页面按分片订阅。
- `shared/api-adapter.js`：REST 入口；本地预览不请求网络，切换配置后可使用新契约并回退到现有只读接口。
- `shared/ws-client.js`：行情、运行、订单流的统一连接封装，按 sequence 丢弃旧帧。

页面脚本只负责视图和交互；真实接入时把数据源替换为 adapter，不把 fetch、WebSocket 和业务状态散落到每个页面。

页面接入顺序固定为：`preview-core` → `demo-data` → `view-model` → `preview-store` → `ws-client` → `api-adapter` → 页面脚本。生产挂载时只需把 `window.__POLY_PREVIEW_CONFIG__` 放在这些脚本之前，例如 `{ mode: "backend", apiBase: "", apiFlavor: "contract", strategyId: "btc-reversal", streams: { markets: { url }, runtime: { url }, orders: { url } } }`。三个流地址分别对应行情、运行状态和订单事件；任一地址缺失时，前端不会创建该连接，也不会用演示数据冒充实时数据。

## 数据流

1. REST 首次加载页面快照和慢数据。
2. 市场行情/盘口、运行状态、订单事件分别使用独立 WebSocket 频道。
3. 每个帧必须带 `sequence`、`sourceAt`、`expiresAt` 和 `marketId/roundId`。
4. 客户端只接受更新的 sequence；过期时保留最后快照并显示 stale，不闪烁清空。
5. 控制按钮提交带 `requestId` 的幂等命令，等待服务端状态事件确认。

## 状态真相

- 市场“启用”是 desired pool。
- 当前场次、下一场生效、运行中、订单和持仓由服务器返回。
- localStorage 只保存预览草稿；生产禁止用它决定是否交易。
- 盘口、持仓、订单和策略阶段必须按 `marketId + roundId` 隔离。旧接口缺少 `roundId` 时，只显示目录/报价，不查询或猜测轮次数据。
- 账户和交易状态以服务器为准。真实账户、签名和交易环境尚未在当前独立前端完成联调，页面的 `unavailable/stale` 状态必须保留，不能降级成“成功”。
