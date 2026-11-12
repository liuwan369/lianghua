/** Lead trades from three USDT perpetual venues (Bybit, Binance, OKX), each on
 * two kinds of line: direct WebSocket from here, and relayed from a Tokyo box
 * (cli/relay.ts, which runs the same parsers and dedupe on its own direct
 * lines). Every venue has one ingest shared by all its lines: a trade is
 * delivered once, from whichever line has it first, in the venue's order, and
 * only while it is fresh. The engine runs one LeadSignalDetector per venue on
 * the delivered trades (leadSignalFeed).
 *
 * Relay message (one per trade, UDP twice + one TCP line):
 *   venue|id|seq|tradeTimeMs|price|tokyoRecvMs|mac
 * mac = first 16 hex chars of HMAC-SHA256(key, everything before the last `|`). */
import { createHmac, createSecretKey, type KeyObject } from "node:crypto";
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import net from "node:net";
import WebSocket from "ws";
import { LEAD_VENUES, type LeadLine, type LeadVenue } from "../../platform/contracts.js";
import type { AggTrade, LeadSignalDetector } from "./binance-trades.js";
import type { LeadPerpProducts } from "./btc.js";
import type { FeedEvent } from "./index.js";

/** One venue trade as parsed from a frame or a relay message. */
export interface LeadTrade {
  venue: LeadVenue;
  /** Bybit: trade id `i` (UUID). Binance: aggregate id `a`. OKX: tradeId. */
  id: string | number;
  /** Bybit match sequence. */
  seq?: number;
  price: number;
  tradeTimeMs: number;
}
/** A relayed trade with the Tokyo receive time (ms). */
export type RelayTrade = LeadTrade & { tokyoRecvMs: number };

const IDLE_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** OKX closes a connection without traffic for 30 s; it answers "ping" with "pong". */
const OKX_PING_MS = 20_000;
/** The rule was measured with a trade seen ~125 ms after it happened (p90
 * ~360 ms). A copy older than this, e.g. the lagging line after the leading one
 * dropped, would be a stale signal at today's book. */
const MAX_TRADE_AGE_MS = 1_000;
/** Trade time ahead of our clock (chrony keeps it under 1 ms). */
const MAX_TRADE_LEAD_MS = 1_000;
/** A bigger id jump within ID_JUMP_WINDOW_MS of trade time is a bad frame
 * (BTC perps run tens of trades a second); after a longer gap any jump is a
 * real resume, or one outage would drop every later trade. Bybit's seq is the
 * contract's whole match sequence, so it is only checked within one ms. */
const MAX_ID_JUMP = 1_000_000;
const ID_JUMP_WINDOW_MS = 60_000;
/** Delivered trades remembered per venue to time the other line's copy. */
const RECENT = 4096;
const MAC_HEX = 16;
/** A relay line is ~80 bytes; anything longer is not ours. */
const MAX_RELAY_LINE = 512;
const MAX_TCP_CLIENTS = 4;

// --- parsers: one raw frame -> normalised trades (Ireland and Tokyo alike) ---

/** Bybit v5 `publicTrade.<symbol>` frame. */
export function parseBybitFrame(raw: string, symbol: string, out: LeadTrade[]): void {
  let message: { topic?: unknown; data?: unknown };
  try { message = JSON.parse(raw); } catch { return; }
  if (message?.topic !== `publicTrade.${symbol}` || !Array.isArray(message.data)) return;
  for (const item of message.data as Array<Record<string, unknown>>) {
    const id = item?.i, seq = item?.seq, tradeTimeMs = item?.T, price = Number(item?.p);
    if (typeof id !== "string" || !id || typeof seq !== "number" || !Number.isFinite(seq) || typeof tradeTimeMs !== "number"
      || !(price > 0) || price === Infinity || item?.s !== symbol) continue;
    out.push({ venue: "bybit", id, seq, price, tradeTimeMs });
  }
}

/** Binance USD-M futures aggTrade frame (`symbol` uppercase, e.g. BTCUSDT). */
export function parseBinanceFrame(raw: string, symbol: string, out: LeadTrade[]): void {
  let message: { e?: unknown; s?: unknown; a?: unknown; p?: unknown; T?: unknown };
  try { message = JSON.parse(raw); } catch { return; }
  const id = message?.a, tradeTimeMs = message?.T, price = Number(message?.p);
  if (message?.e !== "aggTrade" || message.s !== symbol || typeof id !== "number" || !Number.isSafeInteger(id) || id < 0
    || typeof tradeTimeMs !== "number" || !(price > 0) || price === Infinity) return;
  out.push({ venue: "binance", id, price, tradeTimeMs });
}

