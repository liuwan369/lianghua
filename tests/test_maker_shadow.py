import random

import pytest

from pm_maker.multilevel import MultiLevelMakerShadowEngine, create_shadow_engine
from pm_maker import shadow
from pm_maker.shadow import MakerShadowEngine, best_price, levels, quote_prices


def book(bid: float, ask: float, bid_size: float = 20.0) -> dict:
    return {
        "bids": [{"price": str(bid), "size": str(bid_size)}],
        "asks": [{"price": str(ask), "size": "20"}],
        "tick_size": "0.01",
    }


def market() -> dict:
    return {
        "market_id": "m1",
        "slug": "btc-updown-5m-100",
        "up_token": "up",
        "down_token": "down",
        "start_at": 100,
        "end_at": 400,
    }


def test_quote_prices_improves_without_crossing_pair_cap() -> None:
    assert quote_prices(book(0.47, 0.50), book(0.48, 0.51), max_pair_cost=0.98) == (0.49, 0.49)


def test_quote_prices_rejects_expensive_pair() -> None:
    assert quote_prices(book(0.51, 0.52), book(0.49, 0.50), max_pair_cost=0.98) is None


def test_best_price_matches_sorted_depth_and_observes_in_place_updates() -> None:
    rng = random.Random(20260913)
    for side in ("bids", "asks"):
        for count in (0, 1, 10, 100):
            for _ in range(20):
                depth = {side: [{"price": str(rng.randrange(1, 100) / 100),
                                 "size": str(rng.randrange(-2, 100))} for _ in range(count)]}
                expected = levels(depth, side)
                assert best_price(depth, side) == (expected[0][0] if expected else None)
                depth[side].append({"price": "0.999" if side == "bids" else "0.001", "size": "10"})
                assert best_price(depth, side) == levels(depth, side)[0][0]
                depth[side][-1]["size"] = "0"
                assert best_price(depth, side) == (expected[0][0] if expected else None)


@pytest.mark.parametrize("side", ["bids", "asks"])
def test_quote_prices_requires_positive_depth_on_each_side(side: str) -> None:
    up = book(0.47, 0.50)
    up[side][0]["size"] = "0"
    assert quote_prices(up, book(0.48, 0.51), max_pair_cost=0.98) is None


def test_quote_decisions_match_sorting_reference(monkeypatch) -> None:
    rng = random.Random(314159)

    def sorted_best(depth, side):
        rows = levels(depth, side)
        return rows[0][0] if rows else None

    for _ in range(200):
        books = []
        for _side in range(2):
            midpoint = rng.randrange(20, 80)
            depth = {"tick_size": rng.choice(["0.001", "0.01"])}
            for side in ("bids", "asks"):
                prices = range(max(1, midpoint - 10), midpoint) if side == "bids" else range(midpoint + 1, min(100, midpoint + 11))
                depth[side] = [{"price": str(price / 100), "size": str(rng.randrange(-1, 100))} for price in prices]
                rng.shuffle(depth[side])
            books.append(depth)
        for cap, offset in ((0.97, 0), (1.02, 0), (1.02, 2)):
            actual = quote_prices(*books, max_pair_cost=cap, quote_offset_ticks=offset)
            with monkeypatch.context() as context:
                context.setattr(shadow, "best_price", sorted_best)
                assert actual == quote_prices(*books, max_pair_cost=cap, quote_offset_ticks=offset)


def test_same_price_trade_consumes_queue_before_shadow_fill() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=0.98, min_order_live_ms=0)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 20), 1_000)
    engine.update_book("down", book(0.49, 0.50, 20), 1_000)
    assert engine.process_trade(token="up", price=0.49, size=15, taker_side="SELL", timestamp_ms=2_000) == []
    events = engine.process_trade(token="up", price=0.49, size=10, taker_side="SELL", timestamp_ms=3_000)
    assert events[0]["type"] == "shadow_fill"
    assert events[0]["size"] == 5


def test_trade_below_quote_fills_after_queue_model() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=0.98, min_order_live_ms=0)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    events = engine.process_trade(token="up", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=2_000)
    assert events[0]["type"] == "shadow_fill"
    snapshot = engine.snapshot()
    assert snapshot["inventory"]["Up"] == 10
    assert snapshot["recent_fills"][0]["outcome"] == "Up"


