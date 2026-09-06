# 云仓库备份规则

远程仓库：`https://github.com/liuwan369/lianghua`

仓库只保存可回滚的源码、配置模板、测试和中文文档。以下内容不上传：

- 钱包私钥、API 密钥、服务器密码和 SSH 私钥；
- `node_modules`、Python 虚拟环境和运行日志；
- SQLite 原始采集库、行情压缩包和实验输出。

这些数据继续留在服务器和本机，代码版本通过 Git 回滚。

常用操作：

```powershell
git status
git log --oneline --decorate -10
git tag -a v0.x -m "说明"
git push origin master --tags
```

回滚前先停止交易进程，再执行：

```powershell
git switch --detach <commit>
```

恢复到最新版本：

```powershell
git switch master
git pull --ff-only
```

推送前必须检查 `git diff --cached`，确认没有 `.env`、密钥、密码、原始数据库或运行结果。
