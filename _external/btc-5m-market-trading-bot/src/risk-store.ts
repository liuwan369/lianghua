import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { DailyMode, MarketMode, RiskState } from "./risk.js";

export interface RiskExposure {
  marketStart: number;
  marketEnd: number;
  upShares: number;
  downShares: number;
  cost: number;
  fees: number;
  pendingOrders: number;
  settled: boolean;
}

interface RiskSnapshot {
  sessionPnl: number;
  sessionHalted: boolean;
  dailyDate: string;
  dailyPnl: number;
  dailyMode: DailyMode;
  marketMode: MarketMode;
  singleSideSince: number | null;
  consecutiveMarketLosses: number;
  marketFillsWhileHot: number;
  marketPeakPairCost: number;
}

interface RiskDocument {
  schemaVersion: 1;
  account: string;
  mode: "live" | "paper";
  riskTimezone: "Asia/Shanghai";
  activeRun: boolean;
  reconciliationRequired: boolean;
  stopReason: string | null;
  risk: RiskSnapshot;
  exposure: RiskExposure | null;
}

function snapshot(risk: RiskState): RiskSnapshot {
  return {
    sessionPnl: risk.sessionPnl, sessionHalted: risk.sessionHalted,
    dailyDate: risk.dailyDate, dailyPnl: risk.dailyPnl, dailyMode: risk.dailyMode,
    marketMode: risk.marketMode, singleSideSince: risk.singleSideSince ?? null,
    consecutiveMarketLosses: risk.consecutiveMarketLosses,
    marketFillsWhileHot: risk.marketFillsWhileHot, marketPeakPairCost: risk.marketPeakPairCost,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonnegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validate(value: unknown, account: string, mode: "live" | "paper"): RiskDocument {
  if (!record(value) || !exact(value, ["schemaVersion", "account", "mode", "riskTimezone", "activeRun",
    "reconciliationRequired", "stopReason", "risk", "exposure"]) || value.schemaVersion !== 1 ||
    value.account !== account || value.mode !== mode || value.riskTimezone !== "Asia/Shanghai" ||
    typeof value.activeRun !== "boolean" || typeof value.reconciliationRequired !== "boolean" ||
    !(value.stopReason === null || typeof value.stopReason === "string") ||
    (value.stopReason !== null && !value.reconciliationRequired)) {
    throw new Error("invalid risk state envelope");
  }
  const risk = value.risk;
  if (!record(risk) || !exact(risk, Object.keys(snapshot(new RiskState()))) ||
    !finite(risk.sessionPnl) || typeof risk.sessionHalted !== "boolean" ||
    typeof risk.dailyDate !== "string" || !(risk.dailyDate === "" || validDay(risk.dailyDate)) ||
    (risk.dailyDate === "" && (risk.dailyPnl !== 0 || risk.dailyMode !== DailyMode.Normal)) ||
    !finite(risk.dailyPnl) || !Object.values(DailyMode).includes(risk.dailyMode as DailyMode) ||
    !Object.values(MarketMode).includes(risk.marketMode as MarketMode) ||
    !(risk.singleSideSince === null || nonnegative(risk.singleSideSince)) ||
    !nonnegative(risk.consecutiveMarketLosses) || !Number.isInteger(risk.consecutiveMarketLosses) ||
    !nonnegative(risk.marketFillsWhileHot) || !Number.isInteger(risk.marketFillsWhileHot) ||
    !nonnegative(risk.marketPeakPairCost)) throw new Error("invalid persisted risk counters");
  const exposure = value.exposure;
  if (exposure !== null && (!record(exposure) || !exact(exposure,
    ["marketStart", "marketEnd", "upShares", "downShares", "cost", "fees", "pendingOrders", "settled"]) ||
    !["marketStart", "marketEnd", "upShares", "downShares", "cost", "fees", "pendingOrders"]
      .every(key => nonnegative(exposure[key])) || !Number.isInteger(exposure.pendingOrders) ||
    (exposure.marketEnd as number) < (exposure.marketStart as number) || typeof exposure.settled !== "boolean")) {
    throw new Error("invalid persisted risk exposure");
  }
  return value as unknown as RiskDocument;
}

function unresolved(exposure: RiskExposure | null): boolean {
  return !!exposure && (exposure.pendingOrders > 0 || (!exposure.settled &&
    (exposure.upShares > 0 || exposure.downShares > 0 || exposure.cost > 0)));
}

/** Single-host account/mode lock plus a durable fail-closed restart checkpoint. */
export class RiskStore {
  readonly statePath: string;
  private readonly lockPath: string;
  private readonly initializedPath: string;
  private readonly lockToken = randomUUID();
  private document: RiskDocument;
  private closed = false;
  private failed = false;
  private lastWritten = "";

  constructor(directory: string, accountId: string, mode: "live" | "paper") {
    const account = accountId.trim().toLowerCase();
    if (!account || (mode === "live" && !/^0x[0-9a-f]{40}$/.test(account))) {
      throw new Error("risk state requires a stable public account identity");
    }
    const root = resolve(directory);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const key = `${mode}-${createHash("sha256").update(account).digest("hex")}`;
    this.statePath = join(root, `${key}.json`);
    this.lockPath = join(root, `${key}.lock`);
    this.initializedPath = join(root, `${key}.initialized`);
    const lockFd = fs.openSync(this.lockPath, "wx", 0o600);
    try {
      fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token: this.lockToken }));
      fs.fsyncSync(lockFd);
    } finally {
      fs.closeSync(lockFd);
    }
    this.document = { schemaVersion: 1, account, mode, riskTimezone: "Asia/Shanghai", activeRun: false,
      reconciliationRequired: false, stopReason: null, risk: snapshot(new RiskState()), exposure: null };
    try {
      if (fs.existsSync(this.statePath)) {
        this.document = validate(JSON.parse(fs.readFileSync(this.statePath, "utf8")), account, mode);
      } else if (fs.existsSync(this.initializedPath)) {
        throw new Error("previous risk state is missing; account reconciliation required");
      }
      if (this.document.activeRun || this.document.reconciliationRequired || unresolved(this.document.exposure)) {
        throw new Error("previous run or exposure is unreconciled; refusing new risk");
      }
      this.persist();
      if (!fs.existsSync(this.initializedPath)) this.atomicWrite(this.initializedPath, "initialized\n");
    } catch (error) {
      this.close();
      throw error;
    }
  }

  restore(): RiskState {
    const risk = new RiskState();
    Object.assign(risk, this.document.risk);
    risk.singleSideSince = this.document.risk.singleSideSince ?? undefined;
    return risk;
  }

  begin(risk: RiskState): void {
    this.document.activeRun = true;
    this.checkpoint(risk, this.document.exposure);
  }

  checkpoint(risk: RiskState, exposure: RiskExposure | null = this.document.exposure): void {
    this.document.risk = snapshot(risk);
    this.document.exposure = exposure;
    this.persist();
  }

  requireReconciliation(reason: string): void {
    this.document.reconciliationRequired = true;
    this.document.stopReason = reason;
    this.persist();
  }

  finish(risk: RiskState, exposure: RiskExposure | null): void {
    this.document.activeRun = false;
    this.document.reconciliationRequired ||= unresolved(exposure);
    if (this.document.reconciliationRequired) this.document.stopReason ??= "unsettled exposure";
    this.checkpoint(risk, exposure);
  }

  private persist(): void {
    if (this.closed || this.failed) throw new Error("risk persistence is unavailable; refusing new risk");
    try {
      validate(this.document, this.document.account, this.document.mode);
      const encoded = JSON.stringify(this.document);
      if (encoded === this.lastWritten) return;
      if (this.lastWritten) this.verifyBeforeSubmission();
      this.atomicWrite(this.statePath, `${encoded}\n`);
      this.lastWritten = encoded;
    } catch (error) {
      this.failed = true;
      throw new Error("risk persistence failed; refusing new risk", { cause: error });
    }
  }

  verifyBeforeSubmission(): void {
    if (this.closed || this.failed) throw new Error("risk persistence is unavailable; refusing new risk");
    try {
      const lock: unknown = JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
      if (!record(lock) || lock.token !== this.lockToken ||
        fs.readFileSync(this.statePath, "utf8") !== `${this.lastWritten}\n`) {
        throw new Error("risk state or lock changed outside the active owner");
      }
    } catch (error) {
      this.failed = true;
      throw new Error("risk checkpoint is missing or changed; refusing new risk", { cause: error });
    }
  }

  private atomicWrite(path: string, content: string): void {
    const temporary = `${path}.${this.lockToken}.tmp`;
    const backup = `${path}.${this.lockToken}.bak`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (process.platform === "win32" && fs.existsSync(path)) {
        // Windows rename does not replace an existing file. Keep a private
        // fallback so a failed second rename never destroys the checkpoint.
        fs.renameSync(path, backup);
        try {
          fs.renameSync(temporary, path);
        } catch (error) {
          if (!fs.existsSync(path) && fs.existsSync(backup)) fs.renameSync(backup, path);
          throw error;
        }
        fs.unlinkSync(backup);
      } else {
        fs.renameSync(temporary, path);
      }
      if (process.platform !== "win32") {
        const directoryFd = fs.openSync(resolve(path, ".."), "r");
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      if (fs.existsSync(backup) && !fs.existsSync(path)) fs.renameSync(backup, path);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const owner: unknown = JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
    if (record(owner) && owner.token === this.lockToken) fs.unlinkSync(this.lockPath);
  }
}
