import json
from pathlib import Path


def test_measured_profile_does_not_promote_unknown_execution_parameters():
    path = Path(__file__).parents[1] / "config" / "dublin-measured-latency.json"
    profile = json.loads(path.read_text(encoding="utf-8"))
    assert profile["use"] == "transport_observation_only"
    for key in ("order_ack_ms", "cancel_ack_ms", "fill_report_ms",
                "partial_fill_probability", "hedge_completion_ms", "queue_ahead_factor"):
        assert profile["unmeasured"][key] is None
    assert profile["market_websocket_event_age_ms"]["p95"] == 38
