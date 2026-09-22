# 分支与会话分工

每个会话只负责一个分支和对应目录。不要跨分支顺手重构，也不要为了证明过程写额外报告。发现接口不一致时，先在 `shared/contracts` 记录最小字段，再继续交付。

## `codex/frontend-console`

负责：`frontend/console/`

- 保持深海渐变、圆润交易终端布局。
- 接入 Store/Adapter，页面不直接访问后端细节。
- 保证总览、市场、自动交易、策略、设置五个入口可加载。

验收：五页无脚本错误；启用币种、策略阶段、启动按钮等交互可用；数据分片更新不整页闪烁；接口断开时保留上次数据并显示待接入状态。

## `codex/market-data`

负责：`backend/engine/src/live/feeds/`、`backend/engine/src/live/discovery.ts`、`backend/engine/src/live/orderbook.ts`。

- 复用现有 Polymarket WebSocket 和市场发现逻辑。
- 输出统一 `assetId / marketId / roundId / YES / NO / sequence / sourceAt / expiresAt`。
- 过期行情不能继续触发策略。

验收：断线可恢复；旧消息不会覆盖新消息；五分钟场次切换可识别；能给策略和前端提供同一份市场快照。

## `codex/trading-runtime`

负责：`backend/engine/src/strategies/`、`backend/engine/src/platform/`、`backend/engine/src/live/clob/`。

- 保持单一 BTC 五分钟反转策略。
- 复用现有资金预留、订单幂等、撤单、恢复和结算逻辑。
- 启动、暂停新增、停止命令必须返回最终状态事件。

验收：策略能从行情生成正确阶段指令；同一经济订单不重复提交；停止会处理未完成订单；重启后能恢复运行状态；既有引擎测试和类型检查通过。

## `codex/ledger-api`

负责：`backend/control-plane/scripts/`、账本投影、统计、运行日志和 API DTO。

- 将订单、成交、持仓、结算转换成前端需要的只读数据。
- 总览统计、系统资源、运行日志分别提供，不把高频行情和慢数据绑在一起。
- 账户秘密只由服务器配置管理。

验收：能查询当前持仓、订单、盈亏、胜率、服务状态和运行事件；旧接口回退仍可用；字段与 `shared/contracts` 一致；错误时保留最后成功快照。

## `codex/integration`

负责：跨模块接线、部署和最终验证。这个分支不创造新的业务逻辑，只解决接口、启动顺序、配置和端到端问题。

验收顺序：行情进入 → 策略判断 → 订单执行 → 成交/结算 → 账本统计 → API → 前端显示。完成后再合并到 `main`。

## 分支规则

- `main` 只放可运行基线。
- 每个模块完成后先在自己的分支验证，再合并到 `codex/integration`。
- 集成通过后才合并 `main`；不要求每个模块都拆成独立部署服务。
- 当前先按目录分工，部署初期可以仍然使用一个后端进程，避免过早微服务化。
