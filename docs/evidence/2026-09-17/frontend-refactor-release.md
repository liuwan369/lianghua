# 前端重构发布记录

日期：2026-09-17（Asia/Shanghai）  
入口：https://34-242-206-196.sslip.io/console/  
服务器：都柏林 `34.242.206.196`

## 范围

- 总览不再渲染市场表。
- “市场”和“订单”不再作为独立导航。
- 自动交易页集中显示盘口、持仓、订单、成交、撤单和失败记录。
- 新增“策略”页，支持当前会话添加策略、切换独立 JSON 参数草稿，并承载策略/运行设置。
- 设置页只保留账户接入和系统诊断。
- 策略执行仍暂停；策略草稿不会提交未知服务端字段，也不会触发下单。

## 三段核对

源码提交：`8e1c014`、`c31fd9a`。  
服务器回退目录：`/root/.pm-releases/frontend-refactor-20260917-r2/`。  
构建入口和资源：

| 文件 | SHA-256 |
| --- | --- |
| `docs/console/index.html` | `2b09e2420002dd86463cbea6dd7bf572b68964c65e635da9bcd82aaeecab04d3` |
| `docs/console/assets/index-D1kDYNI7.js` | `628ff53ddc00bd5f7271d3166142ec1f5f73a2282e8ac87479cd68f7428049f6` |
| `docs/console/assets/index-OHVUUzdm.css` | `b754d4fa006ac7743d1a40f715db9683cf4abee548ae275bd2d14e828ed7f46b` |

## 验证

- `npm test -- --run`：10 个测试文件，72 个测试通过。
- `npm run build`：TypeScript 检查和 Vite 构建通过。
- `git diff --check`：通过。
- 公网 `/console/`：HTTP 200，入口指向 `index-D1kDYNI7.js`。
- 公网 `/api/v1/status`：HTTP 200，`running=false`、`mode=paper`、`live_unlocked=false`、`strategy_id=null`。
- 最新 bundle 不再包含 `overview-markets`、旧独立导航选择器或市场/订单导航入口。

浏览器自动化本轮因 Codex 浏览器连接返回 `unsupported Codex auth method: apikey` 未完成；源码测试和公网 HTTP/bundle 核验已完成。
