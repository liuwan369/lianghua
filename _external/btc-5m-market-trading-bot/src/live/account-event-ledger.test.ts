import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountEventLedger } from "./account-event-ledger.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("account event ledger", () => {
  it("persists contiguous, idempotent events across restarts", () => {
    const root = mkdtempSync(join(tmpdir(), "pm-ledger-")); roots.push(root);
    const first = new AccountEventLedger(root, "0xabc", "live");
    expect(first.append("fill:t1:o1", { kind: "exchangeFill" })).toBe(true);
    expect(first.append("fill:t1:o1", { kind: "exchangeFill" })).toBe(false);
    expect(first.status()).toMatchObject({ nextSeq: 2, eventCount: 1, continuous: true });
    const second = new AccountEventLedger(root, "0xabc", "live");
    expect(second.append("cancel:o1", { kind: "orderCancelled" })).toBe(true);
    expect(second.status().nextSeq).toBe(3);
    expect(readFileSync(second.path, "utf8").trim().split(/\r?\n/)).toHaveLength(2);
  });

  it("keeps a reconnect gap closed until explicit resync", () => {
    const root = mkdtempSync(join(tmpdir(), "pm-ledger-")); roots.push(root);
    const ledger = new AccountEventLedger(root, "default-paper", "paper");
    ledger.markDiscontinuous("websocket reconnect");
    expect(ledger.status()).toMatchObject({ continuous: false, reason: "websocket reconnect" });
    ledger.markResynced("REST compensation");
    expect(ledger.status()).toMatchObject({ continuous: true, reason: undefined, nextSeq: 2 });
  });
});
