# 转入 BTC 五分钟反转前的系统备份

日期：2026-09-17，北京时间。状态：本地及服务器归档完成，清单、哈希与读取校验通过。没有执行覆盖生产的还原操作。

## 备份基线

源码HEAD：`78c9d9fdbda9a53c9ced46d5e8363ff1d45d4436`。工作区含用户及其他任务未提交内容，本地归档保留这些内容，没有先清理或重置Git。

交易在备份前后均为 `running=false`、`mode=paper`、`live_unlocked=false`。本轮没有新增真实订单。备份后只整理当前文档与任务树，不代表反转代码已经部署。

## 本地备份

目录：`D:\360MoveData\Users\Administrator\Documents\pm-system-backups\pre-reversal-20260917-021053`。

| 项目 | 结果 |
| --- | --- |
| 主文件 | `workspace.tar` |
| 大小 | 13,084,895,232字节，约12.19GiB |
| SHA256 | `65dc0356ecf3eb52a893d8fe71c5c816a1cdeb8cf09981dc2b1e5a4f0ed6e3c5` |
| 完成时间 | 02:12:39（内容写入02:11:18完成） |
| 范围 | 项目源码、.git、未提交/未跟踪文件、data、exports、已有构建产物 |
| 排除目录名 | node_modules、.deploy、__pycache__、.pytest_cache |
| 排除原因 | 可重装依赖、缓存、旧发布工作文件；当前服务器部署内容另有完整包 |
| 权限 | 本机当前用户及SYSTEM访问，不在仓库或公网目录 |

另存桌面策略目录完整11文件到 `strategy-source/`，逐文件SHA写入 `manifest.json`。独立复核确认这11个副本与当时桌面文件一致：06摘要为`eb46c9e03bb78cf5d5b1aa520a066f30b5f8579a759ee881ce890c6850ac686f`，09为`ea92779c770ecc0d686d893907e65235e6de6fe47b885e3fa7c5501e86001159`。

附带 `git-status-before.txt`、`archive-members.txt`、`manifest.json`。已从归档提取`.git/HEAD`、旧Agent规则、旧任务树、core.ts和前端锁文件至`restore-check/`，确认可读且保留改造前内容；未声称整机或所有数据库还原演练已完成。

## 服务器备份

目录：`/root/.pm-releases/pre-reversal-20260917-20260916T181416Z-381161`。

| 文件 | 大小 | SHA256 |
| --- | ---: | --- |
| `pm-system-complete.tar.zst` | 11,326,797,481字节 | `5fa2b79e13f0e2804267d60ee61ba2173d166206e3fb82988397cbd015eafb60` |
| `nginx-tls-complete.tar.zst` | 9,382字节 | `2cdf9665bf3fc3db53133c00bfd3c5386619449c6b59aafd2e3a8697ee33df39` |

主包无排除，包含完整`/root/pm-system`、真实运行数据、依赖、构建、`/root/.config/pm-system`、相关systemd单位/drop-in/启用链接及`/etc/nginx`。共27,138个成员，包含14个数据库文件和9个WAL文件。完整HTTPS证书目录`/etc/letsencrypt`保存在TLS补充包，含live链接、archive实体和renewal配置。

02:14:16开始，02:18:37完成主包内容冻结，02:23:11完成主包校验，02:23:46完成TLS补充包校验。服务器写服务与相关计时器在归档期间暂时停止，检查无项目可写文件描述符后打包；内容冻结后立即恢复服务，再校验归档。

两包均通过`zstd --test`和完整tar目录读取，SHA256已计算，所有纳入根路径存在。目录0700，归档和manifest均0600、root所有。账户凭据及TLS私钥仅留私有备份，不写入Git或文档。

恢复结果：dashboard、collector、account-baseline.timer、daily-restart.timer与原状态相同，均active；两个相关oneshot仍inactive；`restore_errors=[]`；公网`/console/`返回HTTP200。剩余磁盘约15GiB，不在当前根盘另解出20GiB全量副本。

服务器完整包目前留在该服务器；本地项目包不等于服务器完整包的异地副本。整机丢失风险需要另将服务器私有包复制到可信独立存储，不能声称本次已经完成异地灾备。

## 如何恢复

优先按发布清单回退程序和配置；新成交后的订单、持仓、余额状态不被旧快照覆盖。恢复旧代码不自动启动旧做市。

需要查看完整快照时，在足够空间的独立目录或新磁盘解包，先核对SHA。服务器全量恢复建议使用额外至少40GiB可用空间；保留归档的原始文件权限。以下仅为准备副本的命令，不会直接覆盖生产：

```powershell
# 先建立一个新的空目录，再提取本地副本。
tar.exe -xf 'D:\360MoveData\Users\Administrator\Documents\pm-system-backups\pre-reversal-20260917-021053\workspace.tar' -C 'D:\pm-restore-review'
```

```bash
# /mnt/pm-restore 必须是新建空目录且位于足够大的独立磁盘。
tar --use-compress-program=zstd -xpf /root/.pm-releases/pre-reversal-20260917-20260916T181416Z-381161/pm-system-complete.tar.zst -C /mnt/pm-restore
tar --use-compress-program=zstd -xpf /root/.pm-releases/pre-reversal-20260917-20260916T181416Z-381161/nginx-tls-complete.tar.zst -C /mnt/pm-restore
```

独立副本确认后，再有选择地恢复程序、账户配置、服务和证书；先核对真实订单/持仓及数据版本，再决定是否恢复运行。不能直接把全包解到`/`，也不能把备份时的余额当作当前余额。

## 本轮验证范围

三个Agent完成规格、平台、前端评估；第四个独立复核Agent检查备份脚本和规划，发现并补齐TLS遗漏。底座6个既有测试文件共60项通过；任务树使用前端真实校验器验证。未执行新策略测试、真实新交易、完整系统还原或盈利验证。
