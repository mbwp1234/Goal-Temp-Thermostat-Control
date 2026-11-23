"""Regressions from the evening of 2026-10-20.

Heat season all evening with upstairs 73.4–73.8° against a 71° cool goal; the
18:59 restart zeroed the 3h Heat→Cool countdown. (The ladder, the learning
switch and fan pre-cool these tests also covered were removed in v2.9.0.)
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from custom_components.gttc.const import SEASON_COOLING, SEASON_HEATING
from custom_components.gttc.coordinator import GTTCCoordinator
from custom_components.gttc.models import ScheduleEntry
from tests.test_physical_override import _make_coordinator

NIGHT = ScheduleEntry(time_start="19:00", time_end="06:00", target_temp=71.0, cooling_temp=71.0)


def _heated_house(hours=3.0):
    coord = _make_coordinator()
    coord.season = SEASON_HEATING
    coord.schedule_enabled = True
    coord.scheduler.get_current_entry = MagicMock(return_value=NIGHT)
    coord.seasonal_recommend_hours = hours
    coord.current_temp = 73.6
    coord._outdoor_temp = 56.0
    coord.hvac_action = None
    return coord


def test_heat_to_cool_keeps_the_full_threshold():
    coord = _heated_house()
    coord.auto_season_switch = False
    coord._update_season_recommendation()
    coord._cooling_conditions_since -= timedelta(minutes=31)
    assert coord.recommended_season == SEASON_COOLING
    assert coord.season_threshold_hours == 3.0
    assert not coord.suggest_season_switch


@pytest.mark.asyncio
async def test_the_countdown_survives_a_restart():
    coord = _heated_house()
    since = datetime.now(timezone.utc) - timedelta(hours=2)
    coord._cooling_conditions_since = since
    await GTTCCoordinator.async_save(coord)            # the real one; the factory mocks it
    saved = coord._store.async_save.call_args.args[0]
    fresh = _make_coordinator()
    fresh._load_stored_data(saved)
    # saved a moment ago, so the outage shift is (nearly) nothing
    assert abs((fresh._cooling_conditions_since - since).total_seconds()) < 5
