import { readFileSync } from "node:fs";
import { SignatureTypeV2 } from "@polymarket/clob-client-v2";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  checkPublicAccount,
  loadAccountConfig,
  ownerSignerPrivateKey,
} from "./account.js";
import { ClobWrapper } from "./clob/client.js";
import {
  COLLATERAL_ONRAMP,
  CTF,
  CTF_EXCHANGE,
  PUSD,
  USDC_E,
} from "./contracts.js";
import {
  envWalletOverrides,
  resolveWallet,
  signatureTypeLabel,
} from "./clob/wallet.js";

export {
  CTF,
  CTF_EXCHANGE,
  NEG_RISK_CTF_EXCHANGE,
  PUSD,
  USDC_E,
  COLLATERAL_ONRAMP,
  COLLATERAL_OFFRAMP,
} from "./contracts.js";

const DEFAULT_RPC = "https://polygon-bor-rpc.publicnode.com";

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const onrampAbi = parseAbi([
  "function wrap(address _asset, address _to, uint256 _amount) external",
]);

const ctfAbi = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
]);

function rpcUrl(): string {
  return process.env.POLYGON_RPC ?? DEFAULT_RPC;
}

function keyAddress(): Address | undefined {
  const key = ownerSignerPrivateKey();
  if (!key) return undefined;
  try {
    return privateKeyToAccount(key).address;
  } catch {
    return undefined;
  }
}

function privateKeyHex(): Hex | undefined {
  return ownerSignerPrivateKey();
}

function sel(cd: Hex): string {
  return cd.slice(0, 10);
}

function toF64(v: bigint, decimals: number): number {
  return Number.parseFloat(formatUnits(v, decimals));
}

/** CLOB-reported tradable collateral (pUSD) after balance sync. */
export async function fetchClobCollateralUsd(key: string): Promise<number> {
  const wrapper = await ClobWrapper.connect({ key });
  try {
    return await wrapper.syncCollateralBalance();
  } finally {
    wrapper.stopHeartbeat();
  }
}

export interface PreflightOptions {
  /** When true, throw if wallet is not ready for live trading. */
  strict?: boolean;
}

export interface PreflightReport {
  ready: boolean;
  collateralWallet: Address;
  signatureType: number | null;
  walletSource: string;
  gasWallet: Address;
  walletOwner: Address | null;
  ownerSignerPresent: boolean;
  ownerMatchesSigner: boolean | null;
  approvalsFullyReady: boolean | null;
  missingErc20Approvals: number;
  missingErc1155Approvals: number;
  approvalsError: string | null;
  otherApprovalsMissing?: number;
  configErrors: string[];
  clobUsd: number | null;
  pusdOnChain: number;
  usdcOnChain: number;
  polGas: number;
  pUsdAllowance: number;
}

/** READ-ONLY pre-flight: pUSD / CLOB balance + POL gas (CLOB V2). */
export async function preflight(
  address?: string,
  opts?: PreflightOptions,
): Promise<boolean> {
  const report = await preflightReport(address);
  printPreflight(report);
  if (opts?.strict && !report.ready) {
    throw new Error(
      "账户预检未通过：需核对 Owner/Session 签名、资金和当前 CLOB V2 交易授权",
    );
  }
  return report.ready;
}

