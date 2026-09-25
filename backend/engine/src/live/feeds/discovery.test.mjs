import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MARKET_ASSET,
  fiveMinuteMarketSlug,
  findFiveMinuteMarket,
  normalizeMarketAsset,
  parseMarket,
} from "../../../dist/live/discovery.js";

const market = (slug, outcomes = ["Up", "Down"]) => ({
  slug,
  conditionId: "condition",
  clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
  outcomes: JSON.stringify(outcomes),
  closed: false,
});

test("market discovery accepts an explicit non-BTC asset while keeping BTC as the default", () => {
  assert.equal(DEFAULT_MARKET_ASSET, "btc");
  assert.equal(normalizeMarketAsset(" ETH "), "eth");
  assert.equal(fiveMinuteMarketSlug("ETH", 1_800_000_000), "eth-updown-5m-1800000000");
  assert.equal(parseMarket(market("btc-updown-1800000000")), undefined);

  const parsed = parseMarket(market("eth-updown-5m-1800000000"), "eth");
  assert.deepEqual(parsed && {
    asset: parsed.asset,
    slug: parsed.slug,
    slugStart: parsed.slugStart,
    upToken: parsed.upToken,
    downToken: parsed.downToken,
  }, {
    asset: "eth",
    slug: "eth-updown-5m-1800000000",
    slugStart: 1_800_000_000,
    upToken: "yes-token",
    downToken: "no-token",
  });
});

test("market discovery rejects unsafe symbols and non-five-minute boundaries", () => {
  assert.throws(() => normalizeMarketAsset("eth/usd"), /letters and digits/);
  assert.throws(() => fiveMinuteMarketSlug("eth", 1_800_000_001), /five-minute/);
  assert.equal(parseMarket(market("eth-updown-5m-1800000001"), "eth"), undefined);
  assert.equal(parseMarket(market("sol-updown-5m-1800000000"), "eth"), undefined);
});

test("parameterized discovery requests the selected asset slug", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requested;
  globalThis.fetch = async input => {
    requested = String(input);
    return new Response(JSON.stringify([market("eth-updown-5m-1800000000")]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const found = await findFiveMinuteMarket("ETH", {
    now: 1_800_000_050,
    allowCollectorFallback: false,
    directOnly: true,
  });
  assert.equal(requested, "https://gamma-api.polymarket.com/markets?slug=eth-updown-5m-1800000000");
  assert.equal(found?.asset, "eth");
  assert.equal(found?.roundId, "1800000000");
});

test("discovery requires an unambiguous binary outcome mapping without shifting malformed tokens", () => {
  const slug = "sol-updown-5m-1800000000";
  assert.equal(parseMarket(market(slug, ["Down", "Up"]), "sol").upToken, "no-token");
  assert.equal(parseMarket(market(slug, ["No", "Yes"]), "sol").downToken, "yes-token");
  assert.equal(parseMarket(market(slug, ["First", "Second"]), "sol"), undefined);
  assert.equal(parseMarket(market(slug, []), "sol"), undefined);
  assert.equal(parseMarket({ ...market(slug), clobTokenIds: [null, "yes-token", "no-token"] }, "sol"), undefined);
  assert.equal(parseMarket({ ...market(slug), clobTokenIds: ["one", "two", "three"] }, "sol"), undefined);
});

test("discovery ignores malformed batch entries and normalizes token identities", () => {
  const slug = "eth-updown-5m-1800000000";
  assert.equal(parseMarket(null, "eth"), undefined);
  assert.equal(parseMarket({ slug, conditionId: "condition", clobTokenIds: ["  yes-token ", " no-token "], outcomes: ["Yes", "No"] }, "eth")?.upToken, "yes-token");
  assert.equal(parseMarket({ slug, conditionId: "condition", clobTokenIds: ["yes-token", " yes-token "], outcomes: ["Yes", "No"] }, "eth"), undefined);
});
