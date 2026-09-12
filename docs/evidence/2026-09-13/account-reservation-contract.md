# EXEC-02: Atomic Reservation Contract

日期：2026-09-13，Asia/Shanghai。状态：离线状态机完成，尚未接入执行器、权威账户适配或持久化文件。

`account-reservation.ts` 将每笔提交的本金和费用预留按微美元原子记录。活动状态包括 `prepared`、`submitted`、`unknown`、`acknowledged`、`partially_filled` 和 `settlement_pending`；只有显式 `reconciled` 才释放额度。固定本金上限为 50 美元，钱包余额不会放大该上限；累计日损失达到 30 美元后粘滞停机。

验证包含费用计入、超额拒绝、未知 ACK 保留额度、重复 ID、状态和时间倒退、整数溢出、篡改 JSON 与序列化恢复。独立审查发现并修复了损失停机标志可被清除及回执时间倒退问题；修复后 `account-reservation.test.ts` **5 项通过**，引擎 `typecheck` 通过。

该模块没有网络、签名或下单调用。下一步由执行 Agent 接入 `Executor`/`Engine.prepareSubmission()` 的同账户互斥段，并将权威余额、存量持仓、费用和未知提交回执映射进预留状态；完成前保持 `execution_ready=false`。
