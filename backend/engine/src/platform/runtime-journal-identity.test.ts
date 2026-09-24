import assert from "node:assert/strict";
import { journalMarketIdentity } from "../cli/platform.js";
import type { Instrument, MarketInfo } from "./contracts.js";

const marketId = "condition-eth-journal";
const instruments: Instrument[] = [
  { tokenId: "eth-journal-yes", marketId, outcome: "YES", tickSize: 0.01, minOrderSize: 1 },
  { tokenId: "eth-journal-no", marketId, outcome: "NO", tickSize: 0.01, minOrderSize: 1 },
];
const market: MarketInfo = { id: marketId, assetId: "eth", roundId: "2100", name: "eth-updown-5m-2100",
  startsAt: 2100, endsAt: 2400, instruments };

const identity = journalMarketIdentity(market, "eth-journal-yes");
assert.deepEqual(identity, { asset_id: "eth", market_id: marketId, round_id: "2100",
  market_slug: "eth-updown-5m-2100", side: "YES" });
assert.equal(journalMarketIdentity(undefined).asset_id, null);

console.log("runtime-journal-identity.test: PASS");
