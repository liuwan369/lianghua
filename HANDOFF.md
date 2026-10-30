# 交接

接手先读这份，再读 [AGENTS.md](AGENTS.md)（铁律）、[README.md](README.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[API.md](API.md)、[STRATEGY.md](STRATEGY.md)。

## 1. 这是什么

Polymarket 加密货币 5 分钟涨跌盘的**币安领先策略（binance-lead）实盘系统，真钱**。用户是操盘人，用中文沟通，懂交易、不写代码，会逐条追问逻辑，经常指出我们算错的地方（多数时候他是对的）。

## 2. 铁律（AGENTS.md 要点）

- 不过度工程化、不过早抽象；不拿报告/清单代替改代码；不用"拦住不显示"代替修复。
- 先修会亏钱、漏单、卡交易的问题。
- **对话一律用中文**，简洁，可以幽默，回复里不要夹英文段落。
- 系统只有一份：新的替换旧的，旧代码/旧文档同一提交删干净。
- **服务器运行数据（journal、账本、状态、结算记录、发布备份、录制行情）删前先列清单和影响，用户同意再删。**
- **小额实盘必须用户明确同意才跑。**
- 秘密（私钥、API 凭证、控制密码、basic auth 口令）不进源码、日志、文档，不在对话里打印。
- 修 bug 先写测试（旧代码上失败、修好后通过）；改架构/接口同步 ARCHITECTURE.md / API.md。
- 策略结论要**拿真实数据说话**，并且**换一段没参与挑选的数据再验证**（以前多次"换一天就不灵"）。规则**逐条和用户确认**后才写进 STRATEGY.md。

## 3. 服务器与操作

- SSH：`ssh pm-new`（`root@166.1.221.53`，都柏林，4 核 Xeon Gold 6152、3.8G，Ubuntu 24.04，Node 24.13.0，Python 3.12），目录 `/root/pm-system`。
  - **本机联通线路直连 22 端口不通**，`~/.ssh/config` 里 `Host pm-new 166.1.221.53` 走本地 SOCKS5 代理 `127.0.0.1:10808`。代理没开就连不上，交易不受影响。
  - 时钟用 chrony，误差 < 0.1 ms。
- 控制面只在服务器本机：`curl -s -H "X-PM-Authenticated: probe" http://127.0.0.1:18766/api/...`（GET 只读）。公网 `https://166-1-221-53.sslip.io/console/`，nginx basic auth。
- 服务：`pm-system-dashboard-dublin`（控制面，内存上限 900M）、`pm-clob-market-snapshot`（行情采集 + 录制，7 个币）、nginx。引擎由控制面按需启动在独立 scope `pm-engine-<run_id>`。
- 部署：`PM_DEPLOY_SOCKS=127.0.0.1:10808 python scripts/deploy-reversal-release.py`（部署已提交的 HEAD，交易必须停着）。
- 推送：`git push origin main`；连不上时 `git -c http.proxy=socks5h://127.0.0.1:10808 push -q origin main`。
- 从服务器命令行启动实盘：见记忆 `live-run-start-from-shell`（**必须先得到用户同意**）。
- 在服务器上跑脚本：写成本地文件 `scp` 过去再执行，跑完删掉。长任务用 `setsid nohup ... &`，**不要用 `pkill -f <名字>`**（会连 ssh 自己一起杀掉）。**大文件只能流式读**：一天的录制解压后几 GB，整份读进内存会把服务器挤爆（10-21 发生过）。回测和数据分析一律在本机跑。

## 4. 当前状态（2026-10-30）

- **交易停着**。main 已部署：binance-lead 引擎，信号源可选（`leadSource`：币安现货 / Bybit 合约），预签单，`deferExec` 默认 false。服务器上发布的配置是 Bybit 合约、`makerHoldSec 0`；用户 10-30 定下次实盘只把 `limitPremium` 从 0.03 改成 0.08。
- 账户余额 172.30 美元。
- 实盘记录（都要用户同意）：
  - 10-26 吃单（FAK）3 次共 18 单，只成交 2 单，+3.79。
  - 10-27 挂单（买一价挂 3 秒撤）24 场 8 单，0 成交，0 亏损，系统零故障。
  - 10-29 Bybit 合约信号 24 场 7 单，成交 1 单，−1.08；交易所回复 4/7 单 2~3 秒。
  - 10-30 同上加 `deferExec` false：24 场 19 单，成交 3 单，+18.07；回复中位 303 ms，0 单过 1 秒。别人第一笔同向成交中位仍比我们早约 220 ms（`E:\pm-backup\research-1030\live_vs_others_1030.py`）。
- 限价研究（10-30，`E:\pm-backup\research-1030\limits_fine.py`）：撮合 300 ms 时限价 +0.03~0.15 回测合计都约 +490~530，但 +0.03 的回测买到率（59%）被录制高估，实盘只有 18%；撮合 900 ms 时 +0.08 样本外小亏。所以宽一点的限价要靠撮合够快。
- 为什么买不到（10-27/28 研究，`E:\pm-backup\research-1027\`、`research-1028\`，详见记忆）：
  - 币安成交到我们收到中位 126 ms，我们自己约 23 ms，POST 到交易所回复中位 383~444 ms。合计约 650 ms 才撮合。
  - 便宜的卖单 94% 是做市商在压单期间撤掉的。撮合在币安成交后 150 / 300 / 500 / 700 ms 时，还能买到的比例是 96 / 76 / 48 / 35%。
  - 慢在交易所撮合引擎：同一时刻发出的单，被参数校验拒掉的 32 ms 就回，真挂上去的要等几百 ms，盘口越忙越慢。我们这边最多能省约 40 ms。
  - **`deferExec` 是原因之一（10-30 更正）**：10-28 只用远离盘口的挂单比过 true/false，测不出撮合。官方 SDK 全发 false，我们一直发 true。10-30 实盘改成 false：19 单回复中位 303 ms、最慢 791 ms、0 单过 1 秒；10-29 发 true 时 7 单里 4 单 1.9~2.9 秒。现在代码默认 false，`CLOB_DEFER_EXEC=1` 才发 true。
  - Polymarket 撮合只在 AWS 伦敦一处，英国 IP 不能开新仓，都柏林已接近最好。KYC 后可申请伦敦机房直连，约省 20 ms。
  - 挂单落地时买一已经跑走，样本外回测（干净录制）挂单不显著。之前 22 天的挂单回测被 10-05~15 的录制滞后夸大了。
- **下一步（用户 2026-10-29 定）**：实盘先用 Bybit 合约做信号源，阈值 2bp，其他不变。同时每天跑 `forward-lead-sources.py`，看两个源 × 2/1.8/1.5bp 的前向结果，攒 5~7 天再决定要不要降阈值。Bybit 2026-11-12 迁东京，在那之前把实盘样本攒够，迁完复测延迟。
- 引擎状态文件名不变（`btc-reversal-<hash>.platform-state.json`，按账户共用）：结算记录在 `<状态文件>.settlements.json`，改名会丢掉未完成的赎回。里面旧的 `strategyStates["btc-reversal"]` 不读也不删。
- 10-03～14 的成交历史只在本机备份 `Desktop\pm-backup-20261014\pm-run-data.tgz` 里（服务器上没有）。同目录 `pm-secrets.tgz` 是秘密备份，别外传、别打开。
- 每日亏损上限只在下单前检查：离上限还差一点时还能再下一场，这一场最多亏 5 股 × 0.99 ≈ 4.95 加手续费。
- 盯盘：`E:\pm-backup\live\`（pm_ctl.py 远程执行、watch_maker.py 健康检查、stop_run.py 停机、loop_watch.py 每分钟检查一次，有问题就停），服务器上在 `/root/pm-live/`。

## 5. 行情录制

- 服务器 `data/market-history/<币>/<北京日期>.jsonl.gz`，7 个币，保留 30 天。本机副本 `E:\pm-backup\market-history\`，同步用 `bash /e/pm-backup/pull-market-history.sh`（只在服务器文件更大时才覆盖本地）。
- 行格式：
  - 盘口（无 `k`）：`ub/ua/db/da` 最优买卖价，`ubl/ual/dbl/dal` 前五档，`ue/de` 两边交易所时间。
  - `k:"o"`：一边没卖单的盘口，场次 1791179100（2026-10-05 05:45 UTC）起才有；之前每场最后约 50 秒没录盘口，回测不用。这种帧的五档不是可成交深度。
  - `k:"t"`：逐笔成交，`side` 是吃单方的方向。`k:"p"`：币安 1 秒 K 线（10-07 起）。`k:"c"`：Chainlink 价（10-07 起）。
- 数据质量：
  - 2026-10-07 的日文件中间有 3 段坏 gzip，`scripts/backtest.py` 的 `read_lines` 会跳过继续读；`gzip.open`/`zcat` 读到那里就停。
  - 10-06 到 10-15 14:54（北京）盘口大多晚到 1～5 秒：旧服务器 CPU 积分耗光被限速。10-17 01:20 起是新服务器录的，盘口延迟中位约 12 ms。
  - 10-05～09 和 10-10～15 是两台旧服务器各录的，同一场两份录制回测会差几百。
- 谁赢：收盘前最后一帧盘口 ≥ 0.9 的一边（和官方对过 17,280 场，判错 12 场）。官方按 Chainlink 收盘前 60 秒均价结算，收盘点值对比开盘点值约一成判错，不能用。官方结果：`https://gamma-api.polymarket.com/events?slug=<币>-updown-5m-<场次>` 的 `outcomePrices`（要带 `User-Agent: curl/8`）。

## 6. 策略：币安领先（2026-10-25 定死，10-29 加信号源）

规则见 [STRATEGY.md](STRATEGY.md)：领先交易所逐笔成交 250 ms 内动 ≥ 2 bp 是信号；开盘后 15～265 秒内、当前盘口两边有卖价且到达时新鲜、这一边卖价 ≤ 0.80，买信号那一边 5 股 FAK，限价 = 卖价 + 0.03（最高 0.99）；一场一次，持有到结算；只做 btc。信号源 `leadSource`：币安现货（默认）或 Bybit 合约。

- 为什么是它：反转阶梯、挂单、网格、配对、狙击等十几类在没参与挑选的日子上都亏（市场价格是准的，吃单多付价差加费）。币安成交领先 Polymarket 盘口约 1 秒，是第一个有机制的优势。
- 前向数据：
  - `E:\pm-backup\forward-binance-agg.py`：定死的币安规则，10-24 起，每日 cron 跑这个。币安逐笔文件在 `E:\pm-backup\binance-aggtrades\`，实盘代码的独立回放在 `E:\pm-backup\replay\`。
  - `E:\pm-backup\forward-lead-sources.py`：两个源 × 三档阈值，10-27 起。Bybit 文件在 `E:\pm-backup\bybit-trades\`。
  - 只跑前向脚本看新数据，**不再调参数**。
- 研究过、别再重测：
  - 窗口 150/200/250 ms 差别在噪声里，250 不动。
  - 阈值降到 1.5bp，同一波行情只早 20~26 ms 触发。合计变多是因为尝试变多，买到率不升。
  - 两边预挂单会亏（吃亏那边被打穿）。
  - 币安 @trade 和 @aggTrade 同时到；离欧洲近的交易所（Kraken、Bitstamp、Deribit、LMAX）量太小；Hyperliquid 最慢。
  - 第三方文章里的 gRPC、FIX、批量撤单保护只在 Polymarket US。
- 最怕慢：挑选段按成交时刻总延迟算，375 ms +237、440 ms +207、500 ms +172（买到率随延迟掉，胜率不变）；实盘约 650 ms。

## 7. 延后的事（用户安排，到时提醒）

- **O1**：root 密码登录对公网开放、防火墙关着（80 端口要对所有人开放，否则证书续不上）。
- **O3**：没有备份（服务器内每晚备份账本/结算由我们加）。
- **C30**：账本自算的结算盈亏逻辑，等官方数据稳定几天后删。

## 8. 其他

记忆目录 `C:\Users\Administrator\.claude\projects\c--Users-Administrator-Desktop-polymarket\memory\` 有更多背景（实盘启动方法、账本口径、时区、做市/吃单费率等）。
