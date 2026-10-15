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

- SSH：`ssh -i ~/.ssh/id_ed25519_dublin_pm root@34.242.206.196`，目录 `/root/pm-system`（2 核 1.9G，Ubuntu，Python 3.12）。
  - 2026-10-10 曾迁到 18.201.16.51（4 核 16G），**那台 10-15 到期、连不上了**。10-15 起回到这台旧机，部署最新代码 `8eb241d` 覆盖了 10-08 的旧版本。
  - 这台旧机的运行数据（账本、结算、状态）停在 10-02，比新机少 10-03～14 的交易记录。新机最后的运行数据在本机备份 `Desktop\pm-backup-20261014\pm-run-data.tgz`，**没有恢复到旧机**：新机备份里有 3 笔"未知"订单（已确认交易所那边早结束了），旧机账户现在干净（余额以链上为准）。要看 10-03～14 的成交历史就从那份备份里查。
  - 旧机覆盖前的运行数据备份在 `Desktop\pm-backup-oldbox-20261015\old-run.tgz`。
  - 旧机内存只有 1.9G：大回测别在服务器上跑，用本机 + E 盘行情（`--history E:/pm-backup/market-history`）。
- 控制面只在服务器本机：`curl -s -H "X-PM-Authenticated: probe" http://127.0.0.1:18766/api/...`（GET 只读）。公网是 `https://34-242-206-196.sslip.io`，nginx basic auth。
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
- **交易停着**。2026-10-15 部署到旧机 34.242.206.196，版本 `8eb241d`。旧机的已发布策略配置还是 revision 22（btc、1 档 5 股、起始秒 0），不是新机上的 revision 23（eth 60 秒实验），下次实盘前要在控制台重新设。
- 第二次 run `20261013-131839-77a945cc132d`（用户在控制台手动启动，北京 10-13 21:18 至 10-14 约 12:00）：下单 16 场，12 赚 4 亏，合计 **−73.07**，碰到每日亏损上限后停止开新单。
  - 两场各亏约 41（1791919800、1791927600）：都是一场 4 次触发，第 3 档 60 股买完又反转回来。实盘和回测同一场只差几分钱（−41.57 对 −40.8，−41.59 对 −41.66），**是策略亏损，不是系统出错**。
  - 1791922200 亏 3.52：第 2 档对冲挂 0.70 时卖价从 0.45 直接跳到 0.99，一股没买到（规则第 5 条的已知问题）。回测 −3.57。
  - 亏损上限 45 只在下单前检查：当天 −34 时还能开新一场，这一场最多亏 41，所以停在 −73。要防这个得在下单时把"本场最多亏多少"算进去（未做）。
  - 修了：交易所对收盘时部分成交的订单报 MATCHED、拒绝撤单，引擎把它标成"未知"每秒重试、资金卡住（`accef91`，3 笔已在服务器停机状态下用真实状态验证能关闭，下次启动的第一次账户检查会关掉）。账本：落后一行不算过期（`7ec5fdd`）、搬机复制的 journal 不算改写（`0a47d3c`，10-02 那次 run 已重读，统计不再"待核对"）。
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

- **唯一测出来赚钱的：从第 k 次触发开始做，阶梯 5/13/60**（btc/eth 10-05～13，9 天，新成交口径）：
  - btc 从第 3 次开始：366 场 **+279**，前 5 天 +81、后 4 天 +198，最差一场 −42。
  - btc 从第 5 次开始：59 场 **+163**，前 5 天 +66、后 4 天 +96，最差一场 −3.6。
  - eth 从第 3 次开始 +146；eth 60 秒后从第 3 次开始 +92。
  - 对照：从第 1 次开始（现在实盘的做法）btc −46、eth −579。
  - 要实盘得先给引擎加参数"从第几次触发开始做"（同起始秒的改法），每日亏损上限 ≥45。
- **2026-10-14～15 和用户逐个测过、都不赚的结构**（btc 9 天）：4 档阶梯（比 3 档差）；收盘前 30/45/60 秒不下单（少赚）；第 1 档放大、后面保本（大档买不满）；触发线改 0.55/0.60/0.65/0.70；每次触发买便宜那边（亏 176～2734）；0.67 买 A + 对面挂 0.30 锁差价（−352），再加补仓/止损（−346 到 −438）；开盘两边各挂 0.30（−379，审查后口径），再给后成交那边加仓（越加越亏）。原因都一样：0.30 只在输的那边必然成交，赢的那边只有约 37% 的场跌到过 0.30。
- **全网调研**（2026-10-15，5 个方向 50 多个来源）：没找到可核实的、在 5 分钟盘稳定赚钱的结构。值得先回测的只有"收盘前狙击 0.95～0.99"。做市要撤单 <100ms（我们回执 ~250ms）。官方吃单费公式没核实，要拿实盘成交记录核对。
- **回测成交口径 2026-10-15 改过**：加了逐笔成交（`backtest.py` `Order.trade`），旧口径只看盘口、漏算成交。之前所有回测数字都偏保守，上面的数字是新口径。

## 7. 延后的事（用户安排，到时提醒）

- **O1**：root 密码登录对公网开放、防火墙关着（用户计划调试完设 Lightsail IP 白名单；80 端口要对所有人开放，否则证书续不上）。
- **O3**：没有备份（用户开 Lightsail 自动快照；服务器内每晚备份账本/结算由我们加）。
- **C30**：账本自算的结算盈亏逻辑，等官方数据稳定几天后删。
- 没用的"确认价" `confirmationPrice`（只统计不下单）：删掉，涉及引擎、控制面、控制台、账本，旧配置要兼容。

## 8. 其他

- 记忆目录 `C:\Users\Administrator\.claude\projects\c--Users-Administrator-Desktop-polymarket\memory\` 有更多背景（实盘启动方法、账本口径、时区、做市/吃单费率等）。
