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
});
