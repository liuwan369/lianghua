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

服务器工作目录：`/root/pm-system`。

当前服务器基线：`codex/clean-baseline-20260922`。模块完成后由集成会话在服务器拉取 `codex/integration`，验证通过再决定是否更新生产分支。服务器不保存 GitHub 密钥、账户密码或前端秘密；交易账户继续使用服务器自己的环境配置。

```bash
cd /root/pm-system
git fetch origin
git switch codex/integration
git pull --ff-only origin codex/integration
```
