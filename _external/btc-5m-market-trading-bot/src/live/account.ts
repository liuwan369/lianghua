import {
  createPublicClient as createPolymarketPublicClient,
  forkEnvironmentConfig,
} from "@polymarket/client";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { inspectWalletAddress } from "./clob/wallet.js";
import { CTF, CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE, PUSD } from "./contracts.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

function rawValue(name: string): string | undefined {
  return process.env[name]?.trim().replace(/^['"]|['"]$/g, "").trim();
}

function value(name: string): string | undefined {
  const raw = rawValue(name);
  return raw && !/^<.*>$/.test(raw) && !/YOUR_|真实值|已隐藏/i.test(raw)
    ? raw
    : undefined;
}

function address(name: string): Address | undefined {
  const raw = value(name);
  return raw && ADDRESS_RE.test(raw) ? getAddress(raw) : undefined;
}

function privateKey(name: string): Hex | undefined {
  const raw = value(name);
  if (!raw || !PRIVATE_KEY_RE.test(raw)) return undefined;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

export interface AccountConfigStatus {
  depositWallet?: Address;
  ownerPrivateKey?: Hex;
  ownerSigner?: Address;
  sessionPrivateKey?: Hex;
  sessionSigner?: Address;
  relayerApiKeyPresent: boolean;
  relayerApiKeyAddress?: Address;
  builderCredentialsPresent: boolean;
  errors: string[];
}

/** Parse only documented fields. Free-form text and unknown names are ignored. */
export function loadAccountConfig(): AccountConfigStatus {
  const errors: string[] = [];
  const depositWallet = address("POLYMARKET_WALLET_ADDRESS") ?? address("POLY_FUNDER");
  const explicitOwner = rawValue("POLYMARKET_OWNER_PRIVATE_KEY");
  const ownerPrivateKey = explicitOwner != null
    ? privateKey("POLYMARKET_OWNER_PRIVATE_KEY")
    : privateKey("POLYMARKET_PRIVATE_KEY");
  const sessionPrivateKey = privateKey("POLYMARKET_SESSION_PRIVATE_KEY");
  const relayerApiKeyAddress = address("RELAYER_API_KEY_ADDRESS");

  let ownerSigner: Address | undefined;
  let sessionSigner: Address | undefined;
  try {
    if (ownerPrivateKey) ownerSigner = privateKeyToAccount(ownerPrivateKey).address;
    if (sessionPrivateKey) sessionSigner = privateKeyToAccount(sessionPrivateKey).address;
  } catch {
    errors.push("签名私钥格式无效");
  }

  if (value("POLYMARKET_WALLET_ADDRESS") && !address("POLYMARKET_WALLET_ADDRESS")) {
    errors.push("资金钱包地址格式无效");
  }
  if (value("POLYMARKET_OWNER_PRIVATE_KEY") && !privateKey("POLYMARKET_OWNER_PRIVATE_KEY")) {
    errors.push("Owner 私钥格式无效");
  }
  if (value("POLYMARKET_SESSION_PRIVATE_KEY") && !sessionPrivateKey) {
    errors.push("Session Key 格式无效");
  }

  return {
    depositWallet,
    ownerPrivateKey,
    ownerSigner,
    sessionPrivateKey,
    sessionSigner,
    relayerApiKeyPresent: Boolean(value("RELAYER_API_KEY")),
    relayerApiKeyAddress,
    builderCredentialsPresent: Boolean(
      value("POLY_BUILDER_API_KEY") &&
        value("POLY_BUILDER_SECRET") &&
        value("POLY_BUILDER_PASSPHRASE"),
    ),
    errors,
  };
}

export function ownerSignerPrivateKey(): Hex | undefined {
  return loadAccountConfig().ownerPrivateKey;
}

export interface PublicAccountCheck {
  wallet: Address;
  walletKind: "EOA" | "DEPOSIT_WALLET" | "CONTRACT_UNKNOWN";
  owner?: Address;
  ownerMatchesConfiguredSigner: boolean | null;
  approvalsFullyReady: boolean | null;
  missingErc20Approvals: number;
  missingErc1155Approvals: number;
  approvalsError?: string;
  /** SDK requirements for other products, outside this engine's CLOB V2 route. */
  otherApprovalsMissing?: number;
}

/** Official-SDK + Polygon read-only checks. Never signs or submits anything. */
export async function checkPublicAccount(wallet: Address): Promise<PublicAccountCheck> {
  const config = loadAccountConfig();
  const inspected = await inspectWalletAddress(wallet);
  let approvalsFullyReady: boolean | null = null;
  let missingErc20Approvals = 0;
  let missingErc1155Approvals = 0;
  let approvalsError: string | undefined;
  let otherApprovalsMissing = 0;
  try {
    const response = await fetch(`${process.env.CLOB_HOST ?? "https://clob.polymarket.com"}/version`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || (await response.json() as {version?: unknown}).version !== 2) {
      throw new Error("CLOB V2 approval scope cannot be verified");
    }
    // Keep production contracts/endpoints while using the same Polygon node as
    // wallet inspection and balance queries (including retry-selected nodes).
    const client = createPolymarketPublicClient({
      environment: forkEnvironmentConfig({
        name: "production-account-check",
        ...(process.env.POLYGON_RPC?.trim() ? {rpc: process.env.POLYGON_RPC.trim()} : {}),
      }),
    });
    const state = await client.fetchTradingApprovalsState({ user: wallet });
    const { erc20, erc1155 } = state.missing;
    if (!Array.isArray(erc20) || !Array.isArray(erc1155)
      || erc20.some(a => !ADDRESS_RE.test(a.tokenAddress) || !ADDRESS_RE.test(a.spenderAddress))
      || erc1155.some(a => !ADDRESS_RE.test(a.tokenAddress) || !ADDRESS_RE.test(a.operatorAddress))
      || state.isFullyApproved !== (erc20.length + erc1155.length === 0)) {
      throw new Error("invalid approval response");
    }
    // The SDK's global setup also includes Perps deposits and protocol V3
    // modules. Only the two CLOB V2 exchange routes are used by this engine.
    // The order adapter independently rejects any server version other than 2.
    const exchanges = new Set([CTF_EXCHANGE.toLowerCase(), NEG_RISK_CTF_EXCHANGE.toLowerCase()]);
    missingErc20Approvals = erc20.filter(a => a.tokenAddress.toLowerCase() === PUSD.toLowerCase()
      && exchanges.has(a.spenderAddress.toLowerCase())).length;
    missingErc1155Approvals = erc1155.filter(a => a.tokenAddress.toLowerCase() === CTF.toLowerCase()
      && exchanges.has(a.operatorAddress.toLowerCase())).length;
    otherApprovalsMissing = erc20.length + erc1155.length - missingErc20Approvals - missingErc1155Approvals;
    approvalsFullyReady = missingErc20Approvals + missingErc1155Approvals === 0;
  } catch {
    // Provider errors may contain credential-bearing RPC URLs.
    approvalsError = "交易授权查询失败，请检查 Polygon RPC 和 CLOB V2 服务后重试。";
  }

  return {
    wallet,
    walletKind: inspected.walletKind,
    owner: inspected.owner,
    ownerMatchesConfiguredSigner:
      inspected.owner && config.ownerSigner
        ? inspected.owner.toLowerCase() === config.ownerSigner.toLowerCase()
        : null,
    approvalsFullyReady,
    missingErc20Approvals,
    missingErc1155Approvals,
    approvalsError,
    otherApprovalsMissing,
  };
}
