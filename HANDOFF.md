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

- 爱尔兰：`ssh pm-ire`（AWS Lightsail 3.254.138.119，2 核可突发 CPU、保底每核 20%，2 GB），**只跑控制台**（`pm-console@1`、`pm-console@2`，一个账户一个）和到两台交易机的隧道，目录 `/root/pm-system`。11-21 起控制台和引擎拆开：控制台只看数据、发命令（数据在 `data/console/`），代理管引擎、私钥、参数（`backend/engine/results/`）；之后代理搬到每个账户的交易机 `pm-a`（63.35.183.205）、`pm-b`（54.217.184.66），`pm-ire` 只留控制台。2026-11-21 从 Baxet 迁回（Baxet 断网 1 个多小时）。CPU 积分用光会被限速、直连行情卡住，所以只开 Bybit 直连（`directVenues`）、账户 60 秒读一次。控制面 systemd `pm-console`，引擎由控制面按需启动在 scope `pm-engine-<run_id>`。公网 `https://3-254-138-119.sslip.io/console/`（nginx basic auth，证书自动续）。
- 交易机 `ssh pm-a`（63.35.183.205）、`ssh pm-b`（54.217.184.66）：Lightsail eu-west-1a、Debian 12、和 pm-ire 不是同一个 AWS 账户（没有内网）、没有静态 IP（面板上「停止」再「启动」IP 会变，改 pm-ire 的 `/root/.ssh/tunnels.config` 里 `HostName` 和东京 relay.env）。各跑 `pm-agent` 和一个引擎，账户私钥只在各自的 `backend/engine/.env`（600）；nftables 只开 22 和东京的 47001。pm-a 比 pm-b 慢约两成、被抢 CPU 多（虚拟机所在物理机忙，不是代码）。pm-ire 上 `pm-tunnel@pm-a/pm-b` 把 18777/18787 转到它们的代理。部署 `python scripts/deploy.py engine-a|engine-b`。
- Baxet 都柏林 `ssh pm-baxet-retired`（194.87.245.135）：11-21 退役，pm-console 已 stop + disable；`deploy.py` 拒绝往它部署。别再在上面启动任何东西。
- 东京 AWS ap-northeast-1：`ssh pm-tokyo`，只跑 `pm-relay`（`/root/pm-relay`）：收 Bybit/币安/OKX 成交，HMAC 签名后 UDP×2 + TCP 发爱尔兰 47001 端口（目标在 `/root/.config/pm-system/relay.env` 的 `PM_RELAY_TARGET_HOST`，可以逗号分隔填多台引擎机；11-21 起 3.254.138.119）。
- 伦敦 AWS eu-west-2：`ssh pm-rec`（16.60.186.91，t3.micro 945 MB + 2 GB swap），只跑录制 `pm-rec`（`/root/rec/rec.mjs`，数据 `/root/rec/data/<UTC 日>/<源>-<启动秒>.jsonl.gz`，留 10 天）。本机 `bash backend/engine/scripts/recorder/pull-rec.sh` 拉到 `E:/pm-backup/rec-london/`。别在上面跑分析。
- 都柏林旧机器：`ssh pm-new`（166.1.221.53，本机走代理 127.0.0.1:10808），不交易；predict.fun API key 在 `/root/.config/pm-system/predictfun.key`，历史下载在 `/root/pf-history/`。
- 控制面只在爱尔兰本机：`curl -s http://127.0.0.1:18766/api/...`（GET 只读）。写操作（启动/停止/发布配置）要走 nginx：本机脚本把口令从 stdin 传进去，不打印（口令本机在 `E:/pm-backup/aws-probe/.console_pw`）。
- 部署：`python scripts/deploy.py [ireland|tokyo|all]`（部署已提交的 HEAD，交易必须停着），部署后控制台点启动。
- 推送：`git -c http.proxy=http://127.0.0.1:10808 push origin main`（直连会被重置）。
- 在服务器上跑脚本：写成本地文件 `scp` 过去再执行，跑完删掉。长任务用 `setsid nohup ... &`，**不要用 `pkill -f <名字>`**（会连 ssh 自己一起杀掉，查 pid 再 kill）。注意 Windows 下 bash 和 python 的 `/tmp` 不是同一个目录。回测和数据分析一律在本机跑（`python` 是 3.14，带 numpy；`python3` 没有）。

