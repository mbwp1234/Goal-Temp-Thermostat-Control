"""Findings from the 2026-09-29 season audit (v2.3.2).

Replaying 9/24–29 against v2.3.1 showed it could no longer switch to cooling
at all: every one of Brian's six manual switches to cool had outdoor COOLER
than indoor (a heated house at 74–76° with the heat idle). The rest are the
edges around a switch: open windows, holds that outlive their season, a mode
changed at the wall, and a stale echo of GTTC's own write.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from custom_components.gttc.const import SEASON_COOLING, SEASON_HEATING
from custom_components.gttc.coordinator import HVACAction, HVACMode
from custom_components.gttc.models import ManualOverride, ScheduleEntry
from tests.test_physical_override import _dispatch, _make_coordinator
from tests.test_season_switch_fixes import _dispatch_event, _state_event

EVENING = ScheduleEntry(
    time_start="18:00", time_end="20:00", target_temp=69.0, cooling_temp=71.0
)


def _coord(season: str, indoor: float, outdoor: float, action=None):
    coord = _make_coordinator()
    coord.season = season
    coord.schedule_enabled = True
    coord.scheduler.get_current_entry = MagicMock(return_value=EVENING)
    coord.current_temp = indoor
    coord._outdoor_temp = outdoor
    coord.hvac_action = action
    coord.auto_season_switch = False
    return coord


# ---------------------------------------------------------------------------
# 1. Heat → cool is decided by the house, not the weather
# ---------------------------------------------------------------------------

def test_hot_house_on_a_cooler_evening_is_cooling_weather():
    """9/29 19:03: 75.4° inside in heat mode, 70.3° out. Brian switched by hand."""
    coord = _coord(SEASON_HEATING, indoor=75.4, outdoor=70.34)
    coord._update_season_recommendation()
    assert coord._cooling_conditions_since is not None


def test_house_just_past_cool_goal_is_not_cooling_weather():
    coord = _coord(SEASON_HEATING, indoor=71.8, outdoor=80.0)  # goal 71 + 1 margin
    coord._update_season_recommendation()
    assert coord._cooling_conditions_since is None


def test_running_heat_blocks_the_cooling_count():
    coord = _coord(SEASON_HEATING, indoor=75.0, outdoor=60.0, action=HVACAction.HEATING)
    coord._update_season_recommendation()
    assert coord._cooling_conditions_since is None


# ---------------------------------------------------------------------------
# 2. Cool → heat needs a margin and an idle AC
# ---------------------------------------------------------------------------

def test_ac_overshoot_just_under_heat_goal_is_not_heating_weather():
    coord = _coord(SEASON_COOLING, indoor=68.5, outdoor=55.0)  # goal 69 - 1 margin
    coord._update_season_recommendation()
    assert coord._heating_conditions_since is None


def test_running_ac_blocks_the_heating_count():
    coord = _coord(SEASON_COOLING, indoor=66.0, outdoor=50.0, action=HVACAction.COOLING)
    coord._update_season_recommendation()
    assert coord._heating_conditions_since is None


def test_cold_house_cold_night_ac_idle_is_heating_weather():
    coord = _coord(SEASON_COOLING, indoor=66.0, outdoor=50.0, action=HVACAction.IDLE)
    coord._update_season_recommendation()
    assert coord._heating_conditions_since is not None


# ---------------------------------------------------------------------------
# 3. An open window resets the countdown
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_open_window_resets_a_running_countdown():
    """9/25 15:23–17:11 showed "Cooling Recommended" for hours nobody checked."""
    coord = _coord(SEASON_HEATING, indoor=75.0, outdoor=75.0)
    coord._cooling_conditions_since = datetime.now(timezone.utc) - timedelta(hours=4)
    coord.windows_open_override = True
    thermostat = MagicMock(state="heat", attributes={"temperature": 70.0, "current_temperature": 75.0})
    coord.hass.states.get.side_effect = lambda eid: thermostat if eid == "climate.test" else None

    await coord._async_update_data()

    assert coord._cooling_conditions_since is None
    assert coord.suggest_season_switch is False


# ---------------------------------------------------------------------------
# 4. A season switch cancels holds and boosts
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_season_switch_cancels_a_boost_from_the_old_season():
    coord = _coord(SEASON_COOLING, indoor=72.0, outdoor=60.0)
    coord.async_request_refresh = MagicMock(side_effect=lambda: _noop())
    coord.manual_override = ManualOverride(
        target_temp=70.0,
        started_at=datetime.now(timezone.utc).isoformat(),
        duration_minutes=90,
    )

    await coord.async_set_season(SEASON_HEATING)

    assert coord.manual_override is None


@pytest.mark.asyncio
async def test_reselecting_the_same_season_keeps_the_hold():
    coord = _coord(SEASON_COOLING, indoor=72.0, outdoor=60.0)
    coord.async_request_refresh = MagicMock(side_effect=lambda: _noop())
    coord.manual_override = ManualOverride(
        target_temp=70.0,
        started_at=datetime.now(timezone.utc).isoformat(),
        duration_minutes=90,
    )

    await coord.async_set_season(SEASON_COOLING)

    assert coord.manual_override is not None


async def _noop():
    return None


# ---------------------------------------------------------------------------
# 5. A heat/cool change at the wall becomes the season
# ---------------------------------------------------------------------------

def _wall_coord(season: str):
    coord = _make_coordinator()
    coord.season = season
    coord.async_request_refresh = MagicMock(side_effect=lambda: _noop())
    coord._known_thermostat_setpoint = 71.0
    return coord


@pytest.mark.asyncio
async def test_wall_switch_to_cool_adopts_cooling_without_rewriting_the_mode():
    coord = _wall_coord(SEASON_HEATING)
    # Armed so the mode write WOULD happen if the wall path asked for it
    coord.hvac_mode = HVACMode.HEAT
    coord.get_thermostat_hvac_modes = MagicMock(return_value=[HVACMode.HEAT, HVACMode.COOL])

    await _dispatch_event(coord, _state_event("cool", 74.0, "heat"))

    assert coord.season == SEASON_COOLING
    assert coord.manual_override is None
    mode_calls = [
        c for c in coord.hass.services.async_call.call_args_list
        if c.args[1] == "set_hvac_mode"
    ]
    assert mode_calls == []
    assert coord._last_thermostat_temp is None  # next cycle pushes the cool target


@pytest.mark.asyncio
async def test_thermostat_turned_on_at_the_wall_in_the_other_mode_is_adopted():
    coord = _wall_coord(SEASON_HEATING)
    await _dispatch_event(coord, _state_event("cool", 74.0, "off"))
    assert coord.season == SEASON_COOLING


@pytest.mark.asyncio
async def test_gttcs_own_mode_change_is_not_adopted_back():
    coord = _wall_coord(SEASON_COOLING)
    await coord.async_set_hvac_mode(MagicMock(value="cool"))
    # A late report of the old mode must not flip the season back
    await _dispatch_event(coord, _state_event("heat", 68.0, "cool"))
    assert coord.season == SEASON_COOLING


@pytest.mark.asyncio
async def test_reconnect_reporting_a_mode_is_not_a_wall_change():
    coord = _wall_coord(SEASON_HEATING)
    await _dispatch_event(coord, _state_event("cool", 74.0, "unavailable"))
    assert coord.season == SEASON_HEATING


@pytest.mark.asyncio
async def test_heat_cool_at_the_wall_leaves_the_season_alone():
    coord = _wall_coord(SEASON_HEATING)
    await _dispatch_event(coord, _state_event("heat_cool", 71.0, "heat"))
    assert coord.season == SEASON_HEATING


# ---------------------------------------------------------------------------
# 6. A stale re-report of an older GTTC write is not a wall change
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_stale_report_of_an_earlier_write_is_not_an_override():
    """9/28: wrote 71.1 at 22:44, 69.7 at 22:52; the T6 said 71.1 at 22:53."""
    coord = _make_coordinator()
    coord._note_own_write(71.1)
    coord._recent_writes[-1] = (71.1, datetime.now(timezone.utc) - timedelta(minutes=8, seconds=30))
    coord._pending_write_until = datetime.now(timezone.utc) - timedelta(minutes=7)
    coord._note_own_write(69.7)

    await _dispatch(coord, 71.1)

    assert coord.manual_override is None


@pytest.mark.asyncio
async def test_a_nudge_near_an_earlier_write_is_still_an_override():
    coord = _make_coordinator()
    coord._note_own_write(71.1)
    coord._recent_writes[-1] = (71.1, datetime.now(timezone.utc) - timedelta(minutes=8))
    coord._note_own_write(69.7)

    await _dispatch(coord, 72.0)

    assert coord.manual_override is not None
    assert coord.manual_override.target_temp == 72.0


@pytest.mark.asyncio
async def test_writes_older_than_the_stale_window_do_not_mask_a_change():
    coord = _make_coordinator()
    coord._note_own_write(71.1)
    coord._recent_writes[-1] = (71.1, datetime.now(timezone.utc) - timedelta(minutes=20))
    coord._note_own_write(69.7)

    await _dispatch(coord, 71.1)

    assert coord.manual_override is not None
