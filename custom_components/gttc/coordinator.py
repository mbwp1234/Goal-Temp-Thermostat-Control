"""Data coordinator for GTTC."""
from __future__ import annotations

import logging
from datetime import datetime, time, timedelta, timezone
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
    CONF_OUTDOOR_TEMP_SENSOR,
    CONF_PRECONDITION_ENABLED,
    CONF_PRESENCE_DETECTION,
    CONF_SCHEDULE_ENABLED,
    CONF_TEMP_MAX,
    CONF_TEMP_MIN,
    CONF_THERMOSTAT,
    CONF_TOU_ENABLED,
    CONF_TOU_PROVIDER,
    CONF_WINDOW_SENSORS,
    DEFAULT_AWAY_TEMP,
    DEFAULT_LEARNING_THRESHOLD,
    DEFAULT_MANUAL_OVERRIDE_MINUTES,
    DEFAULT_PRECONDITION_MINUTES,
    DEFAULT_PRESENCE_MODE,
    DEFAULT_TEMP_MAX,
    DEFAULT_TEMP_MIN,
    DOMAIN,
    HEAT_PUMP_MAX_SETBACK,
    HEAT_PUMP_RECOVERY_STEP,
    LEARNING_TEMP_TOLERANCE,
    OUTDOOR_COLD_THRESHOLD,
    OUTDOOR_MILD_THRESHOLD,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from .learning import LearningEngine
from .models import ManualOverride, ScheduleEntry
from .scheduler import Scheduler
from .tou import (
    RatePeriod,
    TOU_ON_PEAK_COOLING_OFFSET,
    TOU_ON_PEAK_HEATING_OFFSET,
    TOU_PRECONDITION_WINDOW_MINUTES,
    TOU_PROVIDERS,
    TOUProvider,
)
from .zone_manager import ZoneManager

_LOGGER = logging.getLogger(__name__)

UPDATE_INTERVAL = timedelta(seconds=30)
TEMP_HYSTERESIS = 0.5  # Minimum change (degrees) before updating thermostat
MAX_TEMP_OFFSET = 5.0  # Maximum offset correction between zone and thermostat sensors