## 4. 当前状态（2026-11-25）

- 两个账户各一台交易机：账户 1 在 `pm-a`、账户 2 在 `pm-b`，控制台在 `pm-ire`（`/acct/1/`、`/acct/2/`，总览页对比两个账户）。
- 账户 1：配置第 39 版（11-24 15:51 北京起）：10 股、限价 = 卖价 + 0.04、限价单剩余挂 5 秒、开盘后 30~265 秒、开盘前 60 秒均价 ±4 bp、**优势低于 −0.02 不买（`minEdge`）**、三个开关（行情太乱就暂停、按优势定股数、反向信号就卖出）全关、单场预算 20、总预算 60、日亏 40、三家交易所 + 东京转发（只开 Bybit 直连）。
- 账户 2：还是第 3 版（5 股、开盘线 ±6、三个开关里"行情太乱就暂停"开）。
- 11-23 全参数测试（`E:/pm-backup/research-1123/`，记忆 `params-2026-11-23`）：回测撮合延迟要按 1.2 秒才和实盘对上（旧样本中位 0.57 秒，买到率 83% vs 实盘 57%）；没买到的赢 58%、买到的 49%（好单被抢走）。实盘和回测都支持的只有"开盘线 ±4 + 优势 ≥ −0.02"：实盘 1105 单按 5 股 +26.7 → +155.8、回撤 −79 → −28。按优势定股数、只吃单、换交易所回测说好但实盘不支持；反向卖实盘约打平。
- 连赢连输（11-24，用 Bybit 真实币价查 980 单）：赢单和输单开盘前的行情一样，事前分不出；两个账户拼在一起看像扎堆，是因为两边常买同一场（95% 同输赢），各自看不扎堆。
- 凌晨买不到变多（11-25 03~07 点买到率约三成）：两个账户同时变差，交易所回复从几百毫秒涨到 1 秒以上，我们自己的信号速度没变；观察中。
- Polymarket Protocol V2：见 [ARCHITECTURE.md](ARCHITECTURE.md)「结算 / Polymarket Protocol V2」。代码已写好（7bcfbb2）、**没部署**，用户说等官方公布 BTC 切换日期再说；之后先在 SOL 5 分钟盘用账户 2 小单把买、卖、结算、赎回走一遍。

## 5. 行情数据

- 本机 `E:/pm-backup/`：`market-history\btc\`（Polymarket 盘口录制，10-05~11-13，11-13 起停录）、`bybit-trades\`、`binance-futures-aggtrades\`、`okx-swap-trades\`（逐笔成交，次日发布，下载走代理）。
- 录制行格式：盘口（无 `k`）`ub/ua/db/da` 买一卖一、`ubl/ual/dbl/dal` 五档、`ue/de` 两边交易所时间；`k:"o"` 一边没卖单的盘口；`k:"t"` 逐笔成交；`k:"p"` 币安 1 秒 K 线；`k:"c"` Chainlink 价。
- 谁赢：收盘前最后一帧盘口 ≥ 0.9 的一边；官方结果 `https://gamma-api.polymarket.com/events?slug=btc-updown-5m-<场次>` 的 `outcomePrices`（带 `User-Agent: curl/8`）。官方按 Chainlink 60 秒均价结算，单点价约一成判错。
- 实盘的官方成交和手续费：Data API `/v2/activity`（本机走代理），`usdc_size − size × price` 就是实收手续费。

## 6. 策略要点

规则见 [STRATEGY.md](STRATEGY.md)。研究过、别再重测的：窗口 150/200/250 ms、阈值 1.5~1.8 bp、两边预挂单、加价 0.03~0.20（22 天 +0.08 最好）、上面第 4 节列的信号过滤。改参数前先看记忆里对应的研究条目。

## 7. 下一步

都在 [ROADMAP.md](ROADMAP.md)：资金管理、出场、告警、备份、伦敦录制机，按顺序一项项做。

## 8. 其他

记忆目录 `C:\Users\Administrator\.claude\projects\c--Users-Administrator-Desktop-polymarket\memory\` 有更多背景（实盘启动方法、账本口径、时区、做市/吃单费率等）。
