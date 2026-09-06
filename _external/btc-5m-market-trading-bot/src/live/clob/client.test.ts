import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderType } from "@polymarket/clob-client-v2";
import { apiOrderRegionAllowed, ClobWrapper, geocheck } from "./client.js";

describe("API geographic rules", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts frontend-only restricted countries for API placement screening", () => {
    expect(apiOrderRegionAllowed({ blocked: true, country: "IE" })).toBe(true);
    expect(apiOrderRegionAllowed({ blocked: true, country: "JP" })).toBe(true);
    expect(apiOrderRegionAllowed({ blocked: true, country: "MT" })).toBe(true);
    expect(apiOrderRegionAllowed({ blocked: true, country: "NL" })).toBe(true);
  });

  it("rejects API-restricted countries while accepting an unblocked response", () => {
    expect(apiOrderRegionAllowed({ blocked: true, country: "DE" })).toBe(false);
    expect(apiOrderRegionAllowed({ blocked: false, country: "CH" })).toBe(true);
    expect(apiOrderRegionAllowed({})).toBe(false);
  });

  it("fails closed when the geographic check cannot connect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unavailable")));
    await expect(geocheck()).rejects.toThrow(/GEO-CHECK FAILED.*network unavailable/i);
  });

  it("fails closed on a non-success response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "upstream" }, 503)));
    await expect(geocheck()).rejects.toThrow(/GEO-CHECK FAILED.*503/i);
  });

  it("fails closed when required response fields are missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ country: "IE" })));
    await expect(geocheck()).rejects.toThrow(/GEO-CHECK FAILED.*fields/i);
  });

  it("fails closed when the response is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json")));
    await expect(geocheck()).rejects.toThrow(/GEO-CHECK FAILED/i);
  });
});

const sdkMocks = vi.hoisted(() => ({
  createL2Headers: vi.fn(async () => ({ "POLY-API-KEY": "k" })),
  orderToJsonV2: vi.fn(
    (_order: unknown, owner: string, orderType: OrderType, postOnly: boolean, deferExec: boolean) => ({
      owner,
      orderType,
      postOnly,
      deferExec,
      order: { signed: true },
    }),
  ),
}));

vi.mock("@polymarket/clob-client-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polymarket/clob-client-v2")>();
  return {
    ...actual,
    createL2Headers: sdkMocks.createL2Headers,
    isV2Order: () => true,
    orderToJsonV2: sdkMocks.orderToJsonV2,
  };
});

type WrapperCtor = new (
  client: Record<string, unknown>,
  signerAddress: `0x${string}`,
  funder: `0x${string}`,
  creds: { key: string; secret: string; passphrase: string },
  signatureType: number,
) => ClobWrapper;

