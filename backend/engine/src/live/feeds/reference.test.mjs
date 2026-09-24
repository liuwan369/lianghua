import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReferenceFeedUnsupportedError,
  referenceFeedCapability,
  referenceEvent,
  referenceVenueProducts,
  runReferenceFeed,
} from "../../../dist/live/feeds/btc.js";

test("reference products are parameterized and do not reuse BTC symbols", () => {
  assert.deepEqual(referenceFeedCapability("BTC"), { asset: "btc", supported: true });
  assert.deepEqual(referenceFeedCapability("eth"), { asset: "eth", supported: true });
  assert.deepEqual(referenceFeedCapability("sol"), { asset: "sol", supported: true });

  const btc = referenceVenueProducts("btc");
  const eth = referenceVenueProducts("eth");
  const sol = referenceVenueProducts("sol");
  assert.equal(btc.binance, "btcusdt");
  assert.equal(eth.binance, "ethusdt");
  assert.equal(sol.binance, "solusdt");
  assert.notDeepEqual(eth, btc);
  assert.notDeepEqual(sol, btc);
  assert.equal(eth.coinbase, "ETH-USD");
  assert.equal(sol.okx, "SOL-USDT");
});

test("unsupported and disabled reference assets fail before opening a feed", () => {
  assert.deepEqual(referenceFeedCapability("xrp"), {
    asset: "xrp", supported: false, reason: "unsupported_asset",
  });
  assert.throws(() => runReferenceFeed(() => {}, "xrp"), error =>
    error instanceof ReferenceFeedUnsupportedError && error.capability.reason === "unsupported_asset");

  const previous = process.env.PM_REFERENCE_ASSETS;
  process.env.PM_REFERENCE_ASSETS = "btc,eth";
  try {
    assert.deepEqual(referenceFeedCapability("sol"), {
      asset: "sol", supported: false, reason: "disabled_by_configuration",
    });
    assert.throws(() => runReferenceFeed(() => {}, "sol"), error =>
      error instanceof ReferenceFeedUnsupportedError && error.capability.reason === "disabled_by_configuration");
  } finally {
    if (previous == null) delete process.env.PM_REFERENCE_ASSETS;
    else process.env.PM_REFERENCE_ASSETS = previous;
  }
});

test("asset-scoped reference events cannot relabel ETH or SOL as BTC", () => {
  assert.deepEqual(referenceEvent("btc", 1, 100_000), {
    kind: "btc", asset: "btc", tsUnix: 1, price: 100_000,
  });
  assert.deepEqual(referenceEvent("eth", 2, 3_000), {
    kind: "oracle", asset: "eth", tsUnix: 2, price: 3_000,
  });
  assert.deepEqual(referenceEvent("sol", 3, 150), {
    kind: "oracle", asset: "sol", tsUnix: 3, price: 150,
  });
});