def test_inventory_gate_stops_heavy_side() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=0.98, max_inventory_imbalance=10, min_order_live_ms=0)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    engine.process_trade(token="up", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=2_000)
    assert "up" not in engine.market.orders
    assert "down" in engine.market.orders


def test_paired_edge_uses_average_inventory_cost() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=0.98, min_order_live_ms=0)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    engine.process_trade(token="up", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=2_000)
    engine.process_trade(token="down", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=2_001)
    snapshot = engine.snapshot()
    assert snapshot["paired_shares"] == 10
    assert snapshot["paired_average_cost"] == 0.98
    assert snapshot["guaranteed_paired_edge_usdc"] == 0.2


def test_order_cannot_fill_before_live_delay() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=0.98, min_order_live_ms=250)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    assert engine.process_trade(token="up", price=0.49, size=20, taker_side="SELL", timestamp_ms=1_249) == []
    events = engine.process_trade(token="up", price=0.49, size=20, taker_side="SELL", timestamp_ms=1_250)
    assert events[0]["type"] == "shadow_fill"


def test_first_fill_is_blocked_when_no_safe_opposite_capacity_remains() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=0.98, min_order_live_ms=0)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    # Simulate the opposite quote disappearing before the first public fill.
    engine.market.orders.pop("down")
    events = engine.process_trade(token="up", price=0.49, size=20, taker_side="SELL", timestamp_ms=2_000)
    assert engine.market.inventory["Up"] == 0
    assert engine.market.orders == {}
    assert events == [{"type": "quote_cancelled", "outcome": "Up", "reason": "execution_pair_cap"}]


def test_first_fill_does_not_count_opposite_quote_before_live_delay() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=0.98, min_order_live_ms=250)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    engine.market.orders["down"].eligible_at_ms = 2_000
    events = engine.process_trade(token="up", price=0.49, size=20, taker_side="SELL", timestamp_ms=1_250)
    assert engine.market.inventory["Up"] == 0
    assert any(e.get("reason") == "execution_pair_cap" for e in events if e["type"] == "quote_cancelled")


def test_partial_execution_cap_cancels_unfillable_remainder() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=0.98, min_order_live_ms=0)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    # Only five opposite shares are still safely available.
    engine.market.orders["down"].remaining = 5
    events = engine.process_trade(token="up", price=0.49, size=20, taker_side="SELL", timestamp_ms=2_000)
    assert engine.market.inventory["Up"] == 5
    assert any(e.get("reason") == "execution_pair_cap" for e in events if e["type"] == "quote_cancelled")


def test_trade_without_identity_is_not_deduplicated_by_shape() -> None:
    engine = MakerShadowEngine(order_size=20, max_pair_cost=1.02, min_order_live_ms=0)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    first = engine.process_trade(token="up", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=2_000)
    second = engine.process_trade(token="up", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=2_000)
    assert first and second


def test_activity_id_deduplicates_replayed_trade() -> None:
    engine = MakerShadowEngine(order_size=20, max_pair_cost=1.02, min_order_live_ms=0)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    kwargs = dict(token="up", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=2_000, activity_id="a1")
    assert engine.process_trade(**kwargs)
    assert engine.process_trade(**kwargs) == []


def test_reset_live_book_preserves_inventory_but_removes_stale_quotes() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=0.98, min_order_live_ms=0)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    engine.process_trade(token="up", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=2_000)
    engine.reset_live_book()
    assert engine.market.inventory["Up"] == 10
    assert engine.market.books == {}
    assert engine.market.orders == {}


def test_book_update_can_defer_quote_refresh() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=0.98, min_order_live_ms=0)
    engine.start_market(market())
    assert engine.update_book("up", book(0.49, 0.50), 1_000, refresh=False) == []
    assert engine.update_book("down", book(0.49, 0.50), 1_000, refresh=False) == []
    assert engine.refresh_quotes(1_000)[0]["type"] == "quote_placed"