/** OKX v5 public `trades` frame; "pong" and subscribe acks carry no trades.
 * The trades of one push are put in tradeId order. */
export function parseOkxFrame(raw: string, instId: string, out: LeadTrade[]): void {
  if (raw === "pong") return;
  let message: { arg?: { channel?: unknown; instId?: unknown }; data?: unknown };
  try { message = JSON.parse(raw); } catch { return; }
  if (message?.arg?.channel !== "trades" || message.arg.instId !== instId || !Array.isArray(message.data)) return;
  const first = out.length;
  for (const item of message.data as Array<Record<string, unknown>>) {
    const tradeId = item?.tradeId, ts = item?.ts;
    const id = Number(tradeId), tradeTimeMs = Number(ts), price = Number(item?.px);
    if (typeof tradeId !== "string" || !tradeId || !Number.isSafeInteger(id) || id < 0 || typeof ts !== "string"
      || !Number.isFinite(tradeTimeMs) || !(price > 0) || price === Infinity || item?.instId !== instId) continue;
    out.push({ venue: "okx", id, price, tradeTimeMs });
  }
  if (out.length - first > 1) {
    const mine = out.splice(first).sort((a, b) => (a.id as number) - (b.id as number));
    for (const trade of mine) out.push(trade);
  }
}

// --- per-venue dedupe shared by all lines ---

export interface LineCounters {
  /** WebSocket frames / relay messages (each UDP and TCP copy counts). */
  frames: number;
  /** Trades parsed, duplicates included. */
  trades: number;
  /** Trades this line delivered first. */
  delivered: number;
  /** Wall clock (ms) of the last current trade on this line; 0 = none. */
  lastAt: number;
  /** How much earlier this line was, over the other line's copies seen. */
  leadSumMs: number;
  leadCount: number;
}
const counters = (): LineCounters => ({ frames: 0, trades: 0, delivered: 0, lastAt: 0, leadSumMs: 0, leadCount: 0 });
export type VenueLineStats = Record<LeadLine, LineCounters & { leadMeanMs: number | null }>;

/** 0 dropped (bad, stale), 1 a copy or older trade (the line is current), 2 delivered. */
export type IngestResult = 0 | 1 | 2;

export class VenueIngest {
  private readonly parse: (raw: string, out: LeadTrade[]) => void;
  private readonly scratch: LeadTrade[] = [];
  private readonly lines: [LineCounters, LineCounters] = [counters(), counters()];
  private current = false;
  // Binance/OKX: the last delivered id and its trade time.
  private lastId = -1;
  // Bybit: last delivered seq/time, the ids delivered at that seq, a delivery count.
  private lastSeq = -1;
  private lastTimeMs = -Infinity;
  private readonly atTop = new Set<string>();
  private delivered = 0;
  // Recently delivered keys: slot by key, first line (-1 = copy counted), mono receive time.
  private readonly recentSlot = new Map<string | number, number>();
  private readonly recentKey: Array<string | number | undefined> = new Array(RECENT);
  private readonly recentLine = new Int8Array(RECENT);
  private readonly recentAt = new Float64Array(RECENT);
  private recentNext = 0;

  constructor(readonly venue: LeadVenue, product: string,
    private readonly onTrade: (trade: AggTrade, source: LeadTrade) => void) {
    this.parse = venue === "bybit" ? (raw, out) => parseBybitFrame(raw, product, out)
      : venue === "binance" ? (raw, out) => parseBinanceFrame(raw, product.toUpperCase(), out)
        : (raw, out) => parseOkxFrame(raw, product, out);
  }

  /** One raw frame from a direct line; true when it delivered a trade. */
  frame(raw: unknown, line: LeadLine, receivedAtUnix: number, receivedAtMonoMs: number): boolean {
    this.current = false;
    this.lines[line === "direct" ? 0 : 1].frames += 1;
    const out = this.scratch;
    out.length = 0;
    this.parse(typeof raw === "string" ? raw : String(raw), out);
    let any = false;
    try {
      for (let k = 0; k < out.length; k += 1) {
        const result = this.push(out[k]!, line, receivedAtUnix, receivedAtMonoMs);
        if (result) this.current = true;
        if (result === 2) any = true;
      }
    } finally { out.length = 0; }
    return any;
  }

