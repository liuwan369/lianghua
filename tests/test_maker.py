import unittest

from pm_maker.scoring import (
    adjusted_midpoint,
    aggregate_side_scores,
    competitor_score_bounds,
    estimate_reward_range,
    hypothetical_quote,
    official_aggregate_scores,
    order_score,
)


class MakerScreenTests(unittest.TestCase):
    def setUp(self):
        self.book = {
            "bids": [
                {"price": "0.40", "size": "100"},
                {"price": "0.49", "size": "100"},
                {"price": "0.48", "size": "200"},
            ],
            "asks": [
                {"price": "0.60", "size": "100"},
                {"price": "0.51", "size": "100"},
                {"price": "0.52", "size": "200"},
            ],
            "tick_size": "0.01",
        }

    def test_quadratic_score(self):
        self.assertAlmostEqual(order_score(3.0, 1.0, 100.0), 44.4444444444)
        self.assertEqual(order_score(3.0, 4.0, 100.0), 0.0)

    def test_midpoint_sorts_api_levels_internally(self):
        self.assertEqual(adjusted_midpoint(self.book, 100.0), (0.49, 0.51, 0.5))

    def test_aggregate_score_ignores_levels_outside_max_spread(self):
        bid, ask = aggregate_side_scores(self.book, 0.5, 3.0)
        expected = order_score(3.0, 1.0, 100.0) + order_score(3.0, 2.0, 200.0)
        self.assertAlmostEqual(bid, expected)
        self.assertAlmostEqual(ask, expected)

    def test_aggregate_score_excludes_levels_below_minimum_size(self):
        bid, ask = aggregate_side_scores(self.book, 0.5, 3.0, minimum_size=150.0)
        expected = order_score(3.0, 2.0, 200.0)
        self.assertAlmostEqual(bid, expected)
        self.assertAlmostEqual(ask, expected)

    def test_official_score_uses_both_token_books(self):
        complement = {
            "bids": [{"price": "0.49", "size": "300"}],
            "asks": [{"price": "0.51", "size": "400"}],
        }
        q_one, q_two = official_aggregate_scores(
            self.book, complement, 0.5, 3.0, minimum_size=0.0
        )
        market_side = order_score(3.0, 1.0, 100.0) + order_score(3.0, 2.0, 200.0)
        self.assertAlmostEqual(q_one, market_side + order_score(3.0, 1.0, 400.0))
        self.assertAlmostEqual(q_two, market_side + order_score(3.0, 1.0, 300.0))

    def test_competitor_bounds_are_ordered(self):
        lower, upper = competitor_score_bounds(300.0, 100.0, 0.5)
        self.assertAlmostEqual(lower, 100.0)
        self.assertAlmostEqual(upper, 100.0 + 200.0 / 3.0)

    def test_quote_uses_complementary_yes_and_no_bids(self):
        quote = hypothetical_quote(0.45, 0.55, 0.01, 0.5, 6.0, 20.0)
        self.assertEqual(quote["yes_bid"], 0.46)
        self.assertEqual(quote["no_bid"], 0.46)
        self.assertAlmostEqual(quote["locked_capital_proxy"], 18.4)

    def test_reward_range_is_conservative_first(self):
        low, high = estimate_reward_range(100.0, 10.0, 90.0, 190.0)
        self.assertAlmostEqual(low, 5.0)
        self.assertAlmostEqual(high, 10.0)

if __name__ == "__main__":
    unittest.main()
