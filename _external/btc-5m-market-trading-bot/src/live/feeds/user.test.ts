import { afterEach, describe, expect, it, vi } from "vitest";
import { Side } from "../../models.js";
import {
  parseUserMessage,
  parseAuthenticatedTrade,
  PendingUserEvents,
  isUserChannelEvidence,
  type UserFeedOptions,
} from "./user.js";

const opts: UserFeedOptions = {
  creds: { key: "k", secret: "s", passphrase: "p" },
  conditionId: "0xcond",
  upToken: "up-tok",
  downToken: "dn-tok",
  isOurOrder: (id) => id === "our-order" || id === "our-taker",
};

describe("parseUserMessage", () => {
  it("does not count an order UPDATE as a fill", () => {
    const matched = new Map<string, number>();
    matched.set("our-order", 2);
    const evs = parseUserMessage(
      {
        event_type: "order",
        type: "UPDATE",
        id: "our-order",
        asset_id: "up-tok",
        price: "0.48",
        size_matched: "5",
      },
      opts,
      matched,
      new Set(),
    );
    expect(evs).toHaveLength(0);
  });

  it("emits a maker fill from the authoritative trade event", () => {
    const evs = parseUserMessage(
      {
        event_type: "trade",
        status: "MATCHED",
        id: "trade-maker",
        taker_order_id: "someone-else",
        maker_orders: [{
          order_id: "our-order",
          asset_id: "up-tok",
          price: "0.48",
          matched_amount: "3",
        }],
      },
      opts,
      new Map(),
      new Set(),
    );
    expect(evs).toHaveLength(1);
    if (evs[0]?.kind === "exchangeFill") {
      expect(evs[0].fill.side).toBe(Side.Up);
      expect(evs[0].fill.shares).toBe(3);
      expect(evs[0].fill.isMaker).toBe(true);
    }
  });

  it("does not double count an order update followed by its trade", () => {
    const matched = new Map<string, number>();
    const seen = new Set<string>();
    const update = parseUserMessage(
      {
        event_type: "order",
        type: "UPDATE",
        id: "our-order",
        asset_id: "up-tok",
        price: "0.48",
        size_matched: "3",
      },
      opts,
      matched,
      seen,
    );
    const trade = parseUserMessage(
      {
        event_type: "trade",
        status: "MATCHED",
        id: "trade-once",
        taker_order_id: "someone-else",
        maker_orders: [{
          order_id: "our-order",
          asset_id: "up-tok",
          price: "0.48",
          matched_amount: "3",
        }],
      },
      opts,
      matched,
      seen,
    );
    expect(update).toHaveLength(0);
    expect(trade).toHaveLength(1);
  });

  it("emits taker fill on trade MATCHED", () => {
    const evs = parseUserMessage(
      {
        event_type: "trade",
        status: "MATCHED",
        id: "trade-1",
        asset_id: "dn-tok",
        price: "0.52",
        size: "5",
        taker_order_id: "our-taker",
      },
      opts,
      new Map(),
      new Set(),
    );
    expect(evs).toHaveLength(1);
    if (evs[0]?.kind === "exchangeFill") {
      expect(evs[0].fill.side).toBe(Side.Down);
      expect(evs[0].fill.isMaker).toBe(false);
    }
  });

  it("ignores trades for orders we do not own", () => {
    const evs = parseUserMessage(
      {
        event_type: "trade",
        status: "MATCHED",
        id: "trade-2",
        asset_id: "up-tok",
        price: "0.5",
        size: "5",
        taker_order_id: "someone-else",
      },
      opts,
      new Map(),
      new Set(),
    );
    expect(evs).toHaveLength(0);
  });

  it("emits orderCancelled for our orders", () => {
    const evs = parseUserMessage(
      {
        event_type: "order",
        type: "CANCELLATION",
        id: "our-order",
        asset_id: "up-tok",
      },
      opts,
      new Map(),
      new Set(),
    );
    expect(evs[0]?.kind).toBe("orderCancelled");
  });
});

