"""Data coordinator for Better Thermostat."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.components.climate import (
    HVACAction,
    HVACMode,
)
from homeassistant.const import ATTR_TEMPERATURE
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    CONF_AWAY_TEMP,
    CONF_LEARNING_ENABLED,
    CONF_LEARNING_THRESHOLD,
    CONF_MANUAL_OVERRIDE_MINUTES,
    CONF_OCCUPANCY_ENABLED,
    CONF_PRESENCE_DETECTION,
    CONF_SCHEDULE_ENABLED,
    CONF_TEMP_MAX,
    CONF_TEMP_MIN,
    CONF_THERMOSTAT,
    DEFAULT_AWAY_TEMP,
    DEFAULT_LEARNING_THRESHOLD,
    DEFAULT_MANUAL_OVERRIDE_MINUTES,
    DEFAULT_PRESENCE_MODE,
    DEFAULT_TEMP_MAX,
    DEFAULT_TEMP_MIN,
    DOMAIN,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from .learning import LearningEngine
from .models import ManualOverride, ScheduleEntry
from .scheduler import Scheduler
from .zone_manager import ZoneManager

_LOGGER = logging.getLogger(__name__)

UPDATE_INTERVAL = timedelta(seconds=30)


class BetterThermostatCoordinator(DataUpdateCoordinator):
    """Central coordinator that ties together zones, schedule, learning, and thermostat control."""

    def __init__(
        self,
        hass: HomeAssistant,
        config_entry,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=UPDATE_INTERVAL,
        )
        self.config_entry = config_entry
        self._store = Store(
            hass, STORAGE_VERSION, f"{STORAGE_KEY}_{config_entry.entry_id}"
        )

        # Config values
        data = config_entry.data
        self.thermostat_entity: str = data.get(CONF_THERMOSTAT, "")
        self.temp_min: float = float(data.get(CONF_TEMP_MIN, DEFAULT_TEMP_MIN))
        self.temp_max: float = float(data.get(CONF_TEMP_MAX, DEFAULT_TEMP_MAX))
        self.away_temp: float = float(data.get(CONF_AWAY_TEMP, DEFAULT_AWAY_TEMP))
        self.occupancy_enabled: bool = data.get(CONF_OCCUPANCY_ENABLED, False)
        self.learning_enabled: bool = data.get(CONF_LEARNING_ENABLED, True)
        self.manual_override_minutes: int = int(
            data.get(CONF_MANUAL_OVERRIDE_MINUTES, DEFAULT_MANUAL_OVERRIDE_MINUTES)
        )
        self.schedule_enabled: bool = True

        # Sub-managers
        self.zone_manager = ZoneManager(hass, config_entry.entry_id)
        self.zone_manager.presence_mode = data.get(
            CONF_PRESENCE_DETECTION, DEFAULT_PRESENCE_MODE
        )
        self.scheduler = Scheduler(self.temp_min, self.temp_max)
        self.learning = LearningEngine(
            threshold=int(
                data.get(CONF_LEARNING_THRESHOLD, DEFAULT_LEARNING_THRESHOLD)
            )
        )

        # State
        self.manual_override: ManualOverride | None = None
        self.target_temp: float | None = None
        self.current_temp: float | None = None
        self.hvac_mode: HVACMode | None = None
        self.hvac_action: HVACAction | None = None
        self._last_thermostat_temp: float | None = None
        self._initialized = False
        self._available = False

    @property
    def available(self) -> bool:
        """Whether the real thermostat is reachable."""
        return self._available

    async def async_initialize(self) -> None:
        """Load stored data and set up initial state."""
        try:
            stored = await self._store.async_load()
            if stored and isinstance(stored, dict):
                self._load_stored_data(stored)
        except Exception as err:
            _LOGGER.warning("Error loading stored data, starting fresh: %s", err)

        self._initialized = True
        _LOGGER.info("Better Thermostat coordinator initialized")

    def _load_stored_data(self, data: dict[str, Any]) -> None:
        """Restore state from storage with validation."""
        try:
            if "zones" in data and isinstance(data["zones"], list):
                self.zone_manager.load_zones(data["zones"])
            if "active_zone_id" in data:
                self.zone_manager.set_active_zone(data["active_zone_id"])
            if "scheduler" in data:
                self.scheduler.load(data["scheduler"])
            if "learning" in data:
                self.learning.load(data["learning"])
            if "target_temp" in data and data["target_temp"] is not None:
                try:
                    self.target_temp = float(data["target_temp"])
                except (ValueError, TypeError):
                    pass
            if "schedule_enabled" in data:
                self.schedule_enabled = bool(data["schedule_enabled"])
                self.scheduler.enabled = self.schedule_enabled
            if "manual_override" in data and data["manual_override"]:
                try:
                    override = ManualOverride.from_dict(data["manual_override"])
                    if not override.is_expired:
                        self.manual_override = override
                    else:
                        _LOGGER.debug("Discarding expired manual override from storage")
                except Exception:
                    pass  # Invalid override data
        except Exception as err:
            _LOGGER.error("Error restoring state: %s", err)

    async def async_save(self) -> None:
        """Persist state to storage."""
        try:
            data = {
                "zones": self.zone_manager.save_zones(),
                "active_zone_id": self.zone_manager.active_zone_id,
                "scheduler": self.scheduler.save(),
                "learning": self.learning.save(),
                "target_temp": self.target_temp,
                "schedule_enabled": self.schedule_enabled,
                "manual_override": (
                    self.manual_override.to_dict() if self.manual_override else None
                ),
            }
            await self._store.async_save(data)
        except Exception as err:
            _LOGGER.error("Error saving state: %s", err)

    async def _async_update_data(self) -> dict[str, Any]:
        """Called periodically. Updates all state and adjusts thermostat."""
        try:
            # Check real thermostat availability
            state = self.hass.states.get(self.thermostat_entity)
            self._available = (
                state is not None and state.state not in ("unavailable", "unknown")
            )

            if not self._available:
                _LOGGER.debug("Thermostat %s is unavailable", self.thermostat_entity)
                return self._build_state_dict()

            # Update zone sensor data
            self.zone_manager.update_all_zones()

            # Read real thermostat state
            self._read_thermostat_state()

            # Get current temp from active zone
            active_zone = self.zone_manager.active_zone
            if active_zone and active_zone.current_temp is not None:
                self.current_temp = active_zone.current_temp
            else:
                self.current_temp = self._get_thermostat_current_temp()

            # Clear expired override
            if self.manual_override and self.manual_override.is_expired:
                _LOGGER.debug("Manual override expired, resuming automation")
                self.manual_override = None

            # Determine target temperature
            desired_temp = self._calculate_desired_temp()

            # Apply to thermostat if changed
            if desired_temp is not None and desired_temp != self._last_thermostat_temp:
                await self._set_thermostat_temp(desired_temp)
                self._last_thermostat_temp = desired_temp

            self.target_temp = desired_temp

            # Save state periodically
            await self.async_save()

            return self._build_state_dict()
        except Exception as err:
            _LOGGER.error("Error in coordinator update: %s", err)
            return self._build_state_dict()

    def _build_state_dict(self) -> dict[str, Any]:
        """Build the data dict returned to listeners."""
        override_active = (
            self.manual_override is not None and not self.manual_override.is_expired
        )
        return {
            "current_temp": self.current_temp,
            "target_temp": self.target_temp,
            "hvac_mode": self.hvac_mode,
            "hvac_action": self.hvac_action,
            "available": self._available,
            "active_zone": (
                self.zone_manager.active_zone.name
                if self.zone_manager.active_zone
                else None
            ),
            "zone_temps": self.zone_manager.get_zone_temperatures(),
            "zone_occupancy": self.zone_manager.get_zone_occupancy(),
            "presence_home": self.zone_manager.is_anyone_home(),
            "schedule_entry": self._get_current_schedule_info(),
            "schedule_enabled": self.schedule_enabled,
            "override_active": override_active,
            "override_remaining": (
                self.manual_override.remaining_minutes if override_active else 0
            ),
            "learning_status": {
                "enabled": self.learning_enabled,
                "events_recorded": len(self.learning.events),
                "patterns_learned": len(self.learning.learned_entries),
            },
        }

    def _read_thermostat_state(self) -> None:
        """Read the real thermostat's current state."""
        try:
            state = self.hass.states.get(self.thermostat_entity)
            if state is None:
                return

            try:
                self.hvac_mode = HVACMode(state.state)
            except ValueError:
                self.hvac_mode = None

            action = state.attributes.get("hvac_action")
            if action:
                try:
                    self.hvac_action = HVACAction(action)
                except ValueError:
                    self.hvac_action = None
            else:
                self.hvac_action = None
        except Exception as err:
            _LOGGER.debug("Error reading thermostat state: %s", err)

    def _get_thermostat_current_temp(self) -> float | None:
        """Get the real thermostat's current temperature reading."""
        try:
            state = self.hass.states.get(self.thermostat_entity)
            if state:
                temp = state.attributes.get("current_temperature")
                if temp is not None:
                    return float(temp)
        except (ValueError, TypeError):
            pass
        return None

    def get_thermostat_features(self) -> int:
        state = self.hass.states.get(self.thermostat_entity)
        if state:
            return state.attributes.get("supported_features", 0)
        return 0

    def get_thermostat_hvac_modes(self) -> list[HVACMode]:
        """Get HVAC modes supported by the real thermostat."""
        state = self.hass.states.get(self.thermostat_entity)
        if state:
            modes = state.attributes.get("hvac_modes", [])
            result = []
            for m in modes:
                try:
                    result.append(HVACMode(m))
                except ValueError:
                    pass
            if result:
                return result
        return [HVACMode.OFF, HVACMode.HEAT, HVACMode.COOL]

    def get_thermostat_min_temp(self) -> float:
        state = self.hass.states.get(self.thermostat_entity)
        if state:
            try:
                return float(state.attributes.get("min_temp", self.temp_min))
            except (ValueError, TypeError):
                pass
        return self.temp_min

    def get_thermostat_max_temp(self) -> float:
        state = self.hass.states.get(self.thermostat_entity)
        if state:
            try:
                return float(state.attributes.get("max_temp", self.temp_max))
            except (ValueError, TypeError):
                pass
        return self.temp_max

    def _calculate_desired_temp(self) -> float | None:
        """Determine target temp: manual > occupancy > schedule > last setting."""
        # 1. Manual override (highest priority)
        if self.manual_override and not self.manual_override.is_expired:
            return self.manual_override.target_temp

        # 2. Occupancy check
        if self.occupancy_enabled:
            active_zone = self.zone_manager.active_zone
            # Per-zone occupancy
            if active_zone and active_zone.occupancy_override:
                if active_zone.is_occupied is False:
                    zone_away = active_zone.away_temp or self.away_temp
                    return zone_away

            # Global: nobody home
            if not self.zone_manager.is_anyone_home():
                return self.away_temp

        # 3. Schedule
        if self.schedule_enabled:
            entry = self.scheduler.get_current_entry()
            if entry:
                return entry.target_temp

        # 4. Fall back to current target
        return self.target_temp

    def _get_current_schedule_info(self) -> dict[str, Any] | None:
        if not self.schedule_enabled:
            return None
        entry = self.scheduler.get_current_entry()
        if entry:
            return {
                "time_start": entry.time_start,
                "time_end": entry.time_end,
                "target_temp": entry.target_temp,
                "zone_id": entry.zone_id,
            }
        return None

    async def async_set_temperature(self, temperature: float) -> None:
        """Handle a temperature set from the virtual climate entity (manual adjustment)."""
        # Clamp to valid range
        temperature = max(self.temp_min, min(self.temp_max, temperature))

        old_temp = self.target_temp
        self.target_temp = temperature

        # Set manual override
        self.manual_override = ManualOverride(
            target_temp=temperature,
            started_at=datetime.now(timezone.utc).isoformat(),
            duration_minutes=self.manual_override_minutes,
            zone_id=self.zone_manager.active_zone_id,
        )

        # Record for learning
        if self.learning_enabled:
            try:
                learned = self.learning.record_event(
                    target_temp=temperature,
                    zone_id=self.zone_manager.active_zone_id,
                    previous_temp=old_temp,
                )
                if learned:
                    _LOGGER.info("New pattern learned: %s", learned)
                    await self._apply_learned_entry(learned)
            except Exception as err:
                _LOGGER.warning("Error in learning engine: %s", err)

        # Apply immediately
        await self._set_thermostat_temp(temperature)
        self._last_thermostat_temp = temperature
        await self.async_save()

        self.async_set_updated_data(self._build_state_dict())

    async def _apply_learned_entry(self, learned: dict[str, Any]) -> None:
        """Add a learned pattern to the schedule."""
        try:
            minutes = int(learned["time"].split(":")[0]) * 60 + int(
                learned["time"].split(":")[1]
            )
            start_min = max(0, minutes - 30)
            end_min = min(1439, minutes + 30)

            entry = ScheduleEntry(
                time_start=f"{start_min // 60:02d}:{start_min % 60:02d}",
                time_end=f"{end_min // 60:02d}:{end_min % 60:02d}",
                target_temp=learned["temp"],
                zone_id=learned.get("zone_id"),
            )

            day_type = learned.get("day_type", "daily")
            if day_type == "weekday":
                self.scheduler.add_entry_to_day("weekday", entry)
            elif day_type == "weekend":
                self.scheduler.add_entry_to_day("weekend", entry)
            else:
                self.scheduler.add_entry_to_day("weekday", entry)
                self.scheduler.add_entry_to_day("weekend", entry)
        except Exception as err:
            _LOGGER.warning("Error applying learned entry: %s", err)

    async def _set_thermostat_temp(self, temperature: float) -> None:
        """Set the real thermostat's target temperature."""
        if not self._available:
            _LOGGER.warning("Thermostat %s is not available", self.thermostat_entity)
            return

        try:
            await self.hass.services.async_call(
                "climate",
                "set_temperature",
                {
                    "entity_id": self.thermostat_entity,
                    ATTR_TEMPERATURE: temperature,
                },
                blocking=True,
            )
        except Exception as err:
            _LOGGER.error(
                "Failed to set temperature on %s to %.1f: %s",
                self.thermostat_entity,
                temperature,
                err,
            )

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        """Set the real thermostat's HVAC mode."""
        try:
            await self.hass.services.async_call(
                "climate",
                "set_hvac_mode",
                {
                    "entity_id": self.thermostat_entity,
                    "hvac_mode": hvac_mode.value,
                },
                blocking=True,
            )
            self.hvac_mode = hvac_mode
        except Exception as err:
            _LOGGER.error("Failed to set HVAC mode to %s: %s", hvac_mode, err)

    async def async_set_active_zone(self, zone_id: str) -> None:
        """Change the active target zone."""
        if self.zone_manager.set_active_zone(zone_id):
            await self.async_save()
            self.async_set_updated_data(self._build_state_dict())

    def cancel_override(self) -> None:
        """Cancel the manual override."""
        self.manual_override = None

    def set_schedule_enabled(self, enabled: bool) -> None:
        """Toggle schedule on/off."""
        self.schedule_enabled = enabled
        self.scheduler.enabled = enabled
        if not enabled:
            self.scheduler.deactivate_preset()