  /** One relayed trade (Tokyo line). */
  relayed(trade: RelayTrade, receivedAtUnix: number, receivedAtMonoMs: number): IngestResult {
    this.lines[1].frames += 1;
    return this.push(trade, "tokyo", receivedAtUnix, receivedAtMonoMs, trade.tokyoRecvMs);
  }

  /** Whether the last frame() carried a current trade (delivered or a fresh copy). */
  lastWasCurrent(): boolean { return this.current; }
  lastAt(line: LeadLine): number { return this.lines[line === "direct" ? 0 : 1].lastAt; }

  push(trade: LeadTrade, line: LeadLine, receivedAtUnix: number, receivedAtMonoMs: number, relayRecvMs?: number): IngestResult {
    const index = line === "direct" ? 0 : 1;
    const counter = this.lines[index];
    counter.trades += 1;
    const t = trade.tradeTimeMs;
    const ageMs = receivedAtUnix * 1000 - t;
    if (!(ageMs <= MAX_TRADE_AGE_MS && ageMs >= -MAX_TRADE_LEAD_MS)) return 0;
    let id: number;
    if (this.venue === "bybit") {
      // A copy of a delivered trade is never later than the latest delivered
      // trade time, so a later trade is new whatever its seq; seq and id only
      // order trades within one millisecond (one sweep shares a seq and a time).
      const key = trade.id, seq = trade.seq;
      if (typeof key !== "string" || typeof seq !== "number") return 0;
      if (t < this.lastTimeMs) return this.copy(key, index, receivedAtUnix, receivedAtMonoMs);
      if (t === this.lastTimeMs) {
        if (seq < this.lastSeq || (seq === this.lastSeq && this.atTop.has(key))) return this.copy(key, index, receivedAtUnix, receivedAtMonoMs);
        if (seq - this.lastSeq > MAX_ID_JUMP) return 0;
      }
      if (seq !== this.lastSeq) { this.lastSeq = seq; this.atTop.clear(); }
      this.lastTimeMs = t;
      this.atTop.add(key);
      id = ++this.delivered;
    } else {
      const key = trade.id;
      if (typeof key !== "number") return 0;
      if (!(key > this.lastId)) return this.copy(key, index, receivedAtUnix, receivedAtMonoMs);
      if (this.lastId >= 0 && key - this.lastId > MAX_ID_JUMP && t - this.lastTimeMs < ID_JUMP_WINDOW_MS) return 0;
      this.lastId = key;
      this.lastTimeMs = t;
      id = key;
    }
    counter.delivered += 1;
    counter.lastAt = receivedAtUnix * 1000;
    this.remember(trade.id, index, receivedAtMonoMs);
    const delivered: AggTrade = { venue: this.venue, id, price: trade.price, tradeTimeMs: t, line, receivedAtUnix, receivedAtMonoMs };
    if (relayRecvMs !== undefined) delivered.relayRecvMs = relayRecvMs;
    this.onTrade(delivered, trade);
    return 2;
  }

  stats(): VenueLineStats {
    const view = (c: LineCounters) => ({ ...c, leadMeanMs: c.leadCount ? c.leadSumMs / c.leadCount : null });
    return { direct: view(this.lines[0]), tokyo: view(this.lines[1]) };
  }

  /** A current copy of an older trade: the line is alive; if the trade was
   * delivered recently from the other line, that line was first by the gap. */
  private copy(key: string | number, index: number, receivedAtUnix: number, receivedAtMonoMs: number): IngestResult {
    this.lines[index]!.lastAt = receivedAtUnix * 1000;
    const slot = this.recentSlot.get(key);
    if (slot !== undefined) {
      const first = this.recentLine[slot]!;
      if (first >= 0 && first !== index) {
        const counter = this.lines[first]!;
        counter.leadSumMs += receivedAtMonoMs - this.recentAt[slot]!;
        counter.leadCount += 1;
        this.recentLine[slot] = -1;
      }
    }
    return 1;
  }

