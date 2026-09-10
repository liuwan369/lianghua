# 都柏林 CPU 优化与诊断（2026-09-10）

核对时间：2026-09-10。增量盘口、账本空闲跳过和历史分析资源隔离已部署到现有都柏林服务器；没有新增付费实例。以下为短时实测，不代表长期吞吐或实盘验收。

## 当前实现

- 控制台后台持有最近 180 秒已解码盘口，普通追加只应用新事件；窗口内压缩块仍需读取并比较，修订/晚到/删除纠正回放，日切与异常清空后重建。HTTP 不触发解压，后台不再每轮启动 Python，systemctl 活性最多每 10 秒检查一次。
- 原子发布 `data/dashboard/market-snapshot.json`；开发预览 SSH 只读取该文件。源快照超过 15 秒失效，报价保留真实源时间，无效价格变更不能刷新旧报价。
- 账本已追平且无错误的日志未变时跳过摄取事务；摘要和大快照只在数据或选择变化时生成。每秒独立 heartbeat 绑定运行与快照版本，保持 3 秒 stale 判断；仍有轻量历史轮询 SQL。
- 历史分析移入同机 `pm-analysis.slice`：CPUQuota 20%（最多 0.2 核）、CPUWeight/IOWeight 10、Nice 19、idle I/O、MemoryHigh 384 MiB、MemoryMax 512 MiB。线上采集和控制台不在该 slice。分析仍每小时扫描最近 24 小时，尚未改成增量历史统计；限额可能延长报告完成时间。报告使用临时文件原子替换，不阻塞在线行情接口。

## 部署前后实测

对照窗口均包含采集、控制台与运行中的分析任务，没有启动 paper/live。通过 `/proc/stat` 和服务 cgroup `cpu.stat` 取差值；行情流量与宿主机 steal 有波动，并非固定流量实验。

| 指标 | 优化前 20.073 秒 | 最终版本 20.801 秒 |
|---|---:|---:|
| 控制台 CPU 用时 | 12.6823 秒 | 3.7585 秒 |
| 历史分析 CPU 用时 | 9.8970 秒 | 4.0378 秒 |
| 采集器 CPU 用时 | 10.0101 秒 | 16.1688 秒 |
| CPU steal | 79.13% | 67.21% |
| CPU idle | 0.91% | 14.75% |
| iowait | 0.00% | 0.07% |
| 样本末采集队列 | 84 | 0 |
| 最新采集事件年龄 | 3.04 秒 | 3.25 秒 |
| HTTP 行情缓存年龄 | 1.93 秒 | 0.96 秒 |

按墙钟归一后，控制台 CPU 用时在这两个样本间降低约 71%；不能解释成整机性能永久提升 71%。采集器处理真实证据，其使用量不能全部视作浪费。cgroup CPU 计数与虚拟机 steal 的统计口径不同，不据其求和倒推可用核心数。

分析父 slice 实际 `cpu.max=20000 100000`，已有 throttled 计数，表明限额生效；子服务自己的 throttle=0 不表示父层未限额。I/O 权重和 idle 调度的实际效果受设备调度器影响。

账户只读检查从优化前 **46.33 秒 / HTTP 504** 变为 **23.817 秒 / HTTP 200、ok=true**。检查与分析并行时，控制台 cgroup 在 20.478 秒窗口消耗 14.3064 秒 CPU，说明 Node SDK 冷启动仍是明显开销。单次成功不能代替 p95 或满负载稳定性。

证据：[优化前](evidence/2026-09-10/cpu-before.json)、[初次部署样本](evidence/2026-09-10/cpu-after-initial.json)、[最终常规样本](evidence/2026-09-10/cpu-after.json)、[账户检查并发样本](evidence/2026-09-10/cpu-after-account-load.json)、[账户前](evidence/2026-09-10/cpu-account-before.json)、[账户后](evidence/2026-09-10/cpu-account-after.json)、[部署哈希与资源限制](evidence/2026-09-10/cpu-release-check.json)、[远端小快照读取](evidence/2026-09-10/cpu-remote-snapshot-check.json)。

## 验证与边界

Python 243 passed / 1 skipped，独立代码审查通过。回归覆盖同秒块 UPDATE、日切/数据库替换、空侧/旧报价、坏数据连续失败后恢复、无效 delta 不续鲜、空闲账本跳过及心跳失效。采集器未重启，账户文件哈希未变，交易未运行且实盘锁关闭。六页设计未修改。

最终公网 31 次采样全部在线，跨过一次五分钟市场切换，两侧报价均存在；最大缓存年龄不超过 1.271 秒，六个页面/状态接口均为 HTTP 200。采样包含行情、队列、源报价时间与投影计数，见 [最终接口验收](evidence/2026-09-10/cpu-public-final-acceptance.json)。部署期间的初次采样另存 [初次记录](evidence/2026-09-10/cpu-public-acceptance.json)，其中两次异常（一次 HTTP 错误、一次离线）发生在最终 dashboard 重启附近，不作为稳态通过样本。

## 仍需处理

实例为 eu-west-1 的 t3.small（2 vCPU、约 2 GB RAM），高 steal 仍存在。CloudWatch 积分查询返回 AccessDenied、EC2 credit mode 查询返回 UnauthorizedOperation，CPU 积分是否耗尽、standard/unlimited 模式尚未核实。同机隔离不能消除宿主机等待；没有改动 IAM 或计费配置。

后续容量工作包括减少账户 SDK 冷启动、历史分析增量化、长时间并发/纸面运行测试和完整事件对账。确认云端积分与稳定负载数据后再评估是否需要独立分析节点或增加算力。本次优化不代表真实下单、撤单、资金对账或策略盈利已验收。
