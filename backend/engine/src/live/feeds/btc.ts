/** Exchange product codes per coin. The collector (cli/market-snapshot.ts)
 * subscribes to each coin's Binance 1 s kline with them. */

export interface ReferenceFeedCapability {
  asset: string;
  supported: boolean;
  reason?: "invalid_asset" | "unsupported_asset" | "disabled_by_configuration";
}

export interface ReferenceVenueProducts {
  binance: string;
  coinbase: string;
  okx: string;
  bybit: string;
}

const REFERENCE_ASSETS: Readonly<Record<string, ReferenceVenueProducts>> = Object.freeze({
  btc: { binance: "btcusdt", coinbase: "BTC-USD", okx: "BTC-USDT", bybit: "BTCUSDT" },
  eth: { binance: "ethusdt", coinbase: "ETH-USD", okx: "ETH-USDT", bybit: "ETHUSDT" },
  sol: { binance: "solusdt", coinbase: "SOL-USD", okx: "SOL-USDT", bybit: "SOLUSDT" },
  // Each product string was verified live on all four venues before being added
  // (prices agreed across Binance/Coinbase/OKX/Bybit), including hype — the one
  // coin that could plausibly have lacked a spot pair.
  xrp: { binance: "xrpusdt", coinbase: "XRP-USD", okx: "XRP-USDT", bybit: "XRPUSDT" },
  doge: { binance: "dogeusdt", coinbase: "DOGE-USD", okx: "DOGE-USDT", bybit: "DOGEUSDT" },
  hype: { binance: "hypeusdt", coinbase: "HYPE-USD", okx: "HYPE-USDT", bybit: "HYPEUSDT" },
  bnb: { binance: "bnbusdt", coinbase: "BNB-USD", okx: "BNB-USDT", bybit: "BNBUSDT" },
});

function configuredReferenceAssets(): Set<string> | undefined {
  const raw = process.env.PM_REFERENCE_ASSETS?.trim();
  if (!raw) return undefined;
  return new Set(raw.split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
}

/** Reports whether this process has a real venue mapping for an asset. */
function referenceFeedCapability(asset = "btc"): ReferenceFeedCapability {
  const normalized = asset.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(normalized)) return { asset: String(asset), supported: false, reason: "invalid_asset" };
  if (!Object.hasOwn(REFERENCE_ASSETS, normalized)) return { asset: normalized, supported: false, reason: "unsupported_asset" };
  const configured = configuredReferenceAssets();
  if (configured && !configured.has(normalized)) {
    return { asset: normalized, supported: false, reason: "disabled_by_configuration" };
  }
  return { asset: normalized, supported: true };
}

/** Returns the exact public venue products used for the requested asset. */
export function referenceVenueProducts(asset = "btc"): ReferenceVenueProducts {
  const capability = referenceFeedCapability(asset);
  if (!capability.supported) throw new ReferenceFeedUnsupportedError(capability);
  return { ...REFERENCE_ASSETS[capability.asset]! };
}

export class ReferenceFeedUnsupportedError extends Error {
  readonly code = "reference_feed_unsupported";
  readonly capability: ReferenceFeedCapability;

  constructor(capability: ReferenceFeedCapability) {
    super(`${capability.asset}: ${capability.reason ?? "reference_feed_unsupported"}`);
    this.name = "ReferenceFeedUnsupportedError";
    this.capability = capability;
  }
}
