// Live 2026-10-01: the recorded 5-level depth was crossed (UP bids 0.74..0.69
// above asks 0.34..0.38) while the venue's REST book had bids 0.37.. / asks
// 0.38... A trade that empties a level does not always arrive as a size-0
// price_change, so the replica kept dead levels. The venue's own best bid/ask
// (best_bid_ask / price_change best_*) proves every level beyond it is gone.
//
// Run after `npm run build`:  node scripts/regress/depth-trim.mjs
import assert from "node:assert/strict";
import { OrderBook } from "../../dist/live/orderbook.js";

const book = new OrderBook();
book.applySnapshot([[0.74, 107], [0.73, 5], [0.37, 757], [0.36, 2457]], [[0.34, 15], [0.38, 45], [0.39, 226]]);
// bug shape: dead bids above dead asks
assert.ok(book.levels(5).bids[0][0] > book.levels(5).asks[0][0], "fixture is crossed like the live book");

assert.equal(book.trimTo(0.37, 0.38), true, "dead levels are removed");
assert.deepEqual(book.levels(5), { bids: [[0.37, 757], [0.36, 2457]], asks: [[0.38, 45], [0.39, 226]] },
  "only levels at or inside the venue's best bid/ask remain");
assert.deepEqual(book.bestBid(), [0.37, 757]);
assert.deepEqual(book.bestAsk(), [0.38, 45]);

// control: a consistent book is untouched
assert.equal(book.trimTo(0.37, 0.38), false);
assert.equal(book.trimTo(undefined, undefined), false, "no best quote, no change");
console.log("depth-trim OK");