export async function preflightReport(
  address?: string,
): Promise<PreflightReport> {
  const client = createPublicClient({
    chain: polygon,
    transport: http(rpcUrl()),
  });

  const eoa = keyAddress();
  const accountConfig = loadAccountConfig();
  const overrides = envWalletOverrides();

  let collat: Address;
  let sigType: number | null = null;
  let walletSource = "资金地址待核对";

  if (address) {
    collat = address as Address;
    if (eoa) {
      try {
        const resolved = await resolveWallet(eoa, {
          funderOverride: collat,
          sigTypeOverride: overrides.sigType,
          rpcUrl: rpcUrl(),
        });
        sigType = resolved.signatureType;
        walletSource = resolved.source;
      } catch (error) {
        walletSource = `资金地址已提供，签名关系核对失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  } else if (accountConfig.depositWallet) {
    collat = accountConfig.depositWallet;
  } else if (!eoa) {
    throw new Error(
      "未提供 --address，也没有 POLYMARKET_WALLET_ADDRESS",
    );
  } else {
    const resolved = await resolveWallet(eoa, {
      funderOverride: overrides.funder,
      sigTypeOverride: overrides.sigType,
      rpcUrl: rpcUrl(),
    });
    collat = resolved.funder;
    sigType = resolved.signatureType;
    walletSource = resolved.source;
  }

  const publicCheck = await checkPublicAccount(collat);
  if (sigType == null) {
    if (publicCheck.walletKind === "DEPOSIT_WALLET") {
      sigType = SignatureTypeV2.POLY_1271;
      walletSource = "链上 owner()：Deposit Wallet（只读识别）";
    } else if (publicCheck.walletKind === "EOA") {
      sigType = SignatureTypeV2.EOA;
      walletSource = "链上无合约代码：EOA（只读识别）";
    } else {
      walletSource = "合约钱包类型未知（只读识别）";
    }
  }
  const ownerMatchesSigner = publicCheck.owner && eoa
    ? publicCheck.owner.toLowerCase() === eoa.toLowerCase()
    : sigType === SignatureTypeV2.EOA && eoa
      ? collat.toLowerCase() === eoa.toLowerCase()
      : null;
  const gasAddr = eoa ?? publicCheck.owner ?? collat;

  const [pusdBal, usdcBal, pUsdAllow, pol] = await Promise.all([
    client.readContract({
      address: PUSD,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [collat],
    }),
    client.readContract({
      address: USDC_E,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [collat],
    }),
    client.readContract({
      address: PUSD,
      abi: erc20Abi,
      functionName: "allowance",
      args: [collat, CTF_EXCHANGE],
    }),
    client.getBalance({ address: gasAddr }),
  ]);

  const pusdF = toF64(pusdBal, 6);
  const usdcF = toF64(usdcBal, 6);
  const polF = toF64(pol, 18);
  const allowF = toF64(pUsdAllow, 6);
  // Do not authenticate or derive CLOB credentials in a command advertised as
  // read-only. Authenticated balance is checked later by the live connector.
  const clobUsd: number | null = null;

  const tradableUsd = Math.max(clobUsd ?? 0, pusdF);
  const hasFunds = tradableUsd >= 2;
  const allowanceOk = publicCheck.approvalsFullyReady === true;
  const polRequired = sigType === SignatureTypeV2.EOA;
  const polOk = !polRequired || polF >= 0.05;
  const signerOk = sigType === SignatureTypeV2.EOA
    ? Boolean(eoa) && collat.toLowerCase() === eoa?.toLowerCase()
    : sigType === SignatureTypeV2.POLY_1271
      ? ownerMatchesSigner === true
      : false;
  const ready = hasFunds && polOk && allowanceOk && signerOk && accountConfig.errors.length === 0;

  return {
    ready,
    collateralWallet: collat,
    signatureType: sigType,
    walletSource,
    gasWallet: gasAddr,
    walletOwner: publicCheck.owner ?? null,
    ownerSignerPresent: Boolean(eoa),
    ownerMatchesSigner,
    approvalsFullyReady: publicCheck.approvalsFullyReady,
    missingErc20Approvals: publicCheck.missingErc20Approvals,
    missingErc1155Approvals: publicCheck.missingErc1155Approvals,
    approvalsError: publicCheck.approvalsError ?? null,
    otherApprovalsMissing: publicCheck.otherApprovalsMissing,
    configErrors: accountConfig.errors,
    clobUsd,
    pusdOnChain: pusdF,
    usdcOnChain: usdcF,
    polGas: polF,
    pUsdAllowance: allowF,
  };
}

function printPreflight(r: PreflightReport): void {
  const clobLine =
    r.clobUsd != null
      ? `  CLOB tradable (pUSD):          $${r.clobUsd.toFixed(2)}   ${r.clobUsd >= 2 ? "✅" : "❌"}`
      : "  CLOB tradable (pUSD):          (skipped — no key or check failed)";

  console.log("================ 交易账户只读预检 ================");
  console.log(`  资金钱包:         ${r.collateralWallet}`);
  console.log(`  钱包类型:         ${r.signatureType == null ? "未知" : signatureTypeLabel(r.signatureType)}`);
  console.log(`  识别依据:         ${r.walletSource}`);
  console.log(`  Owner:            ${r.walletOwner ?? "未识别"}`);
  console.log(`  Owner 签名凭据:   ${r.ownerSignerPresent ? "已配置" : "未配置（只能只读）"}`);
  console.log(`  签名关系:         ${r.ownerMatchesSigner == null ? "尚未核对" : r.ownerMatchesSigner ? "匹配" : "不匹配"}`);
  console.log(`  Gas 地址:         ${r.gasWallet}`);
  console.log(clobLine);
  console.log(
    `  pUSD on-chain:                 $${r.pusdOnChain.toFixed(2)}   ${r.pusdOnChain >= 2 ? "✅" : "—"}`,
  );
  console.log(
    `  USDC.e on-chain (unwrap/wrap): $${r.usdcOnChain.toFixed(2)}   ${r.usdcOnChain >= 2 && r.pusdOnChain < 2 ? "⚠ wrap via UI or \`wrap --broadcast\`" : "—"}`,
  );
  console.log(
    `  POL (gas) on EOA:              ${r.polGas.toFixed(3)}   ${r.polGas >= 0.05 ? "✅" : r.signatureType === SignatureTypeV2.EOA ? "❌" : "— (optional for proxy CLOB trading)"}`,
  );
  console.log(
    `  pUSD→Exchange allowance: ${r.pUsdAllowance > 1e12 ? "unlimited" : r.pUsdAllowance.toFixed(2)}   ${r.pUsdAllowance > 0 ? "✅" : r.signatureType !== SignatureTypeV2.EOA ? "(proxy-managed)" : "❌ run approve --broadcast"}`,
  );
  console.log(
    `  当前 CLOB V2 交易授权: ${r.approvalsFullyReady === true ? "是" : r.approvalsFullyReady === false ? "否" : "查询失败"}` +
      `（缺 ERC20 ${r.missingErc20Approvals} 项，ERC1155 ${r.missingErc1155Approvals} 项）`,
  );
  if (r.approvalsError) console.log(`  授权查询错误:      ${r.approvalsError}`);
  if (r.configErrors.length > 0) console.log(`  配置错误:          ${r.configErrors.join("；")}`);
  if (r.pusdOnChain >= 2 && (r.clobUsd ?? 0) < 2) {
    console.log(
      "  ℹ pUSD on-chain but CLOB ledger low — live connect syncs balance; if orders reject, refresh deposit on polymarket.com",
    );
  }
  console.log(`\n${r.ready ? "✅ 已满足旧执行器预检" : "❌ 尚不能实盘（见上方缺项）"}`);
  console.log("（本命令只读，不签名、不下单。）");
}

/** Approve pUSD for CTF Exchange V2 (EOA wallets). Proxy wallets are UI-managed. */
export async function approve(broadcast: boolean): Promise<void> {
  const cd = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [CTF_EXCHANGE, 2n ** 256n - 1n],
  });
  console.log(`approve pUSD -> CTF Exchange V2 ${CTF_EXCHANGE}`);
  console.log(`  selector ${sel(cd)} (${cd.length / 2 - 1} bytes calldata)`);
  if (!broadcast) {
    console.log("  DRY-RUN — add --broadcast + POLYMARKET_PRIVATE_KEY + POL.");
    return;
  }

  const pk = privateKeyHex();
  if (!pk) throw new Error("--broadcast requires POLYMARKET_PRIVATE_KEY");
  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(rpcUrl()),
  });
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(rpcUrl()),
  });

  const resolved = await resolveWallet(account.address, {
    funderOverride: envWalletOverrides().funder,
    sigTypeOverride: envWalletOverrides().sigType,
    rpcUrl: rpcUrl(),
  });
  const owner = resolved.funder;
  if (resolved.signatureType !== SignatureTypeV2.EOA
    || owner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("此命令仅支持普通 EOA 钱包；平台资金钱包必须通过其自身的授权流程，不能由 Owner 地址直接代替授权。");
  }

  const existing = await publicClient.readContract({
    address: PUSD,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, CTF_EXCHANGE],
  });
  if (existing > 0n) {
    console.log("  pUSD already approved for V2 exchange — nothing to do.");
    return;
  }

  const hash = await walletClient.writeContract({
    chain: polygon,
    account,
    address: PUSD,
    abi: erc20Abi,
    functionName: "approve",
    args: [CTF_EXCHANGE, 2n ** 256n - 1n],
  });
  console.log(`  ✅ approval tx sent: ${hash}`);
}

/** Wrap USDC.e → pUSD via CollateralOnramp (API-only path; UI users auto-wrap). */
export async function wrap(
  amountUsd: number,
  broadcast: boolean,
): Promise<void> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error("amount must be finite and > 0");
  const amount = parseUnits(amountUsd.toFixed(6), 6);

  console.log(
    `wrap $${amountUsd.toFixed(2)} USDC.e -> pUSD via Onramp ${COLLATERAL_ONRAMP}`,
  );
  if (!broadcast) {
    console.log("  DRY-RUN — add --broadcast + POLYMARKET_PRIVATE_KEY + POL.");
    return;
  }

  const pk = privateKeyHex();
  if (!pk) throw new Error("--broadcast requires POLYMARKET_PRIVATE_KEY");
  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(rpcUrl()),
  });
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(rpcUrl()),
  });

  const resolved = await resolveWallet(account.address, {
    funderOverride: envWalletOverrides().funder,
    sigTypeOverride: envWalletOverrides().sigType,
    rpcUrl: rpcUrl(),
  });
  const recipient = resolved.funder;

  const usdcBal = await publicClient.readContract({
    address: USDC_E,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (usdcBal < amount) {
    throw new Error(
      `EOA USDC.e balance $${toF64(usdcBal, 6).toFixed(2)} < wrap amount $${amountUsd}`,
    );
  }

  const approveHash = await walletClient.writeContract({
    chain: polygon,
    account,
    address: USDC_E,
    abi: erc20Abi,
    functionName: "approve",
    args: [COLLATERAL_ONRAMP, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`  USDC.e approved for onramp: ${approveHash}`);

  const wrapHash = await walletClient.writeContract({
    chain: polygon,
    account,
    address: COLLATERAL_ONRAMP,
    abi: onrampAbi,
    functionName: "wrap",
    args: [USDC_E, recipient, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: wrapHash });
  console.log(`  ✅ wrapped to pUSD (recipient ${recipient}): ${wrapHash}`);
}

/** Redeem resolved positions for conditionIds (V2 collateral = pUSD). */
export async function settle(
  conditionIds: string[],
  fromLog: string | undefined,
  broadcast: boolean,
): Promise<void> {
  const conds = [...conditionIds];
  if (fromLog) {
    try {
      const text = readFileSync(fromLog, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const v = JSON.parse(line) as {
            conditionId?: string;
            condition?: string;
          };
          const c = v.conditionId ?? v.condition;
          if (c) conds.push(c);
        } catch {
          /* skip bad lines */
        }
      }
    } catch {
      /* ignore missing log */
    }
  }

  const unique = [...new Set(conds.filter(Boolean))];
  if (unique.length === 0) {
    console.log("no conditionIds (use --condition-id or --from-log)");
    return;
  }

  let walletClient:
    | ReturnType<typeof createWalletClient>
    | undefined;
  if (broadcast) {
    const pk = privateKeyHex();
    if (!pk) throw new Error("--broadcast requires POLYMARKET_PRIVATE_KEY");
    const account = privateKeyToAccount(pk);
    const resolved = await resolveWallet(account.address, {
      funderOverride: envWalletOverrides().funder,
      sigTypeOverride: envWalletOverrides().sigType,
      rpcUrl: rpcUrl(),
    });
    if (resolved.signatureType !== SignatureTypeV2.EOA
      || resolved.funder.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error("此结算命令仅支持普通 EOA 钱包；平台资金钱包的持仓必须由其自身的结算流程赎回。");
    }
    walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(rpcUrl()),
    });
  }

  const zeroBytes32 = `0x${"0".repeat(64)}` as Hex;

  for (const cid of unique) {
    const cond = cid as Hex;
    const cd = encodeFunctionData({
      abi: ctfAbi,
      functionName: "redeemPositions",
      args: [PUSD, zeroBytes32, cond, [1n, 2n]],
    });
    console.log(
      `condition ${cid.slice(0, 14)}…  redeemPositions (pUSD)  selector ${sel(cd)}`,
    );
    if (walletClient) {
      try {
        const hash = await walletClient.writeContract({
          chain: polygon,
          account: walletClient.account!,
          address: CTF,
          abi: ctfAbi,
          functionName: "redeemPositions",
          args: [PUSD, zeroBytes32, cond, [1n, 2n]],
        });
        console.log(`  ✅ broadcast tx ${hash}`);
      } catch (e) {
        console.log(`  ⚠ redeem failed for ${cid}: ${e}`);
      }
    }
  }

  if (!broadcast) {
    console.log("DRY-RUN — add --broadcast + key + POLYGON_RPC + POL gas to redeem.");
  }
}

export { sel, toF64 };
