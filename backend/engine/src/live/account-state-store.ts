import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  parseAccountEquityState,
  serializeAccountEquityState,
  type AccountEquityState,
} from './account-equity.js';
import {
  parseReservationState,
  serializeReservationState,
  type ReservationState,
} from './account-reservation.js';

export interface AccountStateEnvelope {
  schemaVersion: 1;
  account: string;
  mode: 'live';
  equity: AccountEquityState;
  reservation: ReservationState;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function accountKey(account: string, mode: 'live'): string {
  if (!/^0x[0-9a-f]{40}$/i.test(account)) {
    throw new Error('account state requires a stable account identity');
  }
  return `${mode}-${createHash('sha256').update(account.toLowerCase()).digest('hex')}`;
}

function validate(value: unknown, account: string, mode: 'live'): AccountStateEnvelope {
  if (!record(value) || Object.keys(value).length !== 5 || value.schemaVersion !== 1
      || value.account !== account.toLowerCase() || value.mode !== mode) {
    throw new Error('invalid account state envelope');
  }
  const equity = parseAccountEquityState(value.equity, account, mode);
  const reservation = parseReservationState(value.reservation);
  return { schemaVersion: 1, account: account.toLowerCase(), mode, equity, reservation };
}

/** Atomic, fail-closed persistence shared by equity and pre-submit reservations. */
export class AccountStateStore {
  readonly statePath: string;
  private readonly lockPath: string;
  private readonly initializedPath: string;
  private readonly token = randomUUID();
  private closed = false;
  private failed = false;
  private lastWritten = '';
  private hotPersistScheduled = false;
  private lastFileMtimeMs = 0;
  private lastFileSize = 0;
  private state: AccountStateEnvelope;

