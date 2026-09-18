# 开发与构建

要求 Python 3.11+、Node.js 24+。仓库包含 Python 控制台后台、TypeScript 交易引擎和 Vite 前端，当前不是 npm workspace。

## 代码目录

| 目录 | 当前用途 |
| --- | --- |
| `_external/btc-5m-market-trading-bot/src/platform/` | 订单、账户、恢复、结算和真实适配器 |
| `_external/btc-5m-market-trading-bot/src/live/feeds/` | Market/User WebSocket 与市场发现 |
| `_external/btc-5m-market-trading-bot/src/strategies/btc-reversal.ts` | 唯一生产策略 |
| `_external/btc-5m-market-trading-bot/src/cli/platform.ts` | 生产运行入口 |
| `scripts/dashboard/` | 配置、账本投影、账户数据和系统指标 |
| `scripts/system-dashboard-server.py` | 控制台 HTTP 服务和进程控制 |
| `web/src/` | 当前六个页面及 API 客户端 |
| `docs/evidence/` | 脱敏验收证据 |
| `docs/research/` | 原始研究资料，不进入生产热路径 |

服务器仍从 `/root/pm-system` 使用相同相对目录运行。不要在文档或部署脚本中假设引擎已迁出 `_external`。

## 安装与构建

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install pytest requests websocket-client
npm --prefix _external/btc-5m-market-trading-bot ci
npm --prefix _external/btc-5m-market-trading-bot run build
npm --prefix web ci
npm --prefix web run build
```

Linux 虚拟环境使用 `.venv/bin/python`。前端构建写入 `docs/console/`，引擎构建写入自身 `dist/`。新增或重命名模块后要检查旧构建产物；TypeScript 编译不会自动删除废弃文件。

## 本地控制台

```powershell
python scripts/system-dashboard-server.py --host 127.0.0.1 --port 8765 --root .
```

访问 `http://127.0.0.1:8765/console/`。前端热更新使用 `npm --prefix web run dev`。本机状态、账户和行情来源不是服务器状态，不能据此更新线上完成项。

## 生产实现规则

- 行情事件直接由 WebSocket 驱动策略；不要在触发链路加入 REST 查询、固定采样、debounce、轮询等待或页面刷新依赖。
- 一个 Market WS 消息的关联 token 必须批量更新后再判断策略。
- 同一订单状态变换串行，不同订单的网络提交可并行；共享锁不得覆盖 HTTP ACK 等待。
- 发单前关键身份、阶段和预留必须耐久保存；普通日志、账户历史和系统指标走后台慢路径。
- 新策略通过 `StrategyPlugin` 接口接入，并拥有独立配置 schema；不得直接导入 CLOB client 或修改核心账本。
- 未知值保持 `null`，前端显示未知；不能为了页面完整而填零或模拟延迟。
- 生产删除先核对静态引用、systemd、部署脚本、运行状态文件和回退清单。研究脚本存在不代表生产依赖，目录名称也不能证明可以直接删除。

## 修改流程

1. 读取 `CURRENT-STATUS.md`、交付规划、Git 状态和相关测试。
2. 明确文件所有权，保留用户与其他 Agent 的未提交修改。
3. 先写或调整能证明行为的测试，再做最小实现。
4. 运行受影响模块测试、类型检查和构建；共享边界变化再跑统一验证。
5. 独立复核并修复后，更新状态与任务树。
6. 按本地源码、Git 提交、服务器发布包三段同步。
7. 只读核对公网 API、页面、进程和发布 hash。

不得把自动测试、部署成功或页面 HTTP 200 写成真实成交验收。详细完成口径见 [TESTING](TESTING.md)。
