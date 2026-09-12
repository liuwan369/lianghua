from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


EPSILON = 1e-9


def levels(book: dict[str, Any], side: str) -> list[tuple[float, float]]:
    rows = [
        (float(row["price"]), float(row["size"]))
        for row in book.get(side, [])
        if float(row.get("size", 0)) > 0
    ]
    return sorted(rows, reverse=side == "bids")


def best_price(book: dict[str, Any], side: str) -> float | None:
    prices = (float(row["price"]) for row in book.get(side, []) if float(row.get("size", 0)) > 0)
    return (max if side == "bids" else min)(prices, default=None)


def quote_prices(
    up_book: dict[str, Any],
    down_book: dict[str, Any],
    *,
    max_pair_cost: float,
    quote_offset_ticks: int = 0,
) -> tuple[float, float] | None:
    up, down = best_price(up_book, "bids"), best_price(down_book, "bids")
    up_ask, down_ask = best_price(up_book, "asks"), best_price(down_book, "asks")
    if up is None or down is None or up_ask is None or down_ask is None:
        return None
    ticks = [float(up_book.get("tick_size") or 0.01), float(down_book.get("tick_size") or 0.01)]
    asks = [up_ask, down_ask]
    quotes = [up, down]
    spreads = [asks[0] - up, asks[1] - down]
    while True:
        candidates = [
            index
            for index in (0, 1)
            if quotes[index] + ticks[index] < asks[index] - EPSILON
            and sum(quotes) + ticks[index] <= max_pair_cost + EPSILON
        ]
        if not candidates:
            break
        index = max(candidates, key=lambda item: spreads[item])
        quotes[index] = round(quotes[index] + ticks[index], 10)
        spreads[index] = asks[index] - quotes[index]
    if sum(quotes) > max_pair_cost + EPSILON:
        return None
    # Keep a configurable number of ticks below the best ask.  This models a
    # maker deliberately joining the queue below the touch instead of always
    # quoting one tick below the ask.  Never cross below the current bid.
    offset = max(0, int(quote_offset_ticks))
    if offset:
        for index in (0, 1):
            floor = (up, down)[index]
            quotes[index] = round(max(floor, quotes[index] - offset * ticks[index]), 10)
        if sum(quotes) > max_pair_cost + EPSILON:
            return None
    return quotes[0], quotes[1]


@dataclass
class ShadowOrder:
    token: str
    outcome: str
    price: float
    remaining: float
    queue_ahead: float
    placed_at_ms: int
    eligible_at_ms: int
    expires_at_ms: int | None = None


@dataclass
class Fill:
    timestamp_ms: int
    token: str
    outcome: str
    price: float
    size: float
    queue_consumed: float
    transaction_hash: str | None = None
    liquidity: str = "maker"
    fee_usdc: float = 0.0


@dataclass
class MarketState:
    market_id: str
    slug: str
    up_token: str
    down_token: str
    start_at: int
    end_at: int
    books: dict[str, dict[str, Any]] = field(default_factory=dict)
    orders: dict[str, ShadowOrder] = field(default_factory=dict)
    inventory: dict[str, float] = field(default_factory=lambda: {"Up": 0.0, "Down": 0.0})
    cost: dict[str, float] = field(default_factory=lambda: {"Up": 0.0, "Down": 0.0})
    fills: list[Fill] = field(default_factory=list)
    queue_volume_consumed: float = 0.0
    quote_resets: int = 0
    first_unpaired_at_ms: int | None = None
    taker_hedges: int = 0
    taker_fee_usdc: float = 0.0


