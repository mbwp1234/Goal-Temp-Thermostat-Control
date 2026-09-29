"""Regressions from the night of 2026-09-28/29.

01:57 the auto season switch flipped a 71.7° house to heat because a 66.6°
night was 3° cooler than indoors, and the thermostat's stored 75° heat
setpoint — reported back with the mode change — was taken for a wall override
and held for two hours. Upstairs reached 76.3°.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from custom_components.gttc.const import SEASON_COOLING, SEASON_HEATING
from custom_components.gttc.coordinator import PHYSICAL_MODE_SETTLE
from custom_components.gttc.models import ScheduleEntry
from tests.test_physical_override import _dispatch, _make_coordinator


def _state_event(mode: str, temperature: float, old_mode: str) -> MagicMock:
    new_state = MagicMock()
    new_state.state = mode
    new_state.attributes = {"temperature": temperature}
    old_state = MagicMock()
    old_state.state = old_mode
    event = MagicMock()
    event.data = {"new_state": new_state, "old_state": old_state}
    return event


async def _dispatch_event(coord, event) -> None:
    coord._handle_thermostat_state_event(event)
    for coro in coord._created_tasks:
        await coro
    coord._created_tasks.clear()


# ---------------------------------------------------------------------------
# Mode change must not create a phantom physical override
# ---------------------------------------------------------------------------

class TestModeChangeIsNotAnOverride:

    @pytest.mark.asyncio
    async def test_stored_setpoint_arriving_with_mode_change_is_ignored(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 69.3

        await _dispatch_event(coord, _state_event("heat", 75.0, "cool"))

        assert coord.manual_override is None
        # Reseeded, so the next real change compares against 75
        assert coord._known_thermostat_setpoint == 75.0

    @pytest.mark.asyncio
    async def test_setpoint_just_after_gttc_mode_change_is_ignored(self):
        """Z-Wave may report the stored setpoint in a later event."""
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 69.3
        await coord.async_set_hvac_mode(MagicMock(value="heat"))

        await _dispatch(coord, 75.0)

        assert coord.manual_override is None

    @pytest.mark.asyncio
    async def test_wall_change_after_settle_is_still_an_override(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 69.0
        coord._mode_changed_at = (
            datetime.now(timezone.utc) - PHYSICAL_MODE_SETTLE - timedelta(seconds=1)
        )

        await _dispatch(coord, 72.0)

        assert coord.manual_override is not None
        assert coord.manual_override.target_temp == 72.0

    @pytest.mark.asyncio
    async def test_same_mode_setpoint_change_is_still_an_override(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 71.0

        await _dispatch_event(coord, _state_event("cool", 74.0, "cool"))

        assert coord.manual_override is not None


# ---------------------------------------------------------------------------
# Season recommendation must be demand-based
# ---------------------------------------------------------------------------

NIGHT = ScheduleEntry(
    time_start="00:00", time_end="05:59", target_temp=69.0, cooling_temp=71.0
)


def _season_coord(season: str, indoor: float, outdoor: float):
    coord = _make_coordinator()
    coord.season = season
    coord.schedule_enabled = True
    coord.scheduler.get_current_entry = MagicMock(return_value=NIGHT)
    coord.current_temp = indoor
    coord._outdoor_temp = outdoor
    coord.auto_season_switch = False
    return coord


def test_cool_night_with_warm_house_is_not_heating_weather():
    """The exact 01:57 reading: 71.7° inside, 66.6° out, AC running."""
    coord = _season_coord(SEASON_COOLING, indoor=71.7, outdoor=66.56)
    coord._update_season_recommendation()
    assert coord._heating_conditions_since is None


def test_cold_house_on_a_cold_night_is_heating_weather():
    coord = _season_coord(SEASON_COOLING, indoor=67.0, outdoor=50.0)
    coord._update_season_recommendation()
    assert coord._heating_conditions_since is not None


def test_heating_conditions_reset_once_the_house_warms():
    coord = _season_coord(SEASON_COOLING, indoor=67.0, outdoor=50.0)
    coord._update_season_recommendation()
    coord.current_temp = 70.0
    coord._update_season_recommendation()
    assert coord._heating_conditions_since is None


def test_warm_afternoon_with_comfortable_house_is_not_cooling_weather():
    coord = _season_coord(SEASON_HEATING, indoor=70.0, outdoor=78.0)
    coord._update_season_recommendation()
    assert coord._cooling_conditions_since is None


def test_hot_house_on_a_hot_day_is_cooling_weather():
    coord = _season_coord(SEASON_HEATING, indoor=75.5, outdoor=85.0)
    coord._update_season_recommendation()
    assert coord._cooling_conditions_since is not None


def test_auto_switch_does_not_fire_on_last_nights_readings():
    coord = _season_coord(SEASON_COOLING, indoor=71.7, outdoor=66.56)
    coord.auto_season_switch = True
    coord.seasonal_recommend_hours = 3.0
    coord._update_season_recommendation()
    # Even an old countdown can't carry it over: the condition resets it
    coord._heating_conditions_since = datetime.now(timezone.utc) - timedelta(hours=4)
    coord._update_season_recommendation()
    assert coord._created_tasks == []
    assert coord.suggest_season_switch is False
