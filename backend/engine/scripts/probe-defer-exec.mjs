// Live probe (user agreed 2026-10-27, worst case 1 USD): does `deferExec: true`
// make a post-only POST slow on an itode market? Each probe rests a post-only
// BUY of 5 at 0.01 on a btc 5m side whose best bid is >= 0.30 (an ask of 0.01
// there is impossible; post-only never takes), then cancels it at once. It
// alternates deferExec true/false on the same connection and prints the POST
// round trip of each. Stops on the first fill, on any trade id, or when the
// round is near its close.
//
//   node scripts/probe-defer-exec.mjs <conditionId> <upTokenId> <downTokenId> [pairs=10]
// Needs the engine's account env (POLYMARKET_OWNER_PRIVATE_KEY, POLY_FUNDER).
import { ClobWrapper } from "../dist/live/clob/client.js";
import { ownerSignerPrivateKey } from "../dist/live/account.js";

const [conditionId, up, down, pairsArg] = process.argv.slice(2);
const pairs = Number(pairsArg ?? 10);
if (!conditionId || !up || !down || !(pairs >= 1 && pairs <= 10)) throw new Error("usage: <conditionId> <up> <down> [pairs<=10]");
const key = ownerSignerPrivateKey();
if (!key) throw new Error("owner signer key unavailable");
const client = await ClobWrapper.connect({ key });
await client.warmMarket(conditionId);

const PRICE = 0.01, SIZE = 5, MIN_BID = 0.3;
const book = async (token) => {
  const r = await fetch(`https://clob.polymarket.com/book?token_id=${token}`);
  const b = await r.json();
  const bids = (b.bids ?? []).map(x => Number(x.price)), asks = (b.asks ?? []).map(x => Number(x.price));
  return { bid: bids.length ? Math.max(...bids) : 0, ask: asks.length ? Math.min(...asks) : 1 };
};
const rows = [];
let spent = 0;
for (let i = 0; i < pairs * 2; i += 1) {
  const deferExec = i % 2 === 0 ? "1" : "0";
  // The flag is read per POST from the environment by the client module.
  process.env.CLOB_DEFER_EXEC = deferExec;
  const [u, d] = await Promise.all([book(up), book(down)]);
  const token = u.bid >= d.bid ? up : down, side = token === up ? u : d;
  if (side.bid < MIN_BID || side.ask <= PRICE + 0.04) { console.log("skip: side bid", side.bid, "ask", side.ask); break; }
  const started = performance.now();
  const res = await client.submitOrder({ tokenId: token, price: PRICE, size: SIZE, tickSize: 0.01, direction: "BUY",
    timeInForce: "GTC", postOnly: true });
  const postMs = performance.now() - started;
  const traded = (res.tradeIds?.length ?? 0) > 0 || (res.status && res.status !== "live");
  let cancelMs = null, cancelled = null;
  if (res.orderId) {
    const c0 = performance.now();
    try { cancelled = await client.cancel(res.orderId); } catch (e) { cancelled = String(e.message ?? e).slice(0, 80); }
    cancelMs = performance.now() - c0;
  }
  rows.push({ i, deferExec, postMs: Math.round(postMs), headersMs: Math.round(res.responseHeadersLatencyMs ?? -1),
    status: res.status, ok: res.success, err: (res.errorMsg ?? "").slice(0, 60), cancelled, cancelMs: cancelMs && Math.round(cancelMs),
    bid: side.bid, ask: side.ask });
  console.log(JSON.stringify(rows.at(-1)));
  if (traded) { spent += PRICE * SIZE; console.log("STOP: probe traded", res.status, res.tradeIds); break; }
  await new Promise(r => setTimeout(r, 1500));
}
const by = f => rows.filter(r => r.deferExec === f && r.ok).map(r => r.postMs).sort((a, b) => a - b);
const med = v => v.length ? v[Math.floor(v.length / 2)] : null;
console.log(JSON.stringify({ deferTrue: { n: by("1").length, median: med(by("1")), all: by("1") },
  deferFalse: { n: by("0").length, median: med(by("0")), all: by("0") }, spentUsdUpperBound: spent }));
