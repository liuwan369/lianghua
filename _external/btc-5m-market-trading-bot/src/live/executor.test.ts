import { describe, expect, it, vi } from "vitest";
import { Side } from "../models.js";
import { Executor, UnknownOrderStateError } from "./executor.js";

describe("Executor fill tracking", () => {
  it("enforces the USD cap on the actual submitted size", async () => {
    const executor = new Executor(false, 1, 10, 10);

    expect((await executor.submit(Side.Up, "token-up", 0.36, 20)).ok).toBe(false);
    expect((await executor.submit(Side.Up, "token-up", 0.2001, 20)).size).toBe(5);
    expect((await executor.submit(Side.Up, "token-up", 0.19, 20)).size).toBe(5.26);
    expect((await executor.submit(Side.Up, "token-up", 0.18, 20)).size).toBe(5.55);
    expect((await executor.submit(Side.Up, "token-up", 0.04, 20)).size).toBe(20);
  });

  it("keeps a partially filled maker order tracked until its remaining size fills", async () => {
    const executor = new Executor(false, 10, 10, 100);
    const submitted = await executor.submit(Side.Up, "token-up", 0.4, 5);

    expect(submitted.ok).toBe(true);
    expect(submitted.orderId).toBeDefined();
    expect(executor.restingId(Side.Up)).toBe(submitted.orderId);

    executor.live = true;
    executor.noteFill(Side.Up, submitted.orderId, 2);
    expect(executor.restingId(Side.Up)).toBe(submitted.orderId);
    expect(executor.isOurOrder(submitted.orderId!)).toBe(true);

    executor.noteFill(Side.Up, submitted.orderId, 3);
    expect(executor.restingId(Side.Up)).toBeUndefined();
    expect(executor.isOurOrder(submitted.orderId!)).toBe(false);
  });

  it("keeps local order tracking when cancel-all is not confirmed", async () => {
    const executor = new Executor(false, 10, 10, 100);
    const submitted = await executor.submit(Side.Up, "token-up", 0.4, 5);
    expect(submitted.orderId).toBeDefined();

    executor.live = true;
    (executor as unknown as { clob: { cancelAll: () => Promise<void> } }).clob = {
      cancelAll: vi.fn().mockRejectedValue(new Error("not confirmed")),
    };

    await expect(executor.cancelAll()).rejects.toThrow(/not confirmed/i);
    expect(executor.restingId(Side.Up)).toBe(submitted.orderId);
    expect(executor.isOurOrder(submitted.orderId!)).toBe(true);
  });

  it("conservatively charges limits when an order ACK is unknown", async () => {
    const executor = new Executor(true, 10, 10, 100);
    (executor as unknown as { clob: Record<string, unknown> }).clob = {
      tickSize: vi.fn().mockResolvedValue(0.01),
      submitOrder: vi.fn().mockResolvedValue({
        success: false,
        stateUnknown: true,
        errorMsg: "timeout",
      }),
    };

    await expect(executor.submit(Side.Up, "token-up", 0.4, 5))
      .rejects.toBeInstanceOf(UnknownOrderStateError);
    expect(executor.sent).toBe(1);
    expect(executor.spentUsd).toBeCloseTo(2);
  });
});