  private remember(key: string | number, index: number, receivedAtMonoMs: number): void {
    const slot = this.recentNext;
    this.recentNext = slot + 1 === RECENT ? 0 : slot + 1;
    const old = this.recentKey[slot];
    if (old !== undefined) this.recentSlot.delete(old);
    this.recentKey[slot] = key;
    this.recentLine[slot] = index;
    this.recentAt[slot] = receivedAtMonoMs;
    this.recentSlot.set(key, slot);
  }
}

// --- direct WebSocket lines ---

interface WsLine { url: string; subscribe?: string; ping?: string }

/** Bybit v5 public linear: two CloudFront hosts carry the same stream (390/390
 * trades, either first, measured 2026-10-29). */
export const bybitTradeUrls = (): string[] => [
  "wss://stream.bybit.com/v5/public/linear",
  "wss://stream.bytick.com/v5/public/linear",
];
/** Binance moved futures market streams under /market: the old /ws and /stream
 * paths connect but send no aggTrade (checked 2026-11-12). */
export const binanceTradeUrls = (symbol: string): string[] => [`wss://fstream.binance.com/market/ws/${symbol}@aggTrade`];
export const okxTradeUrls = (): string[] => ["wss://ws.okx.com:8443/ws/v5/public"];

function directLines(venue: LeadVenue, products: LeadPerpProducts, urls?: readonly string[]): WsLine[] {
  if (venue === "bybit") {
    const subscribe = JSON.stringify({ op: "subscribe", args: [`publicTrade.${products.bybit}`] });
    return (urls ?? bybitTradeUrls()).map(url => ({ url, subscribe }));
  }
  if (venue === "binance") return (urls ?? binanceTradeUrls(products.binance)).map(url => ({ url }));
  const subscribe = JSON.stringify({ op: "subscribe", args: [{ channel: "trades", instId: products.okx }] });
  return (urls ?? okxTradeUrls()).map(url => ({ url, subscribe, ping: "ping" }));
}

