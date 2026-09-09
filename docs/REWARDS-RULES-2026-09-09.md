# 收益页官方规则核对 · 2026-09-09

本次修改仅作用于 `demo-trading-console.html` 及其 `demo-rewards.js/css`。规则来自本轮实际读取的官方文档；没有登录账户读取账单，也未连接订单、签名或资金接口。网页中的规则核对不等于账户资格或到账确认。

## 核对范围与更正

读取官方 `https://docs.polymarket.com/llms.txt` 索引中的 Predictions Programs 全部章节、Builder 子章节、交易费用、市场配置、奖励/返佣 API 说明、Predictions 更新公告，以及单独的 Perps 奖励章节。原始官方正文保存在 [research/rewards-2026-09-09](research/rewards-2026-09-09)。这是公开文档范围的目录核对，不是全部登录专属、地域专属或临时定向活动的保证。

更正此前“去掉吃单返佣”的建议：当前官方明确有 Taker Rebate Program，自 2026-05-28 生效，还有首次升级奖金。应保留并按当前规则展示。保留未知项目时标记未核实，不能填写传闻比例。

## 规则目录

| 项目 | 本轮核实规则 | 账户或有效期边界 | 官方来源 |
| --- | --- | --- | --- |
| 吃单返佣 | 近 30 天加权量 wV；返还手续费 0/3/8/18/32/44/50% | 只有 taker；当前官方档位、到账待获取 | [Taker](https://docs.polymarket.com/programs/taker-rebates) |
| 升级奖金 | 首次到各档 10/50/250/1500/7500/25000 pUSD | 一次性，领取历史待核对 | [Taker](https://docs.polymarket.com/programs/taker-rebates) |
| 做市返佣 | Crypto 手续费的 20% 入池，Sports 15%，其他收费类别 25%；按市场手续费等价值份额分配 | 不是个人成交额乘 20%；必须 maker 成交 | [Maker](https://docs.polymarket.com/programs/maker-rebates) |
| 流动性奖励 | 挂单有效份数、距离中间价、双边深度和相对评分 | 逐市场最低份数、最大价差、奖励起止期 | [Liquidity](https://docs.polymarket.com/programs/liquidity-rewards) |
| 赞助奖励 | 当前配置接口支持 sponsored，平台/赞助/总日池字段 | 总池不能与其分项重复相加；接口未接入演示页 | [配置 API](https://docs.polymarket.com/api-reference/rewards/get-current-active-rewards-configurations) |
| 推荐奖励 | 直接 10%、间接 5%，基于被推荐者扣除自身返佣后的净手续费；推荐者终身量门槛 $10,000 | 推荐注册 30 天或到 Platinum 为止，先到者；非本人的策略返佣 | [Referral](https://docs.polymarket.com/programs/referral-program) |
| Builder 收费 | 交易名义额比例，默认 0，taker 最大 1%、maker 最大 0.5% | 由用户支付的应用费，非平台补贴；独立经营账 | [Builder Fees](https://docs.polymarket.com/programs/builders/fees) |
| Builder 周奖励/Grants | Verified 说明列出按量周奖励、Grants，均需批准 | 没有公开统一比例；不能靠自营成交默认拿到 | [Builder Tiers](https://docs.polymarket.com/programs/builders/tiers) |
| 持仓奖励 | MarketRewards 类型中存在 holdingRewardsEnabled | 没有确认当前利率、完整规则和 BTC 5m 适用性；只保留待核对入口 | [Market Details](https://docs.polymarket.com/market-data/market-details#liquidity-reward-settings) |
| Crypto TWAP 活动 | 文档写覆盖 8 月 $1M 池上限，5m $550k 中 BTC $300k | 核对日已 9 月；未发现延长依据，作为期限已过/待核对历史，不估计当前收益 | [Liquidity](https://docs.polymarket.com/programs/liquidity-rewards) |
| March Madness | 3 月 17 日公告 $2M+；最低在簿 3.5 秒及分阶段日奖励率 | 历史体育活动，不套用于 BTC 或所有流动性计划 | [更新公告](https://docs.polymarket.com/changelog/predictions) |
| Perps 流动性/推荐 | $75k/日池、7 天 maker 份额至少 1%；推荐 20% 手续费、周发放 | 独立产品、账户及账本，不纳入预测市场策略收益 | [Perps LP](https://docs.polymarket.com/perps/liquidity-rewards)、[Perps Referral](https://docs.polymarket.com/perps/referral-program) |

## 吃单进度口径

`wV = 成交名义金额 × (1 − Entry Price) × 类别权重 × 官方活动倍数`。

- Crypto 权重 2.3；Sports 1；Politics/Finance/Mentions/Tech 1.3；Economics/Culture/Weather/Other 1.7；Geopolitics 0。
- 档位门槛为 2,000 / 20,000 / 200,000 / 1,000,000 / 4,000,000 / 10,000,000 wV。不能拿全部 maker+taker 成交额直接比较。
- 官方同时写“到档后未来交易生效”和“下一次每日更新生效”。UI 保留差异：实际当前档位以账户为准，试算达到门槛提示等待更新，不实时自动切返佣率。
- UTC 00:00（北京时间 08:00）日更/日付；Taker 和 Maker 返佣最低累计发放额 1 pUSD；Liquidity 文档只明确低于 $1 不支付，不能统一承诺累计滚存。
- wV 按滚动 30 天，存在降档及未具体量化的宽限期。不按自然月重置。
- 试算仅输入 wV，明确不改账户/策略。展示量门槛、下一档差额与首次奖金规则，不承诺领取或到账。

## 页面与会计口径

总览 4 项与收益页共用同一含义：未扣费的已结算交易盈亏、实际成本、已到账交易奖励、最终净收益。账户账单未接入时全部 --，不能把缺失当作 0。

收益页包括：账单摘要、9 类计划卡、Taker 档位/进度试算、历史/当期活动入口、独立 Perps 折叠区及到账明细。每项可查看官方来源、规则核对日及资格边界。每个项目预计/待发放/已到账分开，不在交易策略中自动纳入预计收益。

最终净收益仅在成本口径一致且记录完整时计算。若平台 PnL 含手续费，应先统一含费/不含费口径，不能重复扣。赞助池、专项活动与流动性奖励的同笔发放按来源归类，只计一次。经营收入独立于策略利润；资产地址决定币种，不能把不同币种无换算相加。官方累计收益查询不自动证明已经到账。

## 后续真实接入仍需完成

- 当前奖励配置含分页及 sponsored 分支；必须读完并保存完整性，奖励资产/起止日期/最低份数/最大价差映射市场。
- 读取实际账户有效档位、30 天 taker wV、奖金领取记录及推荐/Builder 审批；本轮 API 文档索引未确认所有这些数据的公开接口，不编造路径。
- Maker 公开 `GET /rebates/current` 及已认证收益/占比接口与付款凭证对账；不把 earnings 值直接当到账转账。
- 规则需版本化：source_url、checked_at、effective_from/to、applicability、rate_basis、asset、status。过期/未知规则停止估算，不抹掉历史记录。
- 当前 demo 的选择周期只改变“账单未获取”提示；不会伪造请求或样本金额。实际应用需接入数据后再验收。

## 本轮验证

JavaScript 语法检查及 diff 检查通过。独立源码复审发现 1999.999 wV 临界差额显示问题，已修正为保留输入值及正差额小于 0.01 时明确显示 `<0.01`，避免“还差 0 却未升级”。运行逻辑检查覆盖 1999.999、2000、12000、20000、10000000、负数、空输入，以及示例、清空和总览跳转。未接入实账，也未把这些逻辑检查描述为完整浏览器视觉验收。
