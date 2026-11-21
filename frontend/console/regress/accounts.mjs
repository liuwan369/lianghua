// Several accounts in one console (shared/preview-core.js shell + overview.js):
// - the sidebar lists every account from /api/accounts with its colour; the
//   current one is marked; each links to its own /acct/<id>/console/ page;
// - the header carries the current account's badge ("账户 2 · pm-b"), so no
//   page can be mistaken for another account's;
// - requests go under the page's apiBase (/acct/<id>/api/...);
// - the overview compares accounts: their config side by side with the
//   differing values marked, and their results for one range with the sample
//   size next to each rate, a small sample flagged.
//
// Run:  node frontend/console/regress/accounts.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const text = (markup) => String(markup).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const ACCOUNTS = { schemaVersion: 1, current: "2", accounts: [
  { id: "1", label: "账户 1", color: "#3b82f6", box: "pm-a" }, { id: "2", label: "账户 2", color: "#f59e0b", box: "pm-b" }] };

const boot = (files, apiBase, replies) => {
  const requests = [];
  const window = { location: { search: "", href: "http://x/acct/2/console/overview.html", pathname: "/acct/2/console/overview.html" },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URLSearchParams, URL, AbortController, console,
    __POLY_PREVIEW_CONFIG__: { apiBase, account: "2" },
    document: { hidden: false, addEventListener() {}, querySelector: () => null } };
  window.fetch = async (url) => {
    const path = String(url);
    requests.push(path);
    const key = Object.keys(replies).find((prefix) => path.startsWith(prefix));
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(replies[key] ?? { available: false })) };
  };
  window.window = window;
  const context = vm.createContext(window);
  for (const file of files) vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  return { window, requests };
};

// --- the shell: switcher, badge, prefixed requests ---
{
  const { window, requests } = boot(["shared/preview-core.js"], "/acct/2", { "/acct/2/api/accounts": ACCOUNTS });
  const P = window.PolyPreview;
  await P.api.accounts();
  assert.equal(requests[0], "/acct/2/api/accounts", "requests carry the account prefix");
  const shell = String(P.shell("live", "实盘", "", "", ACCOUNTS));
  const switcher = shell.slice(shell.indexOf("data-accounts"));
  assert.ok(text(switcher).includes("账户 1") && text(switcher).includes("账户 2"), "every account is listed");
  assert.match(shell, /href="\/acct\/1\/console\/overview\.html"/, "a switch keeps the page: account 1's overview");
  assert.match(shell, /class="account current"[^>]*>[\s\S]*?账户 2/, "the current account is marked");
  assert.match(shell, /#f59e0b/, "with its colour");
  assert.match(shell, /data-account-badge[^>]*>[\s\S]*?账户 2 · pm-b/, "the header names the account and its box");
  const lone = String(P.shell("live", "实盘", "", "", null));
  assert.doesNotMatch(lone, /data-accounts/, "one bare console shows no switcher");
  assert.ok(P.NAV.some((item) => item.key === "overview"), "the overview is in the nav");
}

// --- the overview: config side by side, results with sample sizes ---
{
  const config = (shares, premium, rest) => ({ savedRevision: 3, config: { shares, limitPremium: premium, restAfterMissSec: rest,
    openBandBp: 5, openLine: "mean60", entryOrder: "gtc", regimePause: true, edgeSizing: false, exitOnReverse: false,
    leadVenues: ["bybit", "binance", "okx"], directVenues: ["bybit"], dailyLossUsd: 60 } });
  const funnel = (orders, filled, settled, won, pnl, shares) => ({ funnel: { signals: 900, orders, filled, fill_rate: filled / orders,
    settled, won, win_rate: won / settled, pnl_usd: pnl, settled_shares: shares, pnl_per_share: pnl / shares } });
  const { window } = boot(["shared/preview-core.js", "overview.js"], "/acct/2", {});
  const O = window.PolyOverview;
  const rows = O.compareConfig([{ account: ACCOUNTS.accounts[0], config: config(5, 0.04, 5) },
                               { account: ACCOUNTS.accounts[1], config: config(10, 0.04, 8) }]);
  const shares = rows.find((row) => row.key === "shares");
  const premium = rows.find((row) => row.key === "limitPremium");
  assert.equal(shares.differs, true, "different share sizes are marked");
  assert.equal(premium.differs, false, "the same premium is not");
  assert.deepEqual([...shares.values], ["5", "10"]);
  const table = String(O.renderConfig(rows, ACCOUNTS.accounts));
  assert.match(table, /class="differs"[\s\S]*?每场股数/, "the differing row is highlighted");
  const results = String(O.renderResults([{ account: ACCOUNTS.accounts[0], stats: funnel(40, 30, 28, 17, 6.5, 140) },
                                          { account: ACCOUNTS.accounts[1], stats: funnel(8, 5, 5, 3, 1.2, 50) }], ACCOUNTS.accounts));
  const plain = text(results);
  assert.ok(plain.includes("买到率") && plain.includes("75.0%") && plain.includes("30/40"), plain);
  assert.ok(plain.includes("每股") && plain.includes("+0.046"), "PnL per settled share: 6.5 / 140");
  assert.match(results, /class="small-sample"/, "account 2's 5 settled rounds are flagged as a small sample");
  assert.ok(plain.includes("同一个信号") || plain.includes("抢单"), "the note says the accounts compete for the same asks");
}

console.log("accounts OK");
process.exit(0);
