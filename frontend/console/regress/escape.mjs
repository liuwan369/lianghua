// Every text that comes from the server is escaped before it reaches
// innerHTML: signal reasons, order errors, round reasons, event messages,
// position titles, relay errors and health error codes. A hostile string
// renders as text, never as markup.
//
// Run:  node frontend/console/regress/escape.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const window = { location: { search: "", href: "http://x/" }, setTimeout, clearTimeout, setInterval, clearInterval,
  URLSearchParams, URL, AbortController, console, document: { hidden: false, addEventListener() {}, querySelector: () => null } };
window.window = window;
const context = vm.createContext(window);
for (const file of ["shared/preview-core.js", "live.js", "stats.js", "history.js", "settings.js"]) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
}
const { html, esc } = window.PolyPreview;
const EVIL = `<img src=x onerror="alert(1)">'&`;
const SAFE = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;";
const check = (name, markup) => {
  const out = String(markup);
  assert.ok(!out.includes("<img"), `${name}: no raw tag`);
  assert.ok(out.includes(SAFE), `${name}: the text is shown escaped`);
};

// --- engine stop reasons are shown in Chinese; unknown text stays as it is ---
assert.equal(window.PolyPreview.label("daily loss limit"), "已达每日亏损上限，今天不再下单");
assert.equal(window.PolyPreview.label("daily profit ratchet"), "已到抬高后的止损线，今天不再下单");
assert.equal(window.PolyPreview.label("卖价 0.85 高于上限 0.80，等下一个信号"), "卖价 0.85 高于上限 0.80，等下一个信号");

// --- the template itself ---
assert.equal(esc(EVIL), SAFE);
assert.equal(String(html`<b>${EVIL}</b>`), `<b>${SAFE}</b>`);
assert.equal(String(html`<i>${html`<b>${EVIL}</b>`}</i>`), `<i><b>${SAFE}</b></i>`, "nested templates are not double-escaped");
assert.equal(String(html`${[EVIL, EVIL]}`), SAFE + SAFE, "arrays are escaped item by item");
assert.equal(String(html`<a title="${EVIL}">`), `<a title="${SAFE}">`, "attributes cannot be broken out of");
assert.equal(String(html`${null}${undefined}${false}`), "");

// --- 实盘 ---
const L = window.PolyLive;
check("signal reason", L.renderSignals([{ round_id: "1", received_at: 1, venue: EVIL, line: EVIL, direction: EVIL, move_bp: 2, outcome: "skipped", reason: EVIL }], "1"));
check("position error", L.renderPosition({ attempt: { direction: "UP", status: EVIL, error: EVIL, venue: EVIL }, outcomePnl: {} }, { orders: [{ status: EVIL }] }));
check("no attempt reason", L.renderPosition({ attempt: null, reason: EVIL }, null));
check("book error", L.renderBook({ running: true, available: false, error: EVIL }).top);
check("relay error", L.renderSources({ processRunning: true, leadVenues: ["bybit"], leadRelay: true, leadLines: { venues: {}, relay: { error: EVIL } } }, Date.now()));

// --- 统计 / 历史 ---
check("by source venue", window.PolyStats.renderBySource({ rows: [{ venue: EVIL, line: EVIL }], lines: [{ venue: EVIL }] }));
const H = window.PolyHistory;
const row = { client_order_id: EVIL, market_id: EVIL, venue: EVIL, line: EVIL, direction: EVIL, status: EVIL, error: EVIL, filled_shares: 0 };
const sellRow = { stage: "exit", client_order_id: EVIL + "x", market_id: EVIL, direction: EVIL, status: EVIL, error: EVIL, filled_shares: 0 };
const rounds = H.groupRounds([row, sellRow]);
check("history row", H.renderRows(rounds));
check("history detail", H.renderRows(rounds, new Set([H.roundKey(row)])));

// --- 设置 ---
const S = window.PolySettings;
check("event message", S.renderEvents([{ kind: EVIL, code: EVIL, message: EVIL, time: 1 }], ""));
check("account", S.renderAccount({ wallet: EVIL, last_check_error: EVIL }, { positions: { items: [{ title: EVIL, outcome: EVIL, redeemable: true }] }, open_orders: { items: [{ side: EVIL, outcome: EVIL }] } }));
check("health", S.renderHealth({ status: "degraded", error: EVIL, nodeLabel: EVIL, services: { accountBridge: { error: EVIL } },
  leadFeed: { running: true, relayConfigured: true, relayListener: { error: EVIL } } }));

console.log("escape OK");
process.exit(0);
