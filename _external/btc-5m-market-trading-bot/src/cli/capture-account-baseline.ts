import 'dotenv/config';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectAccountReader } from '../live/account-data.js';

type Row = Record<string, unknown>;

function loadProfile(): void {
  const path = process.env.PM_ACCOUNT_PROFILE ?? '/root/.config/pm-system/account.json';
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === 'string' && raw && !process.env[key]) process.env[key] = raw;
    }
  } catch { /* the reader below reports an unavailable account instead of secrets */ }
}

function dayKey(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function completeSection(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as Row).available === true && (value as Row).complete === true
    && Array.isArray((value as Row).items);
}

function evidence(reads: unknown[], capturedAt: string): Row {
  const first = reads[0] as Row | undefined;
  const sections = ['collateral', 'positions', 'open_orders', 'trades', 'closed_positions', 'activity'];
  const complete = reads.length === 2 && reads.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const row = item as Row;
    return row.read_only === true && sections.every((name) => completeSection(row[name]));
  });
  const reconciliation = first?.reconciliation;
  const transferScan = reconciliation && typeof reconciliation === 'object' && !Array.isArray(reconciliation)
    ? (reconciliation as Row).transfer_scan : undefined;
  const transfersComplete = !!transferScan && typeof transferScan === 'object' && !Array.isArray(transferScan)
    && (transferScan as Row).complete === true;
  return {
    schemaVersion: 1, captured_at: capturedAt, opening_day: dayKey(new Date(capturedAt)),
    source: 'server-midnight-account-reader', reads, sections_complete: complete,
    transfers_complete: transfersComplete, eligible_for_live_bootstrap: false,
    eligibility_reason: complete && transfersComplete
      ? 'ordinary-reader-needs-same-cut-liquidation-and-token-evidence'
      : 'account-sections-or-confirmed-transfer-range-incomplete',
  };
}

async function main(): Promise<void> {
  loadProfile();
  const reader = await connectAccountReader();
  const reads: unknown[] = [];
  reads.push(await reader());
  await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  reads.push(await reader());
  const outputDir = process.env.PM_ACCOUNT_BASELINE_DIR ?? join(process.cwd(), 'results/account-baseline');
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const capturedAt = new Date().toISOString();
  const payload = `${JSON.stringify(evidence(reads, capturedAt), null, 2)}\n`;
  const path = join(outputDir, `beijing-${dayKey(new Date(capturedAt))}.json`);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, payload, { mode: 0o600 });
  renameSync(temporary, path);
  process.stdout.write(JSON.stringify({ path, captured_at: capturedAt, reads: reads.length }) + '\n');
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
