"""Tests for repeated schedule override detection in GTTC coordinator."""
from __future__ import annotations

import pytest
from datetime import time
from unittest.mock import AsyncMock, MagicMock, patch

from custom_components.gttc.coordinator import GTTCCoordinator
from custom_components.gttc.models import DaySchedule, ScheduleEntry
from custom_components.gttc.scheduler import Scheduler


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_coordinator() -> GTTCCoordinator:
    """Build a coordinator with mocked HA dependencies."""
    hass = MagicMock()
    hass.states.get.return_value = None
    hass.services.async_call = AsyncMock()

    config_entry = MagicMock()
    config_entry.data = {
        "thermostat_entity": "climate.test",
        "temp_min": 50.0,
        "temp_max": 90.0,
        "learning_enabled": True,
        "learning_threshold": 3,
        "manual_override_minutes": 120,
    }
    config_entry.entry_id = "test_entry"

    with patch(
        "custom_components.gttc.coordinator.Store",
        return_value=MagicMock(async_load=AsyncMock(return_value=None), async_save=AsyncMock()),
    ):
        coord = GTTCCoordinator(hass, config_entry)

    # Stub async helpers that touch HA internals
    coord.async_save = AsyncMock()
    coord.async_set_updated_data = MagicMock()
    coord._available = True

    return coord


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestTrackScheduleOverride:
    """Tests for _track_schedule_override."""

    @pytest.mark.asyncio
    async def test_no_update_before_threshold(self):
        """Override count below threshold should NOT update schedule."""
        coord = _make_coordinator()
        # Activate home preset (has 74°F comfort entries)
        coord.scheduler.activate_preset("home")
        coord.schedule_enabled = True
        coord.scheduler.enabled = True

        # Patch get_current_entry to return a known entry
        entry = ScheduleEntry("08:00", "12:00", 75.0)
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        # First override — count goes to 1
        result = await coord._track_schedule_override(70.0)
        assert result is False
        assert coord._override_repeat_count == 1
        assert entry.target_temp == 75.0  # unchanged

        # Second override — count goes to 2
        result = await coord._track_schedule_override(70.0)
        assert result is False
        assert coord._override_repeat_count == 2
        assert entry.target_temp == 75.0  # still unchanged

    @pytest.mark.asyncio
    async def test_updates_schedule_at_threshold(self):
        """After threshold repeats the schedule entry should be updated."""
        coord = _make_coordinator()
        coord.schedule_enabled = True
        coord.scheduler.enabled = True
        # No active preset — direct entry update path
        coord.scheduler.schedule.active_preset = None

        entry = ScheduleEntry("08:00", "18:00", 75.0)
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        # Simulate 3 repeated overrides (threshold = 3)
        await coord._track_schedule_override(70.0)  # count 1
        await coord._track_schedule_override(70.0)  # count 2
        result = await coord._track_schedule_override(70.0)  # count 3 → update

        assert result is True
        assert entry.target_temp == 70.0
        assert coord.manual_override is None

    @pytest.mark.asyncio
    async def test_updates_preset_entry_at_threshold(self):
        """When a preset is active, the preset entry should be updated."""
        coord = _make_coordinator()
        coord.scheduler.activate_preset("home")
        coord.schedule_enabled = True
        coord.scheduler.enabled = True

        # The home preset has comfort=74 entries; patch the current entry lookup
        entry = ScheduleEntry("08:00", "12:00", 74.0)
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        # Also patch _update_preset_learned_temp to verify it's called
        coord._update_preset_learned_temp = MagicMock()

        await coord._track_schedule_override(70.0)  # 1
        await coord._track_schedule_override(70.0)  # 2
        result = await coord._track_schedule_override(70.0)  # 3 → update

        assert result is True
        coord._update_preset_learned_temp.assert_called_once()
        call_args = coord._update_preset_learned_temp.call_args
        assert call_args[0][0] == "home"  # preset name
        assert call_args[0][2] == 70.0    # new temperature

    @pytest.mark.asyncio
    async def test_resets_on_different_temperature(self):
        """Changing override temp should reset the counter."""
        coord = _make_coordinator()
        coord.schedule_enabled = True
        coord.scheduler.enabled = True
        coord.scheduler.schedule.active_preset = None

        entry = ScheduleEntry("08:00", "18:00", 75.0)
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        await coord._track_schedule_override(70.0)  # count 1
        await coord._track_schedule_override(70.0)  # count 2
        # Switch to a very different temperature
        await coord._track_schedule_override(65.0)  # resets to 1

        assert coord._override_repeat_count == 1
        assert coord._override_target_temp == 65.0
        assert entry.target_temp == 75.0  # unchanged

    @pytest.mark.asyncio
    async def test_resets_on_different_schedule_entry(self):
        """Moving to a different schedule entry should reset the counter."""
        coord = _make_coordinator()
        coord.schedule_enabled = True
        coord.scheduler.enabled = True
        coord.scheduler.schedule.active_preset = None

        entry1 = ScheduleEntry("08:00", "12:00", 75.0)
        entry2 = ScheduleEntry("12:00", "17:00", 75.0)

        coord.scheduler.get_current_entry = MagicMock(return_value=entry1)
        await coord._track_schedule_override(70.0)  # count 1
        await coord._track_schedule_override(70.0)  # count 2

        # Switch to different schedule entry
        coord.scheduler.get_current_entry = MagicMock(return_value=entry2)
        await coord._track_schedule_override(70.0)  # resets to 1

        assert coord._override_repeat_count == 1
        assert entry1.target_temp == 75.0  # unchanged
        assert entry2.target_temp == 75.0  # unchanged

    @pytest.mark.asyncio
    async def test_no_update_when_schedule_disabled(self):
        """Should return False when schedule is disabled."""
        coord = _make_coordinator()
        coord.schedule_enabled = False

        result = await coord._track_schedule_override(70.0)
        assert result is False
        assert coord._override_repeat_count == 0

    @pytest.mark.asyncio
    async def test_no_update_when_temp_difference_small(self):
        """Should not update if override temp is close to schedule temp."""
        coord = _make_coordinator()
        coord.schedule_enabled = True
        coord.scheduler.enabled = True
        coord.scheduler.schedule.active_preset = None

        # Schedule says 70.5, user wants 70.0 — only 0.5° difference
        entry = ScheduleEntry("08:00", "18:00", 70.5)
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        await coord._track_schedule_override(70.0)
        await coord._track_schedule_override(70.0)
        result = await coord._track_schedule_override(70.0)

        # Threshold reached but diff < 1.0° — no update
        assert result is False
        assert entry.target_temp == 70.5


