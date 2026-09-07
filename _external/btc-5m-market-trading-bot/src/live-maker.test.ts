import { describe, expect, it } from "vitest";
import { targetClone } from "./config.js";
import { MakerSession } from "./live-maker.js";
import { Side } from "./models.js";

describe("MakerSession liveMode", () => {
  it("does not simulate book fills when liveMode is true", () => {
    const s = new MakerSession(targetClone(), 15, 0, 0, true);
    s.reset(1000, 1300);
    s.onBook(1005, 0.49, 0.51, 0.49, 0.5);
    const quoteEv = s.onBook(1006, 0.49, 0.48, 0.49, 0.5);
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
    const fills = s.onBook(1006, 0.46, 0.47, 0.52, 0.53)
      .filter((event) => event.kind === "fill");
    expect(fills.some((fill) => fill.shares === 5.25 && fill.price === 0.48)).toBe(true);
  });
});
