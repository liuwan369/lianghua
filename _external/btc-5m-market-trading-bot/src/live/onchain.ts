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
  const key = process.env.POLYMARKET_PRIVATE_KEY;
  if (!key) return undefined;
  const s = key.startsWith("0x") ? key : `0x${key}`;
  try {
    return privateKeyToAccount(s as Hex).address;
  } catch {
    return undefined;
  }
}

function privateKeyHex(): Hex | undefined {
  const key = process.env.POLYMARKET_PRIVATE_KEY;
  if (!key) return undefined;
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
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
  signatureType: number;
  walletSource: string;
  gasWallet: Address;
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
      "preflight failed — fund Polymarket (pUSD), ensure POL gas, or run `wrap --broadcast` if USDC.e is unwrapped",
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
  const overrides = envWalletOverrides();

  let collat: Address;
  let sigType = SignatureTypeV2.EOA;
  let walletSource = "EOA";

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
      } catch {
        /* use defaults */
      }
    }
  } else if (!eoa) {
    throw new Error(
      "no --address and no POLYMARKET_PRIVATE_KEY in env",
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

  const gasAddr = eoa ?? collat;

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
  const pUsdApproved = pUsdAllow > 0n;

  let clobUsd: number | null = null;
  const pk = privateKeyHex();
  if (pk && !address) {
    try {
      clobUsd = await fetchClobCollateralUsd(process.env.POLYMARKET_PRIVATE_KEY!);
    } catch (e) {
      console.warn(`CLOB balance check failed (${e}) — using on-chain pUSD only`);
    }
  }

  const tradableUsd = Math.max(clobUsd ?? 0, pusdF);
  const hasFunds = tradableUsd >= 2;
  const allowanceOk = pUsdApproved || sigType !== SignatureTypeV2.EOA;
  const polRequired = sigType === SignatureTypeV2.EOA;
  const polOk = !polRequired || polF >= 0.05;
  const ready = hasFunds && polOk && allowanceOk;

  return {
    ready,
    collateralWallet: collat,
    signatureType: sigType,
    walletSource,
    gasWallet: gasAddr,
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

  console.log("================ LIVE PRE-FLIGHT (CLOB V2 / pUSD) ================");
  console.log(`  collateral wallet: ${r.collateralWallet}`);
  console.log(`  signature type:    ${signatureTypeLabel(r.signatureType)}`);
  console.log(`  detection:         ${r.walletSource}`);
  console.log(`  gas wallet (EOA):  ${r.gasWallet}`);
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
  if (r.pusdOnChain >= 2 && (r.clobUsd ?? 0) < 2) {
    console.log(
      "  ℹ pUSD on-chain but CLOB ledger low — live connect syncs balance; if orders reject, refresh deposit on polymarket.com",
    );
  }
  console.log(`\n${r.ready ? "✅ READY" : "❌ NOT READY (see above)"}`);
  console.log("(read-only unless you run approve/wrap with --broadcast.)");
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
  if (amountUsd <= 0) throw new Error("amount must be > 0");
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

  const seen = new Set<string>();
  const unique = conds.filter((c) => c && seen.add(c));
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
    walletClient = createWalletClient({
      account: privateKeyToAccount(pk),
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
