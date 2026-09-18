import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookSnapshot } from "../live/feeds/index.js";
import { ClobMarketProjection, publishSnapshot } from "./market-projection.js";

function quote(receivedAtUnix: number, exchange = receivedAtUnix): BookSnapshot {
  return {
    tsUnix: receivedAtUnix, source: "polymarket-ws", receivedAtUnix,
    upReceivedAtUnix: receivedAtUnix, downReceivedAtUnix: receivedAtUnix,
    upExchangeTsUnix: exchange, downExchangeTsUnix: exchange,
    upBid: 0.4, upAsk: 0.5, downBid: 0.4, downAsk: 0.5,
    upBidSz: 5, upAskSz: 4, downBidSz: 3, downAskSz: 2,
    upBidLevels: [[0.4, 5]], upAskLevels: [[0.5, 4]],
    downBidLevels: [[0.4, 3]], downAskLevels: [[0.5, 2]],
    tickSize: 0.01, upTickSize: 0.01, downTickSize: 0.01,
  };
}

describe("ClobMarketProjection", () => {
  it("publishes only a fresh bilateral quote and keeps the older exchange clock", () => {
    const projection = new ClobMarketProjection({ upToken: "up", downToken: "down", slug: "btc", start: 100, end: 400 });
    projection.applySnapshot(quote(100, 99));
    expect(projection.snapshot(100).collector_online).toBe(true);
    const row = projection.snapshot(100).current_markets[0]!;
    expect(row.quote_at).toBe(new Date(99_000).toISOString());
    expect(row.ask_sum).toBe(1);
  });

  it("uses both receive and exchange age and clears books after disconnect", () => {
    const projection = new ClobMarketProjection({ upToken: "up", downToken: "down", end: 400, staleAfterMs: 2_000 });
    projection.applySnapshot(quote(100, 100));
    expect(projection.snapshot(101.5).collector_online).toBe(true);
    expect(projection.snapshot(103).collector_online).toBe(false);
    projection.disconnect();
    expect(projection.snapshot(100.1).current_markets).toEqual([]);
    expect(projection.snapshot(100.1).stale_reason).toContain("未连接");
  });

  it("does not expose an ended market", () => {
    const projection = new ClobMarketProjection({ upToken: "up", downToken: "down", end: 200 });
    projection.applySnapshot(quote(100));
    expect(projection.snapshot(200).collector_online).toBe(false);
    expect(projection.snapshot(200).stale_reason).toContain("结束");
  });

  it("distinguishes a connected incomplete book from a transport disconnect", () => {
    const projection = new ClobMarketProjection({ upToken: "up", downToken: "down" });
    projection.applySnapshot(quote(100));
    projection.invalidateBook();
    const incomplete = projection.snapshot(100.1);
    expect(incomplete).toMatchObject({ collector_online: false, collector_connected: true, current_markets: [] });
    expect(incomplete.stale_reason).toContain("完整 UP/DOWN");
    projection.disconnect();
    expect(projection.snapshot(100.2)).toMatchObject({ collector_online: false, collector_connected: false });
  });

  it("rejects late old frames and incomplete halves", () => {
    const projection = new ClobMarketProjection({ upToken: "up", downToken: "down" });
    projection.applySnapshot(quote(100, 99.5));
    expect(projection.applySnapshot(quote(100.5, 98))).toBe(false);
    expect(projection.snapshot(100.5).current_markets[0]!.quote_at).toBe(new Date(99_500).toISOString());
    const { downAsk: _missing, ...partial } = quote(101);
    expect(projection.applySnapshot(partial)).toBe(false);
    expect(projection.snapshot(101).current_markets).toEqual([]);
    projection.applySnapshot(quote(110, 110));
    expect(projection.snapshot(101).collector_online).toBe(false);
  });

  it("accepts bounded source clock skew, rejects larger skew, and recovers", () => {
    const projection = new ClobMarketProjection({ upToken: "up", downToken: "down" });
    expect(projection.applySnapshot(quote(100, 100.5))).toBe(true);
    const withinSkew = projection.snapshot(100);
    expect(withinSkew.collector_online).toBe(true);
    expect(withinSkew.current_markets[0]!.quote_at).toBe(new Date(100_500).toISOString());
    expect(projection.applySnapshot(quote(101, 102.001))).toBe(false);
    expect(projection.snapshot(101).collector_online).toBe(false);
    expect(projection.applySnapshot(quote(101.1))).toBe(true);
    expect(projection.snapshot(101.1).collector_online).toBe(true);
  });

  it("requires both source clocks and both receive clocks to be fresh", () => {
    const projection = new ClobMarketProjection({ upToken: "up", downToken: "down" });
    projection.applySnapshot({ ...quote(100), downExchangeTsUnix: 97 });
    expect(projection.snapshot(100).collector_online).toBe(false);
    projection.disconnect();
    projection.applySnapshot({ ...quote(100), downReceivedAtUnix: 97 });
    expect(projection.snapshot(100).collector_online).toBe(false);
    projection.disconnect(); projection.markConnected();
    expect(projection.snapshot(100).collector_online).toBe(false);
  });

  it("copies feed data and atomically replaces the output without temporary files", () => {
    const directory = mkdtempSync(join(tmpdir(), "market-projection-"));
    try {
      const projection = new ClobMarketProjection({ upToken: "up", downToken: "down" });
      const source = quote(100); projection.applySnapshot(source);
      source.upAsk = 0.9; source.upAskLevels![0]![0] = 0.9;
      const output = join(directory, "snapshot.json");
      publishSnapshot(output, projection.snapshot(100));
      const saved = JSON.parse(readFileSync(output, "utf8"));
      expect(saved.current_markets[0].up_ask).toBe(0.5);
      expect(saved.current_markets[0].up_ask_levels).toEqual([[0.5, 4]]);
      projection.disconnect(); publishSnapshot(output, projection.snapshot(101));
      expect(JSON.parse(readFileSync(output, "utf8")).collector_online).toBe(false);
      expect(readdirSync(directory)).toEqual(["snapshot.json"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