function connect(url: string, sockets: Set<WebSocket>, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("stopped")); return; }
    const ws = new WebSocket(url);
    sockets.add(ws);
    ws.on("error", () => {});
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("open", onOpen); ws.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if (error) { sockets.delete(ws); ws.terminate(); reject(error); } else resolve(ws);
    };
    const onOpen = () => finish();
    const onClose = () => finish(new Error("closed before open"));
    const onAbort = () => finish(new Error("stopped"));
    const timer = setTimeout(() => finish(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    ws.once("open", onOpen); ws.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** One direct line, reconnected forever. A connection with no current trade
 * for IDLE_MS (pings, garbage and stale copies do not count) is recycled. */
async function lineLoop(line: WsLine, ingest: VenueIngest, signal: AbortSignal, sockets: Set<WebSocket>): Promise<void> {
  while (!signal.aborted) {
    let ws: WebSocket | undefined;
    try {
      ws = await connect(line.url, sockets, signal);
      const socket = ws;
      if (line.subscribe) socket.send(line.subscribe);
      const connectedAt = Date.now();
      let lastCurrentAt = 0, lastPingAt = connectedAt;
      await new Promise<void>(resolve => {
        let finished = false;
        const timer = setInterval(() => {
          const now = Date.now();
          if (now - Math.max(connectedAt, lastCurrentAt) >= IDLE_MS) { finish(); return; }
          if (line.ping && now - lastPingAt >= OKX_PING_MS) { lastPingAt = now; try { socket.send(line.ping); } catch { /* close follows */ } }
        }, 1000);
        const finish = () => {
          if (finished) return;
          finished = true;
          clearInterval(timer);
          signal.removeEventListener("abort", finish);
          socket.off("message", onMessage); socket.off("close", finish); socket.off("error", finish);
          resolve();
        };
        const onMessage = (raw: WebSocket.RawData) => {
          const receivedAtMonoMs = performance.now();
          const receivedAtMs = Date.now();
          try { ingest.frame(raw, "direct", receivedAtMs / 1000, receivedAtMonoMs); }
          catch { /* A consumer error must not kill the line. */ }
          if (ingest.lastWasCurrent()) lastCurrentAt = receivedAtMs;
        };
        socket.on("message", onMessage); socket.once("close", finish); socket.once("error", finish);
        signal.addEventListener("abort", finish, { once: true });
      });
    } catch { /* Reconnect below. */ }
    finally { if (ws) { sockets.delete(ws); ws.terminate(); } }
    if (!signal.aborted) await pause(1000 + Math.random() * 1000, signal);
  }
}

// --- relay codec ---

/** The relay key file: hex (>= 32 hex chars) or raw bytes (>= 16), read once. */
export function readRelayKey(path: string): KeyObject {
  const bytes = readFileSync(path);
  const text = bytes.toString("latin1").trim();
  const key = /^(?:[0-9a-fA-F]{2}){16,}$/.test(text) ? Buffer.from(text, "hex") : bytes;
  if (key.length < 16) throw new Error("relay key file is too short");
  return createSecretKey(key);
}

const macOf = (key: KeyObject, body: string): string => createHmac("sha256", key).update(body).digest("hex").slice(0, MAC_HEX);

/** One relay message for a trade (no newline). */
export function encodeRelay(key: KeyObject, trade: LeadTrade, tokyoRecvMs: number): string {
  const body = `${trade.venue}|${trade.id}|${trade.seq ?? ""}|${trade.tradeTimeMs}|${trade.price}|${tokyoRecvMs}`;
  return `${body}|${macOf(key, body)}`;
}

export const RELAY_BAD_FORMAT = 1;
export const RELAY_BAD_MAC = 2;
const VENUE_SET = new Set<string>(LEAD_VENUES);

/** Verify and parse one relay message: the trade, or why it was refused. */
export function decodeRelay(text: string, key: KeyObject): RelayTrade | typeof RELAY_BAD_FORMAT | typeof RELAY_BAD_MAC {
  const bar = text.lastIndexOf("|");
  if (bar < 0 || text.length - bar - 1 !== MAC_HEX) return RELAY_BAD_FORMAT;
  const body = text.slice(0, bar);
  const mac = macOf(key, body);
  let diff = 0;
  for (let k = 0; k < MAC_HEX; k += 1) diff |= mac.charCodeAt(k) ^ text.charCodeAt(bar + 1 + k);
  if (diff !== 0) return RELAY_BAD_MAC;
  const parts = body.split("|");
  if (parts.length !== 6) return RELAY_BAD_FORMAT;
  const [venue, idText, seqText, timeText, priceText, recvText] = parts as [string, string, string, string, string, string];
  if (!VENUE_SET.has(venue) || !idText) return RELAY_BAD_FORMAT;
  const tradeTimeMs = Number(timeText), price = Number(priceText), tokyoRecvMs = Number(recvText);
  if (!timeText || !Number.isFinite(tradeTimeMs) || !(price > 0) || price === Infinity || !recvText || !Number.isFinite(tokyoRecvMs)) {
    return RELAY_BAD_FORMAT;
  }
  const seq = seqText ? Number(seqText) : undefined;
  if (seq !== undefined && !Number.isFinite(seq)) return RELAY_BAD_FORMAT;
  if (venue === "bybit") {
    if (seq === undefined) return RELAY_BAD_FORMAT;
    return { venue, id: idText, seq, price, tradeTimeMs, tokyoRecvMs };
  }
  const id = Number(idText);
  if (!Number.isSafeInteger(id) || id < 0) return RELAY_BAD_FORMAT;
  return { venue: venue as LeadVenue, id, price, tradeTimeMs, tokyoRecvMs };
}

// --- relay listener (Ireland) ---

export interface RelayListenerOptions {
  port: number;
  /** Bind address; default 0.0.0.0. */
  host?: string;
  key: KeyObject;
  /** Only this source IPv4 address is read, when set. */
  allowedIp?: string;
}
export interface RelayListenerStats {
  listening: boolean; port: number | null; error: string | null;
  messages: number; accepted: number; badSource: number; badFormat: number; badMac: number; tcpClients: number;
}

const plainIp = (address: string | undefined) => address?.startsWith("::ffff:") ? address.slice(7) : address ?? "";

/** UDP and TCP on one port. Each message is checked (source, mac, fields)
 * before onTrade sees it; the key is never logged or reported. */
export function startRelayListener(options: RelayListenerOptions,
  onTrade: (trade: RelayTrade, receivedAtUnix: number, receivedAtMonoMs: number) => void) {
  const host = options.host ?? "0.0.0.0";
  const stats: RelayListenerStats = { listening: false, port: null, error: null,
    messages: 0, accepted: 0, badSource: 0, badFormat: 0, badMac: 0, tcpClients: 0 };
  const handle = (text: string, source: string | undefined, receivedAtMonoMs: number, receivedAtUnix: number) => {
    stats.messages += 1;
    if (options.allowedIp && plainIp(source) !== options.allowedIp) { stats.badSource += 1; return; }
    const trade = decodeRelay(text, options.key);
    if (trade === RELAY_BAD_FORMAT) { stats.badFormat += 1; return; }
    if (trade === RELAY_BAD_MAC) { stats.badMac += 1; return; }
    stats.accepted += 1;
    try { onTrade(trade, receivedAtUnix, receivedAtMonoMs); } catch { /* A consumer error must not kill the listener. */ }
  };
  const udp = dgram.createSocket("udp4");
  udp.on("message", (buffer, info) => {
    const receivedAtMonoMs = performance.now();
    handle(buffer.toString("latin1"), info.address, receivedAtMonoMs, Date.now() / 1000);
  });
  udp.on("error", error => { stats.error = `udp: ${error.message}`; });
  const clients = new Set<net.Socket>();
  const tcp = net.createServer(socket => {
    const source = socket.remoteAddress;
    if ((options.allowedIp && plainIp(source) !== options.allowedIp) || clients.size >= MAX_TCP_CLIENTS) {
      if (options.allowedIp && plainIp(source) !== options.allowedIp) stats.badSource += 1;
      socket.destroy(); return;
    }
    clients.add(socket); stats.tcpClients = clients.size;
    socket.setNoDelay(true);
    let pending = "";
    socket.on("data", chunk => {
      const receivedAtMonoMs = performance.now();
      const receivedAtUnix = Date.now() / 1000;
      pending += chunk.toString("latin1");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line) handle(line, source, receivedAtMonoMs, receivedAtUnix);
      }
      if (pending.length > MAX_RELAY_LINE) { stats.badFormat += 1; socket.destroy(); }
    });
    socket.on("error", () => {});
    socket.on("close", () => { clients.delete(socket); stats.tcpClients = clients.size; });
  });
  tcp.on("error", error => { stats.error = `tcp: ${error.message}`; });
  // TCP first: with port 0 the UDP socket takes the port TCP got.
  const ready = new Promise<void>(resolve => {
    const failed = (error: Error) => { stats.error = error.message; resolve(); };
    tcp.once("error", failed);
    tcp.listen(options.port, host, () => {
      tcp.off("error", failed);
      const port = (tcp.address() as net.AddressInfo).port;
      udp.once("error", failed);
      udp.bind(port, host, () => {
        udp.off("error", failed);
        stats.listening = true; stats.port = port;
        resolve();
      });
    });
  });
  return {
    ready,
    stats: (): RelayListenerStats => ({ ...stats }),
    stop: () => {
      stats.listening = false;
      try { udp.close(); } catch { /* not bound */ }
      tcp.close();
      for (const socket of clients) socket.destroy();
    },
  };
}

