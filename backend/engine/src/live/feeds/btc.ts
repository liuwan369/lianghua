/** Exchange product codes per coin. The collector (cli/market-snapshot.ts)
 * subscribes to each coin's Binance 1 s kline with them; the engine
 * (cli/platform.ts) subscribes to the coin's Binance aggTrade. */

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

/** The exact public venue products for a supported coin. */
export function referenceVenueProducts(asset = "btc"): ReferenceVenueProducts {
  const normalized = asset.trim().toLowerCase();
  const products = Object.hasOwn(REFERENCE_ASSETS, normalized) ? REFERENCE_ASSETS[normalized] : undefined;
  if (!products) throw new Error(`no exchange products for ${asset}`);
  return { ...products };
}
