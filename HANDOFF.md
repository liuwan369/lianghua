# 交接（2026-10-13）

接手先读这份，再读 [AGENTS.md](AGENTS.md)（铁律）、[README.md](README.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[API.md](API.md)、[STRATEGY.md](STRATEGY.md)、[REVERSAL.md](REVERSAL.md)。

## 1. 这是什么

Polymarket 加密货币 5 分钟涨跌市场的**反转策略实盘系统，真钱**。用户是操盘人，用中文沟通，懂交易、不写代码，会逐条追问逻辑，经常指出我们算错的地方（而且多数时候他是对的）。

## 2. 铁律（AGENTS.md 原文要点，必须遵守）

- 不过度工程化、不过早抽象；不拿报告/清单代替改代码；不用"拦住不显示"代替修复。
- 先修会亏钱、漏单、卡交易的问题。
- **对话一律用中文**，简洁，可以幽默。用户多次要求"说中文"——回复里不要夹英文段落。
- 系统只有一份：新的替换旧的，旧代码/旧文档同一提交删干净。
- **服务器运行数据（journal、账本、状态、结算记录、发布备份、录制行情）删前先列清单和影响，用户同意再删。**
- **小额实盘必须用户明确同意才跑。**
- 秘密（私钥、API 凭证、控制密码、basic auth 口令）不进源码、日志、文档，不在对话里打印。
- 修 bug 先写测试（旧代码上失败、修好后通过）；改架构/接口同步 ARCHITECTURE.md / API.md。
- 用户的工作方式：每个结论都要**拿真实数据说话**，并且**换一段没参与挑选的数据再验证**（以前多次出现"换一天就不灵"）。规则要**逐条和用户确认**后才写进 STRATEGY.md。

## 3. 服务器与操作

- SSH：`ssh -i ~/.ssh/id_ed25519_dublin_pm root@18.201.16.51`，目录 `/root/pm-system`（Lightsail 4 核 16G，Ubuntu 22.04，2026-10-10 从旧机 34.242.206.196 整套迁来，数据全带）。旧机保留不动、引擎停着、不再部署；两台共用一个钱包，**只能在新机启动交易**。
- 控制面只在服务器本机：`curl -s -H "X-PM-Authenticated: probe" http://127.0.0.1:18766/api/...`（GET 只读）。公网是 `https://18-201-16-51.sslip.io`，nginx basic auth。
- 服务：`pm-system-dashboard-dublin`（控制面，内存上限 900M）、`pm-clob-market-snapshot`（行情采集 + 录制，7 个币）、nginx。引擎由控制面按需启动在独立 scope `pm-engine-<run_id>`。
- 构建/测试/部署见 AGENTS.md。部署：`python scripts/deploy-reversal-release.py`（部署已提交的 HEAD，交易必须停着）。
- 推送：`git push origin main`；连不上时用 `git -c http.proxy=socks5h://127.0.0.1:10808 push -q origin main`。
- 从服务器命令行启动实盘：见记忆 `live-run-start-from-shell`（需要 UUID requestId、当前 marketIds、走 nginx 认证；**必须先得到用户同意**）。
- 在服务器上跑脚本：写成本地文件 `scp` 过去再执行，跑完删掉。长任务用 `setsid nohup ... &`，**不要用 `pkill -f <名字>`**（会连 ssh 自己一起杀掉）。大文件要**流式**读，别把一天 ~86 万行全放内存（曾把控制面 OOM 掉）。

### 换服务器（2026-10-14 备份好，随时可搬）

本机备份 `C:\Users\Administrator\Desktop\pm-backup-20261014\`（不进 git）：
- `pm-run-data.tgz`（55MB）：`backend/engine/results`（账本、结算记录、实盘状态、策略配置、journal）+ `data/dashboard`。**结算记录和实盘状态里可能有未完成的赎回，不能丢。**
- `pm-secrets.tgz`（10KB，含私钥等秘密，别外传）：`/root/.config/pm-system`（钱包、控制密码）、nginx basic auth、systemd drop-in（`PM_TRADING_LIVE_UNLOCK=1` 等）、`/etc/letsencrypt`。
- `market-history.tar`（2.4G）：行情录制，回测要用。

步骤（新机 Ubuntu 22.04，root，先确认**旧机交易已停**，两台共用一个钱包）：
1. 装 Node 24、Python 3.10、nginx、certbot。
2. 改 IP/域名，共 4 个文件：`scripts/deploy-reversal-release.py`（两处 `client.connect`）、`scripts/system-dashboard-server.py`（`PM_REMOTE_HOST` 默认值）、`config/pm-system-dashboard-dublin-public.conf`（server_name、证书路径、跳转）、`config/pm-system-dashboard-dublin-public-account.conf`（`PM_ACCOUNT_PUBLIC_ORIGIN`）。sslip 域名就是 IP 把点换成横线。提交。
3. 新机放 SSH 公钥 `~/.ssh/id_ed25519_dublin_pm.pub`。
4. 解开 `pm-secrets.tgz` 到 `/`；解开 `pm-run-data.tgz` 和 `market-history.tar` 到 `/root/pm-system/`。
5. 证书：`certbot certonly --nginx -d <新域名>`（旧证书只认旧域名；80 端口要对所有人开放）。
6. 本机跑 `python scripts/deploy-reversal-release.py`：它装 systemd 单元和 nginx 配置、启动采集器和控制面。
7. 验证：`systemctl is-active pm-system-dashboard-dublin pm-clob-market-snapshot nginx`，控制台能打开，"设置"页账户检查通过，`/api/strategy/config` 是 revision 23。之后再由用户在控制台启动。

## 4. 当前状态

- **eth 60 秒实盘实验**（用户 2026-10-13 同意）：配置 revision 23：eth、起始秒 60、阶梯 5/13/60、单场 60、总资金 60、每日亏损 45 USDC。目的：真钱验证 eth 60 秒，并量实际成交比回测差多少。
  - 第一次 run `20261013-045948-9cbed255b537`（我从服务器命令行启动，北京 12:59–15:40）：33 场，下单 4 场，每档都买满，没到第 3 档；4 场官方结算合计 +2.77（+0.42、+0.44、+0.41、+1.50）。用户要求停掉，**改由用户在控制台手动启动**，顺便检查前端。
  - 这次 run 2.7 小时 journal 217MB（约 1.9GB/天）：92% 是每 2 秒一行的 platform_status，其中一大半是已结束场次的盘口。`625a67e` 只带未结束场次的盘口，降到约 1.3GB/天；85% 的 status 行和上一行一样，要再降就得改成"变了才写"（未做）。硬盘 304G 空闲，journal 只留最近 20 个 run。账本投影读得过来（每秒 3.7MB，写入只有 22KB/s）；`ledger_projection_incomplete` 是读到 journal 末尾前的正常状态，停止后已追平。
- 部署版本 `7ec5fdd`；本地和 GitHub 已到 `0a47d3c`（账本：搬机复制的 journal 不再误判为改写，10-02 那次 run 让统计一直显示"待核对"），**交易在跑没部署**，下次停下来时部署。
- 用户 2026-10-13 21:18 起在控制台手动跑 run `20261013-131839-77a945cc132d`（同一份 revision 23）。
- **策略重新开始测**（2026-10-13）：反转统计页和 `STRATEGY-RESEARCH.md` 已删，以前的统计数字作废。回测只用 `scripts/backtest.py`（口径见 STRATEGY.md 文末，测试 `scripts/regress/backtest.py`）。
- 行情录制：`data/market-history/<币>/<北京日期>.jsonl.gz`，7 个币，**保留 30 天**（每 10 天约 2.2G，硬盘 310G）。行格式：
  - 盘口（无 k）：`ub/ua/db/da` 最优买卖价，`ubl/ual/dbl/dal` 前五档，`ue/de` 两边交易所时间。
  - `k:"o"`：一边没卖单的盘口，**2026-10-05 05:50 UTC（1791143400）起**才有；之前每场最后约 50 秒没录盘口，回测不用。
  - `k:"t"`：成交（10-04 起）。`k:"p"`：币安 1 秒 K 线（10-07 起）。`k:"c"`：Chainlink 价（Polymarket RTDS，10-07 起）。
  - 2026-10-07 的日文件中间有 3 段坏 gzip，`scripts/backtest.py` 的 `read_lines` 会跳过继续读；`gzip.open`/`zcat` 读到那里就停。
- 谁赢：收盘前最后一帧盘口 ≥ 0.9 的一边（抽查 82 场全对）。官方按 Chainlink **60 秒均价**结算，收盘点值对比开盘点值约一成判错，不能用。官方结果：`https://gamma-api.polymarket.com/events?slug=<币>-updown-5m-<场次>` 的 `outcomePrices`。

## 5. 已和用户确认的策略规则

见 [STRATEGY.md](STRATEGY.md) 第 1–6 条。第 7–10 条（场末处理、资金上限、开始/暂停/停止、配置生效）还没讨论。

## 6. 下一步

- **eth 60 秒实验**（在跑）：攒一两天后，逐场对比实盘和 `scripts/backtest.py` 同一场的结果：每档实际成交量和成交价、每场盈亏。回测依据：10-05～12 共 469 场，每场 +0.68；验证段 +0.29（t 0.6），分不出是不是运气；起始秒和阶梯扫过（每币约 2700 组），换数据都不稳。4 次触发的场每场约 −41。
- 其他方向（重新商讨）：4 次触发的窟窿、阶梯按挂单量重新比、深度/成交方向信号。

## 7. 延后的事（用户安排，到时提醒）

- **O1**：root 密码登录对公网开放、防火墙关着（用户计划调试完设 Lightsail IP 白名单；80 端口要对所有人开放，否则证书续不上）。
- **O3**：没有备份（用户开 Lightsail 自动快照；服务器内每晚备份账本/结算由我们加）。
- **C30**：账本自算的结算盈亏逻辑，等官方数据稳定几天后删。
- 没用的"确认价" `confirmationPrice`（只统计不下单）：删掉，涉及引擎、控制面、控制台、账本，旧配置要兼容。

## 8. 其他

- 记忆目录 `C:\Users\Administrator\.claude\projects\c--Users-Administrator-Desktop-polymarket\memory\` 有更多背景（实盘启动方法、账本口径、时区、做市/吃单费率等）。
