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

- 爱尔兰 AWS eu-west-1：`ssh pm-ire`（root@3.254.138.119，2 vCPU、2 GB），控制面 + 引擎，目录 `/root/pm-system`。控制面 systemd `pm-console`，引擎由控制面按需启动在 scope `pm-engine-<run_id>`。公网 `https://3-254-138-119.sslip.io/console/`（nginx basic auth）。
- 东京 AWS ap-northeast-1：`ssh pm-tokyo`，只跑 `pm-relay`（`/root/pm-relay`）：收 Bybit/币安/OKX 成交，HMAC 签名后 UDP×2 + TCP 发爱尔兰 47001 端口。
- 都柏林旧机器：`ssh pm-new`（166.1.221.53，本机走代理 127.0.0.1:10808），不交易；predict.fun API key 在 `/root/.config/pm-system/predictfun.key`，历史下载在 `/root/pf-history/`。
- 控制面只在爱尔兰本机：`curl -s http://127.0.0.1:18766/api/...`（GET 只读）。写操作（启动/停止/发布配置）要走 nginx：本机脚本把口令从 stdin 传进去，不打印（口令本机在 `E:/pm-backup/aws-probe/.console_pw`）。
- 部署：`python scripts/deploy.py [ireland|tokyo|all]`（部署已提交的 HEAD，交易必须停着），部署后控制台点启动。
- 推送：`git -c http.proxy=http://127.0.0.1:10808 push origin main`（直连会被重置）。
- 在服务器上跑脚本：写成本地文件 `scp` 过去再执行，跑完删掉。长任务用 `setsid nohup ... &`，**不要用 `pkill -f <名字>`**（会连 ssh 自己一起杀掉，查 pid 再 kill）。注意 Windows 下 bash 和 python 的 `/tmp` 不是同一个目录。回测和数据分析一律在本机跑（`python` 是 3.14，带 numpy；`python3` 没有）。

## 4. 当前状态（2026-11-17）

- 实盘：binance-lead，配置第 22 版：10 股、限价 = 卖价 + 0.08、卖价上限 0.80、开盘后 30~265 秒、离开盘前 60 秒均价 ±5 bp、三家交易所 + 东京转发、**第一单用限价单（GTC）**、剩余挂 4 秒后撤、**行情太乱就暂停：开**、单场预算 20、总预算 100、日亏不限。
- 结论（详见记忆）：
  - 回测天天赚、实盘接近打平：同场对照时差距几乎全在"实盘没买到、回测买到"的单上（10-30~11-12 回测 +167、实盘 +8；回测买到率 68%、实盘 48%）。信号好的单最先被别人抢走（`E:/pm-backup/research-1113/bt_vs_live.py`）。
  - 改信号的方案都测过、都不如现行规则：往回打先观察、跳过震荡、只要多家同动、信号速度、按波动调阈值、距离按剩余时间折算（`E:/pm-backup/research-1115/`）。
  - 限价单把买到率从约 50% 提到约 90%，挂着成交的约占两成股数、不收手续费；多买到的单整体只打平。
  - 行情太乱就暂停：28 天回测 +48~+64 不显著；11-16 半天实盘会暂停的 20 单赢 6、−42，留下的 +3.7。用户 11-16 打开了，继续看。
- 只记录、不影响下单：反向信号卖出（第 3 个反向信号），半天净 +15 但几乎都在会被暂停的单上，建议不开。
- 两个新开关（2026-11-17 做完，默认关 = 只记录，设置页打开就生效）：
  - 按优势定股数 `edgeSizing`：优势 ≥ 0.07 买 15 股、< −0.04 买 5 股，其余按股数；29 天回测 +181.6（t 1.96）。打开前把单场预算从 20 调到 30，15 股超预算时自动退回原股数。
  - 反向信号就卖出 `exitOnReverse`：买到后第一个反向信号，按买一 − 0.08 吃单卖掉持仓，一场一次；限价单剩余先撤再卖；29 天回测 +63.9（t 0.74），两个一起 +254.5（t 2.18，最差一天 +3.3）。
  - 统计页「反向信号就卖出」「按优势定股数」看模拟结果；关着时每单记公允价、优势、反向信号时的买一。
- 等数据：predict.fun 历史（11-05 起每场结果和全部成交，按单点价结算）下载中，下完回测"同样的信号在 predict.fun 是否更有优势"（`E:/pm-backup/research-1116/`）；伦敦录制机等用户租。

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
