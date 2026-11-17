"""binance-lead statistics on a synthetic journal, through the real ledger and
the real control-plane handler.

- lead_order records (cli/platform.ts leadOrderFields) are projected into
  lead_orders, one row per (run, client_order_id); a rewrite under the same
  key (a restart) replaces the row, an identical line is a duplicate;
- platform_settlement keeps winning_token_id / winning_side, and an order's
  won/lost comes from that token, also when the settlement landed in the
  next run;
- GET /api/stats/lead: funnel, misses (would_have_won, hypothetical PnL),
  late_by_ms quantiles and buckets, latency, by_source (venue x line, plus
  the Tokyo-first share from lead_lines), skip buckets mapped from the
  strategy's Chinese reasons, by_hour in UTC+8;
- GET /api/orders/lead: newest first, outcome and PnL joined, paging by before;
- exit on the first reverse signal and size by edge: the exit sell's row
  (stage exit) is not a buy, its proceeds move the round's buy PnL, the
  venue's round PnL still lands on the one buy row; exit_first and
  edge_sizing report the shadow (switch off) and the live (switch on) results;
- GET /api/runtime/book: {running:false} without an engine, the current
  round's book from the engine's snapshot with one;
- mutations pass only behind the HTTPS proxy (Basic Auth): trusted headers
  pass, missing headers or another Origin are refused; removed routes are 404.

Run:  python scripts/regress/lead-stats.py
"""
import http.client
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from dashboard.ledger import Ledger, _range_start, _skip_bucket  # noqa: E402

spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

ACCOUNT = "0x" + "ab" * 20
R1 = 1_800_000_000          # 2027-01-15 08:00 UTC = 16:00 UTC+8
TX = "0x" + "ef" * 32


def order(n, *, venue, line, direction, status, filled, limit, round_start, avg=None, fee=None, late=None,
          gone=None, ack=None, recv=None):
    token = f"{'U' if direction == 'UP' else 'D'}{n}"
    return {"event": "lead_order", "event_id": f"lead_order:c{n}", "recv_ts": recv or round_start + 30,
            "client_order_id": f"c{n}", "order_id": f"o{n}", "market_id": f"0xm{n}", "round_id": str(round_start),
            "round_start": round_start, "direction": direction, "token_id": token, "status": status,
            "venue_status": None, "error": None, "venue": venue, "line": line, "relay_recv_ms": None,
            "trade_id": 1000 + n, "trade_time_ms": (round_start + 29) * 1000, "signal_recv_ms": (round_start + 29) * 1000 + 20,
            "move_bp": 2.5, "signal_price": 100000, "open_line": "mean60", "open_value": 99990, "band_bp": 1.0,
            "sec_since_open": 29, "ask_at_signal": limit - 0.03, "limit_price": limit, "shares": 5,
            "filled_shares": filled, "avg_fill_price": avg, "fee_usd": fee, "decision_ms": None,
            "post_sent_ms": None, "ack_ms": None, "ask_gone_ms": None, "ask_gone_venue_ms": None,
            "t_signal_ms": 20, "t_decide_ms": 1, "t_post_ms": 2, "t_ack_ms": ack, "t_total_ms": None,
            "ask_gone_after_trade_ms": gone, "late_by_ms": late}


def settlement(n, winner, recv):
    return {"event": "platform_settlement", "recv_ts": recv, "asset_id": "btc", "market_id": f"0xm{n}",
            "round_id": None, "market_slug": None, "state": "confirmed", "transaction_id": TX,
            "payout_verified": False, "winning_token_id": winner, "winning_side": "Up" if winner.startswith("U") else "Down"}


def signal(i, outcome, reason, recv):
    return {"event": "lead_signal", "event_id": f"lead:{i}", "recv_ts": recv, "received_at": recv, "asset_id": "btc",
            "venue": "bybit", "line": "direct", "trade_id": i, "direction": "UP", "move_bp": 2.1, "price": 100000,
            "outcome": outcome, "reason": reason}


O1_OPEN = order(1, venue="bybit", line="tokyo", direction="UP", status="OPEN", filled=0, limit=0.58,
                round_start=R1, ack=40, recv=R1 + 29)
O1 = order(1, venue="bybit", line="tokyo", direction="UP", status="FILLED", filled=5, avg=0.55, fee=0.07, limit=0.58,
           round_start=R1, gone=200, ack=40)
O2 = order(2, venue="binance", line="direct", direction="DOWN", status="FILLED", filled=5, avg=0.6, fee=0.05, limit=0.63,
           round_start=R1 + 300, ack=50)
O3 = {**order(3, venue="bybit", line="direct", direction="UP", status="CANCELLED", filled=0, limit=0.5,
            round_start=R1 + 600, late=30, gone=120, ack=60), "stage": "fak", "rest_mode": "shadow",
      "rest_shadow_fill_ms": (R1 + 632) * 1000}
O4 = {**order(4, venue="okx", line="tokyo", direction="DOWN", status="CANCELLED", filled=0, limit=0.4,
            round_start=R1 + 900, late=-10, gone=80, ack=70), "stage": "fak", "rest_mode": "shadow", "rest_shadow_fill_ms": None}