// --- relay sender (Tokyo) ---

export interface RelaySenderStats {
  sent: number; udpErrors: number; tcpConnected: boolean; tcpDrops: number; tcpReconnects: number;
}

/** Each trade as two UDP datagrams and one TCP line (TCP_NODELAY, reconnects
 * after a close). A line that cannot be written now is dropped: it would be
 * stale by the time the connection is back. */
export function createRelaySender(options: { host: string; port: number; key: KeyObject }) {
  const stats: RelaySenderStats = { sent: 0, udpErrors: 0, tcpConnected: false, tcpDrops: 0, tcpReconnects: 0 };
  let closed = false;
  let udpReady = false;
  const udp = dgram.createSocket("udp4");
  udp.on("error", () => { stats.udpErrors += 1; });
  udp.connect(options.port, options.host, () => { udpReady = true; });
  const onUdpSent = (error: Error | null) => { if (error) stats.udpErrors += 1; };
  let tcp: net.Socket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connectTcp = () => {
    if (closed) return;
    const socket = net.connect({ host: options.host, port: options.port });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.on("connect", () => { tcp = socket; stats.tcpConnected = true; });
    socket.on("data", () => {});
    socket.on("error", () => {});
    socket.on("close", () => {
      if (tcp === socket) { tcp = undefined; stats.tcpConnected = false; }
      if (!closed) { stats.tcpReconnects += 1; retry = setTimeout(connectTcp, 1000); }
    });
  };
  connectTcp();
  return {
    send(trade: LeadTrade, tokyoRecvMs: number): void {
      const message = encodeRelay(options.key, trade, tokyoRecvMs);
      if (udpReady) {
        const datagram = Buffer.from(message, "latin1");
        udp.send(datagram, onUdpSent);
        udp.send(datagram, onUdpSent);
      }
      if (tcp && tcp.writableLength < 65_536) tcp.write(`${message}\n`);
      else stats.tcpDrops += 1;
      stats.sent += 1;
    },
    stats: (): RelaySenderStats => ({ ...stats }),
    close(): void {
      closed = true;
      clearTimeout(retry);
      tcp?.destroy();
      try { udp.close(); } catch { /* closed */ }
    },
  };
}

