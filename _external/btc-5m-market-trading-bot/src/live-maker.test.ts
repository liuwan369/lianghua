import { describe, expect, it } from "vitest";
import { targetClone } from "./config.js";
import { MakerSession } from "./live-maker.js";
import { MarketMode } from "./risk.js";
import { Side } from "./models.js";

describe("MakerSession liveMode", () => {
  it("does not simulate book fills when liveMode is true", () => {
    const s = new MakerSession(targetClone(), 15, 0, 0, true);
    s.reset(1000, 1300);
    s.onBook(1005, 0.49, 0.51, 0.49, 0.5, {upTickSize:0.01,downTickSize:0.01});
    const quoteEv = s.onBook(1006, 0.49, 0.48, 0.49, 0.5, {upTickSize:0.01,downTickSize:0.01});
    const fills = quoteEv.filter((e) => e.kind === "fill");
    expect(fills).toHaveLength(0);
  });

  it("uses liveMode flag (paper still allows book simulation path)", () => {
    const paper = new MakerSession(targetClone(), 15, 0, 0, false);
    const live = new MakerSession(targetClone(), 15, 0, 0, true);
    expect(paper.liveMode).toBe(false);
    expect(live.liveMode).toBe(true);
  });

  it("confirmExchangeFill updates inventory", () => {
    const s = new MakerSession(targetClone(), 15, 0, 0, true);
    s.reset(1000, 1300);
    const ev = s.confirmExchangeFill({
      side: Side.Up,
      shares: 5,
      price: 0.48,
      tsUnix: 1010,
      isMaker: true,
    });
    expect(ev.kind).toBe("fill");
    expect(s.fills()).toBe(1);
  });

  it("resizes a pending paper quote before its simulated fill", () => {
    const s = new MakerSession(targetClone(), 15, 0, 0, false);
    s.reset(1000, 1300);
    (s as unknown as { pending: unknown[] }).pending = [{
      side: Side.Up,
      price: 0.5,
      shares: 20,
      lifeEnd: 1020,
      btcAtPost: 0,
    }];

    s.resizePendingQuote(Side.Up, 5.25, 0.48);
    const fills = s.onBook(1006, 0.46, 0.47, 0.52, 0.53, {upTickSize:0.01,downTickSize:0.01})
      .filter((event) => event.kind === "fill");
    expect(fills.some((fill) => fill.shares === 5.25 && fill.price === 0.48)).toBe(true);
  });
});


describe("pending orders remain liabilities until confirmed", () => {
  function session(liveMode = true): MakerSession {
    const s = new MakerSession(targetClone(), 15, 1, 0, liveMode);
    s.reset(1000, 1300);
    s.onBook(1005,0.45,0.46,0.52,0.53, {upTickSize:0.01,downTickSize:0.01});
    expect(s.pendingQuotes()).toHaveLength(1);
    return s;
  }

  it("keeps the unfilled remainder after a partial exchange fill", () => {
    const s = session(); const q = s.pendingQuotes()[0];
    s.confirmExchangeFill({ ...q, shares: 2, tsUnix: 1006, isMaker: true });
    expect(s.pendingQuotes()[0].shares).toBeCloseTo(q.shares-2,8);
    expect(s.fills()).toBe(1);
  });

  it("does not subtract a late old-order fill from the new pending order", () => {
    const s = session(); const q = s.pendingQuotes()[0];
    s.confirmExchangeFill({ ...q, shares: 2, tsUnix: 1006, isMaker: true }, 0);
    expect(s.pendingQuotes()[0].shares).toBe(q.shares);
    expect(s.fills()).toBe(1);
  });

  it("reserves an expired live quote until cancellation acknowledgement", () => {
    const s = session(); const q = s.pendingQuotes()[0];
    expect(s.onBook(1021,0.45,0.46,0.52,0.53, {upTickSize:0.01,downTickSize:0.01}).filter(e => e.kind==='cancel')).toHaveLength(1);
    expect(s.pendingQuotes()).toEqual([q]);
    expect(s.pendingQuotes(false)).toHaveLength(0);
    expect(s.onBook(1022,0.45,0.46,0.52,0.53, {upTickSize:0.01,downTickSize:0.01}).filter(e => e.kind==='quote'||e.kind==='cancel')).toHaveLength(0);
    s.onOrderCancelled(q.side);
    expect(s.pendingQuotes()).toHaveLength(0);
  });

  it("never simulates a fill from a quote that expired before the next book", () => {
    const s = session(false);
    const events = s.onBook(1021,0.40,0.41,0.57,0.58, {upTickSize:0.01,downTickSize:0.01});
    expect(events.filter(e => e.kind==='fill')).toHaveLength(0);
    expect(events.filter(e => e.kind==='cancel')).toHaveLength(1);
  });

  it("cancels before simulating fills when the market trading cutoff has passed", () => {
    const s = session(false);
    s.marketEnd = 1015;
    const events = s.onBook(1006,0.40,0.41,0.57,0.58, {upTickSize:0.01,downTickSize:0.01});
    expect(events.filter(e => e.kind==='fill')).toHaveLength(0);
    expect(events.filter(e => e.kind==='cancel')).toHaveLength(1);
  });

  it("rejects malformed confirmed fills before changing reservations or inventory", () => {
    const s = session(); const q = s.pendingQuotes()[0];
    expect(() => s.confirmExchangeFill({ ...q, shares: Number.NaN, tsUnix:1006, isMaker:true })).toThrow();
    expect(s.fills()).toBe(0);
    expect(s.pendingQuotes()).toEqual([q]);
  });
});


describe("complete trade snapshots do not reset live controls", () => {
  it("preserves outstanding reservations and a halted market while replacing fills", () => {
    const s = new MakerSession(targetClone(),15,1,0,true);
    s.reset(1000,1300);s.onBook(1005,0.45,0.46,0.52,0.53, {upTickSize:0.01,downTickSize:0.01});
    const pending = s.pendingQuotes();
    s.strat.risk.marketMode = MarketMode.Halted;
    s.replaceCurrentMarketFills([{side:Side.Up,shares:2,price:0.4,tsUnix:1006,isMaker:true}]);
    expect(s.fills()).toBe(1);
    expect(s.pendingQuotes()).toEqual(pending);
    expect(s.strat.risk.marketMode).toBe(MarketMode.Halted);
    s.replaceCurrentMarketFills([{side:Side.Up,shares:2,price:0.4,tsUnix:1006,isMaker:true}]);
    expect(s.fills()).toBe(1);
    expect(s.pendingQuotes()).toEqual(pending);
  });
});


describe("session forwards each token market tick", () => {
  it("accepts the rounded hedge using supplied .01 ticks and exposes invalid-tick rejection", () => {
    const session=new MakerSession({...targetClone(),pairAddCostMax:0.99},15,1,0,true);
    session.reset(1000,1300);
    session.confirmExchangeFill({side:Side.Up,shares:20,price:0.23,tsUnix:1020,isMaker:true});
    expect(session.onBook(1050,0.23,0.24,0.76,0.77)).toEqual([]);
    expect(session.lastDecisionRejection()?.code).toBe('maker_tick_missing_or_invalid');
    expect(session.onBook(1051,0.23,0.24,0.76,0.77,{upTickSize:0.01,downTickSize:0.01}))
      .toContainEqual({kind:'quote',side:Side.Down,price:0.76,shares:20});
    expect(session.lastDecisionRejection()).toBeNull();
  });
});
