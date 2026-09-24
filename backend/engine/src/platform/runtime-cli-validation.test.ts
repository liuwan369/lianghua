import assert from "node:assert/strict";
import { validateMarkets } from "../cli/platform.js";
import type { MarketInfo } from "./contracts.js";

const btc: MarketInfo = {
  id: "condition-btc",
  roundId: "1800000000",
  name: "btc-updown-5m-1800000000",
  startsAt: 1800000000,
  endsAt: 1800000300,
  instruments: [
    { tokenId: "btc-up", outcome: "UP", marketId: "condition-btc", tickSize: 0.01, minOrderSize: 1 },
    { tokenId: "btc-down", outcome: "DOWN", marketId: "condition-btc", tickSize: 0.01, minOrderSize: 1 },
  ],
};

assert.equal(validateMarkets([btc])[0]?.roundId, "1800000000");

const reject = (market: MarketInfo, message: string): void => {
  assert.throws(() => validateMarkets([market]), /BTC five-minute market/, message);
};

reject({ ...btc, name: "eth-updown-5m-1800000000" }, "non-BTC markets cannot enter btc-reversal");
reject({ ...btc, asset: "eth" } as MarketInfo, "an explicit non-BTC asset cannot enter btc-reversal");
reject({ ...btc, name: "btc-updown-15m-1800000000" }, "non-five-minute names cannot enter btc-reversal");
reject({ ...btc, roundId: "1800000300" }, "round identity must match the market start");
reject({ ...btc, endsAt: 1800000600 }, "market window must be five minutes");

console.log("runtime-cli-validation.test: PASS");
