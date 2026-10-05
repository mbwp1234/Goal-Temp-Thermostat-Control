"""v2.4.2: cool when asked, and cool the zone that is actually hot.

10/3 evening: 54.7° outside, a full house. The 55° lockout parked the cool
end at 85 from 15:42; a 67–71 hold at 19:16 started the AC and GTTC parked it
again 30 s later. The evening blocks watch the 2nd Floor (71.8°, at goal)
while the 1st floor sat at 73.8° and the wall at 76°, so even the lockout's
fan never ran.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from custom_components.gttc.const import (
    DEFAULT_COOL_LOCKOUT_TEMP,
    SEASON_HEAT_COOL,
    WARM_ZONE_MINUTES,
)
from custom_components.gttc.models import ScheduleEntry, Zone
from tests.test_heat_cool import _calls, _coord
from tests.test_physical_override import _make_coordinator

EVENING = ScheduleEntry(time_start="18:00", time_end="19:59", target_temp=68.0,
                        cooling_temp=72.0, zone_id="up")


def _house(coord, up=71.8, down=73.8, wall=76.0):
    coord.zone_manager.zones = {
        "down": Zone(id="down", name="1st floor", current_temp=down),
        "up": Zone(id="up", name="2nd Floor", current_temp=up),
    }
    coord.zone_manager.set_active_zone("up")
    coord.current_temp = up
    coord._get_thermostat_current_temp = MagicMock(return_value=wall)
    return coord.zone_manager.zones["up"]


# ---------------------------------------------------------------------------
# The lockout
# ---------------------------------------------------------------------------

def test_default_lockout_is_50():
    assert DEFAULT_COOL_LOCKOUT_TEMP == 50.0


@pytest.mark.asyncio
async def test_54_outside_is_not_locked_out():
    coord = _coord(EVENING, outdoor=54.7)
    await coord._update_heat_cool(None)
    assert coord.cool_locked_out is False


@pytest.mark.asyncio
async def test_a_band_hold_cools_on_a_cold_night():
    """The 19:16 hold: 67–71 must reach the wall and stay there."""
    coord = _coord(EVENING, indoor=74.0, outdoor=45.0)
    await coord.async_set_range(67.0, 71.0)
    await coord._update_heat_cool(None)
    written = _calls(coord, "set_temperature")[-1]
    assert written["target_temp_high"] == 71.0
    assert coord.cool_locked_out is False
    assert coord._last_action_reason != "cool_lockout"


@pytest.mark.asyncio
async def test_a_boost_cools_on_a_cold_night():
    coord = _coord(EVENING, indoor=74.0, outdoor=40.0)
    coord.target_low, coord.target_high = 68.0, 72.0
    await coord.async_activate_timed_preset("cool_down")
    await coord._update_heat_cool(None)
    assert _calls(coord, "set_temperature")[-1]["target_temp_high"] < 85.0
    assert coord.cool_locked_out is False


@pytest.mark.asyncio
async def test_lockout_fan_follows_the_warmest_zone():
    coord = _coord(EVENING, outdoor=45.0)
    up = _house(coord)
    await coord._update_heat_cool(up)
    assert coord.cool_locked_out is True
    assert {"entity_id": "climate.test", "fan_mode": "Low"} in _calls(coord, "set_fan_mode")


def test_untouched_old_default_moves_to_the_new_one():
    fresh = _make_coordinator()
    fresh._load_stored_data({"season": SEASON_HEAT_COOL, "cool_lockout_temp": 55.0})
    assert fresh.cool_lockout_temp == 50.0


def test_a_chosen_lockout_is_kept():
    fresh = _make_coordinator()
    fresh._load_stored_data({"cool_lockout_temp": 52.0})
    assert fresh.cool_lockout_temp == 52.0
    fresh = _make_coordinator()
    fresh._load_stored_data({"cool_lockout_temp": 55.0, "cool_lockout_rev": 2})
    assert fresh.cool_lockout_temp == 55.0


# ---------------------------------------------------------------------------
# The warm zone
# ---------------------------------------------------------------------------

def _age(coord):
    coord._warm_zone_since = datetime.now(timezone.utc) - timedelta(minutes=WARM_ZONE_MINUTES + 1)


@pytest.mark.asyncio
async def test_a_warm_zone_waits_before_it_takes_over():
    coord = _coord(EVENING, outdoor=54.7)
    up = _house(coord)
    await coord._update_heat_cool(up)
    assert coord.warm_zone is None
    assert coord._warm_zone_since is not None


@pytest.mark.asyncio
async def test_a_warm_zone_is_cooled_against_after_ten_minutes():
    coord = _coord(EVENING, outdoor=54.7)
    up = _house(coord)
    await coord._update_heat_cool(up)
    _age(coord)
    await coord._update_heat_cool(up)
    assert coord.warm_zone.name == "1st floor"
    assert coord._last_action_reason == "warm_zone"
    written = _calls(coord, "set_temperature")[-1]
    # 72 goal + (76 wall − 73.8 downstairs) — the wall at 76 calls for cooling
    assert written["target_temp_high"] == pytest.approx(74.2, abs=0.05)
    assert written["target_temp_high"] - written["target_temp_low"] >= coord.heat_cool_min_gap
    assert coord._fan_precool_start_time is None      # no fan-only trial first


@pytest.mark.asyncio
async def test_the_warm_zone_lets_go_near_the_goal():
    coord = _coord(EVENING, outdoor=54.7)
    up = _house(coord)
    await coord._update_heat_cool(up)
    _age(coord)
    await coord._update_heat_cool(up)
    coord.zone_manager.zones["down"].current_temp = 73.0     # still over clear
    await coord._update_heat_cool(up)
    assert coord.warm_zone is not None
    coord.zone_manager.zones["down"].current_temp = 72.4     # within 0.5
    await coord._update_heat_cool(up)
    assert coord.warm_zone is None


@pytest.mark.asyncio
async def test_never_chills_the_watched_zone_to_its_heat_goal():
    coord = _coord(EVENING, outdoor=54.7)
    up = _house(coord, up=67.9, down=74.5)      # nursery floor at its 68 heat goal
    await coord._update_heat_cool(up)
    _age(coord)
    await coord._update_heat_cool(up)
    assert coord.warm_zone is None


@pytest.mark.asyncio
async def test_a_warm_watched_zone_is_ordinary_cooling():
    coord = _coord(EVENING, outdoor=54.7)
    up = _house(coord, up=74.5, down=72.0)
    await coord._update_heat_cool(up)
    _age(coord)
    await coord._update_heat_cool(up)
    assert coord.warm_zone is None


@pytest.mark.asyncio
async def test_below_the_lockout_a_warm_zone_does_not_start_the_ac():
    coord = _coord(EVENING, outdoor=45.0)
    up = _house(coord)
    await coord._update_heat_cool(up)
    _age(coord)
    await coord._update_heat_cool(up)
    assert coord.cool_locked_out is True
    assert _calls(coord, "set_temperature")[-1]["target_temp_high"] == 85.0


# ---------------------------------------------------------------------------
# Overheat lifts the lockout (a party, the oven)
# ---------------------------------------------------------------------------

def _age_over(coord):
    coord._overheat_since = datetime.now(timezone.utc) - timedelta(minutes=WARM_ZONE_MINUTES + 1)


@pytest.mark.asyncio
async def test_49_outside_and_76_inside_runs_the_ac():
    coord = _coord(EVENING, outdoor=49.0)
    up = _house(coord, up=76.0, down=74.0, wall=76.0)
    await coord._update_heat_cool(up)
    assert coord.cool_locked_out is True          # not yet — ten minutes first
    _age_over(coord)
    await coord._update_heat_cool(up)
    assert coord.cool_locked_out is False
    assert coord.overheat_active is True
    assert coord._last_action_reason == "overheat"
    assert _calls(coord, "set_temperature")[-1]["target_temp_high"] < 85.0


@pytest.mark.asyncio
async def test_overheat_in_an_unwatched_zone_lifts_the_lockout():
    coord = _coord(EVENING, outdoor=45.0)
    up = _house(coord, up=72.0, down=75.5, wall=77.0)
    await coord._update_heat_cool(up)
    _age_over(coord)
    await coord._update_heat_cool(up)
    assert coord.overheat_active is True
    # cools against downstairs: 72 + (77 − 75.5)
    assert _calls(coord, "set_temperature")[-1]["target_temp_high"] == pytest.approx(73.5, abs=0.05)


@pytest.mark.asyncio
async def test_overheat_hands_back_to_the_lockout_near_the_goal():
    coord = _coord(EVENING, outdoor=45.0)
    up = _house(coord, up=76.0, down=74.0)
    await coord._update_heat_cool(up)
    _age_over(coord)
    await coord._update_heat_cool(up)
    for z in coord.zone_manager.zones.values():
        z.current_temp = 72.3
    coord.current_temp = 72.3
    await coord._update_heat_cool(up)
    assert coord.overheat_active is False
    assert coord.cool_locked_out is True
    assert _calls(coord, "set_temperature")[-1]["target_temp_high"] == 85.0


@pytest.mark.asyncio
async def test_two_degrees_over_on_a_cold_night_is_still_fan_only():
    coord = _coord(EVENING, outdoor=45.0)
    up = _house(coord, up=74.0, down=73.0)
    await coord._update_heat_cool(up)
    _age_over(coord)
    await coord._update_heat_cool(up)
    assert coord.cool_locked_out is True


@pytest.mark.asyncio
async def test_below_the_hard_floor_only_a_hold_cools():
    coord = _coord(EVENING, outdoor=38.0)
    up = _house(coord, up=78.0, down=78.0)
    await coord._update_heat_cool(up)
    _age_over(coord)
    await coord._update_heat_cool(up)
    assert coord.cool_locked_out is True
    await coord.async_set_range(68.0, 72.0)
    await coord._update_heat_cool(up)
    assert _calls(coord, "set_temperature")[-1]["target_temp_high"] == 72.0