def test_unified_shadow_factory_selects_read_only_modes() -> None:
    assert isinstance(create_shadow_engine("pair_cost_gate"), MakerShadowEngine)
    assert not isinstance(create_shadow_engine("pair_cost_gate"), MultiLevelMakerShadowEngine)
    assert isinstance(create_shadow_engine("dynamic_hedge"), MultiLevelMakerShadowEngine)
    protected = create_shadow_engine("protected_hedge", protection_quote=False)
    assert isinstance(protected, MultiLevelMakerShadowEngine)
    assert protected.protection_quote is True


def test_unified_shadow_factory_rejects_unsafe_parameters() -> None:
    with pytest.raises(ValueError):
        create_shadow_engine("dynamic_hedge", order_size=0)
    with pytest.raises(ValueError):
        create_shadow_engine("dynamic_hedge", pair_cap=1.10)
    with pytest.raises(ValueError):
        create_shadow_engine("dynamic_hedge", max_quote_levels=0)


def test_missing_transaction_hash_does_not_drop_distinct_fills() -> None:
    engine = MakerShadowEngine(order_size=10, max_pair_cost=1.02, min_order_live_ms=0)
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    engine.process_trade(token="up", price=0.49, size=5.1, taker_side="SELL", timestamp_ms=2_000)
    engine.process_trade(token="up", price=0.49, size=5.1, taker_side="SELL", timestamp_ms=2_000)
    assert engine.market.inventory["Up"] == 10


def test_preserves_opposite_order_after_one_side_fills() -> None:
    engine = MakerShadowEngine(
        order_size=10,
        max_pair_cost=1.02,
        min_order_live_ms=0,
        preserve_hedge_order=True,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    engine.process_trade(token="up", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=2_000)
    original = engine.market.orders["down"]
    engine.update_book("down", book(0.47, 0.52, 100), 2_100)
    assert engine.market.orders["down"] is original


def test_taker_hedge_buys_other_side_after_timeout_and_includes_fee() -> None:
    engine = MakerShadowEngine(
        order_size=10,
        max_pair_cost=1.02,
        min_order_live_ms=0,
        preserve_hedge_order=True,
        taker_hedge_after_ms=2_000,
        max_taker_pair_cost=1.05,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    engine.process_trade(token="up", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=2_000)
    assert not any(event["type"] == "shadow_fill" for event in engine.refresh_quotes(3_999))
    events = engine.refresh_quotes(4_000)
    fill = next(event for event in events if event["type"] == "shadow_fill")
    assert fill["liquidity"] == "taker"
    assert fill["outcome"] == "Down"
    snapshot = engine.snapshot()
    assert snapshot["paired_shares"] == 10
    assert snapshot["taker_fills"] == 1
    assert snapshot["taker_fee_usdc"] > 0


def test_queue_factor_calibrates_visible_queue_without_changing_book() -> None:
    engine = MakerShadowEngine(
        order_size=20,
        max_pair_cost=1.02,
        min_order_live_ms=0,
        queue_ahead_factor=0.25,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 20), 1_000)
    engine.update_book("down", book(0.49, 0.50, 20), 1_000)
    order = engine.market.orders["up"]
    assert order.queue_ahead == 5
    assert order.remaining == 20


def test_phase_controlled_strategy_waits_aligns_and_stops() -> None:
    engine = MakerShadowEngine(
        order_size=10,
        max_pair_cost=1.02,
        min_order_live_ms=0,
        quote_start_delay_ms=15_000,
        align_after_ms=240_000,
        stop_new_quotes_after_ms=270_000,
        alignment_pair_cost=0.98,
        hedge_order_size=5,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 110_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 110_000)
    assert engine.market.orders == {}

    engine.refresh_quotes(115_000)
    assert set(engine.market.orders) == {"up", "down"}

    engine.process_trade(token="up", price=0.49, size=10.1, taker_side="SELL", timestamp_ms=116_000)
    engine.refresh_quotes(350_000)
    assert set(engine.market.orders) <= {"down"}

    engine.refresh_quotes(371_000)
    assert engine.market.orders == {}


def test_safe_hedge_gate_rejects_quote_without_profitable_opposite_ask() -> None:
    engine = MakerShadowEngine(
        order_size=10,
        max_pair_cost=1.02,
        min_order_live_ms=0,
        taker_hedge_after_ms=0,
        max_taker_pair_cost=0.98,
        require_safe_hedge_at_quote=True,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.47, 0.50), 1_000)
    engine.update_book("down", book(0.47, 0.50), 1_000)
    assert engine.market.orders == {}


