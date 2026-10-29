// Order hot path benchmark (read-only, no network): the real TradingPlatform,
// binance-lead strategy, PlatformStore (fsync, in a temp dir), ClobWrapper
// signing and PolymarketGateway, with global fetch stubbed. Measures, per order,
// the lead event's receive time -> the moment fetch(POST /order) is called, and
// splits it: decision, sign, intent fsync, rest. Run after `npm run build`:
//   node scripts/bench/hot-path.mjs [orders=40]
import { mkdtempSync, rmSync } from "node:fs";
import dc from "node:diagnostics_channel";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";
import { ClobWrapper } from "../../dist/live/clob/client.js";
import { PolymarketGateway } from "../../dist/platform/polymarket.js";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { PlatformStore } from "../../dist/platform/store.js";
import { createStrategy, presignPrices } from "../../dist/strategies/binance-lead.js";
import { PlatformJournal } from "../../dist/platform/journal.js";

const N = Number(process.argv[2] ?? 40);
// PRESIGN=1: sign the round ahead as the connector does (presignPlan).
const PRESIGN = process.env.PRESIGN === "1";
const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
const signer = createWalletClient({ account, chain: polygon, transport: http("http://127.0.0.1:9") });
const creds = { key: "k", passphrase: "p", secret: randomBytes(32).toString("base64url") };
const sdk = new ClobClient({ host: "https://clob.polymarket.com", chain: 137, signer, creds, signatureType: 0, funderAddress: account.address });
const wrapper = new ClobWrapper(sdk, account.address, account.address, creds, 0);
const realFetch = globalThis.fetch;
let postCalledAt, bodySentAt;
dc.subscribe("undici:request:bodySent", m => { if (m.request?.method === "POST" && m.request.path === "/order") bodySentAt ??= performance.now(); });
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/order") && init?.method === "POST") {
    postCalledAt ??= performance.now();
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ error: "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.", orderID: "0x" + "0".repeat(64) }), { status: 400 });
  }
  return realFetch(url, init);
};
const dir = mkdtempSync(join(tmpdir(), "hot-path-"));
const rows = [];
try {
  for (let k = 0; k < N; k++) {
    const START = 1_800_000_000 + k * 300, UP = String(10n ** 76n + BigInt(k) * 2n), DOWN = String(10n ** 76n + BigInt(k) * 2n + 1n);
    const ROUND = String(START), id = `0xm${k}`;
    sdk.tickSizes[UP] = "0.01"; sdk.tickSizes[DOWN] = "0.01";
    wrapper.negRiskByToken.set(UP, false); wrapper.negRiskByToken.set(DOWN, false);
    const market = { id, assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
      instruments: [{ tokenId: UP, marketId: id, outcome: "Up", tickSize: 0.01, minOrderSize: 5 }, { tokenId: DOWN, marketId: id, outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
    let now = START - 20;
    const store = new PlatformStore(join(dir, `s${k}.json`));
    const platform = new TradingPlatform({ account: { accountId: "t", at: now - 60, cashAt: now - 60, cashUsd: 100, positions: [], openOrders: [], complete: true },
      instruments: market.instruments, limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null }, now: () => now,
      adapters: { gateway: new PolymarketGateway(wrapper), estimateFee: () => 0.05,
        persist: (state, critical) => store.save(state, critical), deferPersistence: () => store.defer(),
        persistPreparedOrder: order => store.savePreparedOrder(order) } });
    platform.ingest({ kind: "market", market });
    // As live: the core keeps ~14 markets (ended rounds wait for settlement).
    for (let e = 1; e <= 13; e++) {
      const S = START - e * 300, eid = `${id}e${e}`;
      platform.ingest({ kind: "market", market: { id: eid, assetId: "btc", roundId: String(S), name: `btc-updown-5m-${S}`, startsAt: S, endsAt: S + 300,
        instruments: [{ tokenId: `${UP}${e}1`, marketId: eid, outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                      { tokenId: `${UP}${e}2`, marketId: eid, outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] } });
    }
    // As cli/platform.ts: the strategy persists through the core, and every
    // platform event is journaled (order events with all their fields).
    const journal = new PlatformJournal(join(dir, `j${k}.jsonl`), { onFailure: () => {} });
    platform.subscribe(event => { if (event.kind === "order") journal.write("order", { ...event.order, prepared: undefined }); });
    const strategy = createStrategy({}, undefined, { persist: state => platform.core.setStrategyState("binance-lead", state) });
    platform.attach(strategy);
    platform.ingest({ kind: "timer", ts: now });
    now = START + 20;
    const side = (t, ask) => ({ assetId: t, bid: ask - 0.01, ask, bidSize: 100, askSize: 100, sourceAt: now, expiresAt: now + 2 });
    for (let b = 0; b < 30; b++) platform.ingest({ kind: "book", marketId: id, roundId: ROUND, snapshot: { assetId: "btc", marketId: id, roundId: ROUND,
      sourceAt: now, expiresAt: now + 2, tsUnix: now, receivedAtUnix: now, receivedAtMonoMs: performance.now(), marketAgeMs: 40,
      YES: side(UP, 0.55 + (b % 3) / 100), NO: side(DOWN, 0.45) } });
    await platform.idle();
    if (PRESIGN) for (const tok of [UP, DOWN]) {
      const plan = presignPrices({ maxAsk: 0.8, limitPremium: 0.03, makerHoldSec: 0, shares: 5 }, 0.01);
      const size = new Map(plan.map(x => [x.price, x.shares]));
      await wrapper.presign(tok, plan.map(x => x.price), price => size.get(price), 0.01);
    }
    now = START + 21;
    postCalledAt = undefined; bodySentAt = undefined;
    const recv = performance.now();
    platform.ingest({ kind: "lead", assetId: "btc", direction: "UP", price: 100030, refPrice: 100000, moveBp: 3, tradeId: k + 1,
      tradeTimeMs: now * 1000 - 95, receivedAtUnix: now, receivedAtMonoMs: recv });
    await platform.idle();
    const o = platform.core.orders()[0];
    rows.push({ total: postCalledAt - recv, sign: o?.signLatencyMs ?? NaN, fsync: o?.durableCommitLatencyMs ?? NaN });
    store.close(); journal.close?.();
  }
} finally { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); }
const q = (k) => { const v = rows.slice(5).map(r => r[k]).filter(Number.isFinite).sort((a, b) => a - b);
  return `p50 ${v[v.length >> 1].toFixed(2)}  p90 ${v[Math.floor(v.length * 0.9)].toFixed(2)}  max ${v.at(-1).toFixed(2)}`; };
console.log(`lead received -> POST /order called (ms, ${rows.length - 5} orders): ${q("total")}`);
console.log(`  of which sign: ${q("sign")}`);
console.log(`  of which intent fsync: ${q("fsync")}`);
process.exit(0);
