from __future__ import annotations

from typing import Any


def order_score(max_spread_cents: float, distance_cents: float, size: float) -> float:
    if max_spread_cents <= 0 or size <= 0 or distance_cents > max_spread_cents:
        return 0.0
    distance = max(0.0, distance_cents)
    return ((max_spread_cents - distance) / max_spread_cents) ** 2 * size


def sorted_levels(book: dict[str, Any], side: str) -> list[tuple[float, float]]:
    levels = [
        (float(level["price"]), float(level["size"]))
        for level in book.get(side, [])
        if float(level.get("size", 0)) > 0
    ]
    return sorted(levels, key=lambda item: item[0], reverse=side == "bids")


def adjusted_midpoint(book: dict[str, Any], minimum_size: float) -> tuple[float, float, float] | None:
    bids = [level for level in sorted_levels(book, "bids") if level[1] >= minimum_size]
    asks = [level for level in sorted_levels(book, "asks") if level[1] >= minimum_size]
    if not bids or not asks or bids[0][0] >= asks[0][0]:
        return None
    bid = bids[0][0]
    ask = asks[0][0]
    return bid, ask, (bid + ask) / 2.0


def aggregate_side_scores(
    book: dict[str, Any],
    midpoint: float,
    max_spread_cents: float,
    minimum_size: float = 0.0,
) -> tuple[float, float]:
    bid_score = sum(
        order_score(max_spread_cents, (midpoint - price) * 100.0, size)
        for price, size in sorted_levels(book, "bids")
        if price <= midpoint and size >= minimum_size
    )
    ask_score = sum(
        order_score(max_spread_cents, (price - midpoint) * 100.0, size)
        for price, size in sorted_levels(book, "asks")
        if price >= midpoint and size >= minimum_size
    )
    return bid_score, ask_score


def official_aggregate_scores(
    market_book: dict[str, Any],
    complement_book: dict[str, Any],
    midpoint: float,
    max_spread_cents: float,
    minimum_size: float,
) -> tuple[float, float]:
    market_bid, market_ask = aggregate_side_scores(
        market_book, midpoint, max_spread_cents, minimum_size
    )
    complement_bid, complement_ask = aggregate_side_scores(
        complement_book, 1.0 - midpoint, max_spread_cents, minimum_size
    )
    return market_bid + complement_ask, market_ask + complement_bid


def competitor_score_bounds(
    bid_score: float, ask_score: float, midpoint: float, single_side_divisor: float = 3.0
) -> tuple[float, float]:
    if 0.10 <= midpoint <= 0.90:
        lower = (bid_score + ask_score) / (single_side_divisor + 1.0)
        upper = min(bid_score, ask_score) + abs(bid_score - ask_score) / single_side_divisor
        return min(lower, upper), max(lower, upper)
    return 0.0, min(bid_score, ask_score)


def hypothetical_quote(
    best_bid: float,
    best_ask: float,
    tick_size: float,
    midpoint: float,
    max_spread_cents: float,
    size: float,
) -> dict[str, float]:
    bid = best_bid
    ask = best_ask
    if best_ask - best_bid >= 3.0 * tick_size:
        bid += tick_size
        ask -= tick_size
    bid = round(bid, 10)
    ask = round(ask, 10)
    bid_score = order_score(max_spread_cents, (midpoint - bid) * 100.0, size)
    ask_score = order_score(max_spread_cents, (ask - midpoint) * 100.0, size)
    if 0.10 <= midpoint <= 0.90:
        q_min = max(min(bid_score, ask_score), max(bid_score, ask_score) / 3.0)
    else:
        q_min = min(bid_score, ask_score)
    return {
        "yes_bid": bid,
        "no_bid": round(1.0 - ask, 10),
        "effective_yes_ask": ask,
        "size_each_side": size,
        "locked_capital_proxy": size * (bid + (1.0 - ask)),
        "q_min": q_min,
    }


def estimate_reward_range(
    daily_pool: float,
    hypothetical_score: float,
    competitor_lower: float,
    competitor_upper: float,
) -> tuple[float, float]:
    if daily_pool <= 0 or hypothetical_score <= 0:
        return 0.0, 0.0
    conservative = daily_pool * hypothetical_score / (hypothetical_score + competitor_upper)
    optimistic = daily_pool * hypothetical_score / (hypothetical_score + competitor_lower)
    return conservative, optimistic
