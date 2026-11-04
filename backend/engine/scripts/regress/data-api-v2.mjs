// Data API v1 retired 2026-11-02 (410 "Data API v1 has been retired"): the engine
// refused to start ("account sections incomplete", positions unreadable). v2
// (docs.polymarket.com/migrate/data-api-v1-to-v2) wraps every payload in
// {data, pagination}, pages by cursor only (an `offset` param, even 0, is 400),
// uses snake_case fields, and serves closed positions as /v2/positions?status=CLOSED.
// - v2Pages reads every page by next_cursor, never sends offset/sizeThreshold;
// - v2 rows of our wallet (fixtures/data-api-v2.json, captured 2026-11-04) map
//   back to the v1 names the account snapshot and official PnL read;
// - a failed or looping page leaves the section incomplete (never a short list);
// - the cash-flow activity window pages by cursor too.
// Run after `npm run build`:  node scripts/regress/data-api-v2.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { v2Pages, fromV2Row } from "../../dist/live/account-data.js";
import { accountSnapshot } from "../../dist/platform/polymarket.js";
import { readCashFlowEvidence } from "../../dist/platform/cash-flows.js";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/data-api-v2.json", import.meta.url), "utf8"));
const W = FIX.wallet;

// --- row mapping on real rows ---
{
  const held = fromV2Row(FIX.positions.data[0], "positions");
  const raw = FIX.positions.data[0];
  assert.equal(held.asset, raw.token_id);
  assert.equal(held.conditionId, raw.condition_id);
  assert.equal(held.size, raw.current_size);
  assert.equal(held.avgPrice, raw.avg_price);
  assert.equal(held.curPrice, raw.current_price);
  assert.equal(held.currentValue, raw.current_value);
  assert.equal(held.initialValue, raw.entry_cost_usdc, "v1 initialValue = cost of what is held");
  assert.equal(held.cashPnl, raw.unrealized_pnl, "v1 cashPnl = value - cost");
  assert.equal(held.realizedPnl, raw.realized_pnl);
  assert.equal(held.redeemable, raw.redeemable);
  assert.equal(held.slug, raw.slug);
  assert.equal(held.proxyWallet, raw.proxy_wallet);
  const closed = fromV2Row(FIX.closed.data[0], "closed_positions");
  assert.equal(closed.totalBought, FIX.closed.data[0].total_size, "v1 totalBought = shares ever bought");
  assert.equal(closed.timestamp, FIX.closed.data[0].last_event_at);
  assert.equal(closed.realizedPnl, FIX.closed.data[0].realized_pnl);
  const act = fromV2Row(FIX.activity.data[0], "activity");
  assert.equal(act.usdcSize, FIX.activity.data[0].usdc_size);
  assert.equal(act.transactionHash, FIX.activity.data[0].transaction_hash);
  assert.equal(act.asset, FIX.activity.data[0].token_id);
  assert.equal(act.type, "TRADE");
}