def test_safe_hedge_gate_allows_quote_when_opposite_ask_is_profitable() -> None:
    engine = MakerShadowEngine(
        order_size=10,
        max_pair_cost=0.94,
        min_order_live_ms=0,
        taker_hedge_after_ms=0,
        max_taker_pair_cost=0.98,
        require_safe_hedge_at_quote=True,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.45, 0.47), 1_000)
    engine.update_book("down", book(0.45, 0.47), 1_000)
    assert set(engine.market.orders) == {"up", "down"}


def test_multilevel_execution_cap_blocks_first_fill_on_expensive_hedge() -> None:
    from pm_maker.multilevel import MultiLevelMakerShadowEngine

    engine = MultiLevelMakerShadowEngine(
        order_size=10, level_size=10, max_quote_levels=1,
        max_pair_cost=0.98, min_order_live_ms=0,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.58, 0.59, 0.1), 1_000)
    engine.update_book("down", book(0.39, 0.40, 0.1), 1_000)
    # Seed an existing Up inventory at 0.60, then verify a Down fill at 0.40
    # is blocked because the resulting pair average would exceed 0.98.
    engine.market.inventory["Up"] = 1.0
    engine.market.cost["Up"] = 0.60
    events = engine.process_trade(token="down", price=0.39, size=10.1, taker_side="SELL", timestamp_ms=2_000)
    assert engine.market.inventory["Down"] == 0.0
    assert any(e["type"] == "quote_cancelled" and e["reason"] == "execution_pair_cap" for e in events)


def test_multilevel_trade_only_matches_same_price_tick() -> None:
    from pm_maker.multilevel import MultiLevelMakerShadowEngine

    engine = MultiLevelMakerShadowEngine(
        order_size=10, level_size=10, max_quote_levels=2,
        max_pair_cost=1.02, min_order_live_ms=0,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    # A midpoint/non-grid trade must not fill either .49 or .48 quote.
    assert engine.process_trade(token="up", price=0.485, size=20, taker_side="SELL", timestamp_ms=2_000) == []


def test_multilevel_protection_quote_uses_remaining_pair_budget() -> None:
    from pm_maker.multilevel import MultiLevelMakerShadowEngine

    engine = MultiLevelMakerShadowEngine(
        order_size=10, level_size=10, max_quote_levels=1,
        max_pair_cost=0.99, protection_quote=True, min_order_live_ms=0,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.60, 0.70, 0.1), 1_000)
    engine.update_book("down", book(0.30, 0.70, 0.1), 1_000)
    engine.market.inventory["Up"] = 10.0
    engine.market.cost["Up"] = 6.0  # heavy side average = 0.60
    engine.market.inventory["Down"] = 0.0
    engine.market.orders.clear()
    engine.refresh_quotes(2_000)
    down_prices = sorted(order.price for order in engine.market.orders.values() if order.outcome == "Down")
    assert down_prices
    # The protection price is capped by 0.99 - 0.60 = 0.39 and is above the
    # ordinary best-bid quote of 0.30.
    assert down_prices[0] == 0.39


