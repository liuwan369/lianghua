"""The ledger reads binance-lead's runtime, built by the real engine.

The status line comes from the built engine: BinanceLeadStrategy.getStatus()
after a skipped signal and a placed FAK, enriched by cli/platform.ts
roundOutcome (as summary() does), journaled with leadJournalFields. Then:

- _strategy_projection keeps the round's signal, direction, limit, ask at the
  signal, filled shares and reason, and no reversal field;
- position() reports that attempt and the YES/NO shares;
- lead_signal lines reach /api/events (kind lead_signal) with their outcome
  and reason, so "why no order this round" is visible;
- a verified settlement gets its coverage from upTokenId/downTokenId +
  upShares/downShares and books PnL.

Needs `cd backend/engine && npm run build` first.
Run:  python scripts/regress/lead-ledger.py
"""
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from dashboard.ledger import Ledger, _strategy_projection  # noqa: E402

DIST = ROOT / "backend" / "engine" / "dist"
UP, DOWN = "11" * 38, "22" * 38
ACCOUNT = "0x" + "cd" * 20
TX = "0x" + "ef" * 32

ENGINE = r"""
import { pathToFileURL } from "node:url";
const dist = process.argv[2];
const load = (p) => import(pathToFileURL(`${dist}/${p}`).href);
const { createStrategy } = await load("strategies/binance-lead.js");
const { leadJournalFields, roundOutcome } = await load("cli/platform.js");
const START = Number(process.argv[3]), ROUND = String(START), UP = process.argv[4], DOWN = process.argv[5];
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
let orders = [];
const ctx = (now) => ({ mode: "live", now, markets: [market], books: [], estimateFee: () => 0.05,
  account: { cashUsd: 100, positions: [], orders, quarantinedOrderIds: [], risk: { halted: false, availableUsd: 100, occupiedUsd: 0 } } });
const book = (t, downAsk) => ({ kind: "book", marketId: "0xm", roundId: ROUND, snapshot: { assetId: "btc", marketId: "0xm",
  roundId: ROUND, sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
  YES: { assetId: UP, bid: 0.56, ask: 0.57, sourceAt: t, expiresAt: t + 2 },
  NO: { assetId: DOWN, bid: 0.44, ask: downAsk, sourceAt: t, expiresAt: t + 2 } } });
const lead = (S, tradeId) => ({ kind: "lead", assetId: "btc", direction: "UP", price: 100030, refPrice: 100000, moveBp: 2.9996,
  tradeId, tradeTimeMs: S * 1000 - 100, receivedAtUnix: S, receivedAtMonoMs: 5 });
const s = createStrategy();
s.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20));
s.onEvent(book(START + 20, undefined), ctx(START + 20));
const first = lead(START + 21, 41);
s.onEvent(first, ctx(START + 21));
const signals = [leadJournalFields(first, s.roundAt(first.receivedAtUnix), false)];
s.onEvent(book(START + 22, 0.45), ctx(START + 22));
const second = lead(START + 23, 42);
const actions = s.onEvent(second, ctx(START + 23));
signals.push(leadJournalFields(second, s.roundAt(second.receivedAtUnix), false));
const intent = actions[0].order;
const order = { ...intent, strategyId: "binance-lead", orderId: "0xo1", status: "FILLED", filledShares: 3,
  createdAt: START + 23, updatedAt: START + 23.3, reservedUsd: 0, reservedShares: 0 };
orders = [order];
s.onEvent({ kind: "order", order }, ctx(START + 24));
const state = { positions: [{ tokenId: UP, shares: 3, costUsd: 1.75 }], orders: [order],
  fills: [{ tradeId: "t1", orderId: "0xo1", tokenId: UP, direction: "BUY", price: 0.57, shares: 3, feeUsd: 0.04,
    feeSource: "rate-derived", status: "CONFIRMED", ts: START + 23.3, isMaker: false }] };
const status = s.getStatus();
const enrich = (round) => ({ ...round, ...roundOutcome(round, state) });
const runtime = { ...status, rounds: status.rounds.map(enrich), currentRound: status.currentRound ? enrich(status.currentRound) : null };
console.log(JSON.stringify({ runtime, signals, order, limit: intent.price }));
"""