// --- pagination: every page by cursor, no offset ---
const pager = (pages) => {
  const calls = [];
  const get = async (path, params) => {
    calls.push({ path, params });
    const page = pages[params.cursor ?? "first"];
    if (page instanceof Error) throw page;
    return page;
  };
  return { get, calls };
};
{
  const a = FIX.positions.data[0], b = FIX.positions.data[1];
  const { get, calls } = pager({ first: { data: [a], pagination: { has_more: true, next_cursor: "c2" } },
                                 c2: { data: [b], pagination: { has_more: false, next_cursor: null } } });
  const s = await v2Pages(get, "/v2/positions", "positions", W, {});
  assert.equal(s.available, true); assert.equal(s.complete, true);
  assert.equal(s.items.length, 2); assert.equal(s.pages, 2);
  assert.deepEqual(calls.map(c => c.params.cursor), [undefined, "c2"]);
  for (const c of calls) {
    assert.equal(c.path, "/v2/positions");
    assert.ok(!("offset" in c.params), "v2 rejects offset");
    assert.ok(!("sizeThreshold" in c.params), "no v1-only parameter");
    assert.equal(c.params.user, W);
  }
  assert.equal(s.items[0].asset, a.token_id, "rows come out in v1 names");
  // A position snapshot from these rows: a redeemable worth-0 loser is residue, not inventory.
  const snap = accountSnapshot({ wallet: W, checked_at: new Date().toISOString(),
    collateral: { available: true, complete: true, value: 146.57, items: [] },
    open_orders: { available: true, complete: true, items: [] }, positions: s });
  assert.equal(snap.cashUsd, 146.57);
  assert.equal(snap.positions.length, 0, "both fixture rows are redeemable losers at 0");
}
{
  // CLOSED is its own status.
  const { get, calls } = pager({ first: { data: FIX.closed.data, pagination: { has_more: false, next_cursor: null } } });
  const s = await v2Pages(get, "/v2/positions", "closed_positions", W, { status: "CLOSED" });
  assert.equal(s.complete, true); assert.equal(calls[0].params.status, "CLOSED");
  assert.equal(s.items.length, 3);
}
{
  // A failed second page: incomplete, never a silent short list.
  const { get } = pager({ first: { data: [FIX.positions.data[0]], pagination: { has_more: true, next_cursor: "c2" } }, c2: new Error("http_500") });
  const s = await v2Pages(get, "/v2/positions", "positions", W, {});
  assert.equal(s.complete, false); assert.ok(s.error_code);
}
{
  // A cursor that comes back again is a loop.
  const { get } = pager({ first: { data: [FIX.positions.data[0]], pagination: { has_more: true, next_cursor: "c2" } },
                          c2: { data: [FIX.positions.data[1]], pagination: { has_more: true, next_cursor: "c2" } } });
  const s = await v2Pages(get, "/v2/positions", "positions", W, {});
  assert.equal(s.complete, false);
}
{
  // Not the v2 envelope (a v1 bare array, or a 410 body): incomplete.
  for (const body of [[FIX.positions.data[0]], { error: "Data API v1 has been retired" }, { data: null }]) {
    const { get } = pager({ first: body });
    const s = await v2Pages(get, "/v2/positions", "positions", W, {});
    assert.equal(s.complete, false, JSON.stringify(body).slice(0, 40));
  }
  // A documented empty result is complete and empty.
  const { get } = pager({ first: { data: [], pagination: { has_more: false, next_cursor: null } } });
  const s = await v2Pages(get, "/v2/positions", "positions", W, {});
  assert.equal(s.complete, true); assert.equal(s.items.length, 0);
}
{
  // "More" without a new cursor, or no has_more flag: a short list, never complete.
  for (const pagination of [{ has_more: true, next_cursor: null }, { has_more: true }, { next_cursor: null }]) {
    const { get } = pager({ first: { data: [FIX.positions.data[0]], pagination } });
    const s = await v2Pages(get, "/v2/positions", "positions", W, {});
    assert.equal(s.complete, false, JSON.stringify(pagination));
  }
}
{
  // Another account's row is rejected.
  const other = { ...FIX.positions.data[0], proxy_wallet: "0x" + "1".repeat(40) };
  const { get } = pager({ first: { data: [other], pagination: { has_more: false, next_cursor: null } } });
  const s = await v2Pages(get, "/v2/positions", "positions", W, {});
  assert.equal(s.complete, false);
}

