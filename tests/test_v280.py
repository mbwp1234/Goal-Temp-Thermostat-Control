"""v2.8.0: a year of runtime days, one row per date, a real daily outside average."""
from __future__ import annotations

from datetime import date, timedelta

from custom_components.gttc.const import RUNTIME_HISTORY_MAX_DAYS
from custom_components.gttc.coordinator import _merge_runtime_days
from tests.test_physical_override import _make_coordinator


def test_keeps_a_year():
    assert RUNTIME_HISTORY_MAX_DAYS >= 366


def test_duplicate_date_merges():
    # The live history held 2026-10-04 twice after a restart
    rows = [
        {"date": "2026-10-03", "heating_min": 0, "cooling_min": 329.5, "avg_outdoor": 54.32},
        {"date": "2026-10-04", "heating_min": 34, "cooling_min": 77.5, "avg_outdoor": 64.04},
        {"date": "2026-10-04", "heating_min": 0, "cooling_min": 112.5, "avg_outdoor": 63.5},
    ]
    out = _merge_runtime_days(rows)
    assert [r["date"] for r in out] == ["2026-10-03", "2026-10-04"]
    assert out[1]["heating_min"] == 34 and out[1]["cooling_min"] == 190
    assert out[1]["avg_outdoor"] == 63.77


def test_missing_outdoor_is_not_zero():
    out = _merge_runtime_days([{"date": "2026-01-01", "heating_min": 5, "cooling_min": 0, "avg_outdoor": None}])
    assert out[0]["avg_outdoor"] is None


def test_saved_day_carries_the_average_and_trims_to_cap():
    c = _make_coordinator()
    start = date(2025, 10, 1)
    c.runtime_history = [{"date": (start + timedelta(days=i)).isoformat(), "heating_min": 1, "cooling_min": 0, "avg_outdoor": 50}
                         for i in range(RUNTIME_HISTORY_MAX_DAYS)]
    c._today_heating_min, c._today_cooling_min = 90.0, 0.0
    c._today_outdoor_sum, c._today_outdoor_n = 40.0 + 50.0 + 60.0, 3
    c._outdoor_temp = 33.0
    c._save_daily_runtime("2026-12-31")
    assert len(c.runtime_history) == RUNTIME_HISTORY_MAX_DAYS
    assert c.runtime_history[-1] == {"date": "2026-12-31", "heating_min": 90.0, "cooling_min": 0.0, "avg_outdoor": 50.0}


def test_restart_keeps_todays_minutes():
    from datetime import datetime, timezone
    c = _make_coordinator()
    today = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d")
    c._restore_today_runtime({"date": today, "heating_min": 142.5, "cooling_min": 0, "outdoor_sum": 120.0, "outdoor_n": 2})
    assert c._today_date == today and c._today_heating_min == 142.5
    assert c.today_outdoor_avg() == 60.0


def test_day_that_ended_while_down_reaches_the_history():
    c = _make_coordinator()
    c.runtime_history = []
    c._restore_today_runtime({"date": "2026-01-02", "heating_min": 300, "cooling_min": 0, "outdoor_sum": 90.0, "outdoor_n": 3})
    assert c.runtime_history == [{"date": "2026-01-02", "heating_min": 300.0, "cooling_min": 0.0, "avg_outdoor": 30.0}]
    assert c._today_heating_min == 0.0 and c._today_date != "2026-01-02"


def test_bad_saved_day_is_ignored():
    c = _make_coordinator()
    c._restore_today_runtime({"date": "2026-01-02", "heating_min": "x"})
    c._restore_today_runtime(None)
    assert c._today_heating_min == 0.0