describe("authenticated trade reconciliation", () => {
  it("includes our maker BUY when the matched taker is selling", () => {
    const events = parseAuthenticatedTrade({
      id: "maker-buy-taker-sell", status: "CONFIRMED", market: "0xcond",
      trader_side: "MAKER", side: "SELL", maker_orders: [{
        order_id: "our-order", maker_address: "0xabc", side: "BUY",
        asset_id: "up-tok", price: "0.4", matched_amount: "2",
      }],
    }, { ...opts, accountAddress: "0xAbC" }, new Set());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "exchangeFill", fill: { side: Side.Up, shares: 2 } });
  });
  it("rebuilds a maker fill using the configured account address", () => {
    const evs = parseAuthenticatedTrade(
      {
        id: "trade-reconcile",
        status: "MATCHED",
        market: "0xcond",
        trader_side: "MAKER",
        match_time: "100",
        maker_orders: [{
          order_id: "unknown-ack-order",
          maker_address: "0xabc",
          asset_id: "dn-tok",
          price: "0.51",
          matched_amount: "4",
        }],
      },
      { ...opts, accountAddress: "0xAbC" },
      new Set(),
    );
    expect(evs).toHaveLength(1);
    if (evs[0]?.kind === "exchangeFill") {
      expect(evs[0].fill.side).toBe(Side.Down);
      expect(evs[0].fill.shares).toBe(4);
      expect(evs[0].fill.isMaker).toBe(true);
    }
  });
});

describe("isUserChannelEvidence", () => {
  it("does not treat transport or unrelated messages as subscription readiness", () => {
    expect(isUserChannelEvidence("PONG", opts)).toBe(false);
    expect(isUserChannelEvidence({ type: "connected" }, opts)).toBe(false);
    expect(
      isUserChannelEvidence(
        { event_type: "order", id: "other", asset_id: "another-token" },
        opts,
      ),
    ).toBe(false);
  });

  it("accepts an explicit user subscription confirmation", () => {
    expect(
      isUserChannelEvidence(
        { type: "user", channel: "user", status: "subscribed" },
        opts,
      ),
    ).toBe(true);
    expect(
      isUserChannelEvidence(
        { type: "authenticated", channel: "user", status: "failed" },
        opts,
      ),
    ).toBe(false);
  });

  it("accepts the first valid order or trade on the subscribed market", () => {
    expect(
      isUserChannelEvidence(
        {
          event_type: "order",
          id: "someone-else",
          asset_id: "up-tok",
          market: "0xcond",
        },
        opts,
      ),
    ).toBe(true);
  });
});

describe("PendingUserEvents", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays a fill that arrives before the HTTP ACK registers its order id", () => {
    const owned = new Set<string>();
    const emitted: unknown[] = [];
    const dynamicOpts: UserFeedOptions = {
      ...opts,
      isOurOrder: (id) => owned.has(id),
    };
    const pending = new PendingUserEvents(dynamicOpts, (raw) => emitted.push(raw));
    const earlyFill = {
      event_type: "trade",
      status: "MATCHED",
      id: "trade-early",
      asset_id: "dn-tok",
      price: "0.52",
      size: "5",
      taker_order_id: "ack-later",
    };

    pending.accept(earlyFill);
    expect(emitted).toHaveLength(0);

    owned.add("ack-later");
    pending.register("ack-later");
    expect(emitted).toEqual([earlyFill]);
  });

  it("retains an early fill while its HTTP ACK is delayed by 2.5 seconds", () => {
    vi.useFakeTimers();
    const owned = new Set<string>();
    const emitted: unknown[] = [];
    const dynamicOpts: UserFeedOptions = {
      ...opts,
      isOurOrder: (id) => owned.has(id),
    };
    const pending = new PendingUserEvents(dynamicOpts, (raw) => emitted.push(raw));
    const earlyFill = {
      event_type: "trade",
      status: "MATCHED",
      id: "trade-delayed-ack",
      asset_id: "up-tok",
      price: "0.49",
      size: "3",
      taker_order_id: "slow-ack",
    };

    pending.accept(earlyFill);
    vi.advanceTimersByTime(2_500);
    owned.add("slow-ack");
    pending.register("slow-ack");

    expect(emitted).toEqual([earlyFill]);
  });

  it("replays an early maker fill using its maker order id", () => {
    const owned = new Set<string>();
    const emitted: unknown[] = [];
    const dynamicOpts: UserFeedOptions = {
      ...opts,
      isOurOrder: (id) => owned.has(id),
    };
    const pending = new PendingUserEvents(dynamicOpts, (raw) => emitted.push(raw));
    const earlyFill = {
      event_type: "trade",
      status: "MATCHED",
      id: "trade-maker-early",
      taker_order_id: "other-taker",
      maker_orders: [{
        order_id: "our-maker-later",
        asset_id: "up-tok",
        price: "0.48",
        matched_amount: "2",
      }],
    };

    pending.accept(earlyFill);
    owned.add("our-maker-later");
    pending.register("our-maker-later");
    expect(emitted).toEqual([earlyFill]);
  });
});
