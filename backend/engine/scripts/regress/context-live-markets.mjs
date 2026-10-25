// The strategy context carries only markets that have not ended, and only
// their books (review 10-25). Every event clones the context; the platform
// never forgets a market (settlement needs them), so a context of every
// market seen made each lead event cost ~6.5 ms after one day of rounds and
// ~23 ms after 3.5 days, on the order path.
//
// Drives the real compiled TradingPlatform. Run after `npm run build`:
//   node scripts/regress/context-live-markets.mjs
import assert from "node:assert/strict";
import { TradingPlatform } from "../../dist/platform/platform.js";

const BASE = 1_800_000_000, N = 300;
const token = (k, side) => `${side}`.repeat(70) + String(k).padStart(6, "0");
const market = (k) => {
  const start = BASE + 300 * k, id = `0x${String(k).padStart(64, "0")}`;
  return { id, assetId: "btc", roundId: String(start), name: `btc-updown-5m-${start}`, startsAt: start, endsAt: start + 300,
    instruments: [{ tokenId: token(k, 1), marketId: id, outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                  { tokenId: token(k, 2), marketId: id, outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
};
let now = BASE - 60;
const platform = new TradingPlatform({ account: { accountId: "t", at: now, cashAt: now, cashUsd: 100, positions: [],
  openOrders: [], complete: true }, instruments: [], limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null },
  now: () => now, adapters: { gateway: { mode: "live", durableIdentity: false, async submit() { return { status: "rejected" }; },
    async cancel() { return true; } } } });
const seen = [];
platform.attach({ id: "spy", onEvent: (_event, context) => { seen.push(context); return []; } });
for (let k = 0; k <= N; k += 1) {
  const m = market(k);
  now = m.startsAt - 5;
  platform.ingest({ kind: "market", market: m });
  now = m.startsAt + 20;
  const side = (tokenId, ask) => ({ assetId: tokenId, bid: ask - 0.01, ask, bidSize: 10, askSize: 10, sourceAt: now, expiresAt: now + 2 });
  platform.ingest({ kind: "book", marketId: m.id, roundId: m.roundId, snapshot: { assetId: "btc", marketId: m.id, roundId: m.roundId,
    sourceAt: now, expiresAt: now + 2, tsUnix: now, receivedAtUnix: now, marketAgeMs: 10,
    YES: side(m.instruments[0].tokenId, 0.55), NO: side(m.instruments[1].tokenId, 0.46) } });
}
const next = market(N + 1);
platform.ingest({ kind: "market", market: next });
seen.length = 0;
platform.ingest({ kind: "timer", ts: now });
const context = seen.at(-1);
assert.deepEqual(context.markets.map(m => m.id).sort(), [market(N).id, next.id].sort(),
  "only the running and the next market reach the strategy");
assert.deepEqual(context.books.map(b => b.tokenId).sort(), market(N).instruments.map(i => i.tokenId).sort(),
  "only those markets' books");
assert.equal(platform.market.list().length, N + 2, "the platform itself still knows every market (settlement)");
console.log("context-live-markets OK");
