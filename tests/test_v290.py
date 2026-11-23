"""v2.9.0 — kind to the heat pump, quiet on restart, nothing unused.

From the 2026-11-22 audit:
 - 22:18 restart wrote 70.8 → 70 → 69 → 70 → 71.8 in 50 s: the zone offset
   lived only in memory, so the first writes were the bare goal.
 - 06:00 on 11/21 the wall went 72.2 → 74.4 in one write on a heat pump whose
   T6 brings in the electric strips on a big jump.
 - a restored season countdown counted the time HA was down.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from custom_components.gttc.const import (
    BOOST_TYPES,
    HEAT_PUMP_RAMP_INTERVAL_MIN,
    HEAT_PUMP_RAMP_STEP,
    PRESETS,
    SEASON_HEATING,
    STARTUP_WRITE_GRACE_MIN,
)
from custom_components.gttc.coordinator import GTTCCoordinator, HVACMode
from custom_components.gttc.models import ScheduleEntry
from custom_components.gttc.scheduler import Scheduler
from tests.test_physical_override import _make_coordinator

DAY = ScheduleEntry(time_start="06:00", time_end="19:00", target_temp=72.0, cooling_temp=72.0)


def _calls(coord, service):
    return [c.args[2] for c in coord.hass.services.async_call.call_args_list if c.args[1] == service]


def _heat_pump(coord, wall=72.0):
    coord._is_heat_pump = True
    coord._detect_heat_pump = MagicMock(return_value=True)
    coord._get_thermostat_current_temp = MagicMock(return_value=wall)
    coord.hvac_mode = HVACMode.HEAT
    return coord


# ---------------------------------------------------------------- the ramp
def test_a_big_rise_goes_in_half_degree_steps_from_the_wall_reading():
    coord = _heat_pump(_make_coordinator(), wall=72.0)
    # night setpoint 70.8 on the wall, the room at 72, day wants 74.4
    assert coord._ramp_heat_setpoint(74.4, 70.8) == 72.0 + HEAT_PUMP_RAMP_STEP


def test_the_next_step_waits_for_the_interval():
    coord = _heat_pump(_make_coordinator(), wall=72.0)
    coord._last_heat_raise_at = datetime.now(timezone.utc) - timedelta(minutes=HEAT_PUMP_RAMP_INTERVAL_MIN - 1)
    assert coord._ramp_heat_setpoint(74.4, 72.5) == 72.5          # hold
    coord._last_heat_raise_at -= timedelta(minutes=2)
    assert coord._ramp_heat_setpoint(74.4, 72.5) == 73.0          # next step


def test_small_rises_and_any_fall_pass_straight_through():
    coord = _heat_pump(_make_coordinator(), wall=72.0)
    coord._last_heat_raise_at = datetime.now(timezone.utc)
    assert coord._ramp_heat_setpoint(72.4, 72.1) == 72.4
    assert coord._ramp_heat_setpoint(69.0, 73.4) == 69.0


def test_no_ramp_without_a_heat_pump_or_a_previous_write():
    coord = _heat_pump(_make_coordinator())
    assert coord._ramp_heat_setpoint(75.0, None) == 75.0
    coord._is_heat_pump = False
    coord._detect_heat_pump = MagicMock(return_value=False)
    assert coord._ramp_heat_setpoint(75.0, 70.0) == 75.0


@pytest.mark.asyncio
async def test_the_cycle_steps_the_6am_change_and_marks_why():
    coord = _heat_pump(_make_coordinator(), wall=72.0)
    coord.season = SEASON_HEATING
    coord.schedule_enabled = True
    coord.scheduler.get_current_entry = MagicMock(return_value=DAY)
    coord._last_thermostat_temp = 70.8
    coord._startup_ready = True
    coord._calculate_thermostat_target = MagicMock(return_value=74.4)
    t6 = MagicMock(state="heat", attributes={"temperature": 70.8, "current_temperature": 72.0})
    coord.hass.states.get = MagicMock(side_effect=lambda e: t6 if e == "climate.test" else None)
    coord._read_thermostat_state = lambda: None
    coord._update_runtime_tracking = MagicMock(side_effect=lambda: _noop())
    await coord._async_update_data()
    assert _calls(coord, "set_temperature")[-1]["temperature"] == 72.5
    assert coord._last_action_reason == "heat_pump_step"
    assert coord._last_heat_raise_at is not None


@pytest.mark.asyncio
async def test_a_hold_is_not_ramped():
    from custom_components.gttc.models import ManualOverride
    coord = _heat_pump(_make_coordinator(), wall=70.0)
    coord.season = SEASON_HEATING
    coord.manual_override = ManualOverride(
        target_temp=73.0, started_at=datetime.now(timezone.utc).isoformat(), duration_minutes=60
    )
    coord._last_thermostat_temp = 70.0
    coord._startup_ready = True
    t6 = MagicMock(state="heat", attributes={"temperature": 70.0, "current_temperature": 70.0})
    coord.hass.states.get = MagicMock(side_effect=lambda e: t6 if e == "climate.test" else None)
    coord._read_thermostat_state = lambda: None
    coord._update_runtime_tracking = MagicMock(side_effect=lambda: _noop())
    await coord._async_update_data()
    assert _calls(coord, "set_temperature")[-1]["temperature"] == 73.0


async def _noop():
    return None


# ---------------------------------------------------------------- startup
def test_nothing_is_written_until_the_zone_reads():
    coord = _make_coordinator()
    zone = MagicMock(id="z2", current_temp=None)
    assert coord._ready_to_write(zone) is False
    zone.current_temp = 70.2
    assert coord._ready_to_write(zone) is True


def test_a_saved_offset_lets_it_write_before_the_zone_reads():
    coord = _make_coordinator()
    coord._restore_offsets({"z2": [1.8, datetime.now(timezone.utc).isoformat()]})
    assert coord._ready_to_write(MagicMock(id="z2", current_temp=None)) is True


def test_a_dead_zone_sensor_cannot_freeze_control():
    coord = _make_coordinator()
    coord._started_at -= timedelta(minutes=STARTUP_WRITE_GRACE_MIN + 1)
    assert coord._ready_to_write(MagicMock(id="z2", current_temp=None)) is True


def test_opening_the_gate_takes_what_the_wall_holds_as_the_last_write():
    coord = _make_coordinator()
    t6 = MagicMock(state="heat", attributes={"temperature": 71.8})
    coord.hass.states.get = MagicMock(side_effect=lambda e: t6 if e == "climate.test" else None)
    assert coord._ready_to_write(MagicMock(id="z2", current_temp=70.2))
    assert coord._last_thermostat_temp == 71.8


@pytest.mark.asyncio
async def test_the_offset_survives_a_restart():
    coord = _make_coordinator()
    at = datetime.now(timezone.utc)
    coord._offset_filter = {"z2": (1.83, at)}
    await GTTCCoordinator.async_save(coord)
    saved = coord._store.async_save.call_args.args[0]
    fresh = _make_coordinator()
    fresh._load_stored_data(saved)
    value, when = fresh._offset_filter["z2"]
    assert value == pytest.approx(1.83) and when == at
    # no zone reading yet: it steers by the saved offset, not the bare goal
    fresh._get_thermostat_current_temp = MagicMock(return_value=None)
    assert fresh._calculate_thermostat_target(70.0, MagicMock(id="z2", current_temp=None)) == pytest.approx(71.83, abs=0.01)


# ---------------------------------------------------------------- outages
def test_an_outage_does_not_count_toward_a_season_switch():
    coord = _make_coordinator()
    now = datetime.now(timezone.utc)
    saved = {
        "cooling_conditions_since": (now - timedelta(hours=5)).isoformat(),   # 1h in, then 4h down
        "last_heat_call": (now - timedelta(hours=4, minutes=10)).isoformat(),
        "saved_at": (now - timedelta(hours=4)).isoformat(),
    }
    coord._load_stored_data(saved)
    elapsed = now - coord._cooling_conditions_since
    assert timedelta(minutes=59) < elapsed < timedelta(minutes=61)
    assert now - coord._last_heat_call < timedelta(minutes=11)


def test_no_saved_at_leaves_the_clocks_alone():
    coord = _make_coordinator()
    since = datetime.now(timezone.utc) - timedelta(hours=2)
    coord._load_stored_data({"cooling_conditions_since": since.isoformat()})
    assert coord._cooling_conditions_since == since


# ---------------------------------------------------------------- the rest
def test_heat_boosts_are_small():
    assert BOOST_TYPES["boost"]["delta"] == 2.0
    assert BOOST_TYPES["warm_up"]["delta"] == 1.0


def test_work_from_home_is_gone_and_a_running_one_hands_over_to_home():
    assert "work_from_home" not in PRESETS
    s = Scheduler(50, 90)
    assert "work_from_home" not in s.presets
    data = s.save()
    data["presets"]["work_from_home"] = data["presets"]["home"]
    data["schedule"]["active_preset"] = "work_from_home"
    s2 = Scheduler(50, 90)
    s2.load(data)
    assert "work_from_home" not in s2.presets
    assert s2.schedule.active_preset == "home"


def test_removed_features_leave_no_attributes():
    coord = _make_coordinator()
    for name in ("learning", "learning_enabled", "occupancy_enabled", "tou_enabled",
                 "tou_provider", "precondition_enabled", "heat_cool_ladder", "ramp_history"):
        assert not hasattr(coord, name), name