  constructor(directory: string, account: string, mode: 'live', initial?: AccountStateEnvelope) {
    const normalized = account.toLowerCase();
    const key = accountKey(normalized, mode);
    const root = resolve(directory);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.statePath = join(root, `account-${key}.json`);
    this.lockPath = join(root, `account-${key}.lock`);
    this.initializedPath = join(root, `account-${key}.initialized`);
    const fd = fs.openSync(this.lockPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.token }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      if (fs.existsSync(this.statePath)) {
        this.state = validate(JSON.parse(fs.readFileSync(this.statePath, 'utf8')), normalized, mode);
        this.lastWritten = JSON.stringify(this.state);
        if (this.state.reservation.reservations.some(item => item.status !== 'reconciled')) {
          throw new Error('previous account reservation is unresolved; reconciliation required');
        }
      } else if (fs.existsSync(this.initializedPath)) {
        throw new Error('previous account state is missing; reconciliation required');
      } else if (initial) {
        const checked = validate(initial, normalized, mode);
        this.atomicWrite(this.statePath, `${JSON.stringify(checked)}\n`);
        this.atomicWrite(this.initializedPath, 'initialized\n');
        this.state = checked;
        this.lastWritten = JSON.stringify(checked);
      } else {
        throw new Error('account state must be initialized from an authoritative snapshot');
      }
      this.verifyBeforeSubmission();
      this.captureFileSignature();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  read(): AccountStateEnvelope {
    return structuredClone(this.state);
  }

  write(next: AccountStateEnvelope): void {
    this.flushHot();
    const checked = validate(next, this.state.account, this.state.mode);
    this.verifyBeforeSubmission();
    try {
      this.atomicWrite(this.statePath, `${JSON.stringify(checked)}\n`);
    } catch (error) {
      this.failed = true;
      throw new Error('account checkpoint failed; refusing new risk', { cause: error });
    }
    this.state = checked;
    this.lastWritten = JSON.stringify(checked);
    this.captureFileSignature();
  }

  /**
   * Coalesce non-critical account/equity checkpoints. Pre-submit reservations
   * use write(), so this path is for refresh/mark data and never authorizes a
   * new order on its own.
   */
  writeHot(next: AccountStateEnvelope): void {
    const checked = validate(next, this.state.account, this.state.mode);
    this.verifyHot();
    this.state = checked;
    this.lastWritten = JSON.stringify(checked);
    if (this.hotPersistScheduled) return;
    this.hotPersistScheduled = true;
    setImmediate(() => {
      this.hotPersistScheduled = false;
      if (this.closed || this.failed) return;
      try { this.persistHot(); }
      catch { this.failed = true; }
    });
  }

  initialize(next: AccountStateEnvelope): void {
    if (fs.existsSync(this.initializedPath)) throw new Error('account state already initialized');
    const checked = validate(next, next.account, next.mode);
    this.atomicWrite(this.statePath, `${JSON.stringify(checked)}\n`);
    this.atomicWrite(this.initializedPath, 'initialized\n');
    this.state = checked;
    this.lastWritten = JSON.stringify(checked);
    this.captureFileSignature();
  }

  verifyBeforeSubmission(): void {
    this.flushHot();
    if (this.closed || this.failed) throw new Error('account persistence is unavailable; refusing new risk');
    try {
      const lock: unknown = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (!record(lock) || lock.token !== this.token || fs.readFileSync(this.statePath, 'utf8') !== `${this.lastWritten}\n`) {
        throw new Error('account state or lock changed outside the active owner');
      }
    } catch (error) {
      this.failed = true;
      throw new Error('account checkpoint is missing or changed; refusing new risk', { cause: error });
    }
  }

  /** Cheap in-process guard used by the order hot path. */
  verifyHot(): void {
    if (this.closed || this.failed) throw new Error('account persistence is unavailable; refusing new risk');
    try {
      const stat = fs.statSync(this.statePath);
      if (stat.mtimeMs !== this.lastFileMtimeMs || stat.size !== this.lastFileSize) {
        throw new Error('account state changed outside the active owner');
      }
    } catch (error) {
      this.failed = true;
      throw new Error('account checkpoint is missing or changed; refusing new risk', { cause: error });
    }
  }

  private captureFileSignature(): void {
    const stat = fs.statSync(this.statePath);
    this.lastFileMtimeMs = stat.mtimeMs;
    this.lastFileSize = stat.size;
  }

  flushHot(): void {
    if (!this.hotPersistScheduled) return;
    this.hotPersistScheduled = false;
    if (this.closed || this.failed) return;
    try {
      this.persistHot();
    } catch (error) {
      this.failed = true;
      throw new Error('account hot checkpoint failed; refusing new risk', { cause: error });
    }
  }

  private persistHot(): void {
    const encoded = JSON.stringify(this.state);
    this.atomicWrite(this.statePath, `${encoded}\n`, false);
    this.captureFileSignature();
  }

  close(): void {
    if (this.closed) return;
    try {
      this.flushHot();
    } catch {
      this.failed = true;
    } finally {
      this.closed = true;
      try {
        const owner: unknown = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
        if (record(owner) && owner.token === this.token) fs.unlinkSync(this.lockPath);
      } catch { /* best effort cleanup after a failed constructor */ }
    }
  }

  private atomicWrite(path: string, content: string, durable = true): void {
    const temporary = `${path}.${this.token}.tmp`;
    const backup = `${path}.${this.token}.bak`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, content);
      if (durable) fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (process.platform === 'win32' && fs.existsSync(path)) {
        fs.renameSync(path, backup);
        try { fs.renameSync(temporary, path); }
        catch (error) {
          if (!fs.existsSync(path) && fs.existsSync(backup)) fs.renameSync(backup, path);
          throw error;
        }
        fs.unlinkSync(backup);
      } else fs.renameSync(temporary, path);
      if (durable && process.platform !== 'win32') {
        const dir = fs.openSync(resolve(path, '..'), 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      if (fs.existsSync(backup) && !fs.existsSync(path)) fs.renameSync(backup, path);
    }
  }
}

export function accountStateEnvelope(
  account: string,
  mode: 'live',
  equity: AccountEquityState,
  reservation: ReservationState,
): AccountStateEnvelope {
  return validate({ schemaVersion: 1, account, mode, equity, reservation }, account, mode);
}

export { parseAccountEquityState, serializeAccountEquityState, parseReservationState, serializeReservationState };
