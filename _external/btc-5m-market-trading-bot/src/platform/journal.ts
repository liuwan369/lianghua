import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface JournalOptions {
  onFailure: (error: Error) => void;
  maxBufferedBytes?: number;
  now?: () => number;
}

/** Bounded asynchronous JSONL output, separate from feed diagnostic stdout. */
export class PlatformJournal {
  private readonly stream: WriteStream;
  private readonly completion: Promise<void>;
  private readonly runId = randomUUID();
  private sequence = 0;
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

  write(event: string, fields: Record<string, unknown>, eventId?: string): boolean {
    if (this.failure || this.closed) return false;
    let line: string;
    try {
      line = JSON.stringify({ ...fields, event,
        recv_ts: this.options.now?.() ?? Date.now() / 1000,
        event_id: eventId ?? `${this.runId}:${++this.sequence}` }) + "\n";
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

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.stream.end();
    }
    await this.completion;
    if (this.failure) throw this.failure;
  }
}
