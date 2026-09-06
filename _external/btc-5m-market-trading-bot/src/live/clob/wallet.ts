import { SignatureTypeV2 } from "@polymarket/clob-client-v2";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { polygon } from "viem/chains";

const GAMMA = "https://gamma-api.polymarket.com";
const DEFAULT_RPC = "https://polygon-bor-rpc.publicnode.com";

/** Gnosis Safe `getOwners()` selector — Polymarket CLOB SDK detection. */
const GET_OWNERS_SELECTOR = "0xa0e67e2b" as const;
/** OpenZeppelin `owner()` selector. */
const OWNER_SELECTOR = "0x8da5cb5b" as const;
const ERC1271_INTERFACE_ID = "0x1626ba7e" as const;

export interface ResolvedWallet {
  signer: Address;
  funder: Address;
  signatureType: SignatureTypeV2;
  /** Human-readable resolution path for logs. */
  source: string;
}

export interface ResolveWalletOptions {
  /** Skip Gamma lookup when set. */
  funderOverride?: Address;
  /** Rare manual override — auto-detection preferred. */
  sigTypeOverride?: number;
  rpcUrl?: string;
}

export function signatureTypeLabel(t: SignatureTypeV2): string {
  switch (t) {
    case SignatureTypeV2.EOA:
      return "EOA (0)";
    case SignatureTypeV2.POLY_PROXY:
      return "POLY_PROXY (1)";
    case SignatureTypeV2.POLY_GNOSIS_SAFE:
      return "POLY_GNOSIS_SAFE (2)";
    case SignatureTypeV2.POLY_1271:
      return "POLY_1271 (3)";
    default:
      return String(t);
  }
}

function addrEq(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function rpcUrl(explicit?: string): string {
  return explicit ?? process.env.POLYGON_RPC ?? DEFAULT_RPC;
}

/** Optional env overrides — detection runs when these are unset. */
export function envWalletOverrides(): {
  funder?: Address;
  sigType?: number;
} {
  const funderRaw = process.env.POLY_FUNDER?.trim();
  const funder =
    funderRaw?.startsWith("0x") && funderRaw.length === 42
      ? (funderRaw as Address)
      : undefined;

  const stRaw = process.env.POLY_SIGNATURE_TYPE?.trim();
  let sigType: number | undefined;
  if (stRaw != null && stRaw !== "") {
    const n = Number.parseInt(stRaw, 10);
    if (Number.isFinite(n)) sigType = n;
  }

  return { funder, sigType };
}

/** Gamma API: EOA → Polymarket trading (proxy) wallet. */
export async function fetchProxyWalletFromGamma(
  eoa: Address,
): Promise<Address | undefined> {
  const url = `${GAMMA}/public-profile?address=${eoa}`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (btc-5m-live)" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) return undefined;
    const v = (await resp.json()) as { proxyWallet?: string | null };
    const pw = v.proxyWallet?.trim();
    if (!pw?.startsWith("0x") || pw.length !== 42) return undefined;
    return pw as Address;
  } catch {
    return undefined;
  }
}

async function hasContractCode(
  client: PublicClient,
  address: Address,
): Promise<boolean> {
  const code = await client.getBytecode({ address });
  return code != null && code !== "0x" && code.length > 2;
}

async function isGnosisSafe(
  client: PublicClient,
  address: Address,
): Promise<boolean> {
  try {
    const { data } = await client.call({
      to: address,
      data: GET_OWNERS_SELECTOR,
    });
    return data != null && data !== "0x" && data.length >= 66;
  } catch {
    return false;
  }
}

async function supportsErc1271(
  client: PublicClient,
  address: Address,
): Promise<boolean> {
  try {
    const data = encodeFunctionData({
      abi: parseAbi([
        "function supportsInterface(bytes4) view returns (bool)",
      ]),
      functionName: "supportsInterface",
      args: [ERC1271_INTERFACE_ID],
    });
    const result = await client.call({ to: address, data });
    if (!result.data || result.data.length < 66) return false;
    return BigInt(result.data) === 1n;
  } catch {
    return false;
  }
}

async function readOwner(
  client: PublicClient,
  address: Address,
): Promise<Address | undefined> {
  try {
    const { data } = await client.call({ to: address, data: OWNER_SELECTOR });
    if (!data || data.length < 42) return undefined;
    return `0x${data.slice(-40)}` as Address;
  } catch {
    return undefined;
  }
}

/**
 * On-chain signature type detection (Polymarket clob-client PR #333):
 * - funder == signer → EOA
 * - getOwners() succeeds → Gnosis Safe (2)
 * - ERC-1271 + owner == signer → deposit wallet POLY_1271 (3)
 * - else → Magic/proxy (1)
 */
export async function detectSignatureType(
  client: PublicClient,
  signer: Address,
  funder: Address,
): Promise<SignatureTypeV2> {
  if (addrEq(signer, funder)) {
    return SignatureTypeV2.EOA;
  }

  if (!(await hasContractCode(client, funder))) {
    throw new Error(
      `funder ${funder} is not a contract — cannot detect wallet type. ` +
        "Set POLY_FUNDER to your Polymarket trading wallet (polymarket.com/settings).",
    );
  }

  if (await isGnosisSafe(client, funder)) {
    return SignatureTypeV2.POLY_GNOSIS_SAFE;
  }

  if (await supportsErc1271(client, funder)) {
    const owner = await readOwner(client, funder);
    if (owner && addrEq(owner, signer)) {
      return SignatureTypeV2.POLY_1271;
    }
  }

  return SignatureTypeV2.POLY_PROXY;
}

/** Resolve funder + signature type from signer key address. */
export async function resolveWallet(
  signer: Address,
  opts: ResolveWalletOptions = {},
): Promise<ResolvedWallet> {
  const client = createPublicClient({
    chain: polygon,
    transport: http(rpcUrl(opts.rpcUrl)),
  });

  let funder = opts.funderOverride;
  let source: string;

  if (funder) {
    source = "POLY_FUNDER override";
  } else {
    const proxy = await fetchProxyWalletFromGamma(signer);
    if (proxy && !addrEq(proxy, signer)) {
      funder = proxy;
      source = "gamma-api proxyWallet";
    } else {
      funder = signer;
      source = proxy ? "gamma-api (same as EOA)" : "EOA (no proxy in profile)";
    }
  }

  if (opts.sigTypeOverride != null && Number.isFinite(opts.sigTypeOverride)) {
    return {
      signer,
      funder,
      signatureType: opts.sigTypeOverride as SignatureTypeV2,
      source: `${source} + POLY_SIGNATURE_TYPE override`,
    };
  }

  const signatureType = await detectSignatureType(client, signer, funder);
  return {
    signer,
    funder,
    signatureType,
    source: `${source} → ${signatureTypeLabel(signatureType)}`,
  };
}
