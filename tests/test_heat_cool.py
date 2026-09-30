"""Heat/cool (v2.4.0): both setpoints at once, the house drifting between them.

The thermostat here is a Honeywell T6 on an air-to-air heat pump with Auto
Changeover on and a 3°F Auto Differential, so every band GTTC writes must keep
that gap or the thermostat moves a setpoint by itself — which would then read
as someone at the wall.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from custom_components.gttc.const import (
    SEASON_COOLING,
    SEASON_HEAT_COOL,
    SEASON_HEATING,
)
from custom_components.gttc.coordinator import (
    RANGE_MISMATCH_GRACE,
    RANGE_WRITE_SETTLE,
    HVACAction,
    HVACMode,
)
from custom_components.gttc.models import ManualOverride, ScheduleEntry
from tests.test_physical_override import _make_coordinator

DAY = ScheduleEntry(time_start="06:00", time_end="17:59", target_temp=71.0, cooling_temp=74.0)
NIGHT = ScheduleEntry(time_start="00:00", time_end="05:59", target_temp=70.3, cooling_temp=71.0)


async def _noop():
    return None


def _coord(entry=DAY, indoor=72.0, outdoor=65.0, action=None):
    coord = _make_coordinator()
    coord.season = SEASON_HEAT_COOL
    coord.hvac_mode = HVACMode.HEAT_COOL
    coord.hvac_action = action
    coord.schedule_enabled = True
    coord.precondition_enabled = False
    coord.scheduler.get_current_entry = MagicMock(return_value=entry)
    coord.current_temp = indoor
    coord._outdoor_temp = outdoor
    coord.get_thermostat_hvac_modes = MagicMock(
        return_value=[HVACMode.HEAT, HVACMode.COOL, HVACMode.HEAT_COOL]
    )
    coord.async_request_refresh = MagicMock(side_effect=lambda: _noop())
    return coord


def _calls(coord, service):
    return [
        c.args[2] for c in coord.hass.services.async_call.call_args_list
        if c.args[1] == service
    ]


def _band_event(low, high, mode="heat_cool", old_mode="heat_cool"):
    new_state = MagicMock()
    new_state.state = mode
    new_state.attributes = {"temperature": None, "target_temp_low": low, "target_temp_high": high}
    old_state = MagicMock()
    old_state.state = old_mode
    event = MagicMock()
    event.data = {"new_state": new_state, "old_state": old_state}
    return event


async def _dispatch(coord, event):
    coord._handle_thermostat_state_event(event)
    for coro in coord._created_tasks:
        await coro
    coord._created_tasks.clear()


# ---------------------------------------------------------------------------
# Entering and leaving
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_refused_when_the_thermostat_has_no_heat_cool():
    coord = _coord()
    coord.season = SEASON_HEATING
    coord.hvac_mode = HVACMode.HEAT
    coord.get_thermostat_hvac_modes = MagicMock(return_value=[HVACMode.HEAT, HVACMode.COOL])

    await coord.async_set_season(SEASON_HEAT_COOL)

    assert coord.season == SEASON_HEATING
    assert _calls(coord, "set_hvac_mode") == []


@pytest.mark.asyncio
async def test_entering_sets_heat_cool_and_starts_both_clocks():
    coord = _coord()
    coord.season = SEASON_HEATING
    coord.hvac_mode = HVACMode.HEAT

    await coord.async_set_season(SEASON_HEAT_COOL)

    assert coord.season == SEASON_HEAT_COOL
    assert [c["hvac_mode"] for c in _calls(coord, "set_hvac_mode")] == [HVACMode.HEAT_COOL.value]
    assert coord._last_heat_call is not None and coord._last_cool_call is not None


@pytest.mark.asyncio
async def test_leaving_clears_the_band_and_hands_the_fan_back():
    coord = _coord()
    coord.target_low, coord.target_high = 71.0, 74.0
    coord._last_thermostat_range = (71.0, 74.0)
    coord._fan_precool_fan_on = True

    await coord.async_set_season(SEASON_COOLING)

    assert coord.target_low is None and coord.target_high is None
    assert coord._last_thermostat_range is None
    assert {"entity_id": "climate.test", "fan_mode": "Auto low"} in _calls(coord, "set_fan_mode")


# ---------------------------------------------------------------------------
# The band
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_band_comes_from_both_numbers_of_the_schedule_block():
    coord = _coord(DAY)
    await coord._update_heat_cool(None)

    assert (coord.target_low, coord.target_high) == (71.0, 74.0)
    assert _calls(coord, "set_temperature")[-1] == {
        "entity_id": "climate.test", "target_temp_low": 71.0, "target_temp_high": 74.0,
    }


@pytest.mark.asyncio
async def test_a_narrow_block_lowers_the_heat_end_to_keep_the_gap():
    """The night block is 70.3 / 71 — the T6 would push a setpoint itself."""
    coord = _coord(NIGHT)
    await coord._update_heat_cool(None)

    assert (coord.target_low, coord.target_high) == (68.0, 71.0)
    assert coord._gap_adjusted_from == 70.3
    written = _calls(coord, "set_temperature")[-1]
    assert written["target_temp_high"] - written["target_temp_low"] >= 3.0


@pytest.mark.asyncio
async def test_never_writes_a_band_into_another_mode():
    coord = _coord()
    coord.hvac_mode = HVACMode.OFF
    await coord._update_heat_cool(None)
    assert _calls(coord, "set_temperature") == []


@pytest.mark.asyncio
async def test_moving_up_widens_first_so_the_thermostat_never_sees_a_narrow_band():
    coord = _coord(DAY)
    coord._known_thermostat_range = (68.0, 71.0)

    await coord._set_thermostat_range(71.0, 74.0)

    writes = [(c["target_temp_low"], c["target_temp_high"]) for c in _calls(coord, "set_temperature")]
    assert writes == [(68.0, 74.0), (71.0, 74.0)]
    assert all(hi - lo >= 3.0 for lo, hi in writes)


@pytest.mark.asyncio
async def test_widening_alone_is_one_write():
    coord = _coord(DAY)
    coord._known_thermostat_range = (70.0, 73.0)
    await coord._set_thermostat_range(69.0, 74.0)
    assert len(_calls(coord, "set_temperature")) == 1


@pytest.mark.asyncio
async def test_a_small_drift_does_not_rewrite():
    coord = _coord(DAY)
    coord._last_thermostat_range = (71.0, 74.0)
    coord._range_write_at = datetime.now(timezone.utc) - timedelta(minutes=10)
    coord.hass.states.get.return_value = MagicMock(
        state="heat_cool", attributes={"target_temp_low": 71.0, "target_temp_high": 74.0}
    )
    await coord._update_heat_cool(None)
    assert _calls(coord, "set_temperature") == []


# ---------------------------------------------------------------------------
# The AC lockout
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cold_outside_parks_the_cool_end_and_circulates_a_warm_house():
    coord = _coord(DAY, indoor=75.0, outdoor=50.0)
    await coord._update_heat_cool(None)

    written = _calls(coord, "set_temperature")[-1]
    assert written["target_temp_high"] == 85.0
    assert written["target_temp_low"] == 71.0
    assert coord.cool_locked_out is True
    assert coord._last_action_reason == "cool_lockout"
    assert {"entity_id": "climate.test", "fan_mode": "on"} in _calls(coord, "set_fan_mode")


@pytest.mark.asyncio
async def test_lockout_lifts_when_it_warms_up():
    coord = _coord(DAY, indoor=72.0, outdoor=62.0)
    coord._fan_precool_fan_on = True
    await coord._update_heat_cool(None)
    assert coord.cool_locked_out is False
    assert _calls(coord, "set_temperature")[-1]["target_temp_high"] == 74.0
    assert {"entity_id": "climate.test", "fan_mode": "Auto low"} in _calls(coord, "set_fan_mode")


@pytest.mark.asyncio
async def test_a_comfortable_house_under_lockout_leaves_the_fan_alone():
    coord = _coord(DAY, indoor=72.0, outdoor=50.0)
    await coord._update_heat_cool(None)
    assert _calls(coord, "set_fan_mode") == []


# ---------------------------------------------------------------------------
# Wall changes
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_band_changed_at_the_wall_becomes_a_band_hold():
    coord = _coord()
    coord._known_thermostat_range = (71.0, 74.0)

    await _dispatch(coord, _band_event(72.0, 76.0))

    o = coord.manual_override
    assert o is not None and o.is_physical and o.is_range
    assert (o.target_low, o.target_high) == (72.0, 76.0)


@pytest.mark.asyncio
async def test_reports_while_our_band_write_settles_are_not_holds():
    coord = _coord()
    await coord._set_thermostat_range(71.0, 74.0)
    # The T6 briefly reports a pushed cool end while applying the two setpoints
    await _dispatch(coord, _band_event(71.0, 75.0))
    assert coord.manual_override is None


@pytest.mark.asyncio
async def test_a_stale_report_of_our_own_band_is_not_a_hold():
    coord = _coord()
    coord._note_own_write(68.0)
    coord._note_own_write(71.0)
    coord._known_thermostat_range = (71.0, 74.0)
    coord._range_write_at = datetime.now(timezone.utc) - RANGE_WRITE_SETTLE - timedelta(seconds=5)

    await _dispatch(coord, _band_event(68.0, 71.0))

    assert coord.manual_override is None


@pytest.mark.asyncio
async def test_entering_heat_cool_reports_stored_setpoints_without_a_hold():
    coord = _coord()
    coord._known_thermostat_range = (60.0, 80.0)
    await _dispatch(coord, _band_event(68.0, 78.0, old_mode="cool"))
    assert coord.manual_override is None


@pytest.mark.asyncio
async def test_a_band_the_thermostat_did_not_keep_is_written_again_after_the_grace():
    coord = _coord(DAY)
    coord._last_thermostat_range = (71.0, 74.0)
    coord._range_write_at = datetime.now(timezone.utc) - timedelta(minutes=10)
    coord.hass.states.get.return_value = MagicMock(
        state="heat_cool", attributes={"target_temp_low": 69.0, "target_temp_high": 74.0}
    )
    await coord._update_heat_cool(None)          # first sighting starts the grace
    assert _calls(coord, "set_temperature") == []
    coord._range_mismatch_since -= RANGE_MISMATCH_GRACE + timedelta(seconds=1)
    await coord._update_heat_cool(None)
    assert _calls(coord, "set_temperature")[-1]["target_temp_low"] == 71.0
    # ...and not again straight away, even once the write has settled
    coord._range_write_at = datetime.now(timezone.utc) - timedelta(minutes=2)
    coord._range_mismatch_since = datetime.now(timezone.utc) - RANGE_MISMATCH_GRACE * 2
    await coord._update_heat_cool(None)
    assert len(_calls(coord, "set_temperature")) == 1


# ---------------------------------------------------------------------------
# Holds, boosts, dashboards
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_dashboard_band_keeps_the_gap():
    coord = _coord()
    await coord.async_set_range(72.0, 73.0)
    o = coord.manual_override
    assert (o.target_low, o.target_high) == (70.0, 73.0)


@pytest.mark.asyncio
async def test_a_band_hold_drives_the_next_cycle_unchanged():
    coord = _coord(DAY)
    await coord.async_set_range(70.0, 75.0)
    await coord._update_heat_cool(None)
    assert (coord.target_low, coord.target_high) == (70.0, 75.0)


@pytest.mark.asyncio
async def test_one_number_in_heat_cool_recentres_the_band():
    coord = _coord()
    coord.target_low, coord.target_high = 71.0, 74.0
    await coord.async_set_temperature(73.5)
    o = coord.manual_override
    assert (o.target_low, o.target_high) == (72.0, 75.0)


@pytest.mark.asyncio
async def test_a_boost_shifts_the_whole_band():
    coord = _coord()
    coord.target_low, coord.target_high = 71.0, 74.0
    await coord.async_activate_timed_preset("cool_down")
    o = coord.manual_override
    assert (o.target_low, o.target_high) == (68.0, 71.0)
    assert o.duration_minutes == 60


@pytest.mark.asyncio
async def test_window_open_parks_both_ends():
    coord = _coord()
    coord.windows_open_override = True
    thermostat = MagicMock(state="heat_cool", attributes={"target_temp_low": 71.0, "target_temp_high": 74.0, "current_temperature": 72.0})
    coord.hass.states.get.side_effect = lambda eid: thermostat if eid == "climate.test" else None
    # HVACMode is a stub under test, so keep the mode rather than re-parse it
    coord._read_thermostat_state = lambda: None
    await coord._async_update_data()
    written = _calls(coord, "set_temperature")[-1]
    assert (written["target_temp_low"], written["target_temp_high"]) == (50.0, 90.0)


# ---------------------------------------------------------------------------
# The ladder
# ---------------------------------------------------------------------------

def test_cooling_demand_in_heat_season_points_at_heat_cool_with_the_ladder():
    coord = _coord(DAY, indoor=76.0)
    coord.season = SEASON_HEATING
    coord.heat_cool_ladder = True
    coord.auto_season_switch = False
    coord._update_season_recommendation()
    assert coord.recommended_season == SEASON_HEAT_COOL


def test_without_the_ladder_it_still_goes_straight_across():
    coord = _coord(DAY, indoor=76.0)
    coord.season = SEASON_HEATING
    coord.heat_cool_ladder = False
    coord.auto_season_switch = False
    coord._update_season_recommendation()
    assert coord.recommended_season == SEASON_COOLING


def test_heat_cool_leaves_for_heat_after_five_days_without_cooling():
    coord = _coord()
    now = datetime.now(timezone.utc)
    coord._last_heat_call = now - timedelta(hours=2)
    coord._last_cool_call = now - timedelta(days=5, hours=1)
    assert coord.recommended_season == SEASON_HEATING
    assert coord.suggest_season_switch is True


def test_heat_cool_stays_while_both_sides_still_run():
    coord = _coord()
    now = datetime.now(timezone.utc)
    coord._last_heat_call = now - timedelta(hours=2)
    coord._last_cool_call = now - timedelta(days=2)
    assert coord.recommended_season == SEASON_HEATING
    assert coord.suggest_season_switch is False


def test_heat_cool_stays_when_neither_side_has_run_for_days():
    coord = _coord()
    now = datetime.now(timezone.utc)
    coord._last_heat_call = now - timedelta(days=6)
    coord._last_cool_call = now - timedelta(days=9)
    assert coord.recommended_season is None
    assert coord.suggest_season_switch is False


def test_equipment_runs_are_counted_in_heat_cool():
    coord = _coord(action=HVACAction.COOLING)
    coord._last_cool_call = datetime.now(timezone.utc) - timedelta(days=3)
    coord._last_heat_call = datetime.now(timezone.utc) - timedelta(hours=1)
    coord.auto_season_switch = False
    coord._update_season_recommendation()
    assert datetime.now(timezone.utc) - coord._last_cool_call < timedelta(seconds=5)


def test_auto_switch_acts_on_the_ladder_target():
    coord = _coord()
    coord.auto_season_switch = True
    now = datetime.now(timezone.utc)
    coord._last_heat_call = now - timedelta(hours=1)
    coord._last_cool_call = now - timedelta(days=6)
    coord.async_set_season = MagicMock(side_effect=lambda s: _noop())
    coord._update_season_recommendation()
    assert len(coord._created_tasks) == 1
    coord._created_tasks[0].close()


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def test_settings_and_clocks_survive_a_restart():
    coord = _coord()
    coord.heat_cool_ladder = True
    coord.cool_lockout_temp = 52.0
    coord._last_cool_call = datetime(2026, 9, 28, 14, 0, tzinfo=timezone.utc)
    coord._last_heat_call = datetime(2026, 9, 29, 7, 0, tzinfo=timezone.utc)
    saved = {
        "season": coord.season,
        "heat_cool_ladder": coord.heat_cool_ladder,
        "cool_lockout_temp": coord.cool_lockout_temp,
        "heat_cool_settle_days": 5.0,
        "heat_cool_min_gap": 3.0,
        "last_heat_call": coord._last_heat_call.isoformat(),
        "last_cool_call": coord._last_cool_call.isoformat(),
    }
    fresh = _make_coordinator()
    fresh._load_stored_data(saved)
    assert fresh.season == SEASON_HEAT_COOL
    assert fresh.heat_cool_ladder is True and fresh.cool_lockout_temp == 52.0
    assert fresh._last_cool_call == coord._last_cool_call


def test_a_band_hold_round_trips():
    o = ManualOverride(target_temp=72.5, started_at=datetime.now(timezone.utc).isoformat(),
                       duration_minutes=120, target_low=71.0, target_high=74.0)
    back = ManualOverride.from_dict(o.to_dict())
    assert back.is_range and (back.target_low, back.target_high) == (71.0, 74.0)
