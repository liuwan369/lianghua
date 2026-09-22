# 接入清单

这是一份实际联调清单，不是交付前置流程。

- [ ] 五个入口都由同一部署前缀和路由配置生成。
- [ ] bootstrap 返回版本、能力和固定 5m crypto 范围。
- [ ] market DTO 有 assetId、marketId、roundId、YES/NO token 和有效期。
- [ ] market-pool 支持 desired/current/nextRound，停用不撤当前场次。
- [ ] runtime command 支持 requestId 幂等，响应和最终状态分开。
- [ ] WS 帧有 sequence/sourceAt/expiresAt，旧帧不会覆盖新帧。
- [ ] 多币种每个 marketId 独立显示盘口、持仓、订单和阶段。
- [ ] 策略保存有服务端校验、revision 和 effectiveRoundId。
- [ ] 账户秘密不经过浏览器，账户页面只显示服务器状态；账户切换由服务器环境配置完成。
- [ ] 诊断、账户、统计、日志分别取对应数据源。
- [ ] loading/stale/empty/error 都有可见状态，错误保留上次成功数据。
- [ ] 页面切到后台暂停低优先级刷新，返回时恢复快照。
- [ ] 页面只通过 `PolyPreviewAdapter` 读写，不直接调用 fetch 或 localStorage。
- [ ] 市场目录只在 `demo-data.js`/Store 中定义一次，自动交易不复制币种列表。
- [ ] 启用币种写入 market-pool 后，后端返回 effectiveRoundId/currentIds/nextRoundIds。
- [ ] 控制按钮传递 requestId 和 marketIds，不能只修改页面文字。
- [ ] 策略保存提交统一 ViewModel，价格单位在 adapter 中只转换一次。
- [ ] 用真实接口检查空数据、过期数据、断线、重复 command 和权限错误。
- [ ] 用浏览器检查桌面和窄屏布局，确认无横向滚动和整页闪烁。

当前独立稿仍是预览，以上勾选项在后端接入前不应标记为完成。
