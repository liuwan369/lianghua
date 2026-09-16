import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { CoreState } from "./contracts.js";

/** Account/mode-scoped persistence; reserve writes are durable, event writes are coalesced. */
export class PlatformStore {
  private pending?: CoreState;
  private timer?: ReturnType<typeof setTimeout>;
  private failure?: Error;
  private closed = false;
  private lockFd: number;
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const lock = `${path}.lock`;
    try { this.lockFd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid?: unknown };
        const pid = typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) ? owner.pid : undefined;
        if (!pid) stale = true;
        else {
          try { process.kill(pid, 0); }
          catch (probe) { stale = (probe as NodeJS.ErrnoException).code === "ESRCH"; }
        }
      } catch { stale = true; }
      if (!stale) throw new Error("platform state is locked by a live process");
      unlinkSync(lock);
      this.lockFd = openSync(lock, "wx", 0o600);
    }
    writeSync(this.lockFd, JSON.stringify({ pid: process.pid }));
  }
  load(): CoreState | undefined {
    const recovery = `${this.path}.next`;
    // A crash or rename failure can leave the newest complete snapshot in the
    // recovery file. Prefer it so a durable reservation is never silently lost.
    if (existsSync(recovery)) {
      try { return JSON.parse(readFileSync(recovery, "utf8")) as CoreState; }
      catch { /* fall through to the last committed primary snapshot */ }
    }
    if (!existsSync(this.path)) return undefined;
    return JSON.parse(readFileSync(this.path, "utf8")) as CoreState;
  }
  save(state: CoreState, critical: boolean): void {
    if (this.closed) throw new Error("state store closed");
    if (this.failure) throw this.failure;
    this.pending = structuredClone(state);
    if (critical) { clearTimeout(this.timer); this.timer = undefined; this.flush(); return; }
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.flush(); } catch (error) { this.failure = error instanceof Error ? error : new Error("state write failed"); }
    }, 25);
  }
  private flush(): void {
    if (!this.pending) return;
    const fd = openSync(`${this.path}.next`, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(this.pending)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${this.path}.next`, this.path);
    this.pending = undefined;
  }
  close(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    try { this.flush(); if (this.failure) throw this.failure; }
    finally { closeSync(this.lockFd); unlinkSync(`${this.path}.lock`); this.closed = true; }
  }
}
