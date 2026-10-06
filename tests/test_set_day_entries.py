"""gttc/set_day_entries: replace whole days in one step."""
from __future__ import annotations

from custom_components.gttc.api import _replace_day_entries
from custom_components.gttc.scheduler import Scheduler

ALL = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
NIGHT = {"time_start": "19:00", "time_end": "06:00", "target_temp": 70.0, "cooling_temp": 70.0, "zone_id": "z2"}
DAY = {"time_start": "06:00", "time_end": "19:00", "target_temp": 72.0, "cooling_temp": 72.0, "zone_id": "z2"}


def test_replaces_every_named_day_of_a_preset():
    s = Scheduler(60, 80)
    assert _replace_day_entries(s, "home", ALL, [NIGHT, DAY]) is None
    for d in ALL:
        got = s.presets["home"].schedule[d].entries
        assert [(e.time_start, e.time_end, e.target_temp, e.cooling_temp, e.zone_id) for e in got] == [
            ("06:00", "19:00", 72.0, 72.0, "z2"), ("19:00", "06:00", 70.0, 70.0, "z2")]


def test_leaves_other_days_and_presets_alone():
    s = Scheduler(60, 80)
    before_sun = [e.to_dict() for e in s.presets["home"].schedule["sunday"].entries]
    before_away = [e.to_dict() for e in s.presets["away"].schedule["monday"].entries]
    _replace_day_entries(s, "home", ALL[:5], [DAY])
    assert [e.to_dict() for e in s.presets["home"].schedule["sunday"].entries] == before_sun
    assert [e.to_dict() for e in s.presets["away"].schedule["monday"].entries] == before_away


def test_bad_day_writes_nothing():
    s = Scheduler(60, 80)
    before = [e.to_dict() for e in s.presets["home"].schedule["monday"].entries]
    assert _replace_day_entries(s, "home", ["monday", "funday"], [DAY]) == "funday"
    assert [e.to_dict() for e in s.presets["home"].schedule["monday"].entries] == before


def test_days_are_independent_lists():
    s = Scheduler(60, 80)
    _replace_day_entries(s, "home", ALL, [DAY])
    s.presets["home"].schedule["monday"].entries.clear()
    assert len(s.presets["home"].schedule["tuesday"].entries) == 1
