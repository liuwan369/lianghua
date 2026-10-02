import { SignatureTypeV2 } from "@polymarket/clob-client-v2";
import {
  createPublicClient,
  formatUnits,
  http,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  checkPublicAccount,
  loadAccountConfig,
  ownerSignerPrivateKey,
} from "./account.js";
import {
  CTF_EXCHANGE,
  PUSD,
  USDC_E,
} from "./contracts.js";
import {
  envWalletOverrides,
  resolveWallet,
} from "./clob/wallet.js";

const DEFAULT_RPC = "https://polygon-bor-rpc.publicnode.com";

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
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

function toF64(v: bigint, decimals: number): number {
  return Number.parseFloat(formatUnits(v, decimals));
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
  settlementCredentialsReady: boolean;
  otherApprovalsMissing?: number;
  configErrors: string[];
  clobUsd: number | null;
  pusdOnChain: number;
  usdcOnChain: number;
  polGas: number;
  pUsdAllowance: number;
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
  const ready = hasFunds && polOk && allowanceOk && signerOk
    && publicCheck.settlementCredentialsReady === true && accountConfig.errors.length === 0;

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
    settlementCredentialsReady: publicCheck.settlementCredentialsReady,
    otherApprovalsMissing: publicCheck.otherApprovalsMissing,
    configErrors: accountConfig.errors,
    clobUsd,
    pusdOnChain: pusdF,
    usdcOnChain: usdcF,
    polGas: polF,
    pUsdAllowance: allowF,
  };
}
