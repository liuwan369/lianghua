#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const directory = process.argv[2];
if (!directory) throw new Error("usage: node scripts/summarize-kernel-ab.mjs RESULT_DIRECTORY");
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
}
const expectedRestSamples = option("--expected-rest-samples", 60);
const expectedWsSeconds = option("--expected-ws-seconds", 180);

const files = (await readdir(directory))
  .filter((name) => /^\d{2}-.*\.json$/.test(name))
  .sort();

function value(report, ...path) {
  return path.reduce((current, key) => current?.[key], report);
}

const rows = [];
for (const file of files) {
  const report = JSON.parse(await readFile(join(directory, file), "utf8"));
  rows.push({
    file,
    label: basename(file, ".json").replace(/^\d{2}-/, ""),
    duration_seconds: report.ws_seconds,
    elapsed_ms: report.elapsed_ms,
    rest_count: value(report, "clob_rest", "count"),
    rest_p50_ms: value(report, "clob_rest", "p50_ms"),
    rest_p95_ms: value(report, "clob_rest", "p95_ms"),
    ws_segments: value(report, "websocket", "completed_samples"),
    ws_messages: value(report, "websocket", "messages"),
    message_age_p50_ms: value(report, "websocket", "adjusted_steady_message_age", "p50_ms"),
    message_age_p95_ms: value(report, "websocket", "adjusted_steady_message_age", "p95_ms"),
    receive_gap_p99_ms: value(report, "websocket", "receive_gap", "p99_ms"),
    stale_events: value(report, "websocket", "stale_events"),
    errors: Array.isArray(report.errors) ? report.errors : [],
  });
}

const screenRows = rows.filter((row) => row.label !== "existing-default-30m");
for (const row of screenRows) {
  row.complete = (
    row.errors.length === 0 &&
    row.rest_count === expectedRestSamples &&
    row.duration_seconds === expectedWsSeconds &&
    Number(row.elapsed_ms) >= expectedWsSeconds * 1_000 - 100 &&
    Number(row.ws_segments) > 0 &&
    Number(row.ws_messages) > 0 &&
    row.stale_events === 0 &&
    Number.isFinite(row.receive_gap_p99_ms) &&
    Number.isFinite(row.message_age_p95_ms) &&
    Number.isFinite(row.rest_p95_ms)
  );
}
const eligible = screenRows.filter((row) =>
  row.complete &&
  row.errors.length === 0 &&
  Number.isFinite(row.message_age_p95_ms) &&
  Number.isFinite(row.rest_p95_ms)
);

function variant(label) {
  return label.replace(/-[abc]$/, "");
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const groups = new Map();
for (const row of eligible) {
  const name = variant(row.label);
  const group = groups.get(name) ?? [];
  group.push(row);
  groups.set(name, group);
}

const aggregates = [...groups.entries()].map(([name, group]) => ({
  variant: name,
  complete_runs: group.length,
  message_age_p95_ms: median(group.map((row) => row.message_age_p95_ms)),
  rest_p95_ms: median(group.map((row) => row.rest_p95_ms)),
  receive_gap_p99_ms: median(group.map((row) => row.receive_gap_p99_ms)),
})).filter((row) => row.variant === "default" ? row.complete_runs >= 3 : row.complete_runs >= 2);

aggregates.sort((a, b) =>
  a.message_age_p95_ms - b.message_age_p95_ms ||
  a.rest_p95_ms - b.rest_p95_ms ||
  a.receive_gap_p99_ms - b.receive_gap_p99_ms
);

const baseline = aggregates.find((row) => row.variant === "default");
const winner = aggregates[0];
const improvement = baseline && winner && baseline.message_age_p95_ms > 0
  ? (baseline.message_age_p95_ms - winner.message_age_p95_ms) / baseline.message_age_p95_ms
  : 0;
const recommended = winner && winner.variant !== "default" && improvement >= 0.05
  ? winner.variant
  : "default";

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  directory,
  expected_rest_samples: expectedRestSamples,
  expected_ws_seconds: expectedWsSeconds,
  ranking_rule: "zero errors, then WebSocket adjusted steady message-age p95, REST p95, receive-gap p99",
  note: "Two opposite-order short screens identify candidates only. A non-default needs at least 5% aggregate message-age p95 improvement and must pass a longer confirmation.",
  candidate: winner?.variant ?? null,
  recommended,
  aggregate_improvement_vs_default: improvement,
  aggregates,
  rows,
}, null, 2));