# A live rest order after O7's miss (its own row, stage "rest"): 3 of 5 filled, DOWN won.
O7R = {**order(70, venue="binance", line="tokyo", direction="UP", status="CANCELLED", filled=3, avg=0.7, fee=0,
               limit=0.7, round_start=R1 + 3900, ack=100), "stage": "rest", "rest_mode": "live",
       "parent_client_order_id": "c7", "market_id": "0xm7", "token_id": "U7"}
O5 = order(5, venue="bybit", line="tokyo", direction="UP", status="REJECTED", filled=0, limit=0.5,
           round_start=R1 + 1200, ack=80)
O6 = order(6, venue="bybit", line="tokyo", direction="UP", status="FILLED", filled=5, avg=0.5, fee=0.06, limit=0.53,
           round_start=R1 + 3600, gone=400, ack=90)
O7 = order(7, venue="binance", line="tokyo", direction="UP", status="CANCELLED", filled=0, limit=0.7,
           round_start=R1 + 3900, late=450, gone=300, ack=100)
# entryOrder gtc: one GTC, 6 shares (5 taker at once + 1 maker while it rested),
# then cancelled. Its own row, stage "gtc".
O8 = {**order(8, venue="okx", line="tokyo", direction="UP", status="CANCELLED", filled=6, avg=0.5, fee=0.05,
             limit=0.53, round_start=R1 + 4200, ack=90), "stage": "gtc", "rest_mode": "gtc",
      "taker_shares": 5, "maker_shares": 1}

SIGNALS_A = [signal(1, "no_round", None, R1 - 50), signal(2, "order_submitted", "已下单（FAK），等待成交回报", R1 + 29),
             signal(3, "skipped", "信号在开盘后 3.0 秒，不在本场 [15, 265) 秒内", R1 + 3),
             signal(4, "skipped", "信号离开盘前 60 秒均价 领先 6.0 bp，超出 ±5 bp，等下一个信号", R1 + 40),
             signal(5, "skipped", "卖价 0.85 高于上限 0.80，等下一个信号", R1 + 50),
             signal(6, "skipped", "当前盘口一边没有卖价，等下一个信号", R1 + 60),
             signal(7, "skipped", "当前盘口到达时不新鲜（skew），等下一个信号", R1 + 61)]
SIGNALS_B = [signal(8, "no_round", None, R1 + 3550), signal(9, "skipped", "超过单场预算，本场不下", R1 + 3610),
             signal(10, "skipped", "daily loss limit", R1 + 3620), signal(11, "skipped", "已暂停新增交易", R1 + 3630),
             signal(12, "skipped", "本场已尝试，未成交", R1 + 3640), signal(13, "skipped", "交易所规则暂不可用", R1 + 3650),
             signal(14, "stopping", "停机中，不处理信号", R1 + 3660)]
RUNTIME_B = {"schemaVersion": 1, "engine": "platform", "execution": "strategy", "strategy_id": "binance-lead",
             "status": "running", "mode": "live", "assetId": "btc", "positions": [], "positions_count": 0,
             "lead_feed_healthy": True, "lead_venues": ["bybit", "binance", "okx"], "lead_relay": True,
             "lead_lines": {"venues": {
                 "bybit": {"direct": {"frames": 50, "trades": 40, "delivered": 10, "lastAt": 1, "leadSumMs": 0,
                                      "leadCount": 0, "leadMeanMs": None},
                           "tokyo": {"frames": 60, "trades": 40, "delivered": 30, "lastAt": 1, "leadSumMs": 250,
                                     "leadCount": 20, "leadMeanMs": 12.5}}},
                 "relay": {"listening": True, "port": 47001, "error": None, "messages": 90, "accepted": 88,
                           "badSource": 0, "badFormat": 0, "badMac": 2, "tcpClients": 1}},
             "markets": [], "snapshots": [], "books": []}


def exit_shadow(n, *, direction, triggered, bid, sell, opposite, round_start):
    token = f"{'U' if direction == 'UP' else 'D'}{n}"
    return {"event": "lead_exit_shadow", "event_id": f"lead_exit_shadow:0xm{n}", "recv_ts": round_start + 200,
            "market_id": f"0xm{n}", "round_id": str(round_start), "round_start": round_start, "direction": direction,
            "token_id": token, "held_shares": 5, "opposite_signals": opposite, "triggered": triggered,
            "trigger_ms": (round_start + 100) * 1000 if triggered else None, "trigger_sec_since_open": 100 if triggered else None,
            "bid": bid, "sell_shares": sell}


# O1 won (UP, U1): a sell on the 3rd opposite signal would have been a mistake.
# O2 lost (DOWN token D2, winner U2): the sell would have saved part of it. O6 held, not triggered.
EXITS = [exit_shadow(1, direction="UP", triggered=True, bid=0.40, sell=5, opposite=3, round_start=R1),
         exit_shadow(2, direction="DOWN", triggered=True, bid=0.30, sell=5, opposite=3, round_start=R1 + 300),
         exit_shadow(6, direction="UP", triggered=False, bid=None, sell=None, opposite=1, round_start=R1 + 3600)]


def write(path, records):
    path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")


