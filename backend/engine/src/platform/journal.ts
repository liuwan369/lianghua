import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface JournalOptions {
  onFailure: (error: Error) => void;
  maxBufferedBytes?: number;
  maxTelemetryBufferedBytes?: number;
  now?: () => number;
}

export interface JournalStats {
  telemetryDropped: number;
}

/** Bounded asynchronous JSONL output, separate from feed diagnostic stdout. */
export class PlatformJournal {
  private readonly stream: WriteStream;
  private readonly completion: Promise<void>;
  private readonly runId = randomUUID();
  private sequence = 0;
  private telemetryDropped = 0;
  private closed = false;
  private failure?: Error;

  constructor(path: string, private readonly options: JournalOptions) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: "a", mode: 0o600 });
    this.completion = new Promise<void>((resolve, reject) => {
      this.stream.once("finish", resolve);
      this.stream.once("error", () => {
        this.fail("platform journal write failed");
        reject(this.failure);
      });
    });
    void this.completion.catch(() => undefined);
  }

  private fail(message: string): void {
    if (this.failure) return;
    this.failure = new Error(message);
    this.options.onFailure(this.failure);
  }

  private serialize(event: string, fields: Record<string, unknown>, eventId?: string): string {
    return JSON.stringify({ ...fields, event,
      recv_ts: this.options.now?.() ?? Date.now() / 1000,
      event_id: eventId ?? `${this.runId}:${++this.sequence}` }) + "\n";
  }

  write(event: string, fields: Record<string, unknown>, eventId?: string): boolean {
    if (this.failure || this.closed) return false;
    let line: string;
    try {
      line = this.serialize(event, fields, eventId);
    } catch {
      this.fail("platform journal serialization failed");
      return false;
    }
    if (this.stream.writableLength + Buffer.byteLength(line) > (this.options.maxBufferedBytes ?? 1024 * 1024)) {
      this.fail("platform journal buffer limit reached");
      return false;
    }
    this.stream.write(line);
    return true;
  }

  /** Best-effort high-volume telemetry that cannot consume the critical record reserve. */
  writeTelemetry(event: string, fields: Record<string, unknown>, eventId?: string): boolean {
    if (this.failure || this.closed) return false;
    let line: string;
    try {
      line = this.serialize(event, fields, eventId);
    } catch {
      this.telemetryDropped += 1;
      return false;
    }
    const telemetryLimit = Math.min(
      this.options.maxTelemetryBufferedBytes ?? 256 * 1024,
      this.options.maxBufferedBytes ?? 1024 * 1024,
    );
    if (this.stream.writableLength + Buffer.byteLength(line) > telemetryLimit) {
      this.telemetryDropped += 1;
      return false;
    }
    this.stream.write(line);
    return true;
  }

  stats(): JournalStats {
    return { telemetryDropped: this.telemetryDropped };
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.stream.end();
    }
    await this.completion;
    if (this.failure) throw this.failure;
  }
}
