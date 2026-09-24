"""effective_temp on climate.gttc must match what the coordinator actually aims for."""
from __future__ import annotations

from unittest.mock import MagicMock

from custom_components.gttc.const import BOOST_TYPES
from custom_components.gttc.models import ScheduleEntry
from tests.test_schedule_override import _make_coordinator


def _with_entry(entry: ScheduleEntry, season: str):
    coord = _make_coordinator()
    coord.season = season
    coord.cooling_comfort = 72.0
    coord.schedule_enabled = True
    coord.scheduler.get_current_entry = MagicMock(return_value=entry)
    return coord


def test_cooling_without_cooling_temp_uses_cooling_comfort():
    coord = _with_entry(ScheduleEntry(time_start="06:00", time_end="17:59", target_temp=68.0), "cooling")
    assert coord._get_current_schedule_info()["effective_temp"] == 72.0


def test_cooling_with_cooling_temp_uses_it():
    entry = ScheduleEntry(time_start="06:00", time_end="17:59", target_temp=68.0, cooling_temp=74.0)
    coord = _with_entry(entry, "cooling")
    assert coord._get_current_schedule_info()["effective_temp"] == 74.0


def test_heating_uses_target_temp():
    entry = ScheduleEntry(time_start="06:00", time_end="17:59", target_temp=68.0, cooling_temp=74.0)
    coord = _with_entry(entry, "heating")
    assert coord._get_current_schedule_info()["effective_temp"] == 68.0


def test_cooling_boosts_lower_the_setpoint():
    assert BOOST_TYPES["max_cool"]["delta"] < 0
    assert BOOST_TYPES["cool_down"]["delta"] < 0