function wrapperWith(client: Record<string, unknown>): ClobWrapper {
  const Ctor = ClobWrapper as unknown as WrapperCtor;
  return new Ctor(
    { signer: {}, ...client },
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000001",
    { key: "k", secret: "s", passphrase: "p" },
    0,
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ClobWrapper low-latency order path", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sdkMocks.createL2Headers.mockClear();
    sdkMocks.orderToJsonV2.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warms metadata and order version by signing without posting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ version: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      getClobMarketInfo: vi.fn().mockResolvedValue({ t: [{ t: "token" }], mts: "0.01", nr: false }),
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
    };
    const wrapper = wrapperWith(client);

    await wrapper.warmMarket("condition", 100, 1);

    expect(client.createOrder).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/version$/);
  });

  it("posts a maker order with deferred execution and records ACK latency", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, orderID: "order-1", status: "live", tradeIDs: ["trade-1"] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      getNegRisk: vi.fn().mockResolvedValue(false),
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
    };
    const wrapper = wrapperWith(client);

    const result = await wrapper.submitOrder({
      tokenId: "token",
      price: 0.48,
      size: 5,
      expiration: 2_000_000_000,
      tickSize: 0.01,
    });

    expect(result.success).toBe(true);
    expect(client.createOrder).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      orderType: OrderType.GTD,
      postOnly: true,
      deferExec: true,
    });
    expect(result.ackLatencyMs).toBeTypeOf("number");
    expect(result.tradeIds).toEqual(["trade-1"]);
  });

  it("passes the known price into urgent hedge signing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ success: true, orderID: "order-2" })),
    );
    const client = {
      getNegRisk: vi.fn().mockResolvedValue(false),
      createMarketOrder: vi.fn().mockResolvedValue({ signed: true }),
    };
    const wrapper = wrapperWith(client);

    const result = await wrapper.submitMarketBuy("token", 2.5, 0.5, 0.01);

    expect(result.success).toBe(true);
    expect(client.createMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ tokenID: "token", amount: 2.5, price: 0.5 }),
      expect.objectContaining({ tickSize: "0.01" }),
    );
  });

  it("refreshes the version and re-signs only once on mismatch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "order_version_mismatch" }))
      .mockResolvedValueOnce(jsonResponse({ version: 3 }))
      .mockResolvedValueOnce(jsonResponse({ success: true, orderID: "order-new-version" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      getNegRisk: vi.fn().mockResolvedValue(false),
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
    };
    const wrapper = wrapperWith(client);

    const result = await wrapper.submitOrder({
      tokenId: "token",
      price: 0.48,
      size: 5,
      expiration: 2_000_000_000,
      tickSize: 0.01,
    });

    expect(result.success).toBe(true);
    expect(client.createOrder).toHaveBeenCalledTimes(2);
    expect(client.createOrder.mock.calls[1]?.[1]).toMatchObject({ version: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("marks an aborted POST as unknown exchange state", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("request timed out", "TimeoutError")),
        );
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      getNegRisk: vi.fn().mockResolvedValue(false),
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
    };
    const wrapper = wrapperWith(client);
    (wrapper as unknown as { requestTimeoutMs: number }).requestTimeoutMs = 5;

    const result = await wrapper.submitOrder({
      tokenId: "token",
      price: 0.48,
      size: 5,
      expiration: 2_000_000_000,
      tickSize: 0.01,
    });

    expect(result.success).toBe(false);
    expect(result.stateUnknown).toBe(true);
  });

  it("marks a connection reset during POST as unknown exchange state", async () => {
    const networkError = new TypeError("fetch failed") as TypeError & { code: string };
    networkError.code = "ECONNRESET";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    const client = {
      getNegRisk: vi.fn().mockResolvedValue(false),
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
    };
    const wrapper = wrapperWith(client);

    const result = await wrapper.submitOrder({
      tokenId: "token",
      price: 0.48,
      size: 5,
      expiration: 2_000_000_000,
      tickSize: 0.01,
    });

    expect(result.success).toBe(false);
    expect(result.stateUnknown).toBe(true);
  });

  it("marks a 5xx POST response as unknown exchange state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "upstream" }, 503)));
    const client = {
      getNegRisk: vi.fn().mockResolvedValue(false),
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
    };
    const wrapper = wrapperWith(client);

    const result = await wrapper.submitOrder({
      tokenId: "token",
      price: 0.48,
      size: 5,
      expiration: 2_000_000_000,
      tickSize: 0.01,
    });

    expect(result.success).toBe(false);
    expect(result.stateUnknown).toBe(true);
  });

  it("rejects cancel-all responses that leave orders unresolved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ canceled: [], not_canceled: { a: "error" } })),
    );
    const wrapper = wrapperWith({});

    await expect(wrapper.cancelAll()).rejects.toThrow(/unresolved/i);
  });

  it("rejects an empty cancel-all response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    const wrapper = wrapperWith({});

    await expect(wrapper.cancelAll()).rejects.toThrow(/did not confirm/i);
  });

  it("requires a single cancel response to name the canceled order", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true })));
    const wrapper = wrapperWith({});

    await expect(wrapper.cancel("order-1")).rejects.toThrow(/canceled order list/i);
  });

  it("accepts a single cancel only when its order id is confirmed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ canceled: ["order-1"], not_canceled: {} })),
    );
    const wrapper = wrapperWith({});

    await expect(wrapper.cancel("order-1")).resolves.toBe(true);
  });

  it("times out a stuck market warmup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ version: 2 })));
    const client = {
      getClobMarketInfo: vi.fn(() => new Promise(() => undefined)),
      createOrder: vi.fn(),
    };
    const wrapper = wrapperWith(client);

    await expect(wrapper.warmMarket("condition", 5, 1)).rejects.toThrow(/timed out/i);
  });

  it("requests complete pages for unknown-state trade and order reconciliation", async () => {
    const client = {
      getTrades: vi.fn().mockResolvedValue([]),
      getOpenOrders: vi.fn().mockResolvedValue([]),
    };
    const wrapper = wrapperWith(client);

    await wrapper.getRecentTrades("condition", 1234);
    await wrapper.getOpenOrders("condition");

    expect(client.getTrades).toHaveBeenCalledWith(
      { market: "condition", after: "1234" },
      false,
    );
    expect(client.getOpenOrders).toHaveBeenCalledWith({ market: "condition" }, false);
  });
});