def engine_round(start):
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "lead.mjs"
        script.write_text(ENGINE, encoding="utf-8")
        done = subprocess.run(["node", str(script), str(DIST), str(start), UP, DOWN], capture_output=True,
                              text=True, encoding="utf-8", timeout=60)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


class LeadLedger(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        now = time.time()
        cls.start = int(now // 300) * 300 - 30
        cls.round = str(cls.start)
        cls.data = engine_round(cls.start)
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        journal = root / "run.jsonl"
        market = {"id": "0xm", "assetId": "btc", "roundId": cls.round, "name": f"btc-updown-5m-{cls.start}",
                  "startsAt": cls.start, "endsAt": cls.start + 300,
                  "instruments": [{"tokenId": UP, "marketId": "0xm", "outcome": "Up", "tickSize": 0.01, "minOrderSize": 5},
                                  {"tokenId": DOWN, "marketId": "0xm", "outcome": "Down", "tickSize": 0.01, "minOrderSize": 5}]}
        runtime = {"schemaVersion": 1, "engine": "platform", "execution": "strategy", "strategy_id": "binance-lead",
                   "status": "running", "mode": "live", "assetId": "btc", "positions": [{"tokenId": UP, "shares": 3, "costUsd": 1.75}],
                   "positions_count": 1, "orders_count": 1, "active_orders": 0, "fills_count": 1,
                   "risk": {"halted": False, "availableUsd": 98, "occupiedUsd": 1.75}, "lead_feed_healthy": True,
                   "strategy_runtime": cls.data["runtime"], "markets": [market], "snapshots": [], "books": []}
        order = cls.data["order"]
        lines = [{"event": "platform_status", "recv_ts": now - 3, "runtime": runtime}]
        lines += [{"event": "lead_signal", "recv_ts": now - 2.5 + i * 0.1, "event_id": f"lead:{i}", **fields}
                  for i, fields in enumerate(cls.data["signals"])]
        lines += [{"event": "order", "recv_ts": now - 2, "client_order_id": order["clientOrderId"], "order_id": "0xo1",
                   "token_id": UP, "strategy_id": "binance-lead", "status": "FILLED", "filled_shares": 3,
                   "price": order["price"], "shares": 5, "direction": "BUY", "asset_id": "btc", "market_id": "0xm",
                   "round_id": cls.round, "market_slug": market["name"], "side": "Up", "created_at": cls.start + 23,
                   "updated_at": cls.start + 23.3},
                  {"event": "fill", "recv_ts": now - 2, "trade_id": "t1", "order_id": "0xo1", "token_id": UP,
                   "strategy_id": "binance-lead", "price": 0.57, "shares": 3, "fee": 0.04, "fee_source": "rate-derived",
                   "trade_status": "CONFIRMED", "is_maker": False, "direction": "BUY", "asset_id": "btc",
                   "market_id": "0xm", "round_id": cls.round, "market_slug": market["name"], "side": "Up",
                   "created_at": cls.start + 23.3},
                  {"event": "platform_status", "recv_ts": now - 1, "runtime": runtime},
                  {"event": "platform_settlement", "recv_ts": now - 0.5, "asset_id": "btc", "market_id": "0xm",
                   "round_id": cls.round, "market_slug": market["name"], "state": "confirmed", "transaction_id": TX,
                   "payout_verified": True, "credited_usd": 3, "expected_payout_usd": 3,
                   "cash_before_usd": 98, "cash_after_usd": 101}]
        journal.write_text("".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8")
        cls.ledger = Ledger(root / "ledger.sqlite3")
        cls.ledger.register_run("run-lead", "live", ACCOUNT, str(journal))
        cls.ledger.ingest("run-lead", max_bytes=8 << 20, max_records=10000)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_projection_keeps_the_attempt(self):
        view = _strategy_projection(self.data["runtime"])
        self.assertIsNotNone(view, "a binance-lead runtime is projected")
        self.assertEqual(view["strategyId"], "binance-lead")
        self.assertEqual(view["config"]["shares"], 5)
        self.assertEqual(view["config"]["thresholdBp"], 2)
        self.assertEqual(view["config"]["maxAsk"], 0.8, "the round's ask cap reaches the runtime view")
        self.assertEqual(view["config"]["makerHoldSec"], 0, "and its maker hold (0 = FAK)")
        self.assertEqual(view["config"]["leadSource"], "binance-spot", "and its signal source")
        current = view["currentRound"]
        self.assertEqual((current["upTokenId"], current["downTokenId"]), (UP, DOWN))
        self.assertEqual((current["upShares"], current["downShares"]), (3, 0))
        self.assertTrue(current["attempted"])
        self.assertEqual(current["reason"], "本场已买到 3/5 股，持有到结算")
        stage = current["stages"][0]
        self.assertEqual((stage["direction"], stage["price"], stage["askAtSignal"], stage["shares"], stage["filledShares"],
                          stage["status"]), ("UP", self.data["limit"], 0.57, 5, 3, "FILLED"))
        self.assertEqual(self.data["limit"], 0.6, "ask 0.57 + 0.03")
        self.assertEqual((stage["signal"]["moveBp"], stage["signal"]["tradeId"], stage["signal"]["direction"]),
                         (2.9996, 42, "UP"))
        for gone in ("confirmationCount", "nextStage", "nextShares", "consumedStages", "lastStageDirection"):
            self.assertNotIn(gone, current, f"{gone} is a reversal field")
        for gone in ("triggerPrice", "stageShares", "maxStages"):
            self.assertNotIn(gone, view["config"])

    def test_position_reports_the_round(self):
        position = self.ledger.position("run-lead", self.round, asset_id="btc", market_id="0xm")
        self.assertTrue(position["available"], position)
        self.assertEqual((position["yesShares"], position["noShares"]), (3, 0))
        self.assertEqual(position["reason"], "本场已买到 3/5 股，持有到结算")
        attempt = position["attempt"]
        self.assertEqual((attempt["direction"], attempt["price"], attempt["askAtSignal"], attempt["filledShares"],
                          attempt["shares"], attempt["moveBp"]), ("UP", self.data["limit"], 0.57, 3, 5, 2.9996))
        for gone in ("stage", "consumedStages", "confirmations", "nextShares", "maxStages", "stages"):
            self.assertNotIn(gone, position, f"{gone} is a reversal field")

    def test_lead_signals_reach_events(self):
        events = self.ledger.events("run-lead", kinds=["lead_signal"])["events"]
        self.assertEqual(len(events), 2)
        placed, skipped = events   # newest first
        self.assertEqual((skipped["outcome"], skipped["reason"]), ("skipped", "当前盘口一边没有卖价，等下一个信号"))
        self.assertEqual((placed["outcome"], placed["limit_price"], placed["ask_at_signal"]),
                         ("order_submitted", self.data["limit"], 0.57))
        self.assertEqual((placed["direction"], placed["move_bp"], placed["round_id"]), ("UP", 2.9996, self.round))
        self.assertEqual((placed["binance_price"], placed["price"], placed["amount"]), (100030, None, None),
                         "a signal's price is Binance's, never an order price")
        self.assertNotIn("lead_signal", [item["event"] for item in self.ledger.events("run-lead")["events"]],
                         "the run log is not buried under signals")
        runtime = self.ledger.runtime_stats("run-lead")["runtime"]
        self.assertTrue(runtime["lead_feed_healthy"])
        self.assertEqual([item["trade_id"] for item in runtime["lead_signals"]], [42, 41],
                         "the latest signals ride the runtime view, newest first")
        self.assertEqual(runtime["lead_signals"][1]["reason"], "当前盘口一边没有卖价，等下一个信号")

    def test_settlement_books_pnl_from_lead_coverage(self):
        row = self.ledger.settlements_page("run-lead")["settlements"][0]
        self.assertEqual(row["coverage"], {UP: 3, DOWN: 0})
        self.assertAlmostEqual(row["pnl"], 3 - (0.57 * 3 + 0.04), places=6)


if __name__ == "__main__":
    unittest.main()
