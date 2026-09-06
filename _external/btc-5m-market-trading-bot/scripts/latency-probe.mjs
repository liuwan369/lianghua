#!/usr/bin/env node
import { promises as dns } from "node:dns";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const CLOB = "https://clob.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const MARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
// Malta's frontend restriction currently applies to sports only; the API is
// unrestricted under the same official frontend-only category.
const FRONTEND_ONLY_RESTRICTED_COUNTRIES = new Set(["IE", "JP", "MT", "NL"]);
const execFileAsync = promisify(execFile);

function apiRegionStatus(geoblock) {
  const country = String(geoblock?.country ?? "").toUpperCase();
  if (geoblock?.blocked === false) {
    return { allowed: true, basis: "geoblock endpoint returned blocked=false" };
  }
  if (geoblock?.blocked === true && FRONTEND_ONLY_RESTRICTED_COUNTRIES.has(country)) {
    return {
      allowed: true,
      basis: "official docs list this country as frontend-only restricted; API remains available",
    };
  }
  return { allowed: false, basis: "official API eligibility was not established" };
}

function parseArgs(argv) {
  const options = {
    samples: 15,
    wsSeconds: 3,
    output: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--samples") options.samples = Number(argv[++i]);
    else if (arg === "--ws-seconds") options.wsSeconds = Number(argv[++i]);
    else if (arg === "--output") options.output = argv[++i] ?? null;
    else positional.push(arg);
  }
  if (positional.length > 0) options.samples = Number(positional[0]);
  if (!Number.isFinite(options.samples) || options.samples < 3) {
    throw new Error("--samples must be at least 3");
  }
  if (!Number.isFinite(options.wsSeconds) || options.wsSeconds < 3) {
    throw new Error("--ws-seconds must be at least 3");
  }
  options.samples = Math.floor(options.samples);
  options.wsSeconds = Math.floor(options.wsSeconds);
  return options;
}

const options = parseArgs(process.argv.slice(2));
const samples = options.samples;

function percentile(values, pct) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1),
  );
  return Number(sorted[index].toFixed(2));
}

function summary(values) {
  return {
    count: values.length,
    min_ms: percentile(values, 0),
    p50_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    p99_ms: percentile(values, 99),
    max_ms: percentile(values, 100),
  };
}

async function clockSyncStatus() {
  const result = {
    source: null,
    synchronized: false,
    local_minus_ntp_ms: null,
    detail: null,
  };
  try {
    const { stdout } = await execFileAsync("chronyc", ["tracking"], { timeout: 3_000 });
    const systemTime = stdout.match(
      /System time\s*:\s*([0-9.]+) seconds (fast|slow) of NTP time/i,
    );
    const leap = stdout.match(/Leap status\s*:\s*(.+)/i);
    if (systemTime) {
      const magnitude = Number(systemTime[1]) * 1_000;
      result.local_minus_ntp_ms = systemTime[2].toLowerCase() === "fast"
        ? magnitude
        : -magnitude;
    }
    result.source = "chrony";
    result.synchronized = String(leap?.[1] ?? "").trim().toLowerCase() === "normal";
    result.detail = String(leap?.[1] ?? "unknown").trim();
    return result;
  } catch {
    // Fall through to the operating system sync flag.
  }
  try {
    const { stdout } = await execFileAsync(
      "timedatectl",
      ["show", "--property=NTPSynchronized", "--value"],
      { timeout: 3_000 },
    );
    result.source = "timedatectl";
    result.synchronized = stdout.trim().toLowerCase() === "yes";
    result.detail = stdout.trim();
  } catch {
    result.detail = "clock synchronization could not be verified";
  }
  return result;
}

async function timedFetch(url) {
  const started = performance.now();
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  await response.arrayBuffer();
  return {
    ms: performance.now() - started,
    status: response.status,
    cfRay: response.headers.get("cf-ray"),
  };
}

