"""Holds and the zone offset during a hold."""
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

class TestAsyncSetTemperatureIntegration:
    """Integration tests: async_set_temperature with override tracking."""

    @pytest.mark.asyncio
    async def test_repeated_holds_never_rewrite_the_schedule(self):
        """Before v2.9.0 a third similar hold in one block rewrote the block,
        even with learning off. A hold is a hold; only an edit changes plans."""
        coord = _make_coordinator()
        coord.schedule_enabled = True
        coord.scheduler.enabled = True
        coord.scheduler.schedule.active_preset = None
        entry = ScheduleEntry("08:00", "18:00", 75.0)
        coord.scheduler.get_current_entry = MagicMock(return_value=entry)
        for _ in range(5):
            coord.manual_override = None
            await coord.async_set_temperature(70.0)
            assert coord.manual_override is not None
            assert coord.manual_override.target_temp == 70.0
        assert entry.target_temp == 75.0

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
