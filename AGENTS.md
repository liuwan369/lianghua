# 工作规则

本仓库是 Polymarket 五分钟反转实盘系统，真钱。接手先读 [HANDOFF.md](HANDOFF.md)（当前状态和下一步），再读 [README.md](README.md) 和 [ARCHITECTURE.md](ARCHITECTURE.md)，接口看 [API.md](API.md)，已确认的策略规则在 [STRATEGY.md](STRATEGY.md)。

## 铁律

- 禁止过度工程化、过早抽象：先写具体可用的代码，不为假想需求留扩展点。
- 禁止流程主义、审计驱动开发：不拿报告、清单、评审文档代替改代码。
- 禁止用安全门槛替代交付：拦住不显示不是修复，要交付能用的行为。
- 分轻重缓急：先修会亏钱、会漏单、会卡交易的问题。
- 热路径用最快的实现；动手前查业界做法对照。
- 对话用中文，简洁明了，可以幽默。
- 系统只有一份：新的替换旧的，旧代码、旧兼容分支、旧脚本、旧文档在同一个或紧接着的提交里删干净，不留"备用"。
- 服务器上的运行数据（journal、账本、状态文件、结算记录、发布备份）删了回不来：先列清单和影响，用户同意后再删。
- 小额实盘验证必须用户明确同意后才跑。
- 秘密（私钥、API 凭证、控制密码、basic auth 口令）不进源码、日志、文档、浏览器，也不在对话里打印。
- 修 bug 先写测试：测试在旧代码上失败，修好后通过。
- 改了架构或接口，同步更新 ARCHITECTURE.md / API.md。

## 怎么干活

- 构建：`cd backend/engine && npm run typecheck && npm run build`
- 测试：`node backend/engine/scripts/regress/*.mjs`（先 build）、`node backend/engine/scripts/check-*.mjs`、`python scripts/regress/*.py`、`node frontend/console/regress/*.mjs`。逐个运行，退出码 0 即通过。
- 部署：提交后 `python scripts/deploy-reversal-release.py`，部署的是 HEAD，交易必须已停止。
- 服务器：`ssh -i ~/.ssh/id_ed25519_dublin_pm root@18.201.16.51`，运行目录 `/root/pm-system`；控制面只在服务器本机可直连，如 `curl -s http://127.0.0.1:18766/api/runtime/status`。
- 去哪看：策略 `backend/engine/src/strategies/btc-reversal.ts`；下单与风控 `backend/engine/src/platform/core.ts`、`platform/polymarket.ts`、`live/clob/client.ts`；入口 `backend/engine/src/cli/platform.ts`；控制面 `scripts/system-dashboard-server.py`；账本 `scripts/dashboard/ledger.py`；前端 `frontend/console/`。