def test_multilevel_usdc_budget_is_shared_across_price_levels() -> None:
    from pm_maker.multilevel import MultiLevelMakerShadowEngine

    engine = MultiLevelMakerShadowEngine(
        order_size=10, level_size=10, max_quote_levels=3,
        max_pair_cost=1.02, max_pending_per_side=100,
        max_pending_budget_usdc=5.0, min_order_live_ms=0,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    for outcome in ("Up", "Down"):
        pending = [o for o in engine.market.orders.values() if o.outcome == outcome]
        assert sum(o.remaining * o.price for o in pending) <= 5.0 + 1e-9


def test_multilevel_phase_controls_wait_align_and_stop() -> None:
    from pm_maker.multilevel import MultiLevelMakerShadowEngine

    engine = MultiLevelMakerShadowEngine(
        order_size=10, level_size=10, hedge_order_size=3, max_quote_levels=2,
        max_pair_cost=1.02, alignment_pair_cost=0.98,
        quote_start_delay_ms=15_000, align_after_ms=240_000,
        stop_new_quotes_after_ms=270_000, min_order_live_ms=0,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 110_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 110_000)
    assert engine.market.orders == {}

    engine.refresh_quotes(115_000)
    assert set(o.outcome for o in engine.market.orders.values()) == {"Up", "Down"}

    # Once the alignment phase starts, only the lighter (hedge) side is
    # allowed to quote and it uses the smaller hedge clip.
    engine.market.inventory["Up"] = 10
    engine.market.cost["Up"] = 4.9
    engine.market.orders.clear()
    engine.refresh_quotes(340_000)
    assert all(o.outcome == "Down" for o in engine.market.orders.values())
    assert all(o.remaining <= 3 + 1e-9 for o in engine.market.orders.values())

    engine.refresh_quotes(371_000)
    assert engine.market.orders == {}


def test_multilevel_gate_cancels_existing_heavy_side_orders() -> None:
    from pm_maker.multilevel import MultiLevelMakerShadowEngine

    engine = MultiLevelMakerShadowEngine(
        order_size=10, level_size=10, max_quote_levels=2,
        max_pair_cost=1.02, max_inventory_imbalance=5, min_order_live_ms=0,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    assert any(o.outcome == "Up" for o in engine.market.orders.values())
    engine.market.inventory["Up"] = 10
    engine.market.cost["Up"] = 4.9
    events = engine.refresh_quotes(2_000)
    assert not any(o.outcome == "Up" for o in engine.market.orders.values())
    assert any(e.get("reason") == "inventory_gate" for e in events if e["type"] == "quote_cancelled")


def test_multilevel_ratio_imbalance_blocks_heavy_side() -> None:
    from pm_maker.multilevel import MultiLevelMakerShadowEngine

    engine = MultiLevelMakerShadowEngine(
        order_size=10, level_size=10, max_quote_levels=1,
        max_pair_cost=1.02, max_inventory_imbalance_ratio=0.15,
        min_order_live_ms=0,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    engine.market.inventory["Up"] = 20.0
    engine.market.cost["Up"] = 9.8
    engine.market.inventory["Down"] = 10.0
    engine.market.cost["Down"] = 4.9
    engine.market.orders.clear()
    engine.refresh_quotes(2_000)
    assert not any(o.outcome == "Up" for o in engine.market.orders.values())


def test_multilevel_orders_expire_after_maker_life() -> None:
    from pm_maker.multilevel import MultiLevelMakerShadowEngine

    engine = MultiLevelMakerShadowEngine(
        order_size=10, level_size=10, max_quote_levels=1,
        max_pair_cost=1.02, maker_order_life_ms=1_000,
        min_order_live_ms=0,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    assert engine.market.orders
    events = engine.refresh_quotes(2_000)
    assert any(e.get("reason") == "maker_order_expired" for e in events)
    assert all(o.placed_at_ms == 2_000 for o in engine.market.orders.values())


def test_multilevel_trade_after_stop_cannot_fill_stale_quote() -> None:
    engine = MultiLevelMakerShadowEngine(
        order_size=10, level_size=10, max_quote_levels=1,
        max_pair_cost=1.02, stop_new_quotes_after_ms=100,
        min_order_live_ms=0,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 100_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 100_000)
    assert engine.market.orders
    engine.process_trade(token="up", price=0.49, size=10, taker_side="SELL", timestamp_ms=100_101)
    assert engine.market.inventory["Up"] == 0
    assert engine.market.orders == {}


def test_multilevel_alignment_uses_hedge_size_for_up_side() -> None:
    engine = MultiLevelMakerShadowEngine(
        order_size=10, level_size=10, hedge_order_size=3,
        max_quote_levels=1, max_pair_cost=1.02,
        alignment_pair_cost=0.98, align_after_ms=1,
        min_order_live_ms=0,
    )
    engine.start_market(market())
    engine.update_book("up", book(0.49, 0.50, 0.1), 1_000)
    engine.update_book("down", book(0.49, 0.50, 0.1), 1_000)
    engine.market.inventory["Down"] = 10
    engine.market.cost["Down"] = 4.9
    engine.market.orders.clear()
    engine.refresh_quotes(2_000)
    assert all(o.outcome == "Up" and o.remaining <= 3 + 1e-9 for o in engine.market.orders.values())
