import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMarket,
  isWindowLive,
  parseMarket,
  select,
  type Candidate,
} from "./discovery.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("discovery", () => {
  it("parses up index 0 by default", () => {
    const c = parseMarket({
      slug: "btc-updown-5m-1700000100",
      closed: false,
      clobTokenIds: '["upTok","downTok"]',
      outcomes: '["Up","Down"]',
    });
    expect(c?.upToken).toBe("upTok");
    expect(c?.downToken).toBe("downTok");
    expect(c?.slugStart).toBe(1700000100);
  });

  it("flips when outcomes lead with Down", () => {
    const c = parseMarket({
      slug: "btc-updown-5m-1700000100",
      closed: false,
      clobTokenIds: ["a", "b"],
      outcomes: ["Down", "Up"],
    });
    expect(c?.upToken).toBe("b");
    expect(c?.downToken).toBe("a");
  });

  it("window liveness guard", () => {
    expect(isWindowLive(1000, 1000)).toBe(true);
    expect(isWindowLive(1000, 1299.9)).toBe(true);
    expect(isWindowLive(1000, 999)).toBe(false);
    expect(isWindowLive(1000, 1300)).toBe(false);
  });

  it("selects window containing now", () => {
    const mk = (s: number): Candidate => ({
      slug: `btc-updown-5m-${s}`,
      slugStart: s,
      upToken: `u${s}`,
      downToken: `d${s}`,
      conditionId: "",
    });
    const cands = [mk(1000), mk(1300), mk(1600)];
    expect(select(cands, 1450)?.slugStart).toBe(1300);
    expect(select(cands, 1900)?.slugStart).toBe(1600);
  });

  it("direct-only discovery does not fan out to Gamma listing endpoints", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetch);
    await expect(findMarket(1_700_000_000, false, true)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("slug=btc-updown-5m-");
  });

  it("aborts a hanging Gamma request when discovery is stopped", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    const pending = findMarket(1_700_000_000, false, true, controller.signal);
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
