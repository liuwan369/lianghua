import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformJournal } from "./journal.js";

let temporary: string;
beforeEach(() => { temporary = mkdtempSync(join(tmpdir(), "platform-journal-")); });
afterEach(() => { rmSync(temporary, { recursive: true, force: true }); });

describe("platform journal", () => {
  it("flushes ordered JSONL before close and preserves deterministic execution IDs", async () => {
    const path = join(temporary, "nested", "journal.jsonl"), onFailure = vi.fn();
    const journal = new PlatformJournal(path, { onFailure, now: () => 123 });
    journal.write("order", { status: "OPEN" });
    journal.write("fill", { shares: 2 }, 'fill:["trade","order"]');
    journal.write("order", { status: "PARTIAL" });
    await journal.close();
    const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.event)).toEqual(["order", "fill", "order"]);
    expect(rows.every(row => row.recv_ts === 123)).toBe(true);
    expect(rows[1].event_id).toBe('fill:["trade","order"]');
    expect(rows[0].event_id).not.toBe(rows[2].event_id);
    expect(onFailure).not.toHaveBeenCalled();
    expect(journal.write("order", {})).toBe(false);
    await journal.close();
  });

  it("limits buffered data without blocking the event producer and flushes accepted records", async () => {
    const path = join(temporary, "bounded.jsonl"), onFailure = vi.fn();
    const journal = new PlatformJournal(path, { onFailure, maxBufferedBytes: 300 });
    expect(journal.write("order", { status: "OPEN" })).toBe(true);
    expect(journal.write("too_large", { payload: "x".repeat(500) })).toBe(false);
    expect(journal.write("after_failure", {})).toBe(false);
    expect(onFailure).toHaveBeenCalledOnce();
    await expect(journal.close()).rejects.toThrow(/buffer limit/);
    const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.event)).toEqual(["order"]);
  });

  it("reports filesystem failure with a safe error and rejects close", async () => {
    const onFailure = vi.fn();
    const journal = new PlatformJournal(temporary, { onFailure });
    journal.write("platform_status", {});
    await expect(journal.close()).rejects.toThrow("platform journal write failed");
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0][0].message).not.toContain(temporary);
  });
});
