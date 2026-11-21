// Tokyo relay line (lead-trades.ts): one text message per trade,
//   venue|id|seq|tradeTimeMs|price|tokyoRecvMs|mac   (mac = HMAC-SHA256 hex[0:16])
// sent as two UDP datagrams and one TCP line. Ireland accepts only a message
// with a good mac, a known venue, sound fields and (when set) the allowed
// source IP; the key never shows up in stats or errors.
// 1) codec: good accepted; bad mac / venue / truncated / garbage refused.
// 2) end to end on loopback: the real sender -> the real listener -> the
//    venue ingest, once per trade (UDP twice + TCP = one delivery); a forged
//    message and a wrong source are ignored.
// 3) a venue left out of directVenues opens no direct socket and still
//    arrives over Tokyo.
// 4) several engines: PM_RELAY_TARGET_HOST is a comma list; the fan-out sends
//    every trade to each target on its own sender, so one dead target does not
//    hold up the others.
// Run after `npm run build`:  node scripts/regress/lead-relay.mjs
import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { createRelayFanout, createRelaySender, decodeRelay, encodeRelay, readRelayKey, runLeadTrades, startRelayListener,
  RELAY_BAD_FORMAT, RELAY_BAD_MAC } from "../../dist/live/feeds/lead-trades.js";
import { parseRelayOptions } from "../../dist/cli/relay.js";
import { leadPerpProducts } from "../../dist/live/feeds/btc.js";

const dir = mkdtempSync(join(tmpdir(), "lead-relay-"));
const KEY_HEX = "5f".repeat(8) + "a1b2c3d4".repeat(6);
const keyFile = join(dir, "relay.key");
writeFileSync(keyFile, `${KEY_HEX}\n`);
const key = readRelayKey(keyFile);
const otherFile = join(dir, "other.key");
writeFileSync(otherFile, "77".repeat(32));
const otherKey = readRelayKey(otherFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await sleep(10); } return true; };
const noKey = (text, what) => assert.ok(!String(text).includes(KEY_HEX) && !String(text).toLowerCase().includes("5f5f5f5f"), `${what} carries no key`);

