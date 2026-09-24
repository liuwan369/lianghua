# 接入清单

这是一份实际联调清单，不是交付前置流程。

- [ ] 五个入口都由同一部署前缀和路由配置生成。
- [ ] bootstrap 返回版本、能力和固定 5m crypto 范围。
- [ ] market DTO 有非空 assetId、marketId、roundId、YES/NO token 和有效期；旧 `/api/v1/markets` 缺 roundId 时只能用于目录/报价展示。
- [ ] market-pool 支持 desired/current/nextRound/effectiveRoundId，停用不撤当前场次，PUT 不接受客户端覆盖 current/next。
- [ ] runtime command 支持 requestId 幂等，响应和最终状态分开；stop 在状态暂时 stale 或缺少市场身份时仍可提交，`remoteOrdersState` 为 `unconfirmed` 时不能显示为撤单已完成。
- [ ] `streams.markets`、`streams.runtime`、`streams.orders` 均配置真实 WebSocket 地址；未配置时使用独立 REST 轮询，页面标明轮询/待接入并保留快照，不生成实时假数据。
- [ ] WS 帧有 sequence/sourceAt/expiresAt；行情和订单帧有 marketId/roundId，旧帧不会覆盖新帧，断线保留最后成功快照并显示 stale。
- [ ] 多币种每个 marketId 独立显示盘口、持仓、订单和阶段。
- [ ] 策略保存有服务端校验、完整 `maxStages`、`draftId`、`expectedRevision` 和已发布 revision。
- [ ] 策略草稿保存与策略激活分离；激活请求带 `strategyId`、`draftId`、`expectedRevision`，服务端确认正 revision 后才允许启动；不把草稿提示成已生效。
- [ ] 账户秘密不经过浏览器，账户页面只显示服务器状态；账户切换由服务器环境配置完成。
- [ ] 真实账户快照、账户检查和交易控制已与后端联调；未完成前保持 unavailable/stale，不把演示数据解释成真实交易数据。已保存账户检查发送 `{}`，候选表单检查不替代该检查；保存回执须有 `ok: true` 和对象 `report`。
- [ ] 诊断、账户、统计、日志分别取对应数据源。
- [ ] loading/stale/empty/error 都有可见状态，错误保留上次成功数据。
- [ ] 页面切到后台暂停低优先级刷新，返回时恢复快照。
- [ ] 页面只通过 `PolyPreviewAdapter` 读写，不直接调用 fetch 或 localStorage。
- [ ] 市场目录只由服务器返回并写入 Store，自动交易不复制币种列表或演示资产。
- [ ] 启用币种写入 market-pool 后，后端返回 effectiveRoundId/currentIds/nextRoundIds。
- [ ] 控制按钮传递 requestId 和 marketIds，不能只修改页面文字。
- [ ] 策略保存提交统一 ViewModel，价格单位在 adapter 中只转换一次。
- [ ] 用真实接口检查空数据、过期数据、断线、重复 command、权限错误以及缺失 roundId 的旧市场响应。
- [ ] 用浏览器检查桌面和窄屏布局，确认无横向滚动和整页闪烁。

以上清单描述真实联调前提；后端尚未提供的能力必须在页面保持 `unavailable/stale`，不能用演示数据填充。