class MakerShadowEngine:
    def __init__(
        self,
        *,
        order_size: float = 10.0,
        max_pair_cost: float = 0.98,
        max_inventory_per_side: float = 100.0,
        max_inventory_imbalance: float = 30.0,
        min_order_live_ms: int = 250,
        preserve_hedge_order: bool = False,
        taker_hedge_after_ms: int | None = None,
        taker_fee_rate: float = 0.07,
        max_taker_pair_cost: float | None = None,
        strategy_name: str = "strict_pair",
        pause_heavy_side_when_unpaired: bool = False,
        queue_ahead_factor: float = 1.0,
        quote_start_delay_ms: int = 0,
        align_after_ms: int | None = None,
        stop_new_quotes_after_ms: int | None = None,
        alignment_pair_cost: float | None = None,
        hedge_order_size: float | None = None,
        min_quote_price: float | None = None,
        max_quote_price: float | None = None,
        max_hedge_ask: float | None = None,
        require_safe_hedge_at_quote: bool = False,
        quote_offset_ticks: int = 0,
        min_requote_interval_ms: int = 0,
    ) -> None:
        self.order_size = order_size
        self.max_pair_cost = max_pair_cost
        self.max_inventory_per_side = max_inventory_per_side
        self.max_inventory_imbalance = max_inventory_imbalance
        self.min_order_live_ms = min_order_live_ms
        self.preserve_hedge_order = preserve_hedge_order
        self.taker_hedge_after_ms = taker_hedge_after_ms
        self.taker_fee_rate = taker_fee_rate
        self.max_taker_pair_cost = max_taker_pair_cost
        self.strategy_name = strategy_name
        self.pause_heavy_side_when_unpaired = pause_heavy_side_when_unpaired
        self.queue_ahead_factor = max(0.0, min(1.0, queue_ahead_factor))
        self.quote_start_delay_ms = max(0, int(quote_start_delay_ms))
        self.align_after_ms = align_after_ms if align_after_ms is None else max(0, int(align_after_ms))
        self.stop_new_quotes_after_ms = (
            stop_new_quotes_after_ms
            if stop_new_quotes_after_ms is None
            else max(0, int(stop_new_quotes_after_ms))
        )
        self.alignment_pair_cost = alignment_pair_cost
        self.hedge_order_size = hedge_order_size if hedge_order_size is not None else order_size
        self.min_quote_price = min_quote_price
        self.max_quote_price = max_quote_price
        self.max_hedge_ask = max_hedge_ask
        self.require_safe_hedge_at_quote = require_safe_hedge_at_quote
        self.quote_offset_ticks = max(0, int(quote_offset_ticks))
        self.min_requote_interval_ms = max(0, int(min_requote_interval_ms))
        self.market: MarketState | None = None
        self.seen_trades: set[tuple[Any, ...]] = set()

    def start_market(self, market: dict[str, Any]) -> None:
        self.market = MarketState(
            market_id=str(market["market_id"]),
            slug=str(market["slug"]),
            up_token=str(market["up_token"]),
            down_token=str(market["down_token"]),
            start_at=int(market["start_at"]),
            end_at=int(market["end_at"]),
        )
        self.seen_trades.clear()

    def reset_live_book(self) -> None:
        """Discard stale public books and quotes after a feed reconnect."""
        if self.market is None:
            return
        self.market.books.clear()
        self.market.orders.clear()

    def update_book(
        self,
        token: str,
        book: dict[str, Any],
        timestamp_ms: int,
        *,
        refresh: bool = True,
    ) -> list[dict[str, Any]]:
        if self.market is None or token not in (self.market.up_token, self.market.down_token):
            return []
        self.market.books[token] = book
        return self._refresh_quotes(timestamp_ms) if refresh else []

    def refresh_quotes(self, timestamp_ms: int) -> list[dict[str, Any]]:
        return self._refresh_quotes(timestamp_ms)

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
        if phase_controlled and elapsed_ms < self.quote_start_delay_ms:
            if market.orders:
                market.orders.clear()
                return [{"type": "quotes_cancelled", "reason": "before_strategy_start"}]
            return []
        if phase_controlled and self.stop_new_quotes_after_ms is not None and elapsed_ms >= self.stop_new_quotes_after_ms:
            if market.orders:
                market.orders.clear()
                return [{"type": "quotes_cancelled", "reason": "strategy_stop_time"}]
            return []
        alignment_only = phase_controlled and self.align_after_ms is not None and elapsed_ms >= self.align_after_ms
        prices = quote_prices(
            market.books[market.up_token],
            market.books[market.down_token],
            max_pair_cost=(
                self.alignment_pair_cost
                if alignment_only and self.alignment_pair_cost is not None
                else self.max_pair_cost
            ),
            quote_offset_ticks=self.quote_offset_ticks,
        )
        events: list[dict[str, Any]] = []
        if prices is None:
            hedge_outcome = self._hedge_outcome()
            kept = {
                token: order
                for token, order in market.orders.items()
                if self.preserve_hedge_order and order.outcome == hedge_outcome
            }
            if len(kept) != len(market.orders):
                events.append({"type": "quotes_cancelled", "reason": "pair_cost_gate"})
            market.orders = kept
            events.extend(self._maybe_taker_hedge(timestamp_ms))
            return events
        inventory = market.inventory
        hedge_outcome = self._hedge_outcome()
        for token, outcome, price in (
            (market.up_token, "Up", prices[0]),
            (market.down_token, "Down", prices[1]),
        ):
            other = "Down" if outcome == "Up" else "Up"
            allowed = inventory[outcome] < self.max_inventory_per_side - EPSILON
            if alignment_only and outcome != hedge_outcome:
                allowed = False
            if not alignment_only and self.min_quote_price is not None and price < self.min_quote_price - EPSILON:
                allowed = False
            if not alignment_only and self.max_quote_price is not None and price > self.max_quote_price + EPSILON:
                allowed = False
            if self.pause_heavy_side_when_unpaired and hedge_outcome and outcome != hedge_outcome:
                allowed = False
            if inventory[outcome] - inventory[other] >= self.max_inventory_imbalance - EPSILON:
                allowed = False
            existing = market.orders.get(token)
            if not allowed:
                if existing:
                    del market.orders[token]
                    events.append({"type": "quote_cancelled", "outcome": outcome, "reason": "inventory_gate"})
                continue
            if self.preserve_hedge_order and outcome == self._hedge_outcome() and existing:
                continue
            base_size = self.hedge_order_size if alignment_only and outcome == hedge_outcome else self.order_size
            desired_size = min(base_size, self.max_inventory_per_side - inventory[outcome])
            if self.require_safe_hedge_at_quote and hedge_outcome is None:
                opposite_token = market.down_token if outcome == "Up" else market.up_token
                opposite_asks = levels(market.books[opposite_token], "asks")
                if not opposite_asks:
                    allowed = False
                else:
                    hedge_price, hedge_available = opposite_asks[0]
                    hedge_fee_per_share = self.taker_fee_rate * hedge_price * (1 - hedge_price)
                    all_in_pair_cost = price + hedge_price + hedge_fee_per_share
                    if hedge_available + EPSILON < desired_size:
                        allowed = False
                    if self.max_taker_pair_cost is not None and all_in_pair_cost > self.max_taker_pair_cost + EPSILON:
                        allowed = False
                    if self.max_hedge_ask is not None and hedge_price > self.max_hedge_ask + EPSILON:
                        allowed = False
                if not allowed:
                    if existing:
                        del market.orders[token]
                        events.append({"type": "quote_cancelled", "outcome": outcome, "reason": "safe_hedge_gate"})
                    continue
            if existing and abs(existing.price - price) <= EPSILON and existing.remaining > EPSILON:
                continue
            if (
                existing
                and existing.remaining > EPSILON
                and self.min_requote_interval_ms > 0
                and timestamp_ms - existing.placed_at_ms < self.min_requote_interval_ms
            ):
                # Keep the old quote until its minimum lifetime expires.  This
                # approximates cancel/repost throttling visible to a public
                # feed, without pretending to know the account's real queue.
                continue
            book_bids = dict(levels(market.books[token], "bids"))
            order = ShadowOrder(
                token=token,
                outcome=outcome,
                price=price,
                remaining=desired_size,
                queue_ahead=float(book_bids.get(price, 0.0)) * self.queue_ahead_factor,
                placed_at_ms=timestamp_ms,
                eligible_at_ms=timestamp_ms + self.min_order_live_ms,
            )
            market.orders[token] = order
            market.quote_resets += 1
            events.append({"type": "quote_placed", **asdict(order)})
        events.extend(self._maybe_taker_hedge(timestamp_ms))
        return events

    def _hedge_outcome(self) -> str | None:
        market = self.market
        if market is None:
            return None
        up, down = market.inventory["Up"], market.inventory["Down"]
        if up > down + EPSILON:
            return "Down"
        if down > up + EPSILON:
            return "Up"
        return None

    def _update_unpaired_clock(self, timestamp_ms: int) -> None:
        market = self.market
        if market is None:
            return
        if abs(market.inventory["Up"] - market.inventory["Down"]) <= EPSILON:
            market.first_unpaired_at_ms = None
        elif market.first_unpaired_at_ms is None:
            market.first_unpaired_at_ms = timestamp_ms

    def _maybe_taker_hedge(self, timestamp_ms: int) -> list[dict[str, Any]]:
        market = self.market
        if market is None or self.taker_hedge_after_ms is None:
            return []
        self._update_unpaired_clock(timestamp_ms)
        if market.first_unpaired_at_ms is None:
            return []
        if timestamp_ms - market.first_unpaired_at_ms < self.taker_hedge_after_ms:
            return []
        outcome = self._hedge_outcome()
        if outcome is None:
            return []
        token = market.down_token if outcome == "Down" else market.up_token
        asks = levels(market.books.get(token, {}), "asks")
        if not asks:
            return []
        price, available = asks[0]
        if self.max_hedge_ask is not None and price > self.max_hedge_ask + EPSILON:
            return []
        heavy = "Up" if outcome == "Down" else "Down"
        size = min(
            abs(market.inventory["Up"] - market.inventory["Down"]),
            available,
            self.max_inventory_per_side - market.inventory[outcome],
        )
        if size <= EPSILON:
            return []
        heavy_average = market.cost[heavy] / market.inventory[heavy]
        fee_per_share = self.taker_fee_rate * price * (1 - price)
        if self.max_taker_pair_cost is not None and heavy_average + price + fee_per_share > self.max_taker_pair_cost + EPSILON:
            return []
        fee = size * self.taker_fee_rate * price * (1 - price)
        market.inventory[outcome] += size
        market.cost[outcome] += size * price + fee
        market.taker_fee_usdc += fee
        market.taker_hedges += 1
        market.orders.pop(token, None)
        fill = Fill(
            timestamp_ms=timestamp_ms,
            token=token,
            outcome=outcome,
            price=price,
            size=size,
            queue_consumed=0.0,
            liquidity="taker",
            fee_usdc=fee,
        )
        market.fills.append(fill)
        self._update_unpaired_clock(timestamp_ms)
        return [{"type": "shadow_fill", **asdict(fill)}]

    def _execution_pair_limit(
        self,
        order: ShadowOrder,
        requested_size: float,
        timestamp_ms: int,
    ) -> tuple[float, str | None]:
        """Return the executable size that keeps the pair-cost cap intact.

        A quote is created from a two-sided snapshot, but the opposite quote
        can disappear before this order trades.  Therefore the cap must also
        be checked at execution time, including the first fill when the
        opposite inventory is still zero.  In that case only a currently
        working opposite quote at a safe price can provide hedge capacity.
        """
        market = self.market
        if market is None or requested_size <= EPSILON:
            return 0.0, "execution_pair_cap"

        other_outcome = "Down" if order.outcome == "Up" else "Up"
        other_inventory = market.inventory[other_outcome]
        if other_inventory <= EPSILON:
            hedge_capacity = sum(
                candidate.remaining
                for candidate in market.orders.values()
                if candidate.outcome == other_outcome
                and candidate.remaining > EPSILON
                and timestamp_ms >= candidate.eligible_at_ms
                and order.price + candidate.price <= self.max_pair_cost + EPSILON
            )
            if hedge_capacity <= EPSILON:
                return 0.0, "execution_pair_cap"
            return min(requested_size, hedge_capacity), None

        other_average = market.cost[other_outcome] / other_inventory
        target_average = self.max_pair_cost - other_average
        current_inventory = market.inventory[order.outcome]
        current_cost = market.cost[order.outcome]
        denominator = order.price - target_average
        if denominator <= EPSILON:
            return requested_size, None
        numerator = target_average * current_inventory - current_cost
        allowed = max(0.0, numerator / denominator)
        if allowed <= EPSILON:
            return 0.0, "execution_pair_cap"
        return min(requested_size, allowed), (
            "execution_pair_cap" if allowed + EPSILON < requested_size else None
        )

    def process_trade(
        self,
        *,
        token: str,
        price: float,
        size: float,
        taker_side: str,
        timestamp_ms: int,
        transaction_hash: str | None = None,
        activity_id: str | None = None,
    ) -> list[dict[str, Any]]:
        market = self.market
        if market is None or token not in market.orders or taker_side.upper() != "SELL" or size <= 0:
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
        if self.market.orders[token].expires_at_ms is not None and timestamp_ms >= self.market.orders[token].expires_at_ms:
            market.orders.pop(token, None)
            return []
        # A transaction hash is the only stable public identity.  When the
        # feed omits it, do not collapse two legitimate same-price fills just
        # because their rounded fields happen to match.
        # Prefer the API activity id, then the transaction hash.  If neither
        # exists, do not synthesize a lossy key from price/size/timestamp:
        # separate fills can legitimately share all three fields.
        identity = activity_id or transaction_hash
        if identity:
            trade_key = (identity, token, price, size, timestamp_ms)
            if trade_key in self.seen_trades:
                return []
            self.seen_trades.add(trade_key)
        order = market.orders[token]
        if timestamp_ms < order.eligible_at_ms:
            return []
        # A public trade at a different tick cannot fill this order.  Treating
        # a nearby but different price as a fill overstates shadow volume.
        tick = float(market.books.get(token, {}).get("tick_size") or 0.01)
        if tick > EPSILON and round(price / tick) != round(order.price / tick):
            return []
        available = size
        queue_consumed = min(order.queue_ahead, available)
        order.queue_ahead -= queue_consumed
        market.queue_volume_consumed += queue_consumed
        available -= queue_consumed
        if available <= EPSILON:
            return []
        filled = min(order.remaining, available)
        executable, cap_reason = self._execution_pair_limit(order, filled, timestamp_ms)
        if executable <= EPSILON:
            market.orders.pop(token, None)
            return [{"type": "quote_cancelled", "outcome": order.outcome, "reason": cap_reason or "execution_pair_cap"}]
        cap_limited = executable + EPSILON < filled
        filled = executable
        order.remaining -= filled
        market.inventory[order.outcome] += filled
        market.cost[order.outcome] += filled * order.price
        fill = Fill(
            timestamp_ms=timestamp_ms,
            token=token,
            outcome=order.outcome,
            price=order.price,
            size=filled,
            queue_consumed=queue_consumed,
            transaction_hash=transaction_hash,
        )
        market.fills.append(fill)
        self._update_unpaired_clock(timestamp_ms)
        events = [{"type": "shadow_fill", **asdict(fill)}]
        if order.remaining <= EPSILON or cap_limited:
            del market.orders[token]
            if cap_limited:
                events.append({"type": "quote_cancelled", "outcome": order.outcome, "reason": "execution_pair_cap"})
        if token not in market.orders:
            events.extend(self._refresh_quotes(timestamp_ms))
        return events

    def snapshot(self) -> dict[str, Any]:
        market = self.market
        if market is None:
            return {"market": None}
        up, down = market.inventory["Up"], market.inventory["Down"]
        paired = min(up, down)
        total_cost = market.cost["Up"] + market.cost["Down"]
        paired_cost = 0.0
        if up > EPSILON and down > EPSILON:
            paired_cost = paired * (market.cost["Up"] / up + market.cost["Down"] / down)
        guaranteed_edge = paired - paired_cost
        return {
            "market": {
                "market_id": market.market_id,
                "slug": market.slug,
                "start_at": market.start_at,
                "end_at": market.end_at,
            },
            "orders": {token: asdict(order) for token, order in market.orders.items()},
            "inventory": dict(market.inventory),
            "cost": dict(market.cost),
            "fills": len(market.fills),
            "recent_fills": [asdict(fill) for fill in market.fills[-20:]],
            "fill_shares": round(up + down, 8),
            "paired_shares": round(paired, 8),
            "unpaired_shares": round(abs(up - down), 8),
            "total_cost_usdc": round(total_cost, 8),
            "paired_cost_usdc": round(paired_cost, 8),
            "paired_average_cost": round(paired_cost / paired, 8) if paired > EPSILON else None,
            "guaranteed_paired_edge_usdc": round(guaranteed_edge, 8),
            "settlement_pnl_if_up_usdc": round(up - total_cost, 8),
            "settlement_pnl_if_down_usdc": round(down - total_cost, 8),
            "worst_case_settlement_pnl_usdc": round(min(up, down) - total_cost, 8),
            "maker_fee_usdc": 0.0,
            "maker_rebate_usdc": 0.0,
            "taker_fee_usdc": round(market.taker_fee_usdc, 8),
            "maker_fills": sum(fill.liquidity == "maker" for fill in market.fills),
            "taker_fills": sum(fill.liquidity == "taker" for fill in market.fills),
            "taker_hedges": market.taker_hedges,
            "queue_ahead_factor": self.queue_ahead_factor,
            "unpaired_age_ms": (
                max(0, int(market.books.get(market.up_token, {}).get("timestamp") or 0) - market.first_unpaired_at_ms)
                if market.first_unpaired_at_ms is not None
                else 0
            ),
            "quote_resets": market.quote_resets,
            "queue_volume_consumed": round(market.queue_volume_consumed, 8),
            "limitations": [
                "public books aggregate all orders and do not expose exact queue ownership",
                "fills are conservative shadow estimates, not actual executable account fills",
                "maker rebates and liquidity rewards are excluded until observed settlement exists",
            ],
        }
