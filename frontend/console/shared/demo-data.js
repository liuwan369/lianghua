"use strict";
(() => {
  const markets = [
    { assetId: "btc", symbol: "BTC", name: "\u6BD4\u7279\u5E01", english: "Bitcoin", icon: "₿", tone: "btc", cycle: "5m", marketId: "preview-btc-5m", roundId: "preview-btc-round", yesBid: .486, yesAsk: .492, noBid: .508, noAsk: .514, volume: 284600, liquidity: 68400, spread: .006, close: "14:10:00", remaining: "02:18", enabled: true, current: true },
    { assetId: "eth", symbol: "ETH", name: "\u4EE5\u592A\u574A", english: "Ethereum", icon: "Ξ", tone: "eth", cycle: "5m", marketId: "preview-eth-5m", roundId: "preview-eth-round", yesBid: .521, yesAsk: .527, noBid: .473, noAsk: .479, volume: 176300, liquidity: 42900, spread: .008, close: "14:10:00", remaining: "02:18", enabled: true, current: false },
    { assetId: "sol", symbol: "SOL", name: "\u7D22\u62C9\u7EB3", english: "Solana", icon: "S", tone: "sol", cycle: "5m", marketId: "preview-sol-5m", roundId: "preview-sol-round", yesBid: .508, yesAsk: .514, noBid: .486, noAsk: .492, volume: 143900, liquidity: 36100, spread: .009, close: "14:10:00", remaining: "02:18", enabled: false, current: false },
    { assetId: "xrp", symbol: "XRP", name: "\u745E\u6CE2\u5E01", english: "XRP", icon: "X", tone: "xrp", cycle: "5m", marketId: "preview-xrp-5m", roundId: "preview-xrp-round", yesBid: .474, yesAsk: .480, noBid: .526, noAsk: .532, volume: 96700, liquidity: 22400, spread: .012, close: "14:10:00", remaining: "02:18", enabled: false, current: false },
    { assetId: "doge", symbol: "DOGE", name: "\u72D7\u72D7\u5E01", english: "Dogecoin", icon: "Ð", tone: "doge", cycle: "5m", marketId: "preview-doge-5m", roundId: "preview-doge-round", yesBid: .496, yesAsk: .502, noBid: .498, noAsk: .504, volume: 72100, liquidity: 15700, spread: .015, close: "14:10:00", remaining: "02:18", enabled: false, current: false },
    { assetId: "link", symbol: "LINK", name: "Chainlink", english: "Chainlink", icon: "L", tone: "link", cycle: "5m", marketId: "preview-link-5m", roundId: "preview-link-round", yesBid: .537, yesAsk: .543, noBid: .457, noAsk: .463, volume: 45800, liquidity: 11300, spread: .019, close: "14:10:00", remaining: "02:18", enabled: false, current: false }
  ];
  window.PolyPreviewDemo = Object.freeze({
    markets: Object.freeze(markets),
    marketPool: Object.freeze({ desiredIds: ["btc", "eth"], currentIds: ["btc"], nextRoundIds: ["eth"] })
  });
})();
