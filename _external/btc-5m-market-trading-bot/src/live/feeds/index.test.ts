import { describe, expect, it } from "vitest";
import { FeedQueue, type FeedEvent } from "./index.js";

function book(price: number): FeedEvent {
  return {
    kind: "book",
    snapshot: {
      tsUnix: price,
      source: "polymarket-ws",
      upBid: price,
      upAsk: price,
      downBid: price,
      downAsk: price,
    },
  };
}

describe("FeedQueue low-latency behavior", () => {
  it("coalesces stale books and returns only the newest pending book", () => {
    const queue = new FeedQueue();
    queue.push(book(0.4));
    queue.push(book(0.41));
    queue.push(book(0.42));

    const event = queue.tryPop();
    expect(event?.kind).toBe("book");
    if (event?.kind === "book") expect(event.snapshot.upBid).toBe(0.42);
    expect(queue.tryPop()).toBeUndefined();
  });

  it("delivers private order events before ordinary market data", () => {
    const queue = new FeedQueue();
    queue.push(book(0.4));
    queue.push({ kind: "userStatus", healthy: false, tsUnix: 1 });

    expect(queue.tryPop()?.kind).toBe("userStatus");
    expect(queue.tryPop()?.kind).toBe("book");
  });

  it("delivers a book disconnect before queued quotes", () => {
    const queue = new FeedQueue();
    queue.push(book(0.4));
    queue.push({ kind: "bookStatus", healthy: false, tsUnix: 1 });

    expect(queue.tryPop()?.kind).toBe("bookStatus");
  });

  it("drops unused per-venue quotes before they enter the strategy queue", () => {
    const queue = new FeedQueue();
    queue.push({
      kind: "venue",
      venue: 1,
      tsUnix: 1,
      bid: 100,
      ask: 101,
      bidSz: 1,
      askSz: 1,
    });
    expect(queue.tryPop()).toBeUndefined();
  });
});
