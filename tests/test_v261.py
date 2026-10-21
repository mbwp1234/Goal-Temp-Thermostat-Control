"""Regressions from the evening of 2026-10-20.

Heat season all evening with upstairs 73.4–73.8° against a 71° cool goal; the
18:59 restart zeroed the 3h Heat→Cool countdown and turned learning back on;
after a manual switch to Heat/Cool, fan pre-cool held the compressor off.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from custom_components.gttc.const import SEASON_COOLING, SEASON_HEAT_COOL, SEASON_HEATING
from custom_components.gttc.coordinator import GTTCCoordinator
from custom_components.gttc.models import ScheduleEntry
from tests.test_physical_override import _make_coordinator

NIGHT = ScheduleEntry(time_start="19:00", time_end="06:00", target_temp=71.0, cooling_temp=71.0)


def _heated_house(ladder=True, hours=3.0):
    coord = _make_coordinator()
    coord.season = SEASON_HEATING
    coord.schedule_enabled = True
    coord.scheduler.get_current_entry = MagicMock(return_value=NIGHT)
    coord.heat_cool_ladder = ladder
    coord.seasonal_recommend_hours = hours
    coord.current_temp = 73.6
    coord._outdoor_temp = 56.0
    coord.hvac_action = None
    return coord


def test_a_warm_heated_house_reaches_heat_cool_in_half_an_hour():
    coord = _heated_house()
    coord.auto_season_switch = False
    coord._update_season_recommendation()
    assert coord.recommended_season == SEASON_HEAT_COOL
    assert not coord.suggest_season_switch
    coord._cooling_conditions_since -= timedelta(minutes=31)
    assert coord.suggest_season_switch
    assert coord.season_threshold_hours == 0.5


def test_straight_to_cool_keeps_the_full_threshold():
    coord = _heated_house(ladder=False)
    coord.auto_season_switch = False
    coord._update_season_recommendation()
    coord._cooling_conditions_since -= timedelta(minutes=31)
    assert coord.recommended_season == SEASON_COOLING
    assert not coord.suggest_season_switch


@pytest.mark.asyncio
async def test_switch_flags_and_countdown_survive_a_restart():
    coord = _heated_house()
    coord.learning_enabled = False
    coord.occupancy_enabled = True
    coord.tou_enabled = True
    coord.precondition_enabled = False
    since = datetime.now(timezone.utc) - timedelta(hours=2)
    coord._cooling_conditions_since = since
    await GTTCCoordinator.async_save(coord)            # the real one; the factory mocks it
    saved = coord._store.async_save.call_args.args[0]

    fresh = _make_coordinator()
    assert fresh.learning_enabled is True              # the config-entry default
    fresh._load_stored_data(saved)
    assert fresh.learning_enabled is False
    assert fresh.occupancy_enabled is True
    assert fresh.tou_enabled is True
    assert fresh.precondition_enabled is False
    assert fresh._cooling_conditions_since == since


@pytest.mark.asyncio
async def test_fan_precool_never_inflates_or_runs_the_fan():
    coord = _heated_house()
    coord.season = SEASON_COOLING
    coord.current_temp = 74.0
    coord._outdoor_temp = 56.0
    t6 = MagicMock()
    t6.state = "cool"
    t6.attributes = {"fan_modes": ["Auto low", "Low", "Circulation"], "fan_mode": "Auto low"}
    coord.hass.states.get = MagicMock(side_effect=lambda e: t6 if e == "climate.test" else None)
    assert await coord._apply_fan_precool(71.0) == 71.0
    assert coord._fan_precool_fan_on is False
    assert coord._fan_precool_start_time is None
