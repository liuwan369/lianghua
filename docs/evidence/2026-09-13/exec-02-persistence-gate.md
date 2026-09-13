# EXEC-02 persistence and gate increment

日期：2026-09-13  
源码：working tree after account-state-store and reservation gate changes

本批新增 `live/account-state-store.ts` 与 `live/account-control.ts`：

- 账户和 `paper/live` 隔离的 JSON 状态信封；创建时必须提供权威初始化状态。
- 单账户锁、`fsync` 临时文件替换、篡改/缺失检查；重启读取失败即拒绝继续。
- 权益状态和预留状态在同一持久化记录中写入，预留写盘后才允许调用方继续访问网络。
- `AccountExecutionGate` 检查新鲜、完整权益和 50 美元剩余额度；权益未完成或已暂停时关闭门禁。
- `account-equity-adapter.ts` 将只读账户读取转换为同一观察切片；跨账户、非完整 collateral、缺持仓估值和非原子分页证据直接拒绝。
- 预留状态转换改为显式生命周期图；损失事件增加稳定 ID 去重。
- `Engine.prepareSubmission()` 在 live 模式没有账户门禁时直接拒绝，在有门禁时先校验门禁。
- CLI 的订单、累计名义金额均独立限制在 50 美元以内。

验证：`npm run typecheck` 通过；`npm test` 通过（当前 298 tests）。

仍未完成：将 CLOB/RPC 读取器的实际调用结果接入 `AccountStateStore` 初始化/滚动流程，并在 live 运行编排中创建该 gate。当前 live 入口继续保持不可执行，paper 入口不读取真实资金状态。
