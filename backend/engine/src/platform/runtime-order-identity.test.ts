import { strict as assert } from "node:assert";
import { TradingCore } from "./core.js";
import type { CoreState, Instrument, MarketInfo, OrderGateway, OrderRequest, TradingEvent } from "./contracts.js";

const marketId = "0x" + "1".repeat(64);
const instruments: Instrument[] = [
  { tokenId: "yes", marketId, outcome: "UP", tickSize: 0.01, minOrderSize: 1 },
  { tokenId: "no", marketId, outcome: "DOWN", tickSize: 0.01, minOrderSize: 1 },
];
const market: MarketInfo = { id: marketId, assetId: "btc", roundId: "1000", startsAt: 1000, endsAt: 1300,
  name: "btc-updown-5m-1000", instruments };
const request: OrderRequest = { clientOrderId: "economic-order", strategyId: "btc-reversal", tokenId: "yes",
  direction: "BUY", price: 0.5, shares: 5, timeInForce: "GTC", postOnly: false };
const explicitRequest: OrderRequest = { ...request, marketId, roundId: "1000", assetId: "btc" };

async function bounded<T>(job: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([job, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("order preparation or stop did not finish")), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

function fixture(restored?: CoreState) {
  const submitted: OrderRequest[] = [], cancelled: string[] = [], committed: string[] = [];
  const events: TradingEvent[] = [];
  let releaseAck!: () => void;
  const ack = new Promise<void>(resolve => { releaseAck = resolve; });
  const gateway: OrderGateway = {
    mode: "live", durableIdentity: true,
    async submit(order, _instrument, prepared) {
      submitted.push(structuredClone(order));
      const orderId = `signed-${order.clientOrderId}`;
      prepared!({ orderHash: orderId, signedPayload: { fixture: true }, preparedAt: 1000 });
      await ack;
      return { status: "accepted", orderId, venueStatus: "live" };
    },
    async cancel(orderId) { cancelled.push(orderId); return true; },
  };
  const core = new TradingCore({
    account: { accountId: "identity-test", at: 1000, cashUsd: 100, positions: [], openOrders: [], complete: true },
    instruments, limits: { capitalUsd: 100, maxOrderUsd: 10, dailyLossUsd: null, maxOpenOrders: 5 },
    restored, now: () => 1000,
    adapters: { gateway, persistPreparedOrder: order => { committed.push(order.orderId!); },
      readAccount: async () => ({ accountId: "identity-test", at: 1001, cashUsd: 100,
        positions: [], openOrders: [], complete: true }) },
    onEvent: event => { events.push(event); },
  });
  core.rememberMarket(market);
  return { core, submitted, cancelled, committed, events, releaseAck };
}

// Invalid identity previously threw after acquiring the durable preparation
// lock, leaving every subsequent order and stop waiting forever.
for (const wrong of [{ marketId: "foreign" }, { roundId: "1300" }, { assetId: "eth" }]) {
  const test = fixture();
  await assert.rejects(test.core.submit({ ...request, ...wrong }), /order (market|round|asset) identity mismatch/);
  assert.equal(test.submitted.length, 0);
  assert.equal(test.committed.length, 0);
  test.releaseAck();
  const order = await bounded(test.core.submit(request));
  assert.equal(order.status, "OPEN");
  assert.deepEqual(test.submitted, [explicitRequest], "gateway receives the registered asset/market/round identity");
  await bounded(test.core.stop("invalid-identity-then-stop"));
  assert.deepEqual(test.cancelled, [order.orderId]);
  assert.equal(test.events.at(-1)?.kind, "stopped");
}

// An omitted assertion and an explicit matching assertion describe the same
// economic order while signing/POST is in flight and after the ACK is stored.
for (const first of [request, explicitRequest]) {
  const test = fixture();
  const pending = test.core.submit(first);
  assert.equal(test.core.submit(request), pending);
  assert.equal(test.core.submit(explicitRequest), pending);
  await assert.rejects(test.core.submit({ ...request, shares: 6 }), /clientOrderId reused/);
  await assert.rejects(test.core.submit({ ...request, roundId: "1300" }), /round identity mismatch/);
  await assert.rejects(test.core.submit({ ...request, assetId: "eth" }), /asset identity mismatch/);
  test.releaseAck();
  const order = await bounded(pending);
  assert.equal((await test.core.submit(request)).orderId, order.orderId);
  assert.equal((await test.core.submit(explicitRequest)).orderId, order.orderId);
  assert.equal(test.submitted.length, 1);
  assert.equal(test.committed.length, 1);
  await bounded(test.core.stop("identity-replay-stop"));

  const restarted = fixture(test.core.snapshot());
  assert.equal((await restarted.core.submit(request)).orderId, order.orderId);
  assert.equal((await restarted.core.submit(explicitRequest)).orderId, order.orderId);
  assert.equal(restarted.submitted.length, 0, "durable replay after restart never submits again");
  await bounded(restarted.core.stop("restarted-identity-replay-stop"));
}

console.log("runtime order identity tests passed");
