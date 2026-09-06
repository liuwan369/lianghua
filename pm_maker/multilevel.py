from __future__ import annotations

from dataclasses import asdict
from typing import Any, Literal

from .shadow import EPSILON, Fill, MakerShadowEngine, ShadowOrder, levels, quote_prices


class MultiLevelMakerShadowEngine(MakerShadowEngine):
    """Experimental read-only engine with several bid levels per outcome.

    The base engine intentionally models one working order per token.  This
    subclass keeps that behavior untouched for existing users/tests and uses
    token@price keys for independent levels in calibration replays.
    """

    def __init__(self, *, max_quote_levels: int = 3, level_size: float | None = None,
                 target_align_dh: float | None = None, align_stop_limit: float | None = None,
                 after_align_mode: str = "continue", hedge_delay_ms: int = 0,
                 protection_quote: bool = False,
                 max_pending_per_side: float | None = None,
                 max_pending_budget_usdc: float | None = None,
                 max_inventory_imbalance_ratio: float | None = None,
                 maker_order_life_ms: int | None = None,
                 **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.max_quote_levels = max(1, int(max_quote_levels))
        self.level_size = float(level_size if level_size is not None else self.order_size)
        self.target_align_dh = target_align_dh
        self.align_stop_limit = align_stop_limit
        if after_align_mode not in {"stop", "continue", "reset"}:
            raise ValueError("after_align_mode must be stop, continue, or reset")
        self.after_align_mode = after_align_mode
        self.hedge_delay_ms = max(0, int(hedge_delay_ms))
        self.protection_quote = bool(protection_quote)
        # Multiple price levels share one side budget.  By default the
        # budget equals one clip, preventing a two-level ladder from silently
        # doubling exposure.
        self.max_pending_per_side = float(
            max_pending_per_side if max_pending_per_side is not None else self.level_size
        )
        self.max_pending_budget_usdc = (
            None if max_pending_budget_usdc is None
            else max(0.0, float(max_pending_budget_usdc))
        )
        self.max_inventory_imbalance_ratio = (
            None if max_inventory_imbalance_ratio is None
            else max(0.0, float(max_inventory_imbalance_ratio))
        )
        self.maker_order_life_ms = (
            None if maker_order_life_ms is None else max(1, int(maker_order_life_ms))
        )

    @staticmethod
    def _key(token: str, price: float) -> str:
        return f"{token}@{price:.10f}"

    def _refresh_quotes(self, timestamp_ms: int) -> list[dict[str, Any]]:
        market = self.market
        if market is None or market.up_token not in market.books or market.down_token not in market.books:
            return []
        phase_controlled = (
            self.quote_start_delay_ms > 0
            or self.align_after_ms is not None
            or self.stop_new_quotes_after_ms is not None
        )
        elapsed_ms = timestamp_ms - market.start_at * 1000 if phase_controlled else 0
        expired = [key for key, order in market.orders.items()
                   if order.expires_at_ms is not None and timestamp_ms >= order.expires_at_ms]
        events: list[dict[str, Any]] = []
        for key in expired:
            market.orders.pop(key, None)
            events.append({"type": "quote_cancelled", "order_key": key, "reason": "maker_order_expired"})
        if phase_controlled and elapsed_ms < self.quote_start_delay_ms:
            for key in list(market.orders):
                market.orders.pop(key, None)
                events.append({"type": "quote_cancelled", "order_key": key, "reason": "before_strategy_start"})
            return events
        if phase_controlled and self.stop_new_quotes_after_ms is not None and elapsed_ms >= self.stop_new_quotes_after_ms:
            for key in list(market.orders):
                market.orders.pop(key, None)
                events.append({"type": "quote_cancelled", "order_key": key, "reason": "strategy_stop_time"})
            return events
        alignment_only = phase_controlled and self.align_after_ms is not None and elapsed_ms >= self.align_after_ms
        prices = quote_prices(
            market.books[market.up_token], market.books[market.down_token],
            max_pair_cost=(
                self.alignment_pair_cost
                if alignment_only and self.alignment_pair_cost is not None
                else self.max_pair_cost
            ),
            quote_offset_ticks=self.quote_offset_ticks,
        )
        if prices is None:
            for key in list(market.orders):
                market.orders.pop(key, None)
                events.append({"type": "quote_cancelled", "order_key": key, "reason": "pair_cost_gate"})
            return events
        up, down = market.inventory["Up"], market.inventory["Down"]
        hedge_outcome = self._hedge_outcome()
        if (
            hedge_outcome is not None
            and self.hedge_delay_ms > 0
            and market.first_unpaired_at_ms is not None
            and timestamp_ms - market.first_unpaired_at_ms < self.hedge_delay_ms
        ):
            cancelled = len(market.orders)
            market.orders.clear()
            return ([{"type": "quotes_cancelled", "reason": "hedge_delay", "cancelled": cancelled}]
                    if cancelled else [])
        pair_sum = None
        if up > EPSILON and down > EPSILON:
            pair_sum = market.cost["Up"] / up + market.cost["Down"] / down
        if pair_sum is not None and self.target_align_dh is not None and pair_sum <= self.target_align_dh + EPSILON:
            if self.after_align_mode in {"stop", "reset"}:
                cancelled = len(market.orders)
                market.orders.clear()
                return [{"type": "quotes_cancelled", "reason": "pair_aligned", "cancelled": cancelled}]
        forced_hedge = None
        if pair_sum is not None and self.align_stop_limit is not None and pair_sum >= self.align_stop_limit - EPSILON:
            forced_hedge = self._hedge_outcome()
        desired: dict[str, tuple[str, float, float, float]] = {}
        for token, outcome, base in (
            (market.up_token, "Up", prices[0]), (market.down_token, "Down", prices[1])
        ):
            book = market.books[token]
            bids = levels(book, "bids")
            tick = float(book.get("tick_size") or 0.01)
            floor = bids[0][0] if bids else 0.0
            allowed = market.inventory[outcome] < self.max_inventory_per_side - EPSILON
            other = "Down" if outcome == "Up" else "Up"
            if alignment_only and outcome != hedge_outcome:
                allowed = False
            if self.pause_heavy_side_when_unpaired and self._hedge_outcome() and outcome != self._hedge_outcome():
                allowed = False
            if market.inventory[outcome] - market.inventory[other] >= self.max_inventory_imbalance - EPSILON:
                allowed = False
            total_inventory = market.inventory[outcome] + market.inventory[other]
            if (
                self.max_inventory_imbalance_ratio is not None
                and total_inventory > EPSILON
                and abs(market.inventory[outcome] - market.inventory[other]) / total_inventory
                    >= self.max_inventory_imbalance_ratio - EPSILON
                and market.inventory[outcome] > market.inventory[other] + EPSILON
            ):
                allowed = False
            if forced_hedge is not None and outcome != forced_hedge:
                allowed = False
            if not allowed:
                # Cancel already-live levels when an inventory/phase gate
                # turns this side off.  Otherwise stale orders can still fill
                # after the guard has rejected new quotes.
                for stale_key, stale_order in list(market.orders.items()):
                    if stale_order.outcome == outcome:
                        market.orders.pop(stale_key, None)
                        events.append({
                            "type": "quote_cancelled",
                            "order_key": stale_key,
                            "reason": "inventory_gate",
                        })
                continue
            quote_levels: list[float] = []
            if self.protection_quote and hedge_outcome == outcome and market.inventory[other] > EPSILON:
                heavy_average = market.cost[other] / market.inventory[other]
                max_allowed = self.max_pair_cost - heavy_average
                asks = levels(book, "asks")
                maker_ceiling = asks[0][0] - tick if asks else 0.0
                protection = min(max_allowed, maker_ceiling)
                if protection >= floor - EPSILON:
                    quote_levels.append(round(protection, 10))
            for level in range(self.max_quote_levels):
                quote_levels.append(round(max(floor, base - level * tick), 10))
            for price in dict.fromkeys(quote_levels):
                # Never create a zero/negative order, including when a
                # protection quote is unavailable and the book floor is 0.
                if price <= EPSILON:
                    continue
                if price > base + EPSILON:
                    # A protection quote may intentionally be above the
                    # ordinary pair-price quote, but never above the maker
                    # ceiling or the execution cap checked above.
                    if not (self.protection_quote and hedge_outcome == outcome):
                        continue
                if self.min_quote_price is not None and price < self.min_quote_price - EPSILON:
                    continue
                if self.max_quote_price is not None and price > self.max_quote_price + EPSILON:
                    continue
                key = self._key(token, price)
                quote_size = self.hedge_order_size if alignment_only and outcome == hedge_outcome else self.level_size
                desired[key] = (token, outcome, price, quote_size)
        # Cancel levels no longer desired; preserve no stale orders after a
        # quote refresh because their queue position is unknown.
        for key in list(market.orders):
            if key not in desired:
                del market.orders[key]
                events.append({"type": "quote_cancelled", "order_key": key, "reason": "multilevel_refresh"})
        pending_by_outcome = {
            "Up": sum(o.remaining for o in market.orders.values() if o.outcome == "Up"),
            "Down": sum(o.remaining for o in market.orders.values() if o.outcome == "Down"),
        }
        pending_budget_by_outcome = {
            "Up": sum(o.remaining * o.price for o in market.orders.values() if o.outcome == "Up"),
            "Down": sum(o.remaining * o.price for o in market.orders.values() if o.outcome == "Down"),
        }
        for key, (token, outcome, price, base_size) in desired.items():
            old = market.orders.get(key)
            if old is not None and old.remaining > EPSILON:
                continue
            side_budget = max(0.0, self.max_pending_per_side - pending_by_outcome[outcome])
            if side_budget <= EPSILON:
                continue
            if self.max_pending_budget_usdc is not None:
                budget_left = self.max_pending_budget_usdc - pending_budget_by_outcome[outcome]
                if budget_left <= EPSILON:
                    continue
                side_budget = min(side_budget, budget_left / price)
            visible = dict(levels(market.books[token], "bids")).get(price, 0.0)
            order = ShadowOrder(
                token=token, outcome=outcome, price=price,
                remaining=min(base_size, side_budget, self.max_inventory_per_side - market.inventory[outcome]),
                queue_ahead=visible * self.queue_ahead_factor, placed_at_ms=timestamp_ms,
                eligible_at_ms=timestamp_ms + self.min_order_live_ms,
                expires_at_ms=(timestamp_ms + self.maker_order_life_ms
                               if self.maker_order_life_ms is not None else None),
            )
            if order.remaining <= EPSILON:
                continue
            market.orders[key] = order
            pending_by_outcome[outcome] += order.remaining
            pending_budget_by_outcome[outcome] += order.remaining * order.price
            market.quote_resets += 1
            events.append({"type": "quote_placed", "order_key": key, **asdict(order)})
        return events


    def process_trade(self, *, token: str, price: float, size: float, taker_side: str,
                      timestamp_ms: int, transaction_hash: str | None = None,
                      activity_id: str | None = None) -> list[dict[str, Any]]:
        market = self.market
        if market is None or taker_side.upper() != "SELL" or size <= 0:
            return []
        market_start_ms = market.start_at * 1000
        elapsed_ms = timestamp_ms - market_start_ms
        stop_reached = (
            timestamp_ms >= market.end_at * 1000
            or (self.stop_new_quotes_after_ms is not None and elapsed_ms >= self.stop_new_quotes_after_ms)
        )
        if stop_reached:
            if stop_reached and market.orders:
                market.orders.clear()
            return []
        for key, order in list(market.orders.items()):
            if order.expires_at_ms is not None and timestamp_ms >= order.expires_at_ms:
                market.orders.pop(key, None)
        identity = activity_id or transaction_hash
        if identity:
            event_key = (identity, token, price, size, timestamp_ms)
            if event_key in self.seen_trades:
                return []
            self.seen_trades.add(event_key)
        tick = float(market.books.get(token, {}).get("tick_size") or 0.01)
        # A public fill only belongs to a quote at the same price level.  The
        # previous 0.005 tolerance could incorrectly fill a lower quote from
        # a one-tick-higher public trade and overstate shadow performance.
        trade_tick = round(price / tick) if tick > EPSILON else None
        candidates = [
            (key, order) for key, order in market.orders.items()
            if order.token == token
            and (trade_tick is None or round(order.price / tick) == trade_tick)
            and timestamp_ms >= order.eligible_at_ms
            and (order.expires_at_ms is None or timestamp_ms < order.expires_at_ms)
        ]
        if not candidates:
            return []
        # Better bid prices fill first; each public trade can consume several
        # levels, while retaining an independent queue estimate per level.
        candidates.sort(key=lambda x: x[1].price, reverse=True)
        remaining_public = size
        events: list[dict[str, Any]] = []
        for key, order in candidates:
            if remaining_public <= EPSILON:
                break
            consumed = min(order.queue_ahead, remaining_public)
            order.queue_ahead -= consumed
            market.queue_volume_consumed += consumed
            remaining_public -= consumed
            if remaining_public <= EPSILON:
                continue
            filled = min(order.remaining, remaining_public)
            # Do not let a fill push the running average pair cost above the
            # configured cap.  This is a risk-control rule on *executions*,
            # not just on newly quoted prices.  A partial fill is allowed up
            # to the remaining amount that still satisfies the cap.
            executable, cap_reason = self._execution_pair_limit(order, filled, timestamp_ms)
            cap_limited = executable + EPSILON < filled
            filled = executable
            if filled <= EPSILON:
                market.orders.pop(key, None)
                events.append({"type": "quote_cancelled", "order_key": key, "reason": cap_reason or "execution_pair_cap"})
                continue
            order.remaining -= filled
            remaining_public -= filled
            market.inventory[order.outcome] += filled
            market.cost[order.outcome] += filled * order.price
            fill = Fill(
                timestamp_ms=timestamp_ms, token=token, outcome=order.outcome,
                price=order.price, size=filled, queue_consumed=consumed,
                transaction_hash=transaction_hash,
            )
            market.fills.append(fill)
            events.append({"type": "shadow_fill", **asdict(fill), "order_key": key})
            self._update_unpaired_clock(timestamp_ms)
            if order.remaining <= EPSILON or cap_limited:
                market.orders.pop(key, None)
                if cap_limited:
                    events.append({"type": "quote_cancelled", "order_key": key, "reason": "execution_pair_cap"})
        if events:
            events.extend(self._refresh_quotes(timestamp_ms))
        return events


StrategyMode = Literal["pair_cost_gate", "dynamic_hedge", "protected_hedge"]


def create_shadow_engine(
    strategy: StrategyMode | str,
    *,
    order_size: float = 10.0,
    pair_cap: float = 0.98,
    hedge_delay_ms: int = 500,
    protection_quote: bool = False,
    max_quote_levels: int = 2,
    level_size: float | None = None,
    queue_factor: float = 0.0,
    max_pending_per_side: float | None = None,
    max_pending_budget_usdc: float | None = None,
    max_inventory_per_side: float = 100.0,
    max_inventory_imbalance: float = 30.0,
    pause_heavy_side_when_unpaired: bool = True,
    max_inventory_imbalance_ratio: float | None = None,
    maker_order_life_ms: int | None = None,
    min_order_live_ms: int = 250,
    stop_new_quotes_after_ms: int | None = None,
    strategy_name: str | None = None,
    **kwargs: Any,
) -> MakerShadowEngine:
    """Create a read-only strategy engine from one explicit strategy mode.

    The returned object consumes public books/trades and emits shadow events;
    it never signs, submits, or cancels a live order.
    """
    aliases = {
        "pair": "pair_cost_gate",
        "strict_pair": "pair_cost_gate",
        "ladder": "dynamic_hedge",
        "dynamic": "dynamic_hedge",
        "protected": "protected_hedge",
    }
    mode = aliases.get(str(strategy), str(strategy))
    if mode not in {"pair_cost_gate", "dynamic_hedge", "protected_hedge"}:
        raise ValueError("unknown shadow strategy: " + str(strategy))
    if float(order_size) <= 0:
        raise ValueError("order_size must be positive")
    if not 0 < float(pair_cap) <= 1.05:
        raise ValueError("pair_cap must be in (0, 1.05]")
    if int(hedge_delay_ms) < 0:
        raise ValueError("hedge_delay_ms must be non-negative")
    if int(max_quote_levels) < 1:
        raise ValueError("max_quote_levels must be at least 1")
    if float(max_inventory_per_side) <= 0:
        raise ValueError("max_inventory_per_side must be positive")
    if float(max_inventory_imbalance) < 0:
        raise ValueError("max_inventory_imbalance must be non-negative")

    common = dict(
        order_size=float(order_size),
        max_pair_cost=float(pair_cap),
        max_inventory_per_side=float(max_inventory_per_side),
        max_inventory_imbalance=float(max_inventory_imbalance),
        pause_heavy_side_when_unpaired=bool(pause_heavy_side_when_unpaired),
        min_order_live_ms=max(0, int(min_order_live_ms)),
        queue_ahead_factor=float(queue_factor),
        stop_new_quotes_after_ms=stop_new_quotes_after_ms,
        strategy_name=strategy_name or mode,
        **kwargs,
    )
    if mode == "pair_cost_gate":
        return MakerShadowEngine(**common)
    return MultiLevelMakerShadowEngine(
        **common,
        level_size=float(level_size if level_size is not None else order_size),
        max_quote_levels=int(max_quote_levels),
        hedge_delay_ms=int(hedge_delay_ms),
        protection_quote=(bool(protection_quote) or mode == "protected_hedge"),
        max_pending_per_side=max_pending_per_side,
        max_pending_budget_usdc=max_pending_budget_usdc,
        max_inventory_imbalance_ratio=max_inventory_imbalance_ratio,
        maker_order_life_ms=maker_order_life_ms,
    )
