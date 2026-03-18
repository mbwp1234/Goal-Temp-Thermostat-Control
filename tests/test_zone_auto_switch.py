"""Tests for automatic zone switching based on schedule entry zone_id."""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from custom_components.gttc.coordinator import GTTCCoordinator
from custom_components.gttc.models import (
    DaySchedule,
    ManualOverride,
    ScheduleEntry,
    Zone,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_coordinator() -> GTTCCoordinator:
    """Build a coordinator with mocked HA dependencies."""
    hass = MagicMock()
    # Thermostat is available
    thermostat_state = MagicMock()
    thermostat_state.state = "heat"
    thermostat_state.attributes = {
        "current_temperature": 70.0,
        "hvac_action": "heating",
        "supported_features": 0,
        "hvac_modes": ["off", "heat"],
        "min_temp": 50.0,
        "max_temp": 90.0,
    }
    hass.states.get.return_value = thermostat_state
    hass.services.async_call = AsyncMock()

    config_entry = MagicMock()
    config_entry.data = {
        "thermostat_entity": "climate.test",
        "temp_min": 50.0,
        "temp_max": 90.0,
        "learning_enabled": False,
        "manual_override_minutes": 120,
    }
    config_entry.entry_id = "test_entry"

    with patch(
        "custom_components.gttc.coordinator.Store",
        return_value=MagicMock(
            async_load=AsyncMock(return_value=None),
            async_save=AsyncMock(),
        ),
    ):
        coord = GTTCCoordinator(hass, config_entry)

    # The mocked DataUpdateCoordinator.__init__ doesn't set self.hass
    coord.hass = hass

    # Stub async helpers that touch HA internals
    coord.async_save = AsyncMock()
    coord.async_set_updated_data = MagicMock()
    coord._available = True

    return coord


def _add_zones(coord: GTTCCoordinator) -> tuple[str, str]:
    """Add two zones (1st floor, 2nd floor) and return their IDs."""
    zone1 = Zone(id="floor1", name="1st Floor", sensor_entities=[])
    zone2 = Zone(id="floor2", name="2nd Floor", sensor_entities=[])
    zone1.current_temp = 71.0
    zone2.current_temp = 69.0
    coord.zone_manager.zones["floor1"] = zone1
    coord.zone_manager.zones["floor2"] = zone2
    coord.zone_manager._active_zone_id = "floor1"
    return "floor1", "floor2"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestZoneAutoSwitch:
    """Tests for automatic zone switching in _async_update_data."""

    @pytest.mark.asyncio
    async def test_switches_zone_when_entry_has_zone_id(self):
        """Active zone should switch when schedule entry specifies a different zone."""
        coord = _make_coordinator()
        floor1, floor2 = _add_zones(coord)
        coord.schedule_enabled = True
        coord.scheduler.enabled = True

        # Schedule entry says use floor2
        entry = ScheduleEntry("22:00", "06:00", 68.0, zone_id="floor2")
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        assert coord.zone_manager.active_zone_id == "floor1"

        await coord._async_update_data()

        assert coord.zone_manager.active_zone_id == "floor2"

    @pytest.mark.asyncio
    async def test_no_switch_when_already_on_correct_zone(self):
        """Should not switch when already on the zone specified by the entry."""
        coord = _make_coordinator()
        floor1, floor2 = _add_zones(coord)
        coord.schedule_enabled = True
        coord.scheduler.enabled = True

        entry = ScheduleEntry("06:00", "22:00", 72.0, zone_id="floor1")
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        await coord._async_update_data()

        assert coord.zone_manager.active_zone_id == "floor1"

    @pytest.mark.asyncio
    async def test_no_switch_when_entry_has_no_zone_id(self):
        """Should not switch when schedule entry has no zone_id."""
        coord = _make_coordinator()
        floor1, floor2 = _add_zones(coord)
        coord.schedule_enabled = True
        coord.scheduler.enabled = True

        entry = ScheduleEntry("06:00", "22:00", 72.0)
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        await coord._async_update_data()

        assert coord.zone_manager.active_zone_id == "floor1"

    @pytest.mark.asyncio
    async def test_no_switch_when_schedule_disabled(self):
        """Should not switch zones when schedule is disabled."""
        coord = _make_coordinator()
        floor1, floor2 = _add_zones(coord)
        coord.schedule_enabled = False
        coord.scheduler.enabled = False

        entry = ScheduleEntry("22:00", "06:00", 68.0, zone_id="floor2")
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        await coord._async_update_data()

        assert coord.zone_manager.active_zone_id == "floor1"

    @pytest.mark.asyncio
    async def test_no_switch_during_manual_override(self):
        """Should not switch zones when a manual override is active."""
        coord = _make_coordinator()
        floor1, floor2 = _add_zones(coord)
        coord.schedule_enabled = True
        coord.scheduler.enabled = True

        # Active manual override
        coord.manual_override = ManualOverride(
            target_temp=72.0,
            started_at="2099-01-01T00:00:00+00:00",
            duration_minutes=120,
        )

        entry = ScheduleEntry("22:00", "06:00", 68.0, zone_id="floor2")
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        await coord._async_update_data()

        assert coord.zone_manager.active_zone_id == "floor1"

    @pytest.mark.asyncio
    async def test_no_switch_to_unknown_zone(self):
        """Should not switch if entry's zone_id doesn't exist."""
        coord = _make_coordinator()
        floor1, floor2 = _add_zones(coord)
        coord.schedule_enabled = True
        coord.scheduler.enabled = True

        entry = ScheduleEntry("22:00", "06:00", 68.0, zone_id="nonexistent")
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        await coord._async_update_data()

        assert coord.zone_manager.active_zone_id == "floor1"

    @pytest.mark.asyncio
    async def test_current_temp_updated_after_zone_switch(self):
        """After switching zones, current_temp should reflect the new zone."""
        coord = _make_coordinator()
        floor1, floor2 = _add_zones(coord)
        coord.schedule_enabled = True
        coord.scheduler.enabled = True

        entry = ScheduleEntry("22:00", "06:00", 68.0, zone_id="floor2")
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        await coord._async_update_data()

        assert coord.zone_manager.active_zone_id == "floor2"
        # current_temp should be floor2's temp (69.0)
        assert coord.current_temp == 69.0