try {
  // --- 1. codec ---
  {
    const T = 1_800_000_020_123;
    const bybit = encodeRelay(key, { venue: "bybit", id: "9d1e-uuid", seq: 834185528852, price: 80000.5, tradeTimeMs: T }, T + 30);
    const [body, mac] = [bybit.slice(0, bybit.lastIndexOf("|")), bybit.slice(bybit.lastIndexOf("|") + 1)];
    assert.equal(body, `bybit|9d1e-uuid|834185528852|${T}|80000.5|${T + 30}`);
    assert.equal(mac, createHmac("sha256", Buffer.from(KEY_HEX, "hex")).update(body).digest("hex").slice(0, 16), "mac = HMAC-SHA256 hex[0:16]");
    assert.deepEqual(decodeRelay(bybit, key), { venue: "bybit", id: "9d1e-uuid", seq: 834185528852, price: 80000.5, tradeTimeMs: T, tokyoRecvMs: T + 30 });
    const okx = encodeRelay(key, { venue: "okx", id: 1234567890, price: 80001, tradeTimeMs: T }, T + 5);
    assert.ok(okx.startsWith(`okx|1234567890||${T}|80001|${T + 5}|`), "no seq: empty field");
    assert.deepEqual(decodeRelay(okx, key), { venue: "okx", id: 1234567890, price: 80001, tradeTimeMs: T, tokyoRecvMs: T + 5 });
    assert.equal(decodeRelay(encodeRelay(key, { venue: "binance", id: 7, price: 1, tradeTimeMs: T }, T), key).venue, "binance");
    // bad mac: another key, a flipped price, a flipped mac digit
    assert.equal(decodeRelay(encodeRelay(otherKey, { venue: "okx", id: 1, price: 1, tradeTimeMs: T }, T), key), RELAY_BAD_MAC);
    assert.equal(decodeRelay(okx.replace("|80001|", "|80002|"), key), RELAY_BAD_MAC, "a changed field fails the mac");
    const flipped = okx.slice(0, -1) + (okx.endsWith("0") ? "1" : "0");
    assert.equal(decodeRelay(flipped, key), RELAY_BAD_MAC);
    // wrong venue (signed with the right key: still refused)
    const signed = (body) => `${body}|${createHmac("sha256", Buffer.from(KEY_HEX, "hex")).update(body).digest("hex").slice(0, 16)}`;
    assert.equal(decodeRelay(signed(`kraken|1||${T}|80000|${T}`), key), RELAY_BAD_FORMAT, "unknown venue");
    assert.equal(decodeRelay(signed(`okx|x1||${T}|80000|${T}`), key), RELAY_BAD_FORMAT, "okx id not a number");
    assert.equal(decodeRelay(signed(`bybit|abc||${T}|80000|${T}`), key), RELAY_BAD_FORMAT, "bybit without seq");
    assert.equal(decodeRelay(signed(`okx|1||${T}|0|${T}`), key), RELAY_BAD_FORMAT, "zero price");
    assert.equal(decodeRelay(signed(`okx|1||${T}|80000`), key), RELAY_BAD_FORMAT, "a field short");
    assert.equal(decodeRelay(signed(`okx|1||${T}|80000|${T}|9`), key), RELAY_BAD_FORMAT, "a field over");
    // truncated / garbage
    assert.equal(decodeRelay(okx.slice(0, -3), key), RELAY_BAD_FORMAT, "truncated mac");
    assert.equal(decodeRelay(okx.slice(0, 20), key), RELAY_BAD_FORMAT);
    for (const junk of ["", "|", "hello", "pong", "{}"]) assert.equal(decodeRelay(junk, key), RELAY_BAD_FORMAT, junk);
    // key file: hex or raw bytes, too short refused, the error does not echo it
    writeFileSync(join(dir, "short.key"), "abcd");
    assert.throws(() => readRelayKey(join(dir, "short.key")), e => { noKey(e.message, "error"); return /too short/.test(e.message); });
    writeFileSync(join(dir, "raw.key"), Buffer.alloc(32, 9));
    assert.equal(readRelayKey(join(dir, "raw.key")).symmetricKeySize, 32);
    assert.equal(key.symmetricKeySize, 32, "hex decoded");
    noKey(JSON.stringify(key), "the KeyObject's JSON");
  }

  // --- 2. listener: source check, mac check, stats without the key ---
  {
    const got = [];
    const listener = startRelayListener({ port: 0, host: "127.0.0.1", key, allowedIp: "127.0.0.1" },
      (trade, unix, mono) => got.push({ trade, unix, mono }));
    await listener.ready;
    const { port, listening } = listener.stats();
    assert.equal(listening, true);
    const now = Date.now();
    const udp = dgram.createSocket("udp4");
    const send = (text) => new Promise(r => udp.send(Buffer.from(text), port, "127.0.0.1", r));
    await send(encodeRelay(key, { venue: "okx", id: 5, price: 80000, tradeTimeMs: now - 50 }, now - 20));
    await send(encodeRelay(otherKey, { venue: "okx", id: 6, price: 1, tradeTimeMs: now - 50 }, now - 20));   // forged
    await send("okx|7||1|2|3|deadbeefdeadbeef");
    assert.ok(await until(() => listener.stats().messages === 3));
    assert.equal(got.length, 1, "only the signed message");
    assert.equal(got[0].trade.id, 5);
    assert.equal(listener.stats().badMac, 2, "forged and junk-mac messages refused");
    noKey(JSON.stringify(listener.stats()), "listener stats");
    listener.stop(); udp.close();
    // Wrong source: only 203.0.113.9 is allowed; loopback is refused, TCP too.
    const strict = startRelayListener({ port: 0, host: "127.0.0.1", key, allowedIp: "203.0.113.9" }, () => got.push("wrong"));
    await strict.ready;
    const u2 = dgram.createSocket("udp4");
    await new Promise(r => u2.send(Buffer.from(encodeRelay(key, { venue: "okx", id: 8, price: 1, tradeTimeMs: now }, now)),
      strict.stats().port, "127.0.0.1", r));
    const tcp = net.connect(strict.stats().port, "127.0.0.1");
    await new Promise(r => tcp.on("close", r).on("error", () => {}));
    assert.ok(await until(() => strict.stats().badSource === 2));
    assert.equal(got.length, 1, "wrong source IP ignored (UDP and TCP)");
    strict.stop(); u2.close();
  }

  // --- 3. end to end: the real sender -> listener -> venue ingest, one delivery per trade ---
  {
    const delivered = [];
    const feed = runLeadTrades({ venues: ["okx", "bybit"], products: leadPerpProducts("btc"), urls: { okx: [], bybit: [] },
      relay: { port: 0, host: "127.0.0.1", key, allowedIp: "127.0.0.1" } }, t => delivered.push(t));
    await feed.ready;
    const port = feed.stats().relay.port;
    const sender = createRelaySender({ host: "127.0.0.1", port, key });
    assert.ok(await until(() => sender.stats().tcpConnected), "TCP connects");
    assert.ok(await until(() => feed.stats().relay.tcpClients === 1));
    const now = Date.now();
    sender.send({ venue: "okx", id: 100, price: 80000, tradeTimeMs: now - 40 }, now - 10);
    sender.send({ venue: "bybit", id: "u-1", seq: 900, price: 80001, tradeTimeMs: now - 30 }, now - 5);
    sender.send({ venue: "okx", id: 101, price: 80002, tradeTimeMs: now - 20 }, now - 2);
    sender.send({ venue: "binance", id: 5, price: 80003, tradeTimeMs: now - 20 }, now - 2);   // venue not configured here
    assert.ok(await until(() => feed.stats().relay.accepted === 12), "each trade arrives 3 times (UDP x2 + TCP)");
    await sleep(50);
    assert.deepEqual(delivered.map(t => [t.venue, t.id, t.line]), [["okx", 100, "tokyo"], ["bybit", 1, "tokyo"], ["okx", 101, "tokyo"]],
      "each trade delivered once, on the tokyo line; an unconfigured venue is ignored");
    assert.equal(delivered[0].relayRecvMs, now - 10);
    assert.equal(feed.stats().venues.okx.tokyo.delivered, 2);
    assert.equal(feed.stats().venues.okx.tokyo.frames, 6);
    assert.equal(feed.isHealthy(), true, "the relay line alone keeps the feed healthy");
    // A forged message over TCP is ignored; the connection stays usable.
    const forged = net.connect(port, "127.0.0.1");
    await new Promise(r => forged.on("connect", r));
    forged.write(`${encodeRelay(otherKey, { venue: "okx", id: 102, price: 1, tradeTimeMs: Date.now() }, Date.now())}\n`);
    assert.ok(await until(() => feed.stats().relay.badMac === 1));
    assert.equal(delivered.length, 3, "forged trade not delivered");
    const s = sender.stats();
    assert.equal(s.sent, 4); assert.equal(s.udpErrors, 0); assert.equal(s.tcpDrops, 0);
    noKey(JSON.stringify(feed.stats()) + JSON.stringify(s), "feed and sender stats");
    forged.destroy(); sender.close(); feed.stop();
  }

  // --- 3b. a venue with its direct line off (directVenues, 2026-11-21 CPU): no direct
  // socket is opened for it, and its Tokyo trades still arrive and are delivered once ---
  {
    const okxWs = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise(r => okxWs.on("listening", r));
    let okxConnections = 0;
    okxWs.on("connection", () => { okxConnections += 1; });
    const delivered = [];
    const feed = runLeadTrades({ venues: ["okx", "bybit"], directVenues: ["bybit"], products: leadPerpProducts("btc"),
      urls: { okx: [`ws://127.0.0.1:${okxWs.address().port}/okx`], bybit: [] },
      relay: { port: 0, host: "127.0.0.1", key, allowedIp: "127.0.0.1" } }, t => delivered.push(t));
    await feed.ready;
    await sleep(300);
    assert.equal(okxConnections, 0, "okx is not a direct venue: its direct url is never opened");
    const sender = createRelaySender({ host: "127.0.0.1", port: feed.stats().relay.port, key });
    assert.ok(await until(() => sender.stats().tcpConnected));
    const now = Date.now();
    sender.send({ venue: "okx", id: 200, price: 80000, tradeTimeMs: now - 40 }, now - 10);
    assert.ok(await until(() => delivered.length === 1), "okx still arrives over Tokyo");
    assert.deepEqual(delivered.map(t => [t.venue, t.id, t.line]), [["okx", 200, "tokyo"]]);
    assert.equal(feed.stats().venues.okx.direct.frames, 0, "no direct frames for okx");
    sender.close(); feed.stop(); okxWs.close();
  }

  // --- 4. several engines: a comma list of targets, one sender each ---
  {
    const env = { PM_RELAY_KEY_FILE: keyFile };
    assert.deepEqual(parseRelayOptions([], { ...env, PM_RELAY_TARGET_HOST: "1.2.3.4" }).hosts, ["1.2.3.4"]);
    assert.deepEqual(parseRelayOptions([], { ...env, PM_RELAY_TARGET_HOST: " 1.2.3.4 , 5.6.7.8,1.2.3.4 " }).hosts,
      ["1.2.3.4", "5.6.7.8"], "trimmed, de-duplicated, in order");
    assert.deepEqual(parseRelayOptions(["--host", "9.9.9.9,8.8.8.8"], env).hosts, ["9.9.9.9", "8.8.8.8"]);
    assert.throws(() => parseRelayOptions([], { ...env, PM_RELAY_TARGET_HOST: " , " }), /PM_RELAY_TARGET_HOST/);
    // Two engines on loopback; a third target nobody listens on.
    const got = [[], []];
    const listeners = [0, 1].map(k => startRelayListener({ port: 0, host: "127.0.0.1", key, allowedIp: "127.0.0.1" },
      trade => got[k].push(trade.id)));
    await Promise.all(listeners.map(l => l.ready));
    const dead = net.createServer().listen(0, "127.0.0.1");
    await new Promise(r => dead.on("listening", r));
    const deadPort = dead.address().port;
    dead.close();
    const targets = [...listeners.map(l => ({ host: "127.0.0.1", port: l.stats().port })), { host: "127.0.0.1", port: deadPort }];
    const fanout = createRelayFanout(targets, key);
    assert.ok(await until(() => fanout.stats().filter(s => s.tcpConnected).length === 2), "both live targets connect");
    const now = Date.now();
    fanout.send({ venue: "bybit", id: "u-7", seq: 70, price: 80000, tradeTimeMs: now - 30 }, now - 5);
    fanout.send({ venue: "okx", id: 71, price: 80001, tradeTimeMs: now - 20 }, now - 2);
    assert.ok(await until(() => got[0].length >= 2 && got[1].length >= 2), "each engine gets every trade");
    const stats = fanout.stats();
    assert.deepEqual(stats.map(s => s.target), targets.map(t => `${t.host}:${t.port}`));
    assert.deepEqual(stats.map(s => s.sent), [2, 2, 2], "every target counts its own sends");
    assert.equal(stats[2].tcpConnected, false, "the dead target is only down itself");
    noKey(JSON.stringify(stats), "fan-out stats");
    fanout.close(); listeners.forEach(l => l.stop());
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("lead-relay OK");