class GTTCCoordinator(DataUpdateCoordinator):
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

        # New efficiency features
        self.outdoor_temp_sensor: str = data.get(CONF_OUTDOOR_TEMP_SENSOR, "")
        self.tou_enabled: bool = data.get(CONF_TOU_ENABLED, False)
        self.precondition_enabled: bool = data.get(CONF_PRECONDITION_ENABLED, True)
        tou_provider_key = data.get(CONF_TOU_PROVIDER, "none")
        provider_cls = TOU_PROVIDERS.get(tou_provider_key, TOUProvider)
        self.tou_provider: TOUProvider = provider_cls()
        self._outdoor_temp: float | None = None

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

        # Default comfort temperature: DOE recommends 68°F for occupied
        # heating.  Clamp to the user's configured range.
        self._default_comfort_temp: float = max(
            self.temp_min, min(self.temp_max, 68.0)
        )

        # State
        self.manual_override: ManualOverride | None = None
        self.target_temp: float | None = self._default_comfort_temp
        self.current_temp: float | None = None
        self.hvac_mode: HVACMode | None = None
        self.hvac_action: HVACAction | None = None
        self._last_thermostat_temp: float | None = None
        self._initialized = False
        self._available = False

        # Heat pump detection — when the underlying thermostat is a heat pump
        # we need to limit setback depth and recover gradually to avoid
        # triggering expensive auxiliary/strip heat.
        self._is_heat_pump: bool | None = None  # None = not yet detected

        # Track repeated overrides of the same schedule entry so we can
        # update the schedule when the user keeps fighting it.
        self._override_schedule_key: str | None = None  # "time_start-time_end"
        self._override_target_temp: float | None = None
        self._override_repeat_count: int = 0

        # Window open detection: list of binary_sensor entity IDs to monitor.
        # When any sensor reports "on" (open), thermostat control is suspended.
        # windows_open_override is a manual flag for homes without sensors.
        self.window_sensors: list[str] = []
        self.windows_open_override: bool = False

    @property
    def available(self) -> bool:
        """Whether the real thermostat is reachable."""
        return self._available

    async def async_initialize(self) -> None:
        """Load stored data and set up initial state."""
        first_run = True
        try:
            stored = await self._store.async_load()
            if stored and isinstance(stored, dict):
                self._load_stored_data(stored)
                first_run = False
        except Exception as err:
            _LOGGER.warning("Error loading stored data, starting fresh: %s", err)

        # On first run (no stored data), activate the Home preset so the
        # thermostat has a sensible schedule immediately.
        if first_run and self.scheduler.schedule.active_preset is None:
            _LOGGER.info("First run detected - activating Home preset as default schedule")
            self.scheduler.activate_preset("home")
            self.schedule_enabled = True
            self.scheduler.enabled = True

        self._initialized = True
        _LOGGER.info("GTTC coordinator initialized")

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
            if "window_sensors" in data and isinstance(data["window_sensors"], list):
                self.window_sensors = data["window_sensors"]
            if "windows_open_override" in data:
                self.windows_open_override = bool(data["windows_open_override"])
            if "tracked_persons" in data and isinstance(data["tracked_persons"], list):
                self.zone_manager.tracked_persons = data["tracked_persons"]
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
                "window_sensors": self.window_sensors,
                "windows_open_override": self.windows_open_override,
                "tracked_persons": self.zone_manager.tracked_persons,
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

            # Suspend thermostat control when a window is open — running
            # heating/cooling against an open window wastes energy.
            if self._are_windows_open():
                _LOGGER.debug(
                    "Window open detected — suspending thermostat control"
                )
                return self._build_state_dict()

            # Auto-switch active zone when the current schedule entry
            # specifies a zone_id (e.g. "1st floor" during the day,
            # "2nd floor" at night).
            if self.schedule_enabled and self.manual_override is None:
                entry = self.scheduler.get_current_entry()
                if (
                    entry
                    and entry.zone_id
                    and entry.zone_id != self.zone_manager.active_zone_id
                    and entry.zone_id in self.zone_manager.zones
                ):
                    _LOGGER.info(
                        "Schedule entry specifies zone '%s', switching active zone",
                        entry.zone_id,
                    )
                    self.zone_manager.set_active_zone(entry.zone_id)
                    # Re-read active zone so offset calculation uses the new zone
                    active_zone = self.zone_manager.active_zone
                    if active_zone and active_zone.current_temp is not None:
                        self.current_temp = active_zone.current_temp

            # Re-detect heat pump periodically (attributes may appear
            # after initial setup, e.g. when aux heat first activates).
            if self._is_heat_pump is not None:
                fresh = self._detect_heat_pump()
                if fresh != self._is_heat_pump:
                    _LOGGER.info(
                        "Heat pump detection changed: %s → %s",
                        self._is_heat_pump,
                        fresh,
                    )
                    self._is_heat_pump = fresh

            # Read outdoor temperature sensor (if configured)
            self._outdoor_temp = self._read_outdoor_temp()

            # Determine target temperature
            desired_temp = self._calculate_desired_temp()

            # Pre-conditioning: if a schedule transition is approaching,
            # start ramping toward the next entry's target now so it's
            # reached on time instead of playing catch-up.
            desired_temp = self._apply_precondition(desired_temp)

            # TOU rate optimization: shift setpoint during on-peak to
            # reduce energy cost, and pre-condition before on-peak starts.
            desired_temp = self._apply_tou_adjustment(desired_temp)

            # For heat pumps, ramp the target gradually to avoid aux heat
            desired_temp = self._apply_gradual_recovery(desired_temp)

            # Calculate offset-adjusted target for the real thermostat.
            # Instead of blindly setting the thermostat to the desired temp,
            # use zone sensor feedback to compensate for the difference
            # between the thermostat's own sensor and the zone sensors.
            thermostat_target = self._calculate_thermostat_target(
                desired_temp, active_zone
            )

            # Apply to thermostat if changed beyond hysteresis threshold
            if thermostat_target is not None:
                if self._last_thermostat_temp is None or abs(
                    thermostat_target - self._last_thermostat_temp
                ) >= TEMP_HYSTERESIS:
                    await self._set_thermostat_temp(thermostat_target)
                    self._last_thermostat_temp = thermostat_target

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
            "heat_pump_detected": self.is_heat_pump,
            "outdoor_temp": self._outdoor_temp,
            "tou_rate_period": (
                self.tou_provider.get_rate_period().value
                if self.tou_enabled
                else None
            ),
            "precondition_active": self._is_preconditioning(),
            "windows_open": self._are_windows_open(),
            "window_sensors": list(self.window_sensors),
            "windows_open_override": self.windows_open_override,
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

    def _detect_heat_pump(self) -> bool:
        """Detect whether the real thermostat is connected to a heat pump.

        Checks for heat-pump-specific HVAC actions and preset modes that
        indicate auxiliary/emergency heat capability — a hallmark of heat
        pump systems.
        """
        try:
            state = self.hass.states.get(self.thermostat_entity)
            if state is None:
                return False
            attrs = state.attributes

            # Check for aux/emergency heat indicators
            hvac_action = attrs.get("hvac_action", "")
            preset_modes = attrs.get("preset_modes", []) or []
            hvac_modes = attrs.get("hvac_modes", []) or []

            heat_pump_indicators = {
                "aux",
                "auxiliary",
                "emergency",
                "heat_pump",
                "defrosting",
            }

            for indicator in heat_pump_indicators:
                if indicator in str(hvac_action).lower():
                    return True
                for mode in preset_modes:
                    if indicator in str(mode).lower():
                        return True
                for mode in hvac_modes:
                    if indicator in str(mode).lower():
                        return True

            # Some integrations expose an "aux_heat" attribute
            if attrs.get("aux_heat") is not None:
                return True

        except Exception as err:
            _LOGGER.debug("Error detecting heat pump: %s", err)
        return False

    @property
    def is_heat_pump(self) -> bool:
        """Whether the real thermostat appears to be a heat pump system."""
        if self._is_heat_pump is None:
            self._is_heat_pump = self._detect_heat_pump()
        return self._is_heat_pump

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

    def _calculate_desired_temp(self) -> float:
        """Determine target temp: manual > occupancy > schedule > last setting > comfort default.

        For heat pump systems, setbacks are capped to avoid triggering
        expensive auxiliary/strip heat during the recovery phase.  The DOE
        recommends keeping heat-pump setbacks to 5°F or less.
        """
        comfort = self._get_comfort_reference()

        # 1. Manual override (highest priority)
        if self.manual_override and not self.manual_override.is_expired:
            return self.manual_override.target_temp

        # 2. Occupancy check (only when sensors are explicitly reporting)
        if self.occupancy_enabled:
            active_zone = self.zone_manager.active_zone
            # Per-zone occupancy: only trigger if sensors exist and report unoccupied
            if (
                active_zone
                and active_zone.occupancy_override
                and active_zone.occupancy_sensor_entities
                and active_zone.is_occupied is False
            ):
                zone_away = active_zone.away_temp or self.away_temp
                return self._apply_heat_pump_setback_limit(zone_away, comfort)

            # Global: nobody home
            if not self.zone_manager.is_anyone_home():
                return self._apply_heat_pump_setback_limit(self.away_temp, comfort)

        # 3. Schedule
        if self.schedule_enabled:
            entry = self.scheduler.get_current_entry()
            if entry:
                return entry.target_temp

        # 4. Fall back to current target or default comfort temp
        return self.target_temp if self.target_temp is not None else self._default_comfort_temp

    def _get_comfort_reference(self) -> float:
        """Return the current comfort temperature for setback calculations.

        Uses the most recent scheduled comfort entry, falling back to the
        default comfort temperature.
        """
        if self.schedule_enabled:
            entry = self.scheduler.get_current_entry()
            if entry:
                return entry.target_temp
        return self._default_comfort_temp

    def _apply_gradual_recovery(self, desired_temp: float) -> float:
        """For heat pump systems, limit how quickly the target temperature
        ramps up during recovery from a setback.

        Most heat pump thermostats trigger auxiliary heat when the
        differential between the current temperature and the setpoint
        exceeds 2-3°F.  By stepping the target up gradually, the heat
        pump compressor handles the load alone (COP 2-4) instead of
        falling back to resistance strips (COP 1).
        """
        if not self.is_heat_pump or self.current_temp is None:
            return desired_temp

        # Only apply during heating recovery (current temp below target)
        if self.hvac_mode not in (HVACMode.HEAT, HVACMode.HEAT_COOL):
            return desired_temp

        gap = desired_temp - self.current_temp
        if gap > HEAT_PUMP_RECOVERY_STEP:
            stepped = self.current_temp + HEAT_PUMP_RECOVERY_STEP
            _LOGGER.info(
                "Heat pump gradual recovery: current %.1f°, goal %.1f°, "
                "stepped target %.1f° (max +%.1f° per cycle)",
                self.current_temp,
                desired_temp,
                stepped,
                HEAT_PUMP_RECOVERY_STEP,
            )
            return stepped

        return desired_temp

    # ------------------------------------------------------------------
    # Outdoor temperature integration
    # ------------------------------------------------------------------

    def _read_outdoor_temp(self) -> float | None:
        """Read the configured outdoor temperature sensor."""
        if not self.outdoor_temp_sensor:
            return None
        try:
            state = self.hass.states.get(self.outdoor_temp_sensor)
            if state and state.state not in ("unavailable", "unknown"):
                return float(state.state)
        except (ValueError, TypeError):
            pass
        return None

    def _apply_heat_pump_setback_limit(
        self, setback_temp: float, comfort_temp: float
    ) -> float:
        """For heat pump systems, limit the setback depth.

        Large setbacks (>5°F) cause the heat pump to engage auxiliary
        resistance heat during recovery, which is 2-5x more expensive.
        This clamps the away/sleep temperature so the setback doesn't
        exceed HEAT_PUMP_MAX_SETBACK degrees from comfort.

        When an outdoor temperature sensor is available, the limit adapts:
        - Below OUTDOOR_COLD_THRESHOLD (30°F): tighten the max setback
          to 3°F because the heat pump is already near its balance point
          and recovery would be very slow or impossible without aux heat.
        - Above OUTDOOR_MILD_THRESHOLD (45°F): relax to the full
          HEAT_PUMP_MAX_SETBACK because recovery is fast and efficient.
        """
        if not self.is_heat_pump:
            return setback_temp

        if self.hvac_mode == HVACMode.HEAT or self.hvac_mode == HVACMode.HEAT_COOL:
            max_setback = HEAT_PUMP_MAX_SETBACK

            # Adapt setback limit based on outdoor temperature
            if self._outdoor_temp is not None:
                if self._outdoor_temp < OUTDOOR_COLD_THRESHOLD:
                    # Very cold: heat pump struggling, minimize setback
                    max_setback = 3.0
                    _LOGGER.info(
                        "Outdoor temp %.1f° < %.1f°: tightening heat pump "
                        "setback limit to %.1f°",
                        self._outdoor_temp,
                        OUTDOOR_COLD_THRESHOLD,
                        max_setback,
                    )
                elif self._outdoor_temp > OUTDOOR_MILD_THRESHOLD:
                    # Mild: heat pump efficient, allow full setback
                    max_setback = HEAT_PUMP_MAX_SETBACK

            min_allowed = comfort_temp - max_setback
            if setback_temp < min_allowed:
                _LOGGER.info(
                    "Heat pump detected: limiting heating setback from %.1f° to "
                    "%.1f° (max %.1f° below comfort %.1f°)",
                    setback_temp,
                    min_allowed,
                    max_setback,
                    comfort_temp,
                )
                return min_allowed
        elif self.hvac_mode == HVACMode.COOL:
            # In cooling mode, larger setbacks are fine — higher temps save energy
            pass

        return setback_temp

    # ------------------------------------------------------------------
    # Pre-conditioning
    # ------------------------------------------------------------------

    def _is_preconditioning(self) -> bool:
        """Whether the system is currently pre-conditioning for an upcoming schedule change."""
        if not self.precondition_enabled or not self.schedule_enabled:
            return False
        next_entry, minutes_until = self.scheduler.get_next_entry()
        if next_entry is None:
            return False
        return 0 < minutes_until <= DEFAULT_PRECONDITION_MINUTES

    def _apply_precondition(self, desired_temp: float) -> float:
        """Start ramping toward the next schedule entry's target before
        it officially starts.

        This avoids the catch-up spike that happens when the schedule
        switches from a setback (e.g. sleep 62°F) to comfort (68°F) —
        by starting early, the house reaches the target on time and the
        HVAC system runs at a moderate, efficient load instead of running
        flat-out (or triggering aux heat).

        The ramp is linear: if 30 minutes remain and the gap is 6°F,
        the target moves 1°F every 5 minutes.
        """
        if not self.precondition_enabled or not self.schedule_enabled:
            return desired_temp

        # Don't pre-condition during a manual override
        if self.manual_override and not self.manual_override.is_expired:
            return desired_temp

        next_entry, minutes_until = self.scheduler.get_next_entry()
        if next_entry is None or minutes_until <= 0:
            return desired_temp

        if minutes_until > DEFAULT_PRECONDITION_MINUTES:
            return desired_temp

        next_temp = next_entry.target_temp
        gap = next_temp - desired_temp
        if abs(gap) < 1.0:
            return desired_temp  # already close enough

        # Linear interpolation: how far through the precondition window are we?
        progress = 1.0 - (minutes_until / DEFAULT_PRECONDITION_MINUTES)
        progress = max(0.0, min(1.0, progress))
        ramped = desired_temp + (gap * progress)

        _LOGGER.info(
            "Pre-conditioning: next entry at %s (%.1f°) in %d min, "
            "current target %.1f°, ramped to %.1f° (%.0f%% progress)",
            next_entry.time_start,
            next_temp,
            minutes_until,
            desired_temp,
            ramped,
            progress * 100,
        )
        return ramped

    # ------------------------------------------------------------------
    # Time-of-Use rate optimization
    # ------------------------------------------------------------------

    def _apply_tou_adjustment(self, desired_temp: float) -> float:
        """Adjust the target temperature based on TOU electricity rates.

        During on-peak hours (expensive electricity):
        - Cooling: raise the setpoint by TOU_ON_PEAK_COOLING_OFFSET (3°F)
          so the AC runs less.
        - Heating: lower the setpoint by TOU_ON_PEAK_HEATING_OFFSET (2°F)
          so the furnace/heat pump runs less.

        Before on-peak starts (within TOU_PRECONDITION_WINDOW_MINUTES):
        - Pre-condition the house to the comfort target so it can coast
          through the on-peak window with minimal HVAC runtime.
        """
        if not self.tou_enabled:
            return desired_temp

        # Don't override a manual override
        if self.manual_override and not self.manual_override.is_expired:
            return desired_temp

        rate = self.tou_provider.get_rate_period()

        if rate == RatePeriod.ON_PEAK:
            if self.hvac_mode == HVACMode.COOL:
                adjusted = desired_temp + TOU_ON_PEAK_COOLING_OFFSET
                _LOGGER.info(
                    "TOU on-peak cooling: raising setpoint from %.1f° to %.1f° "
                    "(+%.1f° to reduce on-peak usage)",
                    desired_temp, adjusted, TOU_ON_PEAK_COOLING_OFFSET,
                )
                return min(self.temp_max, adjusted)
            elif self.hvac_mode in (HVACMode.HEAT, HVACMode.HEAT_COOL):
                adjusted = desired_temp + TOU_ON_PEAK_HEATING_OFFSET  # negative offset
                _LOGGER.info(
                    "TOU on-peak heating: lowering setpoint from %.1f° to %.1f° "
                    "(%.1f° to reduce on-peak usage)",
                    desired_temp, adjusted, TOU_ON_PEAK_HEATING_OFFSET,
                )
                return max(self.temp_min, adjusted)

        # Pre-condition before on-peak: drive the house to comfort temp
        # so it can coast through the expensive window.
        minutes_to_peak = self.tou_provider.minutes_until_on_peak()
        if (
            minutes_to_peak is not None
            and 0 < minutes_to_peak <= TOU_PRECONDITION_WINDOW_MINUTES
        ):
            comfort = self._get_comfort_reference()
            if self.hvac_mode == HVACMode.COOL and desired_temp > comfort:
                _LOGGER.info(
                    "TOU pre-cool: on-peak in %d min, targeting comfort %.1f° "
                    "(was %.1f°) to coast through peak",
                    minutes_to_peak, comfort, desired_temp,
                )
                return comfort
            elif (
                self.hvac_mode in (HVACMode.HEAT, HVACMode.HEAT_COOL)
                and desired_temp < comfort
            ):
                _LOGGER.info(
                    "TOU pre-heat: on-peak in %d min, targeting comfort %.1f° "
                    "(was %.1f°) to coast through peak",
                    minutes_to_peak, comfort, desired_temp,
                )
                return comfort

        return desired_temp

    def _calculate_thermostat_target(
        self, desired_temp: float | None, active_zone
    ) -> float | None:
        """Adjust thermostat target using zone sensor feedback.

        If zone sensors read differently from the thermostat's own sensor,
        apply an offset so the *zone* reaches the desired temperature rather
        than the thermostat's sensor.

        Example: zone reads 70, thermostat reads 68, goal is 71.
          offset = 68 - 70 = -2  →  thermostat target = 71 + (-2) = 69
          Thermostat heats to 69 at its sensor, zone lands at ~71.

        During a manual override the offset is skipped so the thermostat is
        set to exactly what the user requested — not an offset-inflated value
        that causes the zone to overshoot the override goal.
        """
        if desired_temp is None:
            return None

        # Skip offset correction during a manual override so the T6 target
        # matches the override temp exactly and doesn't overshoot.
        if self.manual_override and not self.manual_override.is_expired:
            return desired_temp

        thermostat_reading = self._get_thermostat_current_temp()
        zone_reading = (
            active_zone.current_temp
            if active_zone and active_zone.current_temp is not None
            else None
        )

        if thermostat_reading is not None and zone_reading is not None:
            offset = thermostat_reading - zone_reading
            # Cap offset to prevent extreme corrections
            offset = max(-MAX_TEMP_OFFSET, min(MAX_TEMP_OFFSET, offset))
            adjusted = desired_temp + offset
            # Clamp to valid range
            adjusted = max(self.temp_min, min(self.temp_max, adjusted))

            if abs(offset) >= 0.5:
                _LOGGER.info(
                    "Zone temp: %.1f°, Thermostat reads: %.1f°, "
                    "Offset: %+.1f°, Goal: %.1f°, Adjusted thermostat target: %.1f°",
                    zone_reading,
                    thermostat_reading,
                    offset,
                    desired_temp,
                    adjusted,
                )
            return adjusted

        # No zone data available — fall back to direct control
        return desired_temp

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

        # Track repeated overrides of the same schedule entry.
        # When the user keeps fighting a schedule entry (override expires,
        # they set it back), update the schedule entry directly so the
        # override cycle stops.  Returns True if the schedule was updated.
        schedule_updated = await self._track_schedule_override(temperature)

        # Set manual override — but skip if we just updated the schedule
        # to match, since there's nothing to override anymore.
        if not schedule_updated:
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

    async def _track_schedule_override(self, temperature: float) -> bool:
        """Detect when the user repeatedly overrides the same schedule entry.

        If the user keeps setting the same temperature while a schedule entry
        is active (i.e. override expires → schedule resumes → user overrides
        again), update the schedule entry to match after ``threshold`` repeats.
        This breaks the frustrating override-expiry cycle.

        Returns True if the schedule was updated (no override needed).
        """
        if not self.schedule_enabled:
            return False

        entry = self.scheduler.get_current_entry()
        if entry is None:
            self._override_schedule_key = None
            self._override_repeat_count = 0
            return False

        entry_key = f"{entry.time_start}-{entry.time_end}"

        # Same schedule block and similar override temperature?
        if (
            entry_key == self._override_schedule_key
            and self._override_target_temp is not None
            and abs(temperature - self._override_target_temp) <= LEARNING_TEMP_TOLERANCE
        ):
            self._override_repeat_count += 1
        else:
            # New schedule entry or different temperature — reset tracking
            self._override_schedule_key = entry_key
            self._override_target_temp = temperature
            self._override_repeat_count = 1

        threshold = max(2, self.learning.threshold if self.learning_enabled else 3)

        if self._override_repeat_count >= threshold:
            # User has overridden this entry enough times — adopt their preference
            if abs(entry.target_temp - temperature) >= 1.0:
                old_target = entry.target_temp
                active_preset = self.scheduler.schedule.active_preset
                if active_preset and active_preset in self.scheduler.presets:
                    self._update_preset_learned_temp(
                        active_preset,
                        self._entry_midpoint_minutes(entry),
                        temperature,
                    )
                else:
                    entry.target_temp = temperature
                _LOGGER.info(
                    "Schedule entry %s updated from %.1f° to %.1f° "
                    "after %d repeated overrides",
                    entry_key,
                    old_target,
                    temperature,
                    self._override_repeat_count,
                )
                # Cancel the override since the schedule now matches
                self.manual_override = None
                # Reset counter so we don't keep logging
                self._override_repeat_count = 0
                return True
            # Reset counter so we don't keep logging
            self._override_repeat_count = 0

        return False

    @staticmethod
    def _entry_midpoint_minutes(entry: ScheduleEntry) -> int:
        """Get the midpoint of a schedule entry in minutes since midnight."""
        start = entry.start_time
        end = entry.end_time
        start_min = start.hour * 60 + start.minute
        end_min = end.hour * 60 + end.minute
        if end_min <= start_min:
            end_min += 1440  # overnight
        return (start_min + end_min) // 2 % 1440

    async def _apply_learned_entry(self, learned: dict[str, Any]) -> None:
        """Add a learned pattern to the schedule.

        When a preset is active the weekday/weekend entries are bypassed, so
        update the preset's own entry directly.  Without an active preset the
        entry is appended to the weekday/weekend schedule as before.
        """
        try:
            minutes = int(learned["time"].split(":")[0]) * 60 + int(
                learned["time"].split(":")[1]
            )
            start_min = max(0, minutes - 30)
            end_min = min(1439, minutes + 30)

            active_preset = self.scheduler.schedule.active_preset
            if active_preset and active_preset in self.scheduler.presets:
                # Preset takes priority over weekday/weekend schedule, so we
                # must update the preset entry itself to make the learned temp
                # persist after the manual override expires.
                self._update_preset_learned_temp(
                    active_preset, minutes, learned["temp"]
                )
            else:
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

    def _update_preset_learned_temp(
        self, preset_name: str, learned_minutes: int, learned_temp: float
    ) -> None:
        """Update the preset entry that covers the learned time with the learned temperature.

        Iterates every day in the preset so the temperature change is consistent
        across the whole schedule (e.g. all weekdays and weekends share the same
        entry objects when the preset was built).
        """
        learned_time = time(learned_minutes // 60, learned_minutes % 60)
        preset = self.scheduler.presets[preset_name]
        updated = False

        for day_schedule in preset.schedule.values():
            entry = self.scheduler._find_entry_for_time(day_schedule, learned_time)
            if entry is not None and entry.target_temp != learned_temp:
                entry.target_temp = learned_temp
                updated = True

        if updated:
            _LOGGER.info(
                "Updated preset '%s' entry covering %02d:%02d to %.1f° from learned pattern",
                preset_name,
                learned_minutes // 60,
                learned_minutes % 60,
                learned_temp,
            )

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

    async def async_cancel_override(self) -> None:
        """Cancel the manual override and resume automation."""
        self.manual_override = None
        await self.async_save()
        self.async_set_updated_data(self._build_state_dict())

    def cancel_override(self) -> None:
        """Cancel the manual override (sync version)."""
        self.manual_override = None

    async def async_set_schedule_enabled(self, enabled: bool) -> None:
        """Toggle schedule on/off and persist."""
        self.schedule_enabled = enabled
        self.scheduler.enabled = enabled
        if not enabled:
            self.scheduler.deactivate_preset()
        await self.async_save()
        self.async_set_updated_data(self._build_state_dict())

    def set_schedule_enabled(self, enabled: bool) -> None:
        """Toggle schedule on/off (sync version)."""
        self.schedule_enabled = enabled
        self.scheduler.enabled = enabled
        if not enabled:
            self.scheduler.deactivate_preset()

    # ------------------------------------------------------------------
    # Live configuration updates
    # ------------------------------------------------------------------

    async def async_update_config(self, updates: dict) -> None:
        """Apply a partial configuration dict to live coordinator state.

        Callers are responsible for persisting the changes to
        config_entry.data via hass.config_entries.async_update_entry.
        """
        if "temp_min" in updates:
            self.temp_min = float(updates["temp_min"])
            self.scheduler.temp_min = self.temp_min
        if "temp_max" in updates:
            self.temp_max = float(updates["temp_max"])
            self.scheduler.temp_max = self.temp_max
        if "away_temp" in updates:
            self.away_temp = float(updates["away_temp"])
        if "manual_override_minutes" in updates:
            self.manual_override_minutes = int(updates["manual_override_minutes"])
        if "learning_enabled" in updates:
            self.learning_enabled = bool(updates["learning_enabled"])
        if "learning_threshold" in updates:
            self.learning.threshold = int(updates["learning_threshold"])
        if "occupancy_enabled" in updates:
            self.occupancy_enabled = bool(updates["occupancy_enabled"])
        if "presence_detection" in updates:
            self.zone_manager.presence_mode = updates["presence_detection"]
        if "outdoor_temp_sensor" in updates:
            self.outdoor_temp_sensor = updates["outdoor_temp_sensor"] or ""
        if "tou_enabled" in updates:
            self.tou_enabled = bool(updates["tou_enabled"])
        if "tou_provider" in updates:
            provider_cls = TOU_PROVIDERS.get(updates["tou_provider"], TOUProvider)
            self.tou_provider = provider_cls()
        if "precondition_enabled" in updates:
            self.precondition_enabled = bool(updates["precondition_enabled"])
        if "tracked_persons" in updates:
            self.zone_manager.tracked_persons = list(updates["tracked_persons"])

        await self.async_save()
        self.async_set_updated_data(self._build_state_dict())

    # ------------------------------------------------------------------
    # Window open detection
    # ------------------------------------------------------------------

    def _are_windows_open(self) -> bool:
        """Return True if the manual override flag is set OR any configured
        window/contact sensor reports open (state == 'on').

        Contact sensors in HA use binary_sensor with device_class=window or
        door; their state is 'on' when open and 'off' when closed.
        """
        if self.windows_open_override:
            return True
        for entity_id in self.window_sensors:
            try:
                state = self.hass.states.get(entity_id)
                if state and state.state == "on":
                    return True
            except Exception:
                pass
        return False

    def get_open_window_sensors(self) -> list[str]:
        """Return the entity IDs of sensors currently reporting open."""
        return [
            entity_id
            for entity_id in self.window_sensors
            if self.hass.states.get(entity_id) is not None
            and self.hass.states.get(entity_id).state == "on"
        ]
