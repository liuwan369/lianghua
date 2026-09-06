# BTC 5 分钟交易系统

这是当前唯一维护的主线：Polymarket BTC Up/Down 5 分钟市场的只读采集、历史回放、纸面模拟和受控交易引擎。

## 当前结论

- 目标地址 `0x3048d65321be3497164cdfc2996f94f98a2e7537` 的主要行为是两边挂买单，成交后动态补另一边。
- 采集器能取得真实公开盘口、成交和 BTC 行情，但不能取得我们的真实排队位置；当前主节点为 AWS 都柏林，东京仅作历史对照。
- 当前页面可以做纸面模拟；真实交易仍默认锁定。
- 当前裁决：`NOT_READY_FOR_LIVE_TRADING`。
- 账户只读核对（2026-09-06）：公开/API 地址为 `0xA693a0E0e40BDeC3d9d4a40bD4D087A5cECFD7cd`，页面显示现金/组合约 `$17.13`、无持仓；该地址明确标注“仅供 API 使用”，不能向它转账。
- Relayer 签名地址为 `0xDa6F73818Af63191633D8c8025508CD703780CD0`；当前没有 Relayer API 密钥，也没有授权下单。
- 都柏林服务器 SSH 已接通；统一 30 分钟基线为 REST `p50 26.19ms`、WS 稳定消息年龄 `p50 9ms`，明显优于东京。都柏林地理接口返回 `IE / blocked=true`，官方文档将其列为网页端限制、API 初筛可用，但真实账户资格和真实接单仍未验收。

## 直接运行

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-dashboard.ps1
```

打开：`http://127.0.0.1:8765/system-dashboard.html`

页面只有三个入口：

1. **交易**：开始/停止模拟，查看当前盘口、挂单、成交、撤单和本次收益。
2. **配置**：设置配对成本上限、单笔金额、总金额、订单数和运行时间。
3. **订单**：按市场查看成交额和结算结果，不堆出全部明细。

## 运行前验证

```powershell
python -m unittest discover -s tests -v
Set-Location _external/btc-5m-market-trading-bot
npm.cmd run build
npm.cmd test
Set-Location ..\..
```

## 数据口径

- 盘口、成交和 BTC 行情来自公开接口/东京采集器，是真实市场数据。
- 东京页面和 `/api/live` 当前可访问，采集器持续写入；`/api/trading/status` 明确返回纸面模式。2026-09-06 复核四个东京服务/定时器均正常；24 小时分析已成功更新，但报告标记历史数据有断点。
- 纸面成交是模型回放，不是真实订单，也不代表到账收益。
- 页面收益默认不等于官方返佣、奖励或最终结算净额。
- 只有真实账户订单、费用、返佣、奖励和结算逐笔对账后，才可称为真实净结果。

## 目录

```text
_external/btc-5m-market-trading-bot/  TypeScript 交易引擎
pm_maker/                              影子回放和动态补仓模型
scripts/system-dashboard-server.py    页面 API 与交易控制
scripts/pm-r25-tokyo-evidence-collector.py  东京只读采集
config/pm-system-dashboard-tokyo.service   东京页面服务
data/pm-r25-live/                     东京采集数据
data/pm-r25-history-30d-verified/     已核验历史数据
docs/                                 当前中文文档
tests/                                Python 回归测试
```

## 安全边界

当前不会读取或要求用户把私钥填入页面。实盘必须由管理员在服务器环境中单独解锁，并先完成小额、人工确认的 post-only 试单。任何模拟收益都不能当作收益保证。

详细说明见 [START-HERE.md](START-HERE.md) 和 [docs/WEB_GUIDE.md](docs/WEB_GUIDE.md)。
