import importlib.util
from pathlib import Path


path = Path(__file__).parents[1] / "scripts" / "pm-r26-historical-shadow-replay.py"
spec = importlib.util.spec_from_file_location("pm_r26", path)
mod = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(mod)


def test_best_bid_ask_replaces_stale_top_level() -> None:
    book = {
        "bids": [{"price": "0.40", "size": "10"}, {"price": "0.30", "size": "99"}],
        "asks": [{"price": "0.60", "size": "11"}, {"price": "0.70", "size": "88"}],
        "tick_size": "0.01",
        "timestamp": "1",
    }
    mod.apply_best_bid_ask(book, ["2", "0.35", "0.65", "0.30"])
    assert max(float(x["price"]) for x in book["bids"]) == 0.35
    assert min(float(x["price"]) for x in book["asks"]) == 0.65
    assert next(x for x in book["bids"] if float(x["price"]) == 0.35)["size"] == "10"
    assert next(x for x in book["asks"] if float(x["price"]) == 0.65)["size"] == "11"
