#!/usr/bin/env node
/** Tokyo relay: reads the three venues' BTC USDT perpetual trades on their
 * direct lines (same parsers and per-venue dedupe as the engine, so Bybit's two
 * hosts do not double-send) and forwards each trade once to the Ireland engine
 * (lead-trades.ts relay message: UDP twice + one TCP line). Public market data
 * only: no orders, no Polymarket, no keys but the relay key.
 *
 *   node dist/cli/relay.js --host <ireland ip> [--port 47001] [--key-file <path>]
 * or PM_RELAY_TARGET_HOST / PM_RELAY_PORT / PM_RELAY_KEY_FILE. Prints one JSON
 * status line every 60 s. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { leadPerpProducts } from "../live/feeds/btc.js";
import { createRelaySender, readRelayKey, runLeadTrades } from "../live/feeds/lead-trades.js";
import { LEAD_VENUES, type LeadVenue } from "../platform/contracts.js";

const STATUS_MS = 60_000;

export function parseRelayOptions(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  const { values } = parseArgs({ args: argv, options: {
    host: { type: "string" }, port: { type: "string" }, "key-file": { type: "string" } }, strict: true });
  const host = (values.host ?? env.PM_RELAY_TARGET_HOST ?? "").trim();
  const port = Number(values.port ?? env.PM_RELAY_PORT ?? 47001);
  const keyFile = (values["key-file"] ?? env.PM_RELAY_KEY_FILE ?? "").trim();
  if (!host) throw new Error("relay needs --host or PM_RELAY_TARGET_HOST");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("relay port must be 1..65535");
  if (!keyFile) throw new Error("relay needs --key-file or PM_RELAY_KEY_FILE");
  return { host, port, keyFile };
}

export function runRelay(options: { host: string; port: number; keyFile: string }) {
  let key;
  // The key never reaches a message: only "unreadable".
  try { key = readRelayKey(options.keyFile); } catch { throw new Error("relay key file is unreadable or too short"); }
  const sender = createRelaySender({ host: options.host, port: options.port, key });
  const sent: Record<LeadVenue, number> = { bybit: 0, binance: 0, okx: 0 };
  const trades = runLeadTrades({ venues: LEAD_VENUES, products: leadPerpProducts("btc") }, (trade, source) => {
    sender.send(source, trade.receivedAtUnix * 1000);
    sent[trade.venue] += 1;
  });
  const status = setInterval(() => {
    const lines = trades.stats().venues;
    console.log(JSON.stringify({ kind: "relay_status", ts: Date.now() / 1000, sent: { ...sent },
      healthy: trades.isHealthy(), sender: sender.stats(),
      frames: Object.fromEntries(LEAD_VENUES.map(venue => [venue, lines[venue]?.direct.frames ?? 0])) }));
  }, STATUS_MS);
  return { stop: () => { clearInterval(status); trades.stop(); sender.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const relay = runRelay(parseRelayOptions(process.argv.slice(2)));
    const stop = () => { relay.stop(); process.exit(0); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  } catch (error) {
    console.error(JSON.stringify({ kind: "relay_error", message: error instanceof Error ? error.message : "relay failed" }));
    process.exitCode = 1;
  }
}