class LeadStats(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.engine = root / "backend" / "engine"
        dashboard = cls.engine / "results" / "dashboard"
        dashboard.mkdir(parents=True)
        journal_a, journal_b = root / "a.jsonl", root / "b.jsonl"
        # Run A: O1 written twice (OPEN at shutdown-before-ack, then FILLED on a
        # restart) plus an identical duplicate line of O2.
        write(journal_a, [*SIGNALS_A, O1_OPEN, O1, O2, O2, O3, O4, O5, EXITS[0], EXITS[1], EXITS[1]])
        # Run B: its own orders, and the settlements of every round (the venue
        # settles after the run that traded it stopped).
        write(journal_b, [*SIGNALS_B, {"event": "platform_status", "recv_ts": R1 + 3700, "runtime": RUNTIME_B},
                          O6, O7, O7R, EXITS[2], settlement(1, "U1", R1 + 3701), settlement(2, "U2", R1 + 3702),
                          settlement(3, "U3", R1 + 3703), settlement(4, "U4", R1 + 3704),
                          settlement(7, "D7", R1 + 4300)])
        cls.ledger = Ledger(dashboard / "ledger.sqlite3")
        for run, journal in (("run-a", journal_a), ("run-b", journal_b)):
            cls.ledger.register_run(run, "live", ACCOUNT, str(journal))
            cls.ledger.ingest(run, max_bytes=8 << 20, max_records=10000)
        cls.stats = cls.ledger.lead_stats("run-b", range="all", now=R1 + 5000)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    # --- projection ---
    def test_lead_order_projection_and_upsert(self):
        with self.ledger._connect() as db:
            rows = {row["client_order_id"]: json.loads(row["payload"]) for row in
                    db.execute("SELECT client_order_id,payload FROM lead_orders WHERE run_id='run-a'")}
        self.assertEqual(sorted(rows), ["c1", "c2", "c3", "c4", "c5"], "one row per order; the duplicate line adds none")
        self.assertEqual((rows["c1"]["status"], rows["c1"]["filled_shares"]), ("FILLED", 5), "the rewrite replaced the OPEN row")
        o1 = rows["c1"]
        for field in ("venue", "line", "round_start", "trade_time_ms", "signal_recv_ms", "band_bp", "open_line",
                      "t_signal_ms", "t_decide_ms", "t_post_ms", "t_ack_ms", "ask_gone_after_trade_ms", "late_by_ms",
                      "avg_fill_price", "fee_usd", "limit_price", "token_id", "direction"):
            self.assertIn(field, o1, field)
        self.assertEqual((o1["venue"], o1["line"], o1["avg_fill_price"], o1["amount"]), ("bybit", "tokyo", 0.55, None))
        self.assertNotIn("lead_order", [e["event"] for e in self.ledger.events("run-a")["events"]],
                         "lead orders do not bury the run log")

    def test_settlement_keeps_the_winner(self):
        row = self.ledger.settlements_page("run-b")["settlements"]
        winners = {item["market_id"]: (item["winning_token_id"], item["winning_side"]) for item in row}
        self.assertEqual(winners["0xm1"], ("U1", "Up"))
        self.assertEqual(winners["0xm7"], ("D7", "Down"))

    # --- /api/stats/lead numbers ---
    def test_funnel(self):
        funnel = self.stats["funnel"]
        self.assertEqual((funnel["signals"], funnel["signals_in_window"]), (14, 12))
        self.assertEqual((funnel["orders"], funnel["filled"], funnel["settled"], funnel["won"]), (7, 3, 2, 1))
        self.assertAlmostEqual(funnel["fill_rate"], 3 / 7)
        self.assertEqual(funnel["win_rate"], 0.5)
        self.assertAlmostEqual(funnel["pnl_usd"], (5 - 2.75 - 0.07) + (-3 - 0.05), places=6)
        self.assertEqual(funnel["pnl_source"], "ledger")
        self.assertAlmostEqual(funnel["fees_usd"], 0.18, places=6)
        official = self.ledger.lead_stats("run-b", range="all", now=R1 + 5000,
                                          official={("btc", str(R1)): {"pnl": 2.0}})["funnel"]
        self.assertAlmostEqual(official["pnl_usd"], 2.0 - 3.05, places=6, msg="the venue's PnL wins where it exists")
        self.assertEqual(official["pnl_source"], "mixed")

    def test_rest(self):
        rest = self.stats["rest"]
        self.assertEqual((rest["live"]["orders"], rest["live"]["filled"], rest["live"]["settled"], rest["live"]["won"]),
                         (1, 1, 1, 0), "the rest row is counted on its own, lost (DOWN won round 7)")
        self.assertAlmostEqual(rest["live"]["pnl_usd"], -3 * 0.7, places=6, msg="3 filled at 0.70, no fee")
        shadow = rest["shadow"]
        self.assertEqual((shadow["misses"], shadow["would_fill"], shadow["settled"], shadow["won"]), (2, 1, 1, 1),
                         "O3 and O4 were shadowed; O3 came back and won")
        self.assertAlmostEqual(shadow["pnl_if_filled_usd"], 5 * (1 - 0.5), places=6, msg="maker fill at the limit, no fee")
        # The venue's round PnL lands on the round's one filled row (the rest),
        # never also on the unfilled FAK of the same round.
        official = {("btc", str(R1 + 3900)): {"pnl": -2.1}}
        stats = self.ledger.lead_stats("run-b", range="all", now=R1 + 5000, official=official)
        self.assertAlmostEqual(stats["rest"]["live"]["pnl_usd"], -2.1, places=6)
        page = {o["client_order_id"]: o for o in self.ledger.lead_orders_page("run-b", range="all", limit=20,
                                                                          now=R1 + 5000, official=official)["items"]}
        self.assertEqual((page["c70"]["pnl"], page["c70"]["pnl_source"]), (-2.1, "official"))
        self.assertEqual((page["c7"]["pnl"], page["c7"]["pnl_source"]), (None, None), "the unfilled FAK shows no PnL")

    def test_gtc(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        journal = Path(tmp.name) / "c.jsonl"
        write(journal, [O8, settlement(8, "U8", R1 + 4500)])
        ledger = Ledger(Path(tmp.name) / "ledger.sqlite3")
        ledger.register_run("run-c", "live", ACCOUNT, str(journal))
        ledger.ingest("run-c", max_bytes=8 << 20, max_records=10000)
        stats = ledger.lead_stats("run-c", range="run", now=R1 + 5000)
        g = stats["gtc"]
        self.assertEqual((g["orders"], g["filled"], g["rested_fills"]), (1, 1, 1),
                         "one GTC, bought, with a resting (maker) fill")
        self.assertAlmostEqual(g["taker_shares"], 5, places=6)
        self.assertAlmostEqual(g["maker_shares"], 1, places=6)
        self.assertEqual((stats["funnel"]["orders"], stats["funnel"]["filled"], stats["rest"]["live"]["orders"]), (1, 1, 0),
                         "the GTC is the round's order in the funnel, not a rest row")
        self.assertEqual(self.stats["gtc"]["orders"], 0, "no GTC in the FAK runs")

    def test_exit_shadow(self):
        e = self.stats["exit_shadow"]
        fee = lambda b: 0.07 * b * (1 - b) * 5
        self.assertEqual((e["held_rounds"], e["settled"], e["would_sell"], e["mistaken"], e["saved"]), (3, 2, 2, 1, 1),
                         "round 6 has no winner yet; 1 of 2 sells was a winner")
        self.assertAlmostEqual(e["mistaken_cost_usd"], 5 * 0.40 - fee(0.40) - 5, places=6)
        self.assertAlmostEqual(e["saved_usd"], 5 * 0.30 - fee(0.30), places=6)
        self.assertAlmostEqual(e["net_usd"], e["mistaken_cost_usd"] + e["saved_usd"], places=6)
        self.assertEqual(e["mistaken_rate"], 0.5)
        self.assertNotIn("lead_exit_shadow", [x["event"] for x in self.ledger.events("run-a")["events"]],
                         "the shadow lines do not bury the run log")

    def test_misses(self):
        misses = self.stats["misses"]
        self.assertEqual((misses["count"], misses["resolved"], misses["would_have_won"]), (4, 3, 1),
                         "O3 O4 O5 O7 missed; O5's round has no winner yet; O3 would have won")
        expected = ((5 * 0.5 - 0.07 * 0.5 * 0.5 * 5) + (-5 * 0.4 - 0.07 * 0.4 * 0.6 * 5)
                    + (-5 * 0.7 - 0.07 * 0.7 * 0.3 * 5))
        self.assertAlmostEqual(misses["hypothetical_pnl_if_filled"], expected, places=6)

    def test_late_by(self):
        late = self.stats["late_by_ms"]
        self.assertEqual(late["histogram"], {"<0": 1, "0-50": 1, "50-100": 0, "100-200": 0, "200-400": 0, ">400": 1})
        self.assertEqual((late["n"], late["p50"]), (3, 30))
        self.assertAlmostEqual(late["p10"], -2)
        self.assertAlmostEqual(late["p90"], 366)
        gone = late["ask_gone_after_trade_ms"]
        self.assertEqual((gone["missed"]["n"], gone["missed"]["p50"]), (3, 120))
        self.assertAlmostEqual(gone["missed"]["p90"], 264)
        self.assertEqual((gone["filled"]["n"], gone["filled"]["p50"], gone["filled"]["p90"]), (2, 300, 380))

    def test_latency(self):
        latency = self.stats["latency"]
        self.assertEqual(latency["t_ack_ms"], {"n": 7, "p50": 70, "p90": 94})
        self.assertEqual(latency["t_total_ms"], {"n": 0, "p50": None, "p90": None})
        self.assertEqual(latency["t_signal_ms"]["p50"], 20)

    def test_by_source(self):
        rows = {(row["venue"], row["line"]): row for row in self.stats["by_source"]["rows"]}
        bybit_tokyo = rows[("bybit", "tokyo")]
        self.assertEqual((bybit_tokyo["orders"], bybit_tokyo["filled"], bybit_tokyo["settled"], bybit_tokyo["won"]),
                         (3, 2, 1, 1))
        self.assertAlmostEqual(bybit_tokyo["fill_rate"], 2 / 3)
        self.assertAlmostEqual(bybit_tokyo["pnl_usd"], 2.18, places=6)
        self.assertEqual(rows[("binance", "direct")]["win_rate"], 0)
        self.assertEqual(set(rows), {("bybit", "tokyo"), ("binance", "direct"), ("bybit", "direct"),
                                     ("okx", "tokyo"), ("binance", "tokyo")})
        line = self.stats["by_source"]["lines"][0]
        self.assertEqual((line["venue"], line["tokyo_first_share"], line["tokyo_lead_mean_ms"]), ("bybit", 0.75, 12.5))

    def test_skips(self):
        self.assertEqual(self.stats["skips"], {"time_window": 1, "band": 1, "ask_too_high": 1, "book": 2,
                                               "budget": 2, "paused": 1, "mid_round_start": 0, "already_attempted": 1, "other": 2})
        for reason, bucket in (("卖价 0.995 高于最高限价 0.99，等下一个信号", "ask_too_high"),
                               ("本场开盘价未知（行情在本场中途才连上），等下一个信号", "band"),
                               ("信号到达时没有当前盘口，等下一个信号", "book"), ("行情恢复中，等待新盘口", "book"),
                               ("超过总资金预算，本场不下", "budget"), ("可用余额不足", "budget"),
                               ("本场已买到 3/5 股，持有到结算", "already_attempted"), ("中途启动，等待下一场", "mid_round_start"), (None, "other")):
            self.assertEqual(_skip_bucket(reason), bucket, reason)

    def test_by_hour_utc8(self):
        hours = self.stats["by_hour"]
        self.assertEqual(len(hours), 24)
        self.assertEqual(datetime.fromtimestamp(R1, timezone(timedelta(hours=8))).hour, 16)
        h16, h17 = hours[16], hours[17]
        self.assertEqual((h16["orders"], h16["filled"], h16["settled"], h16["won"]), (5, 2, 2, 1))
        self.assertAlmostEqual(h16["pnl_usd"], -0.87, places=6)
        self.assertEqual((h17["orders"], h17["filled"], h17["won"], h17["pnl_usd"]), (2, 1, 0, None))
        self.assertEqual(sum(row["orders"] for row in hours), 7)

    def test_ranges(self):
        run = self.ledger.lead_stats("run-b", range="run", now=R1 + 5000)
        self.assertEqual((run["funnel"]["orders"], run["funnel"]["signals"]), (2, 7), "range=run is the run alone")
        self.assertEqual(run["misses"]["would_have_won"], 0, "O7's winner comes from run B's own settlement")
        now = R1 + 5000
        today = _range_start("today", now)
        self.assertEqual(datetime.fromtimestamp(today, timezone(timedelta(hours=8))).hour, 0)
        self.assertEqual(today - _range_start("7d", now), 6 * 86400)
        with self.assertRaises(ValueError):
            self.ledger.lead_stats("run-b", range="month")

    # --- /api/orders/lead ---
    def test_orders_join(self):
        page = self.ledger.lead_orders_page("run-b", range="all", limit=3, now=R1 + 5000)
        self.assertEqual([item["client_order_id"] for item in page["items"]], ["c70", "c7", "c6"],
                         "newest first; the rest order after c7 is its own row")
        self.assertEqual((page["items"][0]["stage"], page["items"][0]["parent_client_order_id"]), ("rest", "c7"))
        self.assertIsNotNone(page["next_before"])
        rest = self.ledger.lead_orders_page("run-b", range="all", limit=10, before=page["next_before"], now=R1 + 5000)
        self.assertEqual([item["client_order_id"] for item in rest["items"]], ["c5", "c4", "c3", "c2", "c1"])
        self.assertIsNone(rest["next_before"])
        by_id = {item["client_order_id"]: item for item in page["items"] + rest["items"]}
        self.assertEqual((by_id["c1"]["outcome"], by_id["c1"]["pnl_source"]), ("won", "ledger"))
        self.assertAlmostEqual(by_id["c1"]["pnl"], 2.18, places=6)
        self.assertEqual((by_id["c2"]["outcome"], by_id["c5"]["outcome"], by_id["c6"]["outcome"]), ("lost", "pending", "pending"))
        self.assertEqual((by_id["c3"]["would_have_won"], by_id["c7"]["would_have_won"]), (True, False))
        self.assertIsNone(by_id["c3"]["pnl"], "nothing filled, nothing made")
        for field in ("t_signal_ms", "t_decide_ms", "t_post_ms", "t_ack_ms", "t_total_ms", "venue", "line", "late_by_ms"):
            self.assertIn(field, by_id["c4"])

    # --- HTTP ---
    def test_http_routes(self):
        saved = {name: getattr(server, name) for name in ("TRADING_ROOT", "_api_run_id", "_official_or_last")}
        try:
            server.TRADING_ROOT = self.engine
            server._api_run_id = lambda: "run-b"
            server._official_or_last = lambda: (None, None)
            render = server.make_handler(SCRIPTS.parent).push_hub.render
            status, body = render("/api/stats/lead?range=all")
            value = json.loads(body)
            self.assertEqual(status, 200)
            self.assertEqual((value["available"], value["range"], value["funnel"]["orders"]), (True, "all", 7))
            for key in ("funnel", "misses", "rest", "late_by_ms", "latency", "by_source", "skips", "by_hour", "asOf", "stale"):
                self.assertIn(key, value)
            status, body = render("/api/orders/lead?range=all&limit=2")
            value = json.loads(body)
            self.assertEqual([item["client_order_id"] for item in value["items"]], ["c70", "c7"])
            status, _ = render("/api/stats/lead?range=month")
            self.assertEqual(status, 400)
        finally:
            for name, value in saved.items():
                setattr(server, name, value)

    def test_runtime_book(self):
        saved = server._running_runtime
        now = time.time()
        try:
            server._running_runtime = lambda: (False, None, {})
            self.assertEqual((server.runtime_book()["running"], server.runtime_book()["available"]), (False, False))
            start = int(now // 300) * 300
            levels = [[0.55 + i / 100, 10 + i] for i in range(7)]
            side = lambda token, bid, ask: {"assetId": token, "bid": bid, "ask": ask, "bidSize": 10, "askSize": 12,
                                            "bids": [[bid - i / 100, 5] for i in range(6)], "asks": levels,
                                            "sourceAt": now - 0.3, "expiresAt": now + 1.7}
            runtime = {"source_at": now - 0.5, "stale": False,
                       "strategy_runtime": {"currentRound": {"marketId": "0xm", "latest": {"upAsk": 0.55, "twoSided": True}}},
                       "markets": [{"id": "0xold", "roundId": str(start - 300), "startsAt": start - 300, "endsAt": start},
                                   {"id": "0xm", "roundId": str(start), "name": f"btc-updown-5m-{start}",
                                    "startsAt": start, "endsAt": start + 300,
                                    "instruments": [{"tokenId": "UP", "outcome": "Up"}, {"tokenId": "DN", "outcome": "Down"}]}],
                       "snapshots": [{"marketId": "0xm", "roundId": str(start), "sequence": 9, "sourceAt": now - 0.3,
                                      "expiresAt": now + 1.7, "YES": side("UP", 0.54, 0.55), "NO": side("DN", 0.44, 0.46)}]}
            server._running_runtime = lambda: (True, runtime, {"state": "ready", "stale": False})
            book = server.runtime_book()
            self.assertEqual((book["running"], book["available"], book["stale"], book["marketId"], book["roundId"]),
                             (True, True, False, "0xm", str(start)))
            self.assertEqual((book["up"]["ask"], book["down"]["bid"], book["up"]["tokenId"]), (0.55, 0.44, "UP"))
            self.assertEqual((len(book["up"]["asks"]), len(book["up"]["bids"])), (5, 5), "five levels a side")
            self.assertTrue(book["twoSided"])
            self.assertEqual(book["strategyView"]["upAsk"], 0.55)
            runtime["snapshots"][0]["expiresAt"] = now - 1
            self.assertTrue(server.runtime_book()["stale"], "an expired snapshot is stale")
        finally:
            server._running_runtime = saved


def first_exit(n, *, direction, round_start, bid, shares, sent, skip, status=None, filled=None):
    token = f"{'U' if direction == 'UP' else 'D'}{n}"
    return {"event": "lead_exit_shadow", "event_id": f"lead_exit_shadow:0xm{n}", "recv_ts": round_start + 301,
            "market_id": f"0xm{n}", "round_id": str(round_start), "round_start": round_start, "direction": direction,
            "token_id": token, "held_shares": shares, "opposite_signals": 1, "triggered": False, "trigger_ms": None,
            "trigger_sec_since_open": None, "bid": None, "sell_shares": None,
            "first_triggered": True, "first_ms": (round_start + 90) * 1000, "first_sec_since_open": 90,
            "first_bid": bid, "first_shares": shares, "first_sent": sent, "first_skip": skip,
            "exit_status": status, "exit_price": None if bid is None else round(bid - 0.08, 2), "exit_shares": shares if sent else None,
            "exit_filled": filled, "exit_client_order_id": f"c{n}x" if sent else None, "exit_order_id": f"o{n}x" if sent else None}


def exit_sell(n, *, round_start, direction, filled, avg, fee, status="FILLED"):
    token = f"{'U' if direction == 'UP' else 'D'}{n}"
    return {"event": "lead_order", "event_id": f"lead_order:c{n}x", "recv_ts": round_start + 91, "stage": "exit",
            "side": "SELL", "rest_mode": None, "client_order_id": f"c{n}x", "order_id": f"o{n}x",
            "market_id": f"0xm{n}", "round_id": str(round_start), "round_start": round_start, "direction": direction,
            "token_id": token, "status": status, "venue_status": None, "error": None, "sec_since_open": 90,
            "bid_at_signal": 0.5, "limit_price": 0.42, "shares": 10, "filled_shares": filled, "avg_fill_price": avg,
            "fee_usd": fee, "proceeds_usd": None if avg is None else round(avg * filled - fee, 6),
            "decision_ms": None, "post_sent_ms": None, "ack_ms": None}


class ExitAndEdge(unittest.TestCase):
    """Rounds of 10 shares at 0.6 (fee 0.1). E1: exitOnReverse on, sold 10 at
    0.5 (fee 0.1), UP lost: PnL 4.9 - 6.1 = -1.2 instead of -6.1. E2: on, sold,
    UP won: 4.9 - 6.1 = -1.2 instead of 3.9. E3: off (shadow), lost, bid 0.3.
    E4: off, won, no reverse signal. Size by edge (shadow): E3 edge -0.1 -> 5
    shares, E4 edge 0.1 -> 15."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        dashboard = root / "backend" / "engine" / "results" / "dashboard"
        dashboard.mkdir(parents=True)
        journal = root / "e.jsonl"
        base = R1 + 20 * 300
        cls.rounds = [base, base + 300, base + 600, base + 900]

        def buy(n, start, direction, *, edge, edge_shares, sizing=False):
            return {**order(n, venue="bybit", line="tokyo", direction=direction, status="FILLED", filled=10, avg=0.6,
                            fee=0.1, limit=0.68, round_start=start, ack=40),
                    "shares": 10, "stage": "gtc", "rest_mode": "gtc", "taker_shares": 10, "maker_shares": 0,
                    "fair": 0.6 + edge, "edge": edge, "edge_shares": edge_shares, "edge_sizing": sizing}
        records = [
            buy(41, cls.rounds[0], "UP", edge=0.0, edge_shares=10),
            exit_sell(41, round_start=cls.rounds[0], direction="UP", filled=10, avg=0.5, fee=0.1),
            first_exit(41, direction="UP", round_start=cls.rounds[0], bid=0.5, shares=10, sent=True, skip=None,
                       status="FILLED", filled=10),
            buy(42, cls.rounds[1], "UP", edge=0.0, edge_shares=10),
            exit_sell(42, round_start=cls.rounds[1], direction="UP", filled=10, avg=0.5, fee=0.1),
            first_exit(42, direction="UP", round_start=cls.rounds[1], bid=0.5, shares=10, sent=True, skip=None,
                       status="FILLED", filled=10),
            buy(43, cls.rounds[2], "UP", edge=-0.1, edge_shares=5),
            first_exit(43, direction="UP", round_start=cls.rounds[2], bid=0.3, shares=10, sent=False, skip="off"),
            buy(44, cls.rounds[3], "UP", edge=0.1, edge_shares=15),
            {**first_exit(44, direction="UP", round_start=cls.rounds[3], bid=None, shares=10, sent=False, skip=None),
             "first_triggered": False, "first_bid": None, "first_shares": None, "first_skip": None},
            settlement(41, "D41", base + 1500), settlement(42, "U42", base + 1501),
            settlement(43, "D43", base + 1502), settlement(44, "U44", base + 1503)]
        write(journal, records)
        cls.ledger = Ledger(dashboard / "ledger.sqlite3")
        cls.ledger.register_run("run-e", "live", ACCOUNT, str(journal))
        cls.ledger.ingest("run-e", max_bytes=8 << 20, max_records=10000)
        cls.stats = cls.ledger.lead_stats("run-e", range="all", now=base + 2000)
        cls.page = cls.ledger.lead_orders_page("run-e", range="all", now=base + 2000)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_sell_is_not_a_buy(self):
        funnel = self.stats["funnel"]
        self.assertEqual((funnel["orders"], funnel["filled"], funnel["settled"], funnel["won"]), (4, 4, 4, 2),
                         "the two exit sells add no order")
        # E1 -1.2, E2 -1.2, E3 -6.1, E4 +3.9
        self.assertAlmostEqual(funnel["pnl_usd"], -1.2 - 1.2 - 6.1 + 3.9, places=6)

    def test_rows(self):
        rows = {item["client_order_id"]: item for item in self.page["items"]}
        self.assertAlmostEqual(rows["c41"]["pnl"], -1.2, places=6, msg="lost, sold: proceeds instead of 0")
        self.assertAlmostEqual(rows["c42"]["pnl"], -1.2, places=6, msg="won, sold: proceeds instead of 1 a share")
        self.assertEqual((rows["c41"]["exit_shares"], rows["c41"]["exit_proceeds_usd"]), (10, 4.9))
        sell = rows["c41x"]
        self.assertEqual((sell["stage"], sell["order_side"], sell["pnl"], sell["pnl_source"]), ("exit", "SELL", None, None))
        self.assertAlmostEqual(sell["exit_vs_hold_usd"], 4.9, places=6, msg="a sold loser got its proceeds back")
        self.assertAlmostEqual(rows["c42x"]["exit_vs_hold_usd"], 4.9 - 10, places=6, msg="a sold winner gave up 1 a share")
        # The venue's round PnL lands on the buy row (the round's one filled buy).
        page = self.ledger.lead_orders_page("run-e", range="all", now=self.rounds[0] + 2000,
                                            official={("btc", str(self.rounds[0])): {"pnl": -1.25}})
        official = {item["client_order_id"]: item for item in page["items"]}
        self.assertEqual((official["c41"]["pnl"], official["c41"]["pnl_source"]), (-1.25, "official"))
        self.assertIsNone(official["c41x"]["pnl_source"])

    def test_exit_first(self):
        e = self.stats["exit_first"]
        self.assertEqual((e["held_rounds"], e["settled"], e["triggered"]), (4, 4, 3))
        self.assertEqual(e["skips"], {"off": 1})
        self.assertEqual((e["shadow"]["rounds"], e["shadow"]["mistaken"], e["shadow"]["saved"]), (1, 0, 1))
        # E3: sell 10 at 0.3 less the fee, against 0 at the close.
        self.assertAlmostEqual(e["shadow"]["net_usd"], 3 - 0.07 * 0.3 * 0.7 * 10, places=6)
        live = e["live"]
        self.assertEqual((live["sells"], live["filled"], live["settled"], live["mistaken"], live["saved"]), (2, 2, 2, 1, 1))
        self.assertAlmostEqual(live["proceeds_usd"], 9.8, places=6)
        self.assertAlmostEqual(live["net_vs_hold_usd"], 4.9 + (4.9 - 10), places=6)

    def test_edge_sizing(self):
        e = self.stats["edge_sizing"]
        self.assertEqual(e["judged"], 4)
        self.assertEqual((e["tiers"]["low"]["settled"], e["tiers"]["mid"]["settled"], e["tiers"]["high"]["settled"]), (1, 2, 1))
        self.assertEqual(e["shadow"]["settled"], 4)
        # Scaled: E1/E2 x1, E3 x0.5, E4 x1.5.
        self.assertAlmostEqual(e["shadow"]["sized_pnl_usd"], -1.2 - 1.2 - 6.1 * 0.5 + 3.9 * 1.5, places=6)
        self.assertAlmostEqual(e["shadow"]["actual_pnl_usd"], -1.2 - 1.2 - 6.1 + 3.9, places=6)
        self.assertEqual(e["live"]["settled"], 0)

    def test_projection_types(self):
        with self.ledger._connect() as db:
            shadow = json.loads(db.execute("SELECT payload FROM lead_exit_shadows WHERE market_id='0xm43'").fetchone()[0])
            order_row = json.loads(db.execute("SELECT payload FROM lead_orders WHERE client_order_id='c41x'").fetchone()[0])
        self.assertEqual((shadow["first_triggered"], shadow["first_sent"], shadow["first_skip"], shadow["first_bid"]),
                         (True, False, "off", 0.3))
        self.assertEqual((order_row["stage"], order_row["proceeds_usd"], order_row["bid_at_signal"]), ("exit", 4.9, 0.5))


class Auth(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.environ = dict(os.environ)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(SCRIPTS.parent))
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        os.environ.clear()
        os.environ.update(cls.environ)

    def post(self, path, headers, body=b'{"action":"pause"}'):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", path, body=body, headers={"Host": "console.example", **headers})
        response = conn.getresponse()
        status, data = response.status, response.read()
        conn.close()
        return status, data

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path)
        response = conn.getresponse()
        status = response.status
        response.read()
        conn.close()
        return status

    PROXY = {"Content-Type": "application/json", "Origin": "https://console.example",
             "X-PM-Authenticated": "operator", "X-Forwarded-Proto": "https"}

    def test_trusted_proxy_passes(self):
        os.environ["PM_TRUST_ACCOUNT_PROXY"] = "1"
        saved = server.strategy_control
        server.strategy_control = lambda payload: {"command_status": "accepted", "stop_result": {}}
        try:
            status, data = self.post("/api/runtime/commands", self.PROXY)
        finally:
            server.strategy_control = saved
        self.assertEqual(status, 200, data)
        self.assertTrue(json.loads(data)["accepted"])

    def test_refused_without_proxy_headers(self):
        os.environ["PM_TRUST_ACCOUNT_PROXY"] = "1"
        for missing in ("X-PM-Authenticated", "X-Forwarded-Proto"):
            headers = {k: v for k, v in self.PROXY.items() if k != missing}
            self.assertEqual(self.post("/api/runtime/commands", headers)[0], 401, missing)
        self.assertEqual(self.post("/api/runtime/commands", {**self.PROXY, "X-Forwarded-Proto": "http"})[0], 401)
        os.environ.pop("PM_TRUST_ACCOUNT_PROXY")
        self.assertEqual(self.post("/api/runtime/commands", self.PROXY)[0], 401, "the server must opt in")
        # A plain loopback caller (no proxy, no Origin) cannot mutate either.
        self.assertEqual(self.post("/api/ledger/reset", {"Content-Type": "application/json"},
                                   b'{"confirm":"RESET"}')[0], 403)

    def test_origin_and_content_type(self):
        os.environ["PM_TRUST_ACCOUNT_PROXY"] = "1"
        self.assertEqual(self.post("/api/strategy/drafts", {**self.PROXY, "Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.post("/api/strategy/drafts", {**self.PROXY, "Origin": "http://console.example"})[0], 403)
        self.assertEqual(self.post("/api/strategy/drafts", {**self.PROXY, "Content-Type": "text/plain"})[0], 415)

    def test_removed_routes(self):
        os.environ["PM_TRUST_ACCOUNT_PROXY"] = "1"
        for path in ("/api/account/check", "/api/account/save", "/api/trading/auth/session", "/api/runtime/flatten",
                     "/api/runtime/market-pool", "/api/orders/x/cancel"):
            self.assertEqual(self.post(path, self.PROXY)[0], 404, path)
        for path in ("/api/markets", "/api/markets/0xm/snapshot", "/api/live", "/api/bootstrap", "/api/runtime/market-pool"):
            self.assertEqual(self.get(path), 404, path)


if __name__ == "__main__":
    unittest.main()