// --- all venues and lines together ---

export interface LeadTradesOptions {
  venues: readonly LeadVenue[];
  products: LeadPerpProducts;
  /** The Tokyo relay line; absent = direct lines only. */
  relay?: RelayListenerOptions;
  /** Direct line URLs per venue (tests); default the venues' public hosts. */
  urls?: Partial<Record<LeadVenue, readonly string[]>>;
}
export interface LeadLinesStats {
  venues: Partial<Record<LeadVenue, VenueLineStats>>;
  relay: RelayListenerStats | null;
}
export interface LeadTradesControl {
  stop: () => void;
  /** Some configured venue had a current trade on some line within IDLE_MS. */
  isHealthy: () => boolean;
  stats: () => LeadLinesStats;
  /** Settles once the relay listener is bound (or failed); at once without one. */
  ready: Promise<void>;
}

/** Every configured venue's direct lines plus the relay line, each venue
 * deduplicated on its own; onTrade gets every venue's trades once. */
export function runLeadTrades(options: LeadTradesOptions, onTrade: (trade: AggTrade, source: LeadTrade) => void): LeadTradesControl {
  const controller = new AbortController();
  const sockets = new Set<WebSocket>();
  const ingests: Partial<Record<LeadVenue, VenueIngest>> = {};
  for (const venue of options.venues) {
    const ingest = ingests[venue] = new VenueIngest(venue, options.products[venue], onTrade);
    for (const line of directLines(venue, options.products, options.urls?.[venue])) {
      void lineLoop(line, ingest, controller.signal, sockets);
    }
  }
  const relay = options.relay ? startRelayListener(options.relay, (trade, receivedAtUnix, receivedAtMonoMs) => {
    ingests[trade.venue]?.relayed(trade, receivedAtUnix, receivedAtMonoMs);
  }) : undefined;
  return {
    stop: () => {
      if (controller.signal.aborted) return;
      controller.abort();
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      relay?.stop();
    },
    isHealthy: () => {
      if (controller.signal.aborted) return false;
      const now = Date.now();
      return options.venues.some(venue => {
        const ingest = ingests[venue]!;
        return now - ingest.lastAt("direct") < IDLE_MS || now - ingest.lastAt("tokyo") < IDLE_MS;
      });
    },
    stats: () => ({ venues: Object.fromEntries(options.venues.map(venue => [venue, ingests[venue]!.stats()])),
      relay: relay?.stats() ?? null }),
    ready: relay?.ready ?? Promise.resolve(),
  };
}

/** The ConnectOptions.leadFeed producer: every venue's trades through that
 * venue's own detector, signals out as lead feed events (S = local receive
 * time). `stats` reads the running feed's lines. */
export function leadSignalFeed(detectors: Partial<Record<LeadVenue, LeadSignalDetector>>, options: LeadTradesOptions) {
  let control: LeadTradesControl | undefined;
  return {
    feed: (sink: (event: FeedEvent) => void): LeadTradesControl => (control = runLeadTrades(options, trade => {
      const signal = detectors[trade.venue]?.push(trade, trade.receivedAtUnix);
      if (signal) sink({ kind: "lead", ...signal });
    })),
    stats: (): LeadLinesStats | null => control?.stats() ?? null,
  };
}