// --- cash-flow activity window: cursor pages, v1 names ---
// One confirmed incoming pUSD transfer the account read does not explain
// (no trade, no activity): the classifier asks the official activity window,
// which must page by cursor and read the v2 rows.
{
  const { PUSD } = await import("../../dist/live/contracts.js");
  const topic = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const tx = "0x" + "a".repeat(64), sender = "0x" + "2".repeat(40);
  const T0 = 1_793_500_000, B0 = 900, HEAD = 960;
  const blockAt = (n) => ({ number: "0x" + n.toString(16), timestamp: "0x" + (T0 + (n - B0) * 2).toString(16), hash: "0x" + n.toString(16).padStart(64, "0") });
  const log = { address: PUSD, transactionHash: tx, logIndex: "0x1", blockNumber: "0x" + (B0 + 10).toString(16), blockHash: blockAt(B0 + 10).hash,
    topics: [TRANSFER, topic(sender), topic(W)], data: "0x" + (5_000_000).toString(16).padStart(64, "0"), removed: false };
  const rpc = async (method, params) => {
    if (method === "eth_blockNumber") return "0x" + HEAD.toString(16);
    if (method === "eth_getBlockByNumber") return blockAt(Number(BigInt(params[0])));
    if (method === "eth_getLogs") {
      const f = params[0];
      return f.topics[2] === topic(W) ? [log] : [];
    }
    if (method === "eth_getTransactionReceipt") return { transactionHash: tx, status: "0x1", blockNumber: log.blockNumber, blockHash: log.blockHash, logs: [log] };
    throw new Error(method);
  };
  const calls = [];
  // A DEPOSIT row for this transfer, served on the second page.
  const deposit = { timestamp: T0 + 20, type: "DEPOSIT", side: "", size: 5, usdc_size: 5, price: 0, token_id: "", condition_id: "",
    transaction_hash: tx, proxy_wallet: W.toLowerCase() };
  const first = { ...FIX.activity.data[0], timestamp: T0 + 5 };
  const getActivity = async (params) => {
    calls.push(params);
    return params.cursor === "a2" ? { data: [deposit], pagination: { has_more: false, next_cursor: null } }
      : { data: [first], pagination: { has_more: true, next_cursor: "a2" } };
  };
  const out = await readCashFlowEvidence({ wallet: W, fromAt: T0, fromBlock: B0, rpc, getActivity, confirmations: 1 });
  assert.ok(calls.length >= 1, "the classifier asked the activity window");
  for (const c of calls) {
    assert.ok(!("offset" in c), "activity window sends no offset");
    assert.equal(c.sort_by, "TIMESTAMP");
    assert.equal(c.exclude_deposits_withdrawals, "false", "v2 drops deposits/withdrawals unless asked (review 11-04)");
  }
  assert.deepEqual(calls.map(c => c.cursor), [undefined, "a2"], "followed next_cursor");
  assert.equal(out.activityWindow?.complete, true, out.activityWindow?.reason);
  assert.equal(out.activityWindow?.items, 2);
  assert.equal(out.externalFlows.length, 1, out.cashFlowCoverage.reason);
  assert.equal(out.externalFlows[0].kind, "deposit");
  assert.equal(out.externalFlows[0].amountUsd, 5);
}
// --- 2026-11-04 16:16: Node fetch without a User-Agent got 429 (empty body) on
// /v2/positions for minutes while curl and a UA'd fetch got 200; the opening
// read failed and the engine halted. Every public Data API read sends a
// User-Agent, and one 429 / 5xx is retried after a pause before failing.
{
  const { publicJson } = await import("../../dist/live/account-data.js");
  const realFetch = globalThis.fetch;
  try {
    const seen = [];
    let n = 0;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), ua: new Headers(init?.headers).get("user-agent") });
      n += 1;
      return n === 1 ? new Response("", { status: 429 }) : new Response(JSON.stringify({ data: [], pagination: { has_more: false } }), { status: 200 });
    };
    const body = await publicJson("https://data-api.polymarket.com", "/v2/positions", { user: W });
    assert.deepEqual(body.data, []);
    assert.equal(seen.length, 2, "one 429 is retried");
    for (const s of seen) assert.ok(s.ua && s.ua.length > 3, "a User-Agent is sent");
    // Three 429s in a row: fail (the section goes incomplete), no endless retry.
    n = -10; seen.length = 0;
    globalThis.fetch = async () => new Response("", { status: 429 });
    await assert.rejects(publicJson("https://data-api.polymarket.com", "/v2/positions", { user: W }), /http_429/);
    // The cash-flow activity window uses the same reader.
    const { ACTIVITY_URL } = await import("../../dist/platform/cash-flows.js");
    assert.ok(ACTIVITY_URL.startsWith("https://data-api.polymarket.com/v2/"));
  } finally { globalThis.fetch = realFetch; }
}
console.log("data-api-v2 OK");
