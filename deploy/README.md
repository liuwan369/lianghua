# 部署格式

当前先保持一个项目、一个后端运行进程，按目录加载模块；前端可以独立静态部署。

## 本地

```powershell
cd C:\Users\Administrator\Desktop\polymarket\frontend\console
python -m http.server 5175
```

后端沿用 `backend/control-plane/scripts` 和 `backend/engine` 现有启动方式，具体命令以对应模块的 `package.json` 和脚本为准。

## 服务器

- `frontend/console` 构建后的静态文件由 Web 服务托管。
- API 和交易引擎先同机运行，使用环境变量连接行情和账户配置。
- 只有端到端链路稳定后，才考虑拆进程；拆进程不是当前交付条件。
