# Polymarket 五分钟反转系统

这是 Polymarket BTC 五分钟反转系统的唯一源码目录。运行时保持一个后端进程和一个静态前端，避免重复副本和无必要的服务拆分。

## 目录

- `frontend/console/`：独立设计前端，五个页面和共享数据层都在这里。
- `backend/engine/`：成熟交易引擎基线，包含行情 feed、盘口、账户、订单、平台恢复和 BTC 反转策略。
- `scripts/`：控制台后端、账本投影、系统指标和部署脚本。
- `config/`：服务器服务和反向代理配置。
- `shared/contracts/`：前后端接口和数据模型。

## 本地查看前端

```powershell
cd C:\Users\Administrator\Desktop\polymarket\frontend\console
python -m http.server 5175
```

打开 `http://127.0.0.1:5175/overview.html`。

## 架构

完整的技术架构、热路径、风控、部署和路线图见 [ARCHITECTURE.md](ARCHITECTURE.md)。所有 AI 开工前先读它。

## 运行与部署

真实交易状态只来自服务器；账户配置由服务器环境和账户配置文件提供，不进入浏览器或源码。部署脚本位于 `scripts/deploy-reversal-release.py`，服务配置位于 `config/`。

GitHub：<https://github.com/liuwan369/lianghua>。服务器工作目录是 `/root/pm-system`。
