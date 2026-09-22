# Polymarket 五分钟反转系统

这是从当前纯净源码整理出的独立研发目录。目标是把前端、行情、策略执行、账本/API 分开研发，同时保持最后可以直接接起来。

## 目录

- `frontend/console/`：独立设计前端，五个页面和共享数据层都在这里。
- `backend/engine/`：成熟交易引擎基线，包含行情 feed、盘口、账户、订单、平台恢复和 BTC 反转策略。
- `backend/control-plane/`：控制台后端、账本投影、系统指标、配置和部署配置。
- `backend/reference/web/`：原控制台前端源码，仅作为成熟功能参考，不与新设计前端混改。
- `shared/contracts/`：前后端接口和数据模型。
- `docs/`：研发分支和最终集成说明。
- `deploy/`：本地和服务器部署约定。

## 本地查看前端

```powershell
cd C:\Users\Administrator\Desktop\polymarket\frontend\console
python -m http.server 5175
```

打开 `http://127.0.0.1:5175/overview.html`。

## 研发原则

每个分支只改自己的目录；接口先用 `shared/contracts` 中的现有模型；先复用 `backend/engine` 已经验证过的链路，不为了拆分而重写。具体分工和验收见 [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md)。

GitHub：<https://github.com/liuwan369/lianghua>。本地 `main` 当前对应干净基线分支 `codex/clean-baseline-20260922`；模块分支和集成分支都在同一个远程仓库。服务器工作目录是 `/root/pm-system`。
