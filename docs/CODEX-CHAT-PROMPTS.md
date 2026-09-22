# Codex 左侧会话首条消息

在 Codex 左侧选择项目 `C:\Users\Administrator\Desktop\polymarket`，点击“新对话”，分别建立下列会话。所有会话属于同一个主项目，代码隔离目录位于项目内部 `.worktrees`。这些不是新项目，完成后合并回主目录。

## 共同首段

你正在开发 Polymarket BTC 五分钟反转系统。主项目是 `C:\Users\Administrator\Desktop\polymarket`。请先读本会话 worktree 的 `话术.txt`、`AGENTS.md`、`docs/SESSION-RULES.md`、`docs/WORKSTREAMS.md`。交付优先，禁止过度工程化、流程主义、审计驱动开发、过早抽象，不用历史数据、纸面验证或安全门槛替代交付；优先复用成熟源码，实时链路与低频统计分开，回答简洁。只修改本会话负责目录，不覆盖其他分支，不把秘密放进代码或前端。完成后提交本分支并报告修改、验证和真实风险。

## 前端

会话标题：前端控制台。

工作目录：`C:\Users\Administrator\Desktop\polymarket\.worktrees\frontend-console`；分支 `codex/frontend-console`；只改 `frontend/console/`。

任务：保持深海视觉，推进五页对接：总览、市场、自动交易、策略、设置。检查局部 Store 更新、重复请求、整页闪烁、断线/stale、marketId+roundId 隔离和统一 DTO。不要重写样式，不把演示数据当真实交易。

验收：五页无脚本错误，启停币种和策略保存流程明确；高频行情不带动慢数据重绘；错误保留最后成功数据；接口与共享契约一致。

## 行情

会话标题：行情采集。

工作目录：`C:\Users\Administrator\Desktop\polymarket\.worktrees\market-data`；分支 `codex/market-data`；只改 `backend/engine/src/live/feeds/`、`backend/engine/src/live/discovery.ts`、`backend/engine/src/live/orderbook.ts`。

任务：复用 Polymarket WebSocket、市场发现和盘口实现，输出统一市场、场次、YES/NO、sequence 和时间戳。优化实时链路，独立处理断线和过期数据。

验收：旧消息不覆盖新消息，断线能恢复，场次切换正确，同一市场快照供策略与前端消费；过期行情不触发交易。

## 交易运行

会话标题：反转策略与交易执行。

工作目录：`C:\Users\Administrator\Desktop\polymarket\.worktrees\trading-runtime`；分支 `codex/trading-runtime`；只改 `backend/engine/src/strategies/`、`backend/engine/src/platform/`、`backend/engine/src/live/clob/`。

任务：保持单一 BTC 五分钟反转策略，复用资金预留、订单幂等、撤单、恢复和结算。检查阶段判断、同方向重复买入、启动/暂停/停止、超时和重试；实时下单不得等待历史统计。

验收：阶段指令正确，同一经济订单不重复提交，停止处理未完成订单，重启可恢复；相关测试、类型检查通过。

## 账本 API

会话标题：账本统计与 API。

工作目录：`C:\Users\Administrator\Desktop\polymarket\.worktrees\ledger-api`；分支 `codex/ledger-api`；只改 `backend/control-plane/scripts/` 和 `shared/contracts/`。

任务：整理当前持仓、订单、成交、结算、盈亏、胜率、服务状态和运行事件 API。慢数据和实时行情分开；保持 DTO 与前端一致，账户只读。

验收：数据有来源、时间和错误状态；统计不阻塞交易；旧接口可兼容；无私钥、密码回显或前端保存。

## 集成

会话标题：系统集成与服务器部署。

工作目录：`C:\Users\Administrator\Desktop\polymarket\.worktrees\integration`；分支 `codex/integration`。

任务：等待模块完成后合并并接线，不重写模块。按“行情 → 策略 → 下单 → 成交/结算 → 账本 → API → 前端”验证。部署只在服务器 `/root/pm-system` 进行，GitHub 使用同一个 `liuwan369/lianghua` 仓库的对应分支。

验收：统一 marketId+roundId、请求幂等、断线恢复、局部刷新、完整运行状态和端到端链路通过；通过后合并回主项目 `main`。
