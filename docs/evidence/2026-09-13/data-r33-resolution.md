# DATA-01 官方结算标签证据

日期：2026-09-13（Asia/Shanghai）。状态：已完成首轮历史标签补齐，尚不等于策略通过。

使用冻结的五个都柏林 SQLite 日库提取 BTC 五分钟市场身份，再由都柏林服务器访问 Gamma `events?slug=`。没有使用本机对官方接口的失败请求，也没有把最后一笔 BTC 价格当作结算结果。工具和原始响应均按哈希保存；原始快照位于被 `.gitignore` 排除的 `data/research/r33/`，汇总报告为同目录 `report.json`。

结果：1,235 个市场全部返回唯一父事件和唯一 Up/Down 市场；条件 ID、两个 token、五分钟窗口与本地采集身份一致。1,235 个市场均为 `closed=true`、`umaResolutionStatus=resolved`，终态 payout 为一个 Up/Down 的 1 和另一个的 0；身份冲突、未决标签和请求失败均为 0。结算来源字段显示为 Chainlink BTC/USD 60 秒 TWAP（`cryptoMarketConfig.id=btc-5m-twap-60`）。

Gamma `/markets?slug=` 对历史市场曾返回空数组，因此不再把该接口当作历史标签唯一来源；事件端点返回的市场字段与对应 CLOB market 查询的 closed、token、winner 结果一致。每个标签保存 `source_url`、抓取时间、快照 SHA-256、费率/最小份数/奖励元数据和“抓取时元数据，不代表历史费用或到账奖励”的语义。

回放接入 `--resolution-labels data/research/r33/report.json` 后，官方胜方只按命名 token 和终态 payout 选择；没有标签的市场仍不会确认模拟结算收益。模拟结算是影子成交按官方 payout 的计算，仍不是账户钱包利润，也没有加入奖励。12 市场 smoke（11 个完整）结果：strict_pair +0.0207、calibrated_3048 -6.5081、candidate_r19 +1.7010 USDC；样本很小，不能据此写入生产默认值。

复现：

```powershell
python scripts/pm-r33-resolution-audit.py `
  --db data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-06.sqlite3 `
  --db data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-07.sqlite3 `
  --db data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-08.sqlite3 `
  --db data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-09.sqlite3 `
  --db data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-10.sqlite3 `
  --output data/research/r33/report.json --cache-dir data/research/r33/snapshots
```

原始数据库只读打开并拒绝活动 WAL；抓取、标签完整性、token 身份、终态和缓存路径均有回归测试。奖励资格、历史实际费用、排队位置、成交真实性和当前账户净收益仍需独立数据与执行证据。
