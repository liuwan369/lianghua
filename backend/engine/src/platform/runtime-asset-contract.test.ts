import { strict as assert } from "node:assert";
import { TradingPlatform } from "./platform.js";
import { referenceAssetFromFeedPayload, referenceProducerForAsset } from "./polymarket.js";
import { createBtcReversalStrategy } from "../strategies/btc-reversal.js";
import type { Instrument, MarketBookSnapshot, MarketInfo } from "./contracts.js";

const marketId = "condition-eth";
const yes: Instrument = { tokenId: "eth-yes", marketId, outcome: "YES", tickSize: 0.01, minOrderSize: 1 };
const no: Instrument = { tokenId: "eth-no", marketId, outcome: "NO", tickSize: 0.01, minOrderSize: 1 };
const market: MarketInfo = {
  id: marketId, assetId: "eth", referenceProducer: referenceProducerForAsset("eth"),
  roundId: "2000", name: "eth-updown-5m-2000", startsAt: 2000, endsAt: 2300, instruments: [yes, no],
};

function snapshot(assetId: "eth" | "btc"): MarketBookSnapshot {
  return {
    assetId, marketId, roundId: "2000", sequence: 1, sourceAt: 2000, expiresAt: 2299, tsUnix: 2000,
    YES: { assetId: yes.tokenId, bid: 0.45, ask: 0.5, sourceAt: 2000, expiresAt: 2299, sequence: 1 },
    NO: { assetId: no.tokenId, bid: 0.45, ask: 0.5, sourceAt: 2000, expiresAt: 2299, sequence: 1 },
  };
}

let now = 2000;
const platform = new TradingPlatform({
  account: { accountId: "asset-test", at: now, cashUsd: 100, positions: [], openOrders: [], complete: true },
  instruments: [yes, no], limits: { capitalUsd: 100, maxOrderUsd: 100, maxOpenOrders: 10 },
  adapters: { gateway: { mode: "live", submit: async () => ({ status: "accepted" }), cancel: async () => true } },
  now: () => now,
});
platform.ingest({ kind: "market", market });
const strategy = createBtcReversalStrategy({ assetId: "eth" }, { persist: () => undefined });
platform.attach(strategy);

assert.equal(platform.ingestSnapshot(snapshot("btc")), false, "a BTC snapshot cannot enter the ETH market");
assert.equal(platform.ingestSnapshot(snapshot("eth")), true, "the selected ETH paired snapshot is accepted");
assert.equal(strategy.getStatus().rounds[0]?.assetId, "eth");
assert.equal(strategy.getStatus().rounds[0]?.roundId, "2000");
assert.equal(referenceProducerForAsset("eth"), "eth-reference");
assert.equal(referenceAssetFromFeedPayload({ asset: "eth", price: 3200 }), "eth");
assert.equal(referenceAssetFromFeedPayload({ asset: "btc", price: 100000 }), "btc");
assert.equal(referenceAssetFromFeedPayload({ assetId: "eth", price: 3200 }), "eth");
assert.equal(referenceAssetFromFeedPayload({ price: 100000 }), undefined, "reference asset must be explicit");

console.log("runtime-asset-contract.test: PASS");
