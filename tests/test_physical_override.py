"""Tests for physical (at-the-wall) thermostat override detection."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.gttc.const import (
    ACTION_REASON_OVERRIDE,
    ACTION_REASON_PHYSICAL_OVERRIDE,
    OVERRIDE_SOURCE_MANUAL,
    OVERRIDE_SOURCE_PHYSICAL,
)
from custom_components.gttc.coordinator import PHYSICAL_ECHO_WINDOW, GTTCCoordinator
from custom_components.gttc.models import ManualOverride


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
        return_value=MagicMock(
            async_load=AsyncMock(return_value=None), async_save=AsyncMock()
        ),
    ):
        coord = GTTCCoordinator(hass, config_entry)

    # The stubbed DataUpdateCoordinator base doesn't assign self.hass
    coord.hass = hass
    coord.async_save = AsyncMock()
    coord.async_set_updated_data = MagicMock()
    coord._available = True

    # Run tasks created by the callback synchronously so assertions can be
    # made immediately after the event is dispatched.
    coord._created_tasks = []
    hass.async_create_task = lambda coro: coord._created_tasks.append(coro)

    return coord


def _event(temperature: float | None) -> MagicMock:
    """Build a state_changed event carrying a thermostat setpoint."""
    new_state = MagicMock()
    new_state.attributes = {"temperature": temperature}
    event = MagicMock()
    event.data = {"new_state": new_state}
    return event


async def _dispatch(coord: GTTCCoordinator, temperature: float | None) -> None:
    """Fire a state change event and await any resulting task."""
    coord._handle_thermostat_state_event(_event(temperature))
    for coro in coord._created_tasks:
        await coro
    coord._created_tasks.clear()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestPhysicalOverrideDetection:
    """A setpoint change GTTC didn't make becomes a manual override."""

    @pytest.mark.asyncio
    async def test_wall_change_creates_override(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await _dispatch(coord, 72.0)

        assert coord.manual_override is not None
        assert coord.manual_override.target_temp == 72.0
        assert coord.manual_override.duration_minutes == 120
        assert coord.target_temp == 72.0
        # Thermostat is already at 72 — no redundant write
        coord.hass.services.async_call.assert_not_called()

    @pytest.mark.asyncio
    async def test_override_is_logged_with_physical_reason(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await _dispatch(coord, 72.0)

        assert coord.action_log[-1]["reason"] == ACTION_REASON_PHYSICAL_OVERRIDE
        assert coord.action_log[-1]["target_temp"] == 72.0

    @pytest.mark.asyncio
    async def test_last_thermostat_temp_tracks_override(self):
        """The next update cycle must not fight the physical setpoint."""
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0
        coord._last_thermostat_temp = 68.0

        await _dispatch(coord, 72.0)

        # Offset is skipped during an override, so target == 72 == last write
        assert coord._last_thermostat_temp == 72.0
        assert coord._calculate_thermostat_target(72.0, MagicMock()) == 72.0

    @pytest.mark.asyncio
    async def test_first_reading_does_not_create_override(self):
        """No baseline yet (fresh restart) — nothing to compare against."""
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = None

        await _dispatch(coord, 72.0)

        assert coord.manual_override is None
        assert coord._known_thermostat_setpoint == 72.0

    @pytest.mark.asyncio
    async def test_sub_threshold_change_ignored(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await _dispatch(coord, 68.2)

        assert coord.manual_override is None

    @pytest.mark.asyncio
    async def test_missing_temperature_attribute_ignored(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await _dispatch(coord, None)

        assert coord.manual_override is None
        assert coord._known_thermostat_setpoint == 68.0

    @pytest.mark.asyncio
    async def test_out_of_range_setpoint_is_clamped_and_written_back(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await _dispatch(coord, 95.0)  # temp_max is 90

        assert coord.manual_override.target_temp == 90.0
        coord.hass.services.async_call.assert_called_once()


class TestEchoSuppression:
    """GTTC's own writes echo back and must not self-trigger an override."""

    @pytest.mark.asyncio
    async def test_own_write_echo_ignored(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await coord._set_thermostat_temp(72.0)
        coord.hass.services.async_call.reset_mock()
        # Thermostat echoes the new setpoint back
        await _dispatch(coord, 72.0)

        assert coord.manual_override is None

    @pytest.mark.asyncio
    async def test_rounded_echo_ignored(self):
        """Z-Wave thermostats round the setpoint they report back."""
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await coord._set_thermostat_temp(71.6)
        await _dispatch(coord, 72.0)  # within PHYSICAL_ECHO_TOLERANCE of 71.6

        assert coord.manual_override is None

    @pytest.mark.asyncio
    async def test_change_after_echo_window_creates_override(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await coord._set_thermostat_temp(72.0)
        # Age the write past the echo window
        coord._pending_write_until = (
            datetime.now(timezone.utc) - timedelta(seconds=1)
        )

        await _dispatch(coord, 76.0)

        assert coord.manual_override is not None
        assert coord.manual_override.target_temp == 76.0

    @pytest.mark.asyncio
    async def test_wall_change_inside_echo_window_still_detected(self):
        """A value we didn't write is an override even during the echo window."""
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await coord._set_thermostat_temp(70.0)
        # User immediately spins the wall dial to 76
        await _dispatch(coord, 76.0)

        assert coord.manual_override is not None
        assert coord.manual_override.target_temp == 76.0

    @pytest.mark.asyncio
    async def test_echo_window_constant_is_sane(self):
        assert timedelta(seconds=30) < PHYSICAL_ECHO_WINDOW <= timedelta(minutes=5)


class TestOverrideSource:
    """The source flag must survive for the override's whole life."""

    @pytest.mark.asyncio
    async def test_physical_override_is_tagged(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await _dispatch(coord, 72.0)

        assert coord.manual_override.source == OVERRIDE_SOURCE_PHYSICAL
        assert coord.manual_override.is_physical is True

    @pytest.mark.asyncio
    async def test_dashboard_override_is_not_physical(self):
        coord = _make_coordinator()
        coord.schedule_enabled = False

        await coord.async_set_temperature(70.0)

        assert coord.manual_override.source == OVERRIDE_SOURCE_MANUAL
        assert coord.manual_override.is_physical is False

    @pytest.mark.asyncio
    async def test_reason_stays_physical_on_later_cycles(self):
        """The chip must keep saying 'thermostat' for the full duration."""
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await _dispatch(coord, 72.0)
        # Simulate a later coordinator cycle recomputing the setpoint
        _, reason = coord._calculate_desired_temp()

        assert reason == ACTION_REASON_PHYSICAL_OVERRIDE

    @pytest.mark.asyncio
    async def test_reason_is_manual_for_dashboard_override(self):
        coord = _make_coordinator()
        coord.schedule_enabled = False

        await coord.async_set_temperature(70.0)
        _, reason = coord._calculate_desired_temp()

        assert reason == ACTION_REASON_OVERRIDE

    @pytest.mark.asyncio
    async def test_source_exposed_in_state_dict(self):
        coord = _make_coordinator()
        coord._known_thermostat_setpoint = 68.0

        await _dispatch(coord, 72.0)
        data = coord._build_state_dict()

        assert data["override_source"] == OVERRIDE_SOURCE_PHYSICAL

    @pytest.mark.asyncio
    async def test_source_is_none_when_no_override(self):
        coord = _make_coordinator()

        data = coord._build_state_dict()

        assert data["override_source"] is None

    def test_source_round_trips_through_storage(self):
        override = ManualOverride(
            target_temp=72.0,
            started_at=datetime.now(timezone.utc).isoformat(),
            duration_minutes=120,
            source=OVERRIDE_SOURCE_PHYSICAL,
        )

        restored = ManualOverride.from_dict(override.to_dict())

        assert restored.source == OVERRIDE_SOURCE_PHYSICAL
        assert restored.is_physical is True

    def test_pre_2_1_0_stored_override_defaults_to_manual(self):
        """Overrides persisted before the source field existed."""
        restored = ManualOverride.from_dict({
            "target_temp": 70.0,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "duration_minutes": 120,
            "zone_id": None,
        })

        assert restored.source == OVERRIDE_SOURCE_MANUAL
        assert restored.is_physical is False
