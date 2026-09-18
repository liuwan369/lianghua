import { afterEach, describe, expect, it, vi } from "vitest";
import type { Market } from "../live/discovery.js";
import type { FeedSink } from "../live/feeds/index.js";
import type { MarketProjectionSnapshot } from "../dashboard/market-projection.js";
import { parseMarketSnapshotOptions, runMarketSnapshot } from "./market-snapshot.js";

afterEach(() => { vi.useRealTimers(); });

describe("market snapshot CLI", () => {
  it("parses bounded public snapshot options", () => {
    expect(parseMarketSnapshotOptions(["--output", "x.json", "--duration-sec", "5", "--publish-ms", "20"]))
      .toEqual({ output: "x.json", durationSec: 5, staleAfterMs: 2000, publishMs: 20, discoveryMs: 15000 });
  });

  it("rejects invalid intervals and unknown options", () => {
    expect(() => parseMarketSnapshotOptions(["--publish-ms", "0"])).toThrow();
    expect(() => parseMarketSnapshotOptions(["--private-key", "secret"])).toThrow();
  });

  it("keeps events in memory, publishes bounded snapshots, and rolls over to the prefetched market", async () => {
    vi.useFakeTimers(); vi.setSystemTime(599_500);
    const markets: Market[] = [300, 600].map(start => ({ slug: `btc-${start}`, conditionId: `c-${start}`,
      upToken: `up-${start}`, downToken: `down-${start}`, start, end: start + 300 }));
    const sinks = new Map<string, FeedSink>();
    const stopped: string[] = [];
    const output: MarketProjectionSnapshot[] = [];
    const controller = new AbortController();
    const options = parseMarketSnapshotOptions(["--publish-ms", "250"])!;
    const run = runMarketSnapshot(options, {
      now: () => Date.now() / 1000,
      discover: async at => markets.find(market => market.start <= at && at < market.end),
      feed: (sink, up) => { sinks.set(up, sink); return { stop: () => stopped.push(up) }; },
      publish: (_, snapshot) => output.push(snapshot),
    }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const before = output.length;
    const quote = { tsUnix: 599.5, source: "polymarket-ws" as const, upReceivedAtUnix: 599.5,
      downReceivedAtUnix: 599.5, upExchangeTsUnix: 599.5, downExchangeTsUnix: 599.5,
      upBid: 0.4, upAsk: 0.5, downBid: 0.4, downAsk: 0.5 };
    for (let index = 0; index < 20; index += 1) sinks.get("up-300")!({ kind: "book", snapshot: quote });
    sinks.get("up-600")!({ kind: "book", snapshot: quote });
    expect(output).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(250);
    expect(output.at(-1)!.current_markets[0]!.slug).toBe("btc-300");
    await vi.advanceTimersByTimeAsync(250);
    expect(output.at(-1)!.current_markets[0]!.slug).toBe("btc-600");
    expect(stopped).toContain("up-300");
    controller.abort(); await run;
    expect(output.at(-1)!.collector_online).toBe(false);
    expect(stopped).toContain("up-600");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries discovery after a temporary failure without starting a trading process", async () => {
    vi.useFakeTimers(); vi.setSystemTime(600_000);
    const output: MarketProjectionSnapshot[] = [];
    const discover = vi.fn(async () => { throw new Error("offline"); });
    const feed = vi.fn();
    const options = parseMarketSnapshotOptions(["--duration-sec", "2", "--discovery-ms", "500"])!;
    const run = runMarketSnapshot(options, { discover, feed, publish: (_, snapshot) => output.push(snapshot) });
    await vi.advanceTimersByTimeAsync(2_000); await run;
    expect(discover.mock.calls.length).toBeGreaterThan(2);
    expect(feed).not.toHaveBeenCalled();
    expect(output.every(snapshot => !snapshot.collector_online)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts in-flight discovery when the snapshot process stops", async () => {
    const controller = new AbortController();
    const discover = vi.fn((_at: number, _directOnly?: boolean, signal?: AbortSignal) =>
      new Promise<Market | undefined>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    const run = runMarketSnapshot(parseMarketSnapshotOptions(["--publish-ms", "1000"])!,
      { discover, feed: vi.fn(), publish: vi.fn() }, controller.signal);
    await vi.waitFor(() => expect(discover).toHaveBeenCalled());

    controller.abort();

    await expect(run).resolves.toBeUndefined();
  });

  it("prewarms the next market before the exact five-minute boundary", async () => {
    vi.useFakeTimers(); vi.setSystemTime(589_000);
    const current: Market = { slug: "btc-300", conditionId: "c-300", upToken: "up-300", downToken: "down-300", start: 300, end: 600 };
    const next: Market = { slug: "btc-600", conditionId: "c-600", upToken: "up-600", downToken: "down-600", start: 600, end: 900 };
    const discover = vi.fn(async (at: number) => at < 600 ? current : Date.now() >= 599_250 ? next : undefined);
    const feed = vi.fn((_sink: FeedSink, _up: string, _down: string, _deadline: number) => ({ stop: vi.fn() }));
    const controller = new AbortController();
    const options = parseMarketSnapshotOptions(["--publish-ms", "1000", "--discovery-ms", "15000"])!;
    const run = runMarketSnapshot(options, { now: () => Date.now() / 1000, discover, feed, publish: vi.fn() }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(feed).toHaveBeenCalledTimes(1);
    const initialDiscoveryCalls = discover.mock.calls.length;

    await vi.advanceTimersByTimeAsync(999);
    expect(discover).toHaveBeenCalledTimes(initialDiscoveryCalls);
    await vi.advanceTimersByTimeAsync(9_251);

    expect(feed).toHaveBeenCalledWith(expect.any(Function), "up-600", "down-600", 900);
    expect(Date.now()).toBeLessThan(600_000);
    const nextFeedCalls = feed.mock.calls.filter(([, up]) => up === "up-600");
    expect(nextFeedCalls).toHaveLength(1);
    controller.abort(); await run;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps fast discovery alive when Gamma publishes the next market after the boundary", async () => {
    vi.useFakeTimers(); vi.setSystemTime(589_000);
    const current: Market = { slug: "btc-300", conditionId: "c-300", upToken: "up-300", downToken: "down-300", start: 300, end: 600 };
    const next: Market = { slug: "btc-600", conditionId: "c-600", upToken: "up-600", downToken: "down-600", start: 600, end: 900 };
    const discover = vi.fn(async (at: number) => at < 600 ? current : Date.now() >= 606_000 ? next : undefined);
    const feed = vi.fn(() => ({ stop: vi.fn() }));
    const controller = new AbortController();
    const options = parseMarketSnapshotOptions(["--publish-ms", "1000", "--discovery-ms", "15000"])!;
    const run = runMarketSnapshot(options, { now: () => Date.now() / 1000, discover, feed, publish: vi.fn() }, controller.signal);

    await vi.advanceTimersByTimeAsync(17_250);

    expect(feed).toHaveBeenCalledWith(expect.any(Function), "up-600", "down-600", 900);
    expect(Date.now()).toBeLessThan(615_000);
    const callsAfterDiscovery = discover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(discover.mock.calls.length).toBe(callsAfterDiscovery);
    controller.abort(); await run;
    expect(vi.getTimerCount()).toBe(0);
  });
});