async function currentMarket() {
  const start = Math.floor(Date.now() / 1000 / 300) * 300;
  const slug = `btc-updown-5m-${start}`;
  const response = await fetch(`${GAMMA}/markets?slug=${slug}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Gamma returned ${response.status}`);
  const rows = await response.json();
  const market = Array.isArray(rows) ? rows[0] : rows?.data?.[0];
  if (!market) throw new Error(`current market ${slug} not found`);
  const tokens = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : JSON.parse(market.clobTokenIds);
  if (!Array.isArray(tokens) || tokens.length < 2) throw new Error("market tokens missing");
  return { slug, start, end: start + 300, tokens: tokens.slice(0, 2).map(String) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function websocketSample(tokens, collectMs, clockOffsetMs) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const openedAt = { value: 0 };
    let firstBookMs = null;
    const messageAge = [];
    const steadyMessageAge = [];
    const adjustedMessageAge = [];
    const adjustedSteadyMessageAge = [];
    const receiveGaps = [];
    const bookTokens = new Set();
    let messages = 0;
    let timestampedEvents = 0;
    let staleEvents = 0;
    let lastMessageAt = null;
    let firstMessageAt = null;
    let finished = false;
    let heartbeat = null;
    const ws = new WebSocket(MARKET_WS);
    const timeout = setTimeout(() => {
      finished = true;
      if (heartbeat) clearInterval(heartbeat);
      ws.close();
      reject(new Error("websocket sample timed out"));
    }, Math.max(collectMs + 5_000, 10_000));

    ws.addEventListener("open", () => {
      openedAt.value = performance.now();
      ws.send(JSON.stringify({
        assets_ids: tokens,
        type: "market",
        custom_feature_enabled: true,
      }));
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10_000);
    });
    ws.addEventListener("message", (message) => {
      const text = String(message.data);
      if (text === "PONG" || text === "pong") return;
      const receivedAt = performance.now();
      if (firstMessageAt == null) firstMessageAt = receivedAt;
      if (lastMessageAt != null) receiveGaps.push(receivedAt - lastMessageAt);
      lastMessageAt = receivedAt;
      messages += 1;
      try {
        const payload = JSON.parse(text);
        const batch = Array.isArray(payload) ? payload : [payload];
        for (const event of batch) {
          const eventType = String(event?.event_type ?? "").toLowerCase();
          const token = String(event?.asset_id ?? event?.token_id ?? "");
          if (
            eventType === "book" &&
            tokens.includes(token) &&
            (Array.isArray(event?.bids) || Array.isArray(event?.asks))
          ) {
            bookTokens.add(token);
            if (bookTokens.size === tokens.length && firstBookMs == null) {
              firstBookMs = performance.now() - openedAt.value;
            }
          }
          const raw = Number(event?.timestamp ?? event?.ts ?? event?.time);
          if (!Number.isFinite(raw)) continue;
          timestampedEvents += 1;
          const epochMs = raw > 1e12 ? raw : raw * 1000;
          const age = Date.now() - epochMs;
          if (age >= -1_000 && age < 60_000) {
            messageAge.push(age);
            const steady = performance.now() - openedAt.value >= 1_500;
            if (steady) steadyMessageAge.push(age);
            if (Number.isFinite(clockOffsetMs)) {
              const adjusted = age - clockOffsetMs;
              adjustedMessageAge.push(adjusted);
              if (steady) adjustedSteadyMessageAge.push(adjusted);
            }
          } else {
            staleEvents += 1;
          }
        }
      } catch {
        // Count transport messages even when an event has no timestamp.
      }
    });
    ws.addEventListener("error", (error) => {
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      reject(error);
    });
    ws.addEventListener("open", () => {
      setTimeout(() => {
        clearTimeout(timeout);
        if (heartbeat) clearInterval(heartbeat);
        const finishedAt = performance.now();
        const result = {
          connect_ms: openedAt.value - started,
          first_book_ms: firstBookMs,
          messages,
          message_age_values: messageAge,
          steady_message_age_values: steadyMessageAge,
          adjusted_message_age_values: adjustedMessageAge,
          adjusted_steady_message_age_values: adjustedSteadyMessageAge,
          receive_gap_values: receiveGaps,
          timestamped_events: timestampedEvents,
          stale_events: staleEvents,
          first_message_at: firstMessageAt,
          last_message_at: lastMessageAt,
          finished_at: finishedAt,
        };
        finished = true;
        ws.close();
        resolve(result);
      }, collectMs);
    });
    ws.addEventListener("close", (event) => {
      if (finished) return;
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      reject(new Error(`websocket closed early: code=${event.code} reason=${event.reason}`));
    });
  });
}

