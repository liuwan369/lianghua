import { describe, expect, it } from "vitest";
import {
  assertOfficialClobHealth,
  liveBookIsFresh,
} from "./orchestrator.js";

describe("official CLOB health gate", () => {
  it("accepts an HTTP success from the official endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      await expect(assertOfficialClobHealth()).resolves.toBeTypeOf("number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an official endpoint error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad", { status: 503 });
    try {
      await expect(assertOfficialClobHealth()).rejects.toThrow(/HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("live book freshness", () => {
  it("rejects a quote older than the live decision budget", () => {
    expect(liveBookIsFresh({ tsUnix: 9.9 }, 10_000, 250)).toBe(true);
    expect(liveBookIsFresh({ tsUnix: 9.7 }, 10_000, 250)).toBe(false);
  });

  it("uses both exchange-side timestamps for a Polymarket websocket book", () => {
    expect(liveBookIsFresh({
      tsUnix: 10,
      source: "polymarket-ws",
      upExchangeTsUnix: 9.9,
      downExchangeTsUnix: 9.8,
    }, 10_000, 250)).toBe(true);
    expect(liveBookIsFresh({
      tsUnix: 10,
      source: "polymarket-ws",
      upExchangeTsUnix: 9.9,
      downExchangeTsUnix: 9.7,
    }, 10_000, 250)).toBe(false);
    expect(liveBookIsFresh({
      tsUnix: 10,
      source: "polymarket-ws",
    }, 10_000, 250)).toBe(false);
  });
});