class TestAsyncSetTemperatureIntegration:
    """Integration tests: async_set_temperature with override tracking."""

    @pytest.mark.asyncio
    async def test_schedule_updated_skips_override(self):
        """When schedule is updated, manual override should NOT be created."""
        coord = _make_coordinator()
        coord.schedule_enabled = True
        coord.scheduler.enabled = True
        coord.scheduler.schedule.active_preset = None

        entry = ScheduleEntry("08:00", "18:00", 75.0)
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        # Drive to threshold
        await coord.async_set_temperature(70.0)  # 1
        await coord.async_set_temperature(70.0)  # 2
        await coord.async_set_temperature(70.0)  # 3 → schedule updated

        # Schedule should now be 70
        assert entry.target_temp == 70.0
        # No manual override should be active
        assert coord.manual_override is None

    @pytest.mark.asyncio
    async def test_normal_override_before_threshold(self):
        """Before threshold, normal manual override should be created."""
        coord = _make_coordinator()
        coord.schedule_enabled = True
        coord.scheduler.enabled = True
        coord.scheduler.schedule.active_preset = None

        entry = ScheduleEntry("08:00", "18:00", 75.0)
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)

        await coord.async_set_temperature(70.0)  # 1st override

        assert coord.manual_override is not None
        assert coord.manual_override.target_temp == 70.0
        assert entry.target_temp == 75.0  # schedule unchanged


class TestCalculateThermostatTargetOverride:
    """Tests for offset skipping during a manual override."""

    def test_override_skips_offset(self):
        """During an active override the thermostat target must equal the
        override temp exactly — no sensor-offset inflation."""
        from custom_components.gttc.models import ManualOverride
        from datetime import datetime, timezone

        coord = _make_coordinator()

        # Simulate: zone reads 70.7, T6 reads 72 → offset = +1.3
        active_zone = MagicMock()
        active_zone.current_temp = 70.7
        coord._get_thermostat_current_temp = MagicMock(return_value=72.0)

        # Set an active override at 70°F
        coord.manual_override = ManualOverride(
            target_temp=70.0,
            started_at=datetime.now(timezone.utc).isoformat(),
            duration_minutes=30,
            zone_id=None,
        )

        result = coord._calculate_thermostat_target(70.0, active_zone)

        # Should be exactly 70, not 70 + 1.3 = 71.3
        assert result == 70.0

    def test_no_override_applies_offset(self):
        """Without an override the offset correction should still be applied."""
        coord = _make_coordinator()

        active_zone = MagicMock()
        active_zone.current_temp = 70.7
        coord._get_thermostat_current_temp = MagicMock(return_value=72.0)
        coord.manual_override = None

        result = coord._calculate_thermostat_target(70.0, active_zone)

        # offset = 72 - 70.7 = 1.3 → adjusted = 71.3, clamped within range
        assert result is not None
        assert result > 70.0


class TestEntryMidpointMinutes:
    """Tests for _entry_midpoint_minutes helper."""

    def test_normal_entry(self):
        entry = ScheduleEntry("08:00", "12:00", 70.0)
        # midpoint of 480..720 = 600 minutes = 10:00
        assert GTTCCoordinator._entry_midpoint_minutes(entry) == 600

    def test_overnight_entry(self):
        entry = ScheduleEntry("22:00", "06:00", 68.0)
        # 22:00=1320, 06:00=360 → end adjusted to 1800
        # midpoint = (1320 + 1800) // 2 = 1560 → 1560 % 1440 = 120 = 02:00
        assert GTTCCoordinator._entry_midpoint_minutes(entry) == 120
