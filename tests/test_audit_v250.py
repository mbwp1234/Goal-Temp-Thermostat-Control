"""v2.5.0 audit fixes, each pinned to the failure the simulator found.

Simulated against 10 days of this house's recorder data and 8 representative
central-Virginia weeks; see the PR for the numbers.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from custom_components.gttc.models import DaySchedule, ScheduleEntry, Zone
from custom_components.gttc.scheduler import Scheduler
from tests.test_heat_cool import _calls, _coord
from tests.test_physical_override import _make_coordinator


def _t6(coord, **attrs):
    t6 = MagicMock()
    t6.state = attrs.pop("state", "cool")
    t6.attributes = {"fan_modes": ["Auto low", "Low", "Circulation"], "fan_mode": "Auto low", **attrs}
    others = {}
    coord.hass.states.get = MagicMock(side_effect=lambda e: t6 if e == "climate.test" else others.get(e))
    return t6, others


# --------------------------------------------------------------------------- fan
@pytest.mark.asyncio
async def test_fan_uses_the_thermostats_own_continuous_mode():
    coord = _coord()
    _t6(coord)
    assert await coord._fan_run() is True
    assert _calls(coord, "set_fan_mode")[-1]["fan_mode"] == "Low"


@pytest.mark.asyncio
async def test_fan_is_handed_back_as_it_was():
    coord = _coord()
    t6, _ = _t6(coord, fan_mode="Circulation")
    await coord._fan_run()
    t6.attributes["fan_mode"] = "Low"
    await coord._fan_release()
    assert _calls(coord, "set_fan_mode")[-1]["fan_mode"] == "Circulation"


@pytest.mark.asyncio
async def test_fan_changed_by_someone_else_is_left_alone():
    coord = _coord()
    t6, _ = _t6(coord)
    await coord._fan_run()
    t6.attributes["fan_mode"] = "Circulation"     # a vacuum sweep took it
    n = len(_calls(coord, "set_fan_mode"))
    await coord._fan_release()
    assert len(_calls(coord, "set_fan_mode")) == n


@pytest.mark.asyncio
async def test_no_fan_mode_means_no_precool_hold_off():
    coord = _coord()
    _t6(coord, fan_modes=["Auto"])
    coord.season = "cooling"
    coord.current_temp = 75.0
    coord._outdoor_temp = 60.0
    assert await coord._apply_fan_precool(72.0) == 72.0


# --------------------------------------------------------------------------- offset
def test_integer_flicker_does_not_move_the_offset_a_degree():
    coord = _make_coordinator()
    zone = Zone(id="z", name="up", current_temp=72.0)
    t6, _ = _t6(coord, current_temperature=73.0)
    t0 = datetime.now(timezone.utc)
    coord._offset_filter["z"] = (1.5, t0 - timedelta(seconds=30))
    first = coord._zone_offset(zone)
    t6.attributes["current_temperature"] = 74.0
    coord._offset_filter["z"] = (first, datetime.now(timezone.utc) - timedelta(seconds=30))
    second = coord._zone_offset(zone)
    assert abs(second - first) < 0.1


def test_a_lost_zone_keeps_its_offset():
    coord = _make_coordinator()
    _t6(coord, current_temperature=72.0)
    coord._offset_filter["z"] = (2.5, datetime.now(timezone.utc))
    assert coord._zone_offset(Zone(id="z", name="up", current_temp=None)) == pytest.approx(2.5, abs=0.05)


def test_temp_max_bounds_the_goal_not_the_wall_target():
    coord = _make_coordinator()
    coord.temp_min, coord.temp_max = 65.0, 75.0
    _t6(coord, current_temperature=76.0)
    zone = Zone(id="z", name="up", current_temp=73.0)
    assert coord._calculate_thermostat_target(74.0, zone) == pytest.approx(77.0)


# --------------------------------------------------------------------------- schedule
def test_a_block_ending_at_59_covers_its_last_minute():
    s = Scheduler()
    day = DaySchedule(entries=[ScheduleEntry(time_start="06:00", time_end="17:59", target_temp=71),
                               ScheduleEntry(time_start="18:00", time_end="23:59", target_temp=70)])
    assert s._find_entry_for_time(day, time(17, 59, 30)).target_temp == 71
    assert s._find_entry_for_time(day, time(23, 59, 30)).target_temp == 70


# --------------------------------------------------------------------------- outdoor
def test_a_dropped_outdoor_sensor_keeps_its_last_reading():
    coord = _make_coordinator()
    coord.outdoor_temp_sensor = "sensor.out"
    st = MagicMock(); st.state = "44.0"
    coord.hass.states.get = MagicMock(return_value=st)
    assert coord._read_outdoor_temp() == 44.0
    st.state = "unavailable"
    assert coord._read_outdoor_temp() == 44.0
    coord._outdoor_last = (44.0, datetime.now(timezone.utc) - timedelta(hours=4))
    assert coord._read_outdoor_temp() is None


# --------------------------------------------------------------------------- doors
def test_a_brief_door_does_not_park_the_hvac():
    coord = _make_coordinator()
    coord.window_sensors = ["binary_sensor.back_door"]
    st = MagicMock(); st.state = "on"
    coord.hass.states.get = MagicMock(return_value=st)
    assert coord._are_windows_open() is False
    coord._window_open_since = datetime.now(timezone.utc) - timedelta(minutes=3)
    assert coord._are_windows_open() is True


# --------------------------------------------------------------------------- alerts
@pytest.mark.asyncio
async def test_a_heat_pump_holding_temperature_is_not_a_failure():
    coord = _coord()
    _t6(coord, state="heat", current_temperature=70.0, temperature=70.0)
    from custom_components.gttc.coordinator import HVACAction, HVACMode
    coord.hvac_mode = HVACMode.HEAT
    coord.hvac_action = HVACAction.HEATING
    coord._hvac_run_start = datetime.now(timezone.utc) - timedelta(minutes=90)
    coord._hvac_run_start_temp = 70.0
    await coord._update_runtime_tracking()
    assert not any(c.args[0] == "notify" for c in coord.hass.services.async_call.call_args_list)


@pytest.mark.asyncio
async def test_a_real_shortfall_alerts_once():
    from custom_components.gttc.coordinator import HVACAction, HVACMode
    coord = _coord(outdoor=40.0)
    _t6(coord, state="heat", current_temperature=66.0, temperature=70.0)
    coord.hvac_mode = HVACMode.HEAT
    coord.hvac_action = HVACAction.HEATING
    for _ in range(2):
        coord._hvac_run_start = datetime.now(timezone.utc) - timedelta(minutes=60)
        coord._hvac_run_start_temp = 66.0
        await coord._update_runtime_tracking()
    notes = [c for c in coord.hass.services.async_call.call_args_list if c.args[0] == "notify"]
    assert len(notes) == 1
