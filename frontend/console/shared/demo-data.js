"use strict";
(() => {
  const markets = [
    { assetId: "btc", symbol: "BTC", name: "\u6BD4\u7279\u5E01", english: "Bitcoin", icon: "₿", tone: "btc", cycle: "5m", marketId: "preview-btc-5m", roundId: "preview-btc-round", yesBid: .486, yesAsk: .492, noBid: .508, noAsk: .514, volume: 284600, liquidity: 68400, spread: .006, close: "14:10:00", remaining: "02:18", enabled: true, current: true }
  ];
  window.PolyPreviewDemo = Object.freeze({
    markets: Object.freeze(markets),
    marketPool: Object.freeze({ desiredIds: ["btc"], currentIds: ["btc"], nextRoundIds: [] })
  });
})();
