import assert from "node:assert/strict";
import { parsePlatformOptions, validateMarkets } from "../cli/platform.js";
import type { MarketInfo } from "./contracts.js";

const eth: MarketInfo = {
  id: "condition-eth-cli", assetId: "eth", roundId: "1800000000", name: "eth-updown-5m-1800000000",
  startsAt: 1800000000, endsAt: 1800000300,
  instruments: [
    { tokenId: "eth-yes-cli", outcome: "YES", marketId: "condition-eth-cli", tickSize: 0.01, minOrderSize: 1 },
    { tokenId: "eth-no-cli", outcome: "NO", marketId: "condition-eth-cli", tickSize: 0.01, minOrderSize: 1 },
  ],
};

const options = parsePlatformOptions(["--live", "--asset", "ETH"]);
assert.equal(options?.assetId, "eth");
assert.equal(options?.referenceFeed, false);
assert.throws(() => parsePlatformOptions(["--live", "--asset", "xrp"]), /unsupported --asset xrp/);
assert.equal(validateMarkets([eth], "eth")[0]?.assetId, "eth");
assert.throws(() => validateMarkets([eth], "btc"), /BTC five-minute market/);

console.log("runtime-cli-asset.test: PASS");