async function main() {
  const probeStarted = performance.now();
  const report = {
    measured_at: new Date().toISOString(),
    hostname: hostname(),
    samples,
    ws_seconds: options.wsSeconds,
    dns: {},
    outbound_ip_family: null,
    clock_sync: await clockSyncStatus(),
    geoblock: null,
    api_region: null,
    clob_rest: null,
    websocket: null,
    errors: [],
  };

  for (const host of ["clob.polymarket.com", "ws-subscriptions-clob.polymarket.com"]) {
    report.dns[host] = { ipv4: [], ipv6: [] };
    try {
      report.dns[host].ipv4 = await dns.resolve4(host);
    } catch (error) {
      report.errors.push(`DNS IPv4 ${host}: ${error}`);
    }
    try {
      report.dns[host].ipv6 = await dns.resolve6(host);
    } catch {
      // IPv6 is optional; the selected outbound family is recorded below.
    }
  }

  try {
    const response = await fetch("https://polymarket.com/api/geoblock", {
      signal: AbortSignal.timeout(5_000),
    });
    report.geoblock = await response.json();
    report.api_region = apiRegionStatus(report.geoblock);
    const outboundIp = String(report.geoblock?.ip ?? "");
    report.outbound_ip_family = outboundIp.includes(":") ? "ipv6" : outboundIp ? "ipv4" : null;
  } catch (error) {
    report.errors.push(`geoblock: ${error}`);
  }

  const rest = [];
  const cfColos = new Set();
  for (let i = 0; i < samples; i += 1) {
    try {
      const result = await timedFetch(`${CLOB}/time`);
      if (result.status === 200) rest.push(result.ms);
      const colo = result.cfRay?.split("-").at(-1);
      if (colo) cfColos.add(colo);
    } catch (error) {
      report.errors.push(`CLOB REST sample ${i + 1}: ${error}`);
    }
  }
  report.clob_rest = { ...summary(rest), cloudflare_colos: [...cfColos] };

  try {
    const wsRows = [];
    const markets = new Set();
    const wsRuns = options.wsSeconds >= 60 ? 1 : Math.min(samples, 5);
    for (let run = 0; run < wsRuns; run += 1) {
      let remainingCollectMs = options.wsSeconds * 1_000;
      while (remainingCollectMs >= 1_000) {
        const market = await currentMarket();
        markets.add(market.slug);
        const marketRemainingMs = market.end * 1_000 - Date.now() - 1_000;
        if (marketRemainingMs < 3_000) {
          await sleep(Math.max(250, marketRemainingMs + 2_000));
          continue;
        }
        const collectMs = Math.min(remainingCollectMs, marketRemainingMs);
        wsRows.push(await websocketSample(
          market.tokens,
          collectMs,
          report.clock_sync.local_minus_ntp_ms,
        ));
        remainingCollectMs -= collectMs;
      }
    }
    if (wsRows.length === 0) throw new Error("no websocket samples completed");
    const receiveGaps = wsRows.flatMap((row) => row.receive_gap_values);
    for (let i = 1; i < wsRows.length; i += 1) {
      const previous = wsRows[i - 1];
      const current = wsRows[i];
      if (previous.last_message_at != null && current.first_message_at != null) {
        receiveGaps.push(current.first_message_at - previous.last_message_at);
      }
    }
    const finalRow = wsRows.at(-1);
    if (finalRow?.last_message_at != null) {
      receiveGaps.push(finalRow.finished_at - finalRow.last_message_at);
    }
    report.websocket = {
      markets: [...markets],
      connect: summary(wsRows.map((row) => row.connect_ms)),
      first_book: summary(wsRows.map((row) => row.first_book_ms).filter(Number.isFinite)),
      message_age: summary(
        wsRows.flatMap((row) => row.message_age_values),
      ),
      steady_message_age: summary(
        wsRows.flatMap((row) => row.steady_message_age_values),
      ),
      adjusted_message_age: summary(
        wsRows.flatMap((row) => row.adjusted_message_age_values),
      ),
      adjusted_steady_message_age: summary(
        wsRows.flatMap((row) => row.adjusted_steady_message_age_values),
      ),
      receive_gap: summary(
        receiveGaps,
      ),
      messages: wsRows.reduce((sum, row) => sum + row.messages, 0),
      timestamped_events: wsRows.reduce((sum, row) => sum + row.timestamped_events, 0),
      stale_events: wsRows.reduce((sum, row) => sum + row.stale_events, 0),
      completed_samples: wsRows.length,
    };
  } catch (error) {
    report.errors.push(`market websocket: ${error}`);
  }

  if (!report.clock_sync.synchronized || !Number.isFinite(report.clock_sync.local_minus_ntp_ms)) {
    report.errors.push(
      "clock offset was not measured; raw message-age results are display-only and cannot rank hosts",
    );
  }
  report.completed_at = new Date().toISOString();
  report.elapsed_ms = performance.now() - probeStarted;
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(options.output, rendered, "utf8");
  console.log(rendered.trimEnd());
  process.exitCode =
    rest.length === 0 || report.websocket == null || report.websocket.completed_samples === 0
      ? 1
      : 0;
}

await main();
