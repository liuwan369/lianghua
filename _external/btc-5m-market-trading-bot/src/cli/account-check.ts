/** Machine-readable, read-only bridge. Never log an exception or credential. */
import { preflightReport } from "../live/onchain.js";
import { loadAccountConfig } from "../live/account.js";

try {
  const config = loadAccountConfig();
  if (!config.depositWallet || config.errors.length) throw new Error("invalid config");
  const report = await preflightReport(config.depositWallet);
  const blocked = (process.env.PM_BLOCKED_OWNER_ADDRESSES ?? "").toLowerCase().split(",").map(value => value.trim());
  const compromised = Boolean(config.ownerSigner && blocked.includes(config.ownerSigner.toLowerCase()));
  const checks = [
    { name: "账户地址", ok: report.signatureType === 0 || report.signatureType === 3,
      detail: report.signatureType === 3 ? "平台资金钱包" : report.signatureType === 0 ? "普通钱包" : "暂不支持此钱包类型" },
    { name: "签名账户", ok: report.ownerMatchesSigner === true,
      detail: !report.ownerSignerPresent ? "请填写订单签名私钥" : report.ownerMatchesSigner ? "与资金账户匹配" : "私钥与资金账户不匹配" },
    { name: "凭据安全", ok: !compromised, detail: compromised ? "此签名账户已记录凭据暴露，请更换安全账户" : "未命中已知暴露记录（不代表绝对安全）" },
    { name: "链上余额", ok: report.pusdOnChain >= 2, detail: "$" + report.pusdOnChain.toFixed(2) + "，交易可用余额仍需平台确认" },
    { name: "网络手续费", ok: report.signatureType !== 0 || report.polGas >= 0.05,
      detail: report.signatureType === 0 ? report.polGas.toFixed(4) + " POL（当前预检要求至少 0.05）" : "平台资金钱包可通过 Relayer 操作" },
    { name: "交易授权", ok: report.approvalsFullyReady === true,
      detail: report.approvalsFullyReady === null ? "查询失败，请重试" : report.approvalsFullyReady ? "授权齐全" : `缺资金授权 ${report.missingErc20Approvals} 项、持仓授权 ${report.missingErc1155Approvals} 项` },
  ];
  console.log(JSON.stringify({ wallet: report.collateralWallet, owner: report.walletOwner ?? config.ownerSigner ?? null,
    signer_matches: report.ownerMatchesSigner === true, compromised,
    balance: report.pusdOnChain, approvals_ready: report.approvalsFullyReady,
    account_ready: report.ready && !compromised, checks,
    checked_at: new Date().toISOString(), read_only: true }));
} catch {
  console.log(JSON.stringify({ error: "账户检查未完成，请核对地址与密钥格式，并检查网络后重试。" }));
  process.exitCode = 1;
}
