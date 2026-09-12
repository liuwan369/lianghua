# EXEC-01 风险状态持久化证据

日期：2026-09-13（Asia/Shanghai）

## 目标

验证风险日、风险停机、未核对敞口和同账户并发启动在进程重启后不会被内存初始化清空。所有用例使用临时目录、mock 或 paper 对象；没有访问账户凭据、网络下单或链上交易。

## 实现范围

- `engine/src/risk.ts`：风险日使用 Asia/Shanghai（UTC+8），跨日只清理已结算日损益；风险计数器和停机状态保留。
- `engine/src/risk-store.ts`：按公开账户地址与 `paper/live` 分区，使用 `open(..., "wx")` 锁、临时文件 + `fsync` + 原子替换；坏文件、丢失初始化后的状态、活动运行和未核对敞口均 fail closed。
- `engine/src/live/engine.ts`、`live-maker.ts`、`live/orchestrator.ts`：订单提交前核对持久化状态，市场切换不能清除未核对库存；运行入口在风险状态初始化前不读取实盘健康接口或签名密钥。
- `EngineConfig.dailyLossLimitUsd` 只约束已有的已实现日损益状态机；完整账户权益、充值提款、在途资金、费用预留和未平仓 mark-to-market 尚未接入。

## 复现命令与结果

基线 commit（测试前工作树）：`fa31afcd2e38245cb7af517132c693688ae0613f`。

```powershell
cd _external/btc-5m-market-trading-bot
npm test -- src/risk-store.test.ts src/live/orchestrator-risk.test.ts src/live/orchestrator.test.ts
npm run typecheck
npm test
npm run build
```

结果：风险存储与入口定向回归 **25 passed**（risk-store 21、入口门禁 4）；完整引擎回归 **25 files / 253 passed**；TypeScript typecheck 和 build 通过。随后独立审查发现 Windows 目标替换问题，已改为保留备份的跨平台替换，并新增重复 checkpoint 回归；该定向回归在当前 Windows 环境再次通过。

定向覆盖包括：

1. 北京时间 16:00 UTC 风险日切换和回拨时钟拒绝。
2. 日损失、session halt、连续亏损在新 Engine 实例中恢复。
3. 活动运行标记、未结库存、待撤订单在新进程中拒绝启动。
4. 市场 reset 不能丢弃未核对库存，文件损坏/删除/未知 schema 拒绝加载。
5. 原子替换注入失败保留旧 checkpoint 并冻结新提交。
6. 账户地址大小写归一化、paper/live 隔离、不同账户隔离和同账户并发锁。
7. run 入口在风险停机时不发起 CLOB 健康请求、不启动行情 feed。
8. Windows 上重复写入已有 checkpoint 不会误触发持久化故障。

## 未覆盖和后续条件

- 现有账户在首次创建风险状态文件前的历史开放订单、持仓和资金仍需一次只读账户对账；本实现不会凭空证明初始敞口为零。
- 活动运行或未核对敞口会持续阻断新运行；尚未提供自动清除入口，必须由独立账户 reconciler 完成核对后再设计受控恢复。
- 锁采用单主机文件锁；跨主机共享目录、进程崩溃后的人工锁诊断及服务编排仍需运维验收。
- 日损失目前按已有 market PnL 状态机计算，不等于用户权益口径的“期初权益减充值提款后的当前权益”，也不包含完整未平仓估值。
- 本证据不证明真实下单、真实撤单、部分成交、断线恢复、奖励到账或策略收益。
