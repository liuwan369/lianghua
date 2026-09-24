import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderBook } from "../../../dist/live/orderbook.js";

test("five-level depth sorts best first and malformed sizes cannot remove or poison levels", () => {
  const book = new OrderBook();
  book.applySnapshot([[0.4, 10], [0.3, 8], [0.2, Infinity]], [[0.6, 5], [0.7, 6]]);
  book.applyChange(0.4, NaN, true);
  book.applyChange(0.4, -1, true);
  book.applyChange(0.5, Infinity, true);
  assert.deepEqual(book.levels(5), { bids: [[0.4, 10], [0.3, 8]], asks: [[0.6, 5], [0.7, 6]] });
  book.applyChange(0.4, 0, true);
  assert.deepEqual(book.bestBid(), [0.3, 8]);
});
