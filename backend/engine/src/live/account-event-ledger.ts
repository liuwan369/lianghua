import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AccountLedgerRecord {
  seq: number;
  id: string;
  kind: "event" | "resync";
  receivedAtUnix: number;
  payload?: unknown;
  reason?: string;
}

export interface AccountLedgerStatus {
  nextSeq: number;
  continuous: boolean;
  reason?: string;
  eventCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseRecord(value: unknown): AccountLedgerRecord {
  if (!isRecord(value) || typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1 ||
      typeof value.id !== "string" || (value.kind !== "event" && value.kind !== "resync") ||
      typeof value.receivedAtUnix !== "number") {
    throw new Error("invalid account ledger record");
  }
  return value as unknown as AccountLedgerRecord;
}

/** Durable, idempotent account event log used alongside REST and chain reconciliation. */
export class AccountEventLedger {
  readonly path: string;
  private readonly continuityPath: string;
  private nextSeq = 1;
  private continuous = true;
  private reason: string | undefined;
  private readonly ids = new Set<string>();
  private eventCount = 0;

  constructor(directory: string, account: string, mode: "live") {
    if (!/^0x[0-9a-f]{40}$/i.test(account)) throw new Error("account ledger requires a live wallet identity");
    const suffix = account.toLowerCase();
    this.path = join(directory, `account-events-${mode}-${suffix}.jsonl`);
    this.continuityPath = `${this.path}.continuity`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (existsSync(this.continuityPath)) {
      const marker = readFileSync(this.continuityPath, "utf8").trim();
      if (marker) { this.continuous = false; this.reason = marker; }
    }
    if (!existsSync(this.path)) return;
    let expected = 1;
    for (const line of readFileSync(this.path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const record = parseRecord(JSON.parse(line));
      if (record.seq !== expected) throw new Error("account ledger sequence gap");
      expected += 1;
      if (record.kind === "event") {
        if (this.ids.has(record.id)) throw new Error("duplicate account ledger event id");
        this.ids.add(record.id);
        this.eventCount += 1;
      } else {
        this.continuous = true;
        this.reason = undefined;
      }
    }
    this.nextSeq = expected;
  }

  status(): AccountLedgerStatus {
    return { nextSeq: this.nextSeq, continuous: this.continuous, reason: this.reason, eventCount: this.eventCount };
  }

  append(id: string, payload: unknown, receivedAtUnix = Date.now() / 1000): boolean {
    if (!id || this.ids.has(id)) return false;
    this.write({ seq: this.nextSeq, id, kind: "event", receivedAtUnix, payload });
    this.ids.add(id);
    this.eventCount += 1;
    return true;
  }

  markDiscontinuous(reason: string): void {
    this.continuous = false;
    this.reason = reason;
    writeFileSync(this.continuityPath, reason, { mode: 0o600 });
  }

  markResynced(source: string, receivedAtUnix = Date.now() / 1000): void {
    this.write({ seq: this.nextSeq, id: `resync:${this.nextSeq}`, kind: "resync", receivedAtUnix, reason: source });
    this.continuous = true;
    this.reason = undefined;
    writeFileSync(this.continuityPath, "", { mode: 0o600 });
  }

  private write(record: AccountLedgerRecord): void {
    const fd = openSync(this.path, "a", 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.nextSeq += 1;
  }
}
