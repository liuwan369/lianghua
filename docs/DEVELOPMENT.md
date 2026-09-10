# 开发与构建

Python 要求 3.11+，交易引擎要求 Node.js 24+。源码分为 Python 控制台/采集分析、TypeScript 引擎和 Vite 六页前端；不是一个 npm workspace。

## 依赖与构建

从仓库根目录执行：

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install pytest requests websocket-client
npm --prefix _external/btc-5m-market-trading-bot ci
npm --prefix _external/btc-5m-market-trading-bot run build
npm --prefix web ci
npm --prefix web run build
```

Linux 使用 `.venv/bin/python`。`pyproject.toml` 的核心依赖列表为空；采集和研究脚本需要 `requests`、`websocket-client`，测试使用 pytest。引擎依赖由其 package-lock 固定。

前端构建写入 `docs/console/`，引擎构建写入自身 `dist/`，二者由源码生成且不提交仓库。新增/重命名模块后应清理对应旧构建产物，TypeScript 编译不会删除旧文件。

## 开发入口

```powershell
python scripts/system-dashboard-server.py --host 127.0.0.1 --port 8765 --root .
```

访问本机 `/console/` 验证开发构建；正式入口始终为 [都柏林控制台](https://34-242-206-196.sslip.io/console/)。本机控制状态和账户文件属于本机，不能用它们代替服务器状态；市场数据来源由 PM 环境配置决定。

原六页结构来自 `web/src/approved-layout.html`，业务映射在 `live-data.ts`，设置与账户交互在 `forms.ts`，请求契约在 `api/`。不得通过删除原设计模块来规避尚未接通的功能。

策略决策、风险、执行、行情、日志模块位于引擎 `src/`。Python `pm_maker/` 和历史研究脚本服务于模型分析/影子回放，不代替 TypeScript 实盘执行器。

测试命令和验收边界见 [TESTING](TESTING.md)，发布步骤见 [DEPLOYMENT](DEPLOYMENT.md)。
