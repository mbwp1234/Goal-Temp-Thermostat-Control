"""Data coordinator for GTTC."""
from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.components.climate import (
    HVACAction,
    HVACMode,
)
from homeassistant.const import ATTR_TEMPERATURE
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    ACTION_LOG_MAX,
    ACTION_REASON_FALLBACK,
    ACTION_REASON_HEAT_PUMP,
    ACTION_REASON_OVERRIDE,
    ACTION_REASON_PHYSICAL_OVERRIDE,
    ACTION_REASON_SCHEDULE,
    ACTION_REASON_VACATION,
    ACTION_REASON_WINDOW,
    ACTION_REASON_COOL_LOCKOUT,
    ACTION_REASON_OVERHEAT,
    ACTION_REASON_WARM_ZONE,
    BOOST_TYPES,
    BRIAN_NOTIFY_SERVICE,
    CONF_AUTO_SEASON_SWITCH,
    CONF_AWAY_TEMP,
    CONF_COOLING_AWAY_TEMP,
    CONF_COOLING_COMFORT,
    CONF_MANUAL_OVERRIDE_MINUTES,
    CONF_OUTDOOR_TEMP_SENSOR,
    CONF_SCHEDULE_ENABLED,
    CONF_SEASONAL_RECOMMEND_HOURS,
    CONF_TEMP_MAX,
    CONF_TEMP_MIN,
    CONF_THERMOSTAT,
    CONF_WINDOW_SENSORS,
    DEFAULT_AUTO_SEASON_SWITCH,
    DEFAULT_AWAY_TEMP,
    DEFAULT_COOLING_AWAY,
    DEFAULT_COOLING_COMFORT,
    DEFAULT_MANUAL_OVERRIDE_MINUTES,
    DEFAULT_TEMP_MAX,
    DEFAULT_TEMP_MIN,
    DOMAIN,
    HEAT_PUMP_RAMP_INTERVAL_MIN,
    HEAT_PUMP_RAMP_STEP,
    STARTUP_WRITE_GRACE_MIN,
    HEATING_FAILURE_COOLDOWN_H,
    HEATING_FAILURE_MIN_OUTDOOR,
    HEATING_FAILURE_RUN_MINUTES,
    HEATING_FAILURE_SHORTFALL,
    HEATING_FAILURE_TEMP_DELTA,
    OVERRIDE_SOURCE_PHYSICAL,
    RUNTIME_HISTORY_MAX_DAYS,
    SEASON_COOLING,
    SEASON_DEMAND_MARGIN,
    SEASON_HEAT_COOL,
    SEASON_HEATING,
    SEASONS,
    CONF_COOL_LOCKOUT_TEMP,
    CONF_HEAT_COOL_MIN_GAP,
    CONF_HEAT_COOL_SETTLE_DAYS,
    COOL_LOCKOUT_PARK,
    FAN_ON_PREFERENCE,
    COOL_HARD_FLOOR,
    COOL_LOCKOUT_REV,
    OVERHEAT_MARGIN,
    LEGACY_COOL_LOCKOUT_TEMP,
    WARM_ZONE_CLEAR,
    WARM_ZONE_FLOOR_MARGIN,
    WARM_ZONE_MARGIN,
    WARM_ZONE_MINUTES,
    DEFAULT_COOL_LOCKOUT_TEMP,
    DEFAULT_HEAT_COOL_MIN_GAP,
    DEFAULT_HEAT_COOL_SETTLE_DAYS,
    HEAT_COOL_PARK_HIGH,
    HEAT_COOL_PARK_LOW,
    SEASONAL_RECOMMEND_HOURS,
    SEASONAL_SWITCH_MARGIN,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from .models import ManualOverride, VacationMode
from .scheduler import Scheduler
from .zone_manager import ZoneManager

_LOGGER = logging.getLogger(__name__)

UPDATE_INTERVAL = timedelta(seconds=30)
TEMP_HYSTERESIS = 0.5  # Minimum change (degrees) before updating thermostat
MAX_TEMP_OFFSET = 5.0  # Maximum offset correction between zone and thermostat sensors
OFFSET_TAU = timedelta(minutes=20)  # smoothing of the zone↔wall offset
OFFSET_STALE_DECAY = timedelta(hours=3)  # a lost zone's offset fades over this
OUTDOOR_STALE_MAX = timedelta(hours=3)  # last outdoor reading stays usable this long
WINDOW_OPEN_GRACE = timedelta(minutes=2)  # a door must stay open this long to park the HVAC

# Physical (at-the-wall) setpoint change detection.
# A Z-Wave thermostat echoes our own writes back as a state change, often a
# second or two later and sometimes rounded to its own resolution. We only
# treat a setpoint change as user-initiated when it neither matches a value
# we recently wrote nor arrives inside the echo window.
PHYSICAL_CHANGE_THRESHOLD = 0.5  # Minimum delta to count as a real change
PHYSICAL_ECHO_WINDOW = timedelta(seconds=90)  # How long our own write may echo
PHYSICAL_ECHO_TOLERANCE = 1.0  # Rounding slack when matching our echoed write
# A mode change makes the thermostat report the setpoint it has stored for the
# NEW mode (e.g. last winter's 75° heat setpoint). That is not a person at the
# wall, so setpoint changes this soon after a mode change only reseed.
PHYSICAL_MODE_SETTLE = timedelta(seconds=30)
# The T6 sometimes re-reports a setpoint GTTC wrote minutes earlier (seen
# 8.5 min later, after a fan-mode call). An exact match to one of our own
# recent writes is an echo; a person nudging the dial lands more than 0.3 away.
PHYSICAL_STALE_WINDOW = timedelta(minutes=15)
PHYSICAL_STALE_TOLERANCE = 0.3
# A band write is two setpoints, and the thermostat may move one end while it
# applies the other. Reports this soon after our own band write only reseed.
RANGE_WRITE_SETTLE = timedelta(seconds=30)
# If the thermostat still reports a different band than we wrote after this
# long (and no one claimed it at the wall), write ours again — at most once
# per RANGE_REWRITE_INTERVAL so a thermostat that refuses cannot loop us.
RANGE_MISMATCH_GRACE = timedelta(seconds=60)
RANGE_REWRITE_INTERVAL = timedelta(minutes=5)



def _merge_runtime_days(rows: list) -> list:
    """One row per date, in date order: minutes add up, outside readings average."""
    by_date: dict[str, dict] = {}
    for r in rows:
        if not isinstance(r, dict) or not r.get("date"):
            continue
        d = r["date"]
        if d not in by_date:
            by_date[d] = dict(r)
            continue
        a = by_date[d]
        a["heating_min"] = round((a.get("heating_min") or 0) + (r.get("heating_min") or 0), 1)
        a["cooling_min"] = round((a.get("cooling_min") or 0) + (r.get("cooling_min") or 0), 1)
        o = [x for x in (a.get("avg_outdoor"), r.get("avg_outdoor")) if x is not None]
        a["avg_outdoor"] = round(sum(o) / len(o), 2) if o else None
    return [by_date[d] for d in sorted(by_date)]

class GTTCCoordinator(DataUpdateCoordinator):
    """Central coordinator that ties together zones, schedule, and thermostat control."""

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
        self.manual_override_minutes: int = int(
            data.get(CONF_MANUAL_OVERRIDE_MINUTES, DEFAULT_MANUAL_OVERRIDE_MINUTES)
        )
        self.schedule_enabled: bool = True

        # New efficiency features
        self.outdoor_temp_sensor: str = data.get(CONF_OUTDOOR_TEMP_SENSOR, "")
        self._outdoor_temp: float | None = None
        self._outdoor_last: tuple[float, datetime] | None = None
        self._window_open_since: datetime | None = None
        self._last_failure_alert: datetime | None = None

        # Season management — Heating or Cooling.
        # When auto_season_switch is True the coordinator automatically calls
        # async_set_season once suggest_season_switch fires, instead of only
        # surfacing it as a recommendation.
        self.season: str = SEASON_HEATING
        self.cooling_comfort: float = float(
            data.get(CONF_COOLING_COMFORT, DEFAULT_COOLING_COMFORT)
        )
        self.cooling_away_temp: float = float(
            data.get(CONF_COOLING_AWAY_TEMP, DEFAULT_COOLING_AWAY)
        )
        self.seasonal_recommend_hours: float = float(
            data.get(CONF_SEASONAL_RECOMMEND_HOURS, SEASONAL_RECOMMEND_HOURS)
        )
        self.auto_season_switch: bool = bool(
            data.get(CONF_AUTO_SEASON_SWITCH, DEFAULT_AUTO_SEASON_SWITCH)
        )
        # Timestamps tracking how long opposite-season conditions have held.
        # Persisted; on restore they move forward by the time Home Assistant
        # was down, so an outage never counts toward a switch (v2.9.0).
        self._cooling_conditions_since: datetime | None = None
        self._heating_conditions_since: datetime | None = None
        # Guards against scheduling multiple auto-switch tasks simultaneously.
        self._auto_switch_pending: bool = False

        # Heat/cool — both setpoints at once, the house drifting between them.
        self.cool_lockout_temp: float = float(
            data.get(CONF_COOL_LOCKOUT_TEMP, DEFAULT_COOL_LOCKOUT_TEMP)
        )
        self.heat_cool_settle_days: float = float(
            data.get(CONF_HEAT_COOL_SETTLE_DAYS, DEFAULT_HEAT_COOL_SETTLE_DAYS)
        )
        self.heat_cool_min_gap: float = float(
            data.get(CONF_HEAT_COOL_MIN_GAP, DEFAULT_HEAT_COOL_MIN_GAP)
        )
        # The band's goals (zone terms, before offset) and what GTTC did to them
        self.target_low: float | None = None
        self.target_high: float | None = None
        self.cool_locked_out: bool = False
        self._gap_adjusted_from: float | None = None
        # Warm-zone cooling: since when the warmest zone has been over the
        # cool goal, and the zone being cooled against while it is engaged
        self._warm_zone_since: datetime | None = None
        self.warm_zone = None
        self._warm_zone_paused: bool = False
        # Overheat: a zone far over the cool goal lifts the lockout
        self._overheat_since: datetime | None = None
        self.overheat_active: bool = False
        self._overheat_paused: bool = False
        # When each side of the equipment last ran while in heat/cool —
        # heat/cool leaves for a single season once one side has been quiet
        # for heat_cool_settle_days. Persisted, or every restart restarts the
        # wait (and shifted past any outage on restore, like the countdown).
        self._last_heat_call: datetime | None = None
        self._last_cool_call: datetime | None = None
        # Band write bookkeeping (thermostat terms, after offset)
        self._last_thermostat_range: tuple[float, float] | None = None
        self._known_thermostat_range: tuple[float, float] | None = None
        self._range_write_at: datetime | None = None
        self._range_mismatch_since: datetime | None = None
        self._range_rewrite_at: datetime | None = None

        # Sub-managers
        self.zone_manager = ZoneManager(hass, config_entry.entry_id)
        self.scheduler = Scheduler(self.temp_min, self.temp_max)

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
        # Heat-pump ramp: when GTTC last RAISED the wall's heat setpoint
        self._last_heat_raise_at: datetime | None = None
        # Startup: nothing is written until the watched zone reads (or a
        # saved offset can steer), or STARTUP_WRITE_GRACE_MIN has passed
        self._started_at: datetime = datetime.now(timezone.utc)
        self._initialized = False
        self._available = False

        # Heat pump detection — when the underlying thermostat is a heat pump
        # we need to limit setback depth and recover gradually to avoid
        # triggering expensive auxiliary/strip heat.
        self._is_heat_pump: bool | None = None  # None = not yet detected

        # Window open detection: list of binary_sensor entity IDs to monitor.
        # When any sensor reports "on" (open), thermostat control is suspended.
        # windows_open_override is a manual flag for homes without sensors.
        self.window_sensors: list[str] = []
        self.windows_open_override: bool = False

        # Vacation mode — time-bounded global setback with auto-revert
        self.vacation_mode: VacationMode | None = None

        # Why-based action log — ring buffer of {ts, reason, target_temp}
        self.action_log: list[dict] = []
        self._last_action_reason: str = ACTION_REASON_FALLBACK

        # Daily runtime history — list of {date, heating_min, cooling_min, avg_outdoor}
        self.runtime_history: list[dict] = []
        self._hvac_run_start: datetime | None = None
        self._hvac_run_start_temp: float | None = None
        self._today_heating_min: float = 0.0
        self._today_cooling_min: float = 0.0
        self._today_date: str = ""
        # Outside readings through the day, so a saved day carries its
        # average rather than whatever it read at midnight
        self._today_outdoor_sum: float = 0.0
        self._today_outdoor_n: int = 0
        self._last_runtime_save: datetime | None = None

        # Physical override detection — setpoint changes made at the wall unit
        # (or by anything other than GTTC) are promoted to a full manual
        # override so they aren't silently stomped on the next update cycle.
        # _pending_write_* records our own most recent write so its echo back
        # from the thermostat isn't mistaken for a user action.
        self._known_thermostat_setpoint: float | None = None
        self._pending_write_temp: float | None = None
        self._pending_write_until: datetime | None = None
        self._mode_changed_at: datetime | None = None
        self._own_mode_write_at: datetime | None = None
        self._recent_writes: list[tuple[float, datetime]] = []
        self._unsub_thermostat_listener = None

        # The lockout fan (heat/cool below the AC lockout) — whether GTTC is
        # running it, and the mode to hand back
        self._fan_running: bool = False
        self._fan_restore_mode: str | None = None
        # zone id → (smoothed wall−zone offset, when)
        self._offset_filter: dict[str, tuple[float, datetime]] = {}

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

        # Watch the real thermostat for setpoint changes we didn't make
        self._start_physical_override_watch()

        self._initialized = True
        _LOGGER.info("GTTC coordinator initialized")

    # ------------------------------------------------------------------
    # Physical override detection
    # ------------------------------------------------------------------

    def _start_physical_override_watch(self) -> None:
        """Listen for setpoint changes made directly on the real thermostat."""
        if self._unsub_thermostat_listener is not None:
            return

        # Seed the known setpoint from the current state so the first event
        # after a restart doesn't look like a user change.
        self._known_thermostat_setpoint = self._read_thermostat_setpoint()
        self._known_thermostat_range = self._read_thermostat_range()

        self._unsub_thermostat_listener = async_track_state_change_event(
            self.hass,
            [self.thermostat_entity],
            self._handle_thermostat_state_event,
        )

    def async_shutdown_physical_override_watch(self) -> None:
        """Remove the thermostat state listener (called on unload)."""
        if self._unsub_thermostat_listener is not None:
            self._unsub_thermostat_listener()
            self._unsub_thermostat_listener = None

    def _read_thermostat_setpoint(self) -> float | None:
        """Read the real thermostat's current target temperature attribute."""
        state = self.hass.states.get(self.thermostat_entity)
        if state is None:
            return None
        try:
            value = state.attributes.get(ATTR_TEMPERATURE)
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    def _read_thermostat_range(self) -> tuple[float, float] | None:
        """Read the real thermostat's heat/cool setpoints, when it has both."""
        state = self.hass.states.get(self.thermostat_entity)
        if state is None:
            return None
        return self._range_of(state)

    @staticmethod
    def _range_of(state) -> tuple[float, float] | None:
        try:
            low = state.attributes.get("target_temp_low")
            high = state.attributes.get("target_temp_high")
            if low is None or high is None:
                return None
            return float(low), float(high)
        except (TypeError, ValueError, AttributeError):
            return None

    def _within_range_settle(self) -> bool:
        """Whether GTTC wrote a band moments ago."""
        if self._range_write_at is None:
            return False
        return datetime.now(timezone.utc) - self._range_write_at <= RANGE_WRITE_SETTLE

    def _note_own_write(self, temperature: float) -> None:
        """Record a setpoint GTTC is about to write so its echo is ignored."""
        now = datetime.now(timezone.utc)
        self._pending_write_temp = temperature
        self._pending_write_until = now + PHYSICAL_ECHO_WINDOW
        self._known_thermostat_setpoint = temperature
        self._recent_writes = [
            (t, at) for t, at in self._recent_writes if now - at <= PHYSICAL_STALE_WINDOW
        ]
        self._recent_writes.append((temperature, now))

    def _is_own_write_echo(self, setpoint: float) -> bool:
        """Whether an observed setpoint is the thermostat echoing our own write."""
        if self._is_stale_own_write(setpoint):
            return True
        if self._pending_write_temp is None or self._pending_write_until is None:
            return False
        if datetime.now(timezone.utc) > self._pending_write_until:
            # Echo window elapsed — anything from here on is a real change
            self._pending_write_temp = None
            self._pending_write_until = None
            return False
        return abs(setpoint - self._pending_write_temp) <= PHYSICAL_ECHO_TOLERANCE

    def _is_stale_own_write(self, setpoint: float) -> bool:
        """Whether the thermostat is re-reporting a value GTTC wrote recently."""
        now = datetime.now(timezone.utc)
        return any(
            now - at <= PHYSICAL_STALE_WINDOW
            and abs(setpoint - temp) <= PHYSICAL_STALE_TOLERANCE
            for temp, at in self._recent_writes
        )

    def _within_mode_settle(self) -> bool:
        """Whether the thermostat's HVAC mode changed moments ago."""
        if self._mode_changed_at is None:
            return False
        return datetime.now(timezone.utc) - self._mode_changed_at <= PHYSICAL_MODE_SETTLE

    @callback
    def _handle_thermostat_state_event(self, event: Event) -> None:
        """Promote an externally-made setpoint change to a manual override."""
        new_state = event.data.get("new_state")
        if new_state is None:
            return

        old_state = event.data.get("old_state")
        if old_state is not None and old_state.state != new_state.state:
            self._mode_changed_at = datetime.now(timezone.utc)
            self._maybe_adopt_wall_mode(old_state.state, new_state.state)

        # In heat/cool the thermostat reports two setpoints and no single one
        band = self._range_of(new_state) if new_state.state == "heat_cool" else None
        if band is not None:
            self._handle_range_report(*band)
            return

        try:
            raw = new_state.attributes.get(ATTR_TEMPERATURE)
            setpoint = float(raw) if raw is not None else None
        except (TypeError, ValueError):
            setpoint = None
        if setpoint is None:
            return

        # A report whose setpoint did not move is about something else — the
        # fan, the action, humidity. Comparing it against what GTTC has just
        # *asked* for (and the wall has not applied yet) turns GTTC's own
        # pending write into a phantom hold: the fan pre-cool sets the fan
        # first, the fan report still carries the old setpoint, and that old
        # setpoint was held for two hours. Only a moving setpoint is a change.
        if old_state is not None and old_state.state == new_state.state:
            try:
                before_raw = old_state.attributes.get(ATTR_TEMPERATURE)
                before = float(before_raw) if before_raw is not None else None
            except (TypeError, ValueError):
                before = None
            if before is not None and abs(setpoint - before) < PHYSICAL_CHANGE_THRESHOLD:
                return

        previous = self._known_thermostat_setpoint
        self._known_thermostat_setpoint = setpoint

        # Nothing to compare against yet (first reading after a restart)
        if previous is None:
            return

        if abs(setpoint - previous) < PHYSICAL_CHANGE_THRESHOLD:
            return

        if self._within_mode_settle():
            _LOGGER.debug(
                "Thermostat setpoint %.1f° arrived with a mode change — "
                "the mode's stored setpoint, not an override",
                setpoint,
            )
            return

        if self._is_own_write_echo(setpoint):
            _LOGGER.debug(
                "Thermostat setpoint %.1f° matches GTTC's own write — not an override",
                setpoint,
            )
            return

        _LOGGER.info(
            "Physical thermostat change detected: %.1f° → %.1f° — "
            "holding for %d minutes",
            previous,
            setpoint,
            self.manual_override_minutes,
        )
        self.hass.async_create_task(self._async_apply_physical_override(setpoint))

    def _handle_range_report(self, low: float, high: float) -> None:
        """Promote a heat/cool band changed at the wall to a band hold."""
        previous = self._known_thermostat_range
        self._known_thermostat_range = (low, high)
        if previous is None:
            return
        changed = [
            value
            for value, before in ((low, previous[0]), (high, previous[1]))
            if abs(value - before) >= PHYSICAL_CHANGE_THRESHOLD
        ]
        if not changed:
            return
        if self._within_mode_settle() or self._within_range_settle():
            _LOGGER.debug(
                "Thermostat band %.1f–%.1f° arrived with a mode change or our own "
                "band write — not an override",
                low,
                high,
            )
            return
        if all(self._is_stale_own_write(value) for value in changed):
            _LOGGER.debug("Thermostat band %.1f–%.1f° echoes GTTC's own write", low, high)
            return
        _LOGGER.info(
            "Physical heat/cool change detected: %.1f–%.1f° → %.1f–%.1f° — "
            "holding for %d minutes",
            previous[0],
            previous[1],
            low,
            high,
            self.manual_override_minutes,
        )
        self.hass.async_create_task(self._async_apply_physical_range(low, high))

    async def _async_apply_physical_range(self, low: float, high: float) -> None:
        """Hold a band set at the wall unit, exactly as the thermostat has it."""
        self.manual_override = ManualOverride(
            target_temp=round((low + high) / 2, 1),
            started_at=datetime.now(timezone.utc).isoformat(),
            duration_minutes=self.manual_override_minutes,
            zone_id=self.zone_manager.active_zone_id,
            source=OVERRIDE_SOURCE_PHYSICAL,
            target_low=low,
            target_high=high,
        )
        self.target_low, self.target_high = low, high
        # Holds skip the zone offset, so the next cycle computes this same band
        self._last_thermostat_range = (low, high)
        self._log_action(ACTION_REASON_PHYSICAL_OVERRIDE, low, high)
        await self.async_save()
        self.async_set_updated_data(self._build_state_dict())

    def _maybe_adopt_wall_mode(self, old_mode: str, new_mode: str) -> None:
        """Follow a heat/cool change made at the wall unit.

        Otherwise GTTC keeps its season and writes heating targets into cool
        mode (or the reverse): a heat-season 71° becomes an AC setpoint.
        """
        if old_mode in ("unavailable", "unknown"):
            return  # a reconnect reporting the mode it already had
        if (
            self._own_mode_write_at is not None
            and datetime.now(timezone.utc) - self._own_mode_write_at <= PHYSICAL_MODE_SETTLE
        ):
            return  # our own mode change, or a late report of the old one
        wanted = {"cool": SEASON_COOLING, "heat": SEASON_HEATING, "heat_cool": SEASON_HEAT_COOL}
        season = wanted.get(new_mode)
        if season is None or season == self.season:
            return
        _LOGGER.info(
            "Thermostat switched %s → %s at the wall — following it to %s season",
            old_mode,
            new_mode,
            season,
        )
        self.hass.async_create_task(self.async_set_season(season, apply_hvac=False))

    async def _async_apply_physical_override(self, setpoint: float) -> None:
        """Create a manual override from a setpoint change made at the wall unit."""
        temperature = max(self.temp_min, min(self.temp_max, setpoint))

        self.manual_override = ManualOverride(
            target_temp=temperature,
            started_at=datetime.now(timezone.utc).isoformat(),
            duration_minutes=self.manual_override_minutes,
            zone_id=self.zone_manager.active_zone_id,
            source=OVERRIDE_SOURCE_PHYSICAL,
        )
        self.target_temp = temperature
        # During an override the zone offset is skipped, so the thermostat
        # target equals the override temp — record it so the next update
        # cycle sees no drift and leaves the thermostat alone.
        self._last_thermostat_temp = temperature

        self._log_action(ACTION_REASON_PHYSICAL_OVERRIDE, temperature)

        # If the requested value fell outside the configured range, write the
        # clamped value back so the thermostat and GTTC agree.
        if abs(temperature - setpoint) >= 0.1:
            _LOGGER.info(
                "Physical setpoint %.1f° clamped to configured range → %.1f°",
                setpoint,
                temperature,
            )
            await self._set_thermostat_temp(temperature)

        await self.async_save()
        self.async_set_updated_data(self._build_state_dict())

    def _load_stored_data(self, data: dict[str, Any]) -> None:
        """Restore state from storage with validation."""
        try:
            if "zones" in data and isinstance(data["zones"], list):
                self.zone_manager.load_zones(data["zones"])
            if "active_zone_id" in data:
                self.zone_manager.set_active_zone(data["active_zone_id"])
            if "scheduler" in data:
                self.scheduler.load(data["scheduler"])
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
            if "season" in data and data["season"] in SEASONS:
                self.season = data["season"]
            if "cooling_comfort" in data and data["cooling_comfort"] is not None:
                try:
                    self.cooling_comfort = float(data["cooling_comfort"])
                except (ValueError, TypeError):
                    pass
            if "cooling_away_temp" in data and data["cooling_away_temp"] is not None:
                try:
                    self.cooling_away_temp = float(data["cooling_away_temp"])
                except (ValueError, TypeError):
                    pass
            if "seasonal_recommend_hours" in data and data["seasonal_recommend_hours"] is not None:
                try:
                    self.seasonal_recommend_hours = float(data["seasonal_recommend_hours"])
                except (ValueError, TypeError):
                    pass
            if "auto_season_switch" in data:
                self.auto_season_switch = bool(data["auto_season_switch"])
            for key in ("_cooling_conditions_since", "_heating_conditions_since"):
                raw = data.get(key.lstrip("_"))
                if raw:
                    try:
                        setattr(self, key, datetime.fromisoformat(raw))
                    except (ValueError, TypeError):
                        pass
            for key in ("cool_lockout_temp", "heat_cool_settle_days", "heat_cool_min_gap"):
                if data.get(key) is not None:
                    try:
                        setattr(self, key, float(data[key]))
                    except (ValueError, TypeError):
                        pass
            if (
                data.get("cool_lockout_rev") is None
                and self.cool_lockout_temp == LEGACY_COOL_LOCKOUT_TEMP
            ):
                self.cool_lockout_temp = DEFAULT_COOL_LOCKOUT_TEMP
            for key in ("_last_heat_call", "_last_cool_call"):
                raw = data.get(key.lstrip("_"))
                if raw:
                    try:
                        setattr(self, key, datetime.fromisoformat(raw))
                    except (ValueError, TypeError):
                        pass
            # Time Home Assistant was down is time nobody watched: move every
            # season clock forward by it, so an outage neither counts toward
            # a season switch nor reads as a quiet side in heat/cool
            self._skip_downtime(data.get("saved_at"))
            if self.season == SEASON_HEAT_COOL:
                now = datetime.now(timezone.utc)
                self._last_heat_call = self._last_heat_call or now
                self._last_cool_call = self._last_cool_call or now
            self._restore_offsets(data.get("zone_offsets"))
            if "vacation_mode" in data and data["vacation_mode"]:
                try:
                    vm = VacationMode.from_dict(data["vacation_mode"])
                    if not vm.is_expired:
                        self.vacation_mode = vm
                except Exception:
                    pass
            if "runtime_history" in data and isinstance(data["runtime_history"], list):
                self.runtime_history = _merge_runtime_days(data["runtime_history"])
            if isinstance(data.get("action_log"), list):
                self.action_log = [e for e in data["action_log"] if isinstance(e, dict) and e.get("ts")][-ACTION_LOG_MAX:]
            self._restore_today_runtime(data.get("today_runtime"))
        except Exception as err:
            _LOGGER.error("Error restoring state: %s", err)

    async def async_save(self) -> None:
        """Persist state to storage."""
        try:
            data = {
                "zones": self.zone_manager.save_zones(),
                "active_zone_id": self.zone_manager.active_zone_id,
                "scheduler": self.scheduler.save(),
                "target_temp": self.target_temp,
                "schedule_enabled": self.schedule_enabled,
                "manual_override": (
                    self.manual_override.to_dict() if self.manual_override else None
                ),
                "window_sensors": self.window_sensors,
                "windows_open_override": self.windows_open_override,
                "season": self.season,
                "cooling_comfort": self.cooling_comfort,
                "cooling_away_temp": self.cooling_away_temp,
                "seasonal_recommend_hours": self.seasonal_recommend_hours,
                "auto_season_switch": self.auto_season_switch,
                "cooling_conditions_since": (
                    self._cooling_conditions_since.isoformat()
                    if self._cooling_conditions_since else None
                ),
                "heating_conditions_since": (
                    self._heating_conditions_since.isoformat()
                    if self._heating_conditions_since else None
                ),
                "cool_lockout_temp": self.cool_lockout_temp,
                "cool_lockout_rev": COOL_LOCKOUT_REV,
                "heat_cool_settle_days": self.heat_cool_settle_days,
                "heat_cool_min_gap": self.heat_cool_min_gap,
                "last_heat_call": (
                    self._last_heat_call.isoformat() if self._last_heat_call else None
                ),
                "last_cool_call": (
                    self._last_cool_call.isoformat() if self._last_cool_call else None
                ),
                "vacation_mode": (
                    self.vacation_mode.to_dict() if self.vacation_mode else None
                ),
                # The smoothed wall−zone offsets, so a restart steers by them
                # instead of writing the bare goal first (v2.9.0)
                "zone_offsets": {
                    zid: [round(v, 3), at.isoformat()]
                    for zid, (v, at) in self._offset_filter.items()
                },
                "saved_at": datetime.now(timezone.utc).isoformat(),
                "runtime_history": self.runtime_history[-RUNTIME_HISTORY_MAX_DAYS:],
                # Survive a restart: the decisions behind History's 24h chart,
                # and the day's running minutes so far (v2.8.1)
                "action_log": list(self.action_log[-ACTION_LOG_MAX:]),
                "today_runtime": {
                    "date": self._today_date,
                    "heating_min": round(self._today_heating_min, 1),
                    "cooling_min": round(self._today_cooling_min, 1),
                    "outdoor_sum": round(self._today_outdoor_sum, 2),
                    "outdoor_n": self._today_outdoor_n,
                },
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

            # Clear expired vacation mode
            if self.vacation_mode and self.vacation_mode.is_expired:
                _LOGGER.info("Vacation mode expired — resuming normal schedule")
                self.vacation_mode = None

            # Track HVAC runtime and check for heating failure
            await self._update_runtime_tracking()

            # Suspend thermostat control when a window is open — running
            # heating/cooling against an open window wastes energy.
            if self._are_windows_open():
                _LOGGER.debug(
                    "Window open detected — suspending thermostat control"
                )
                if self.season == SEASON_HEAT_COOL and self.hvac_mode == HVACMode.HEAT_COOL:
                    park = (
                        max(self.get_thermostat_min_temp(), HEAT_COOL_PARK_LOW),
                        min(self.get_thermostat_max_temp(), HEAT_COOL_PARK_HIGH),
                    )
                    if self._last_thermostat_range != park:
                        await self._set_thermostat_range(*park)
                        self._last_thermostat_range = park
                    self._log_action(ACTION_REASON_WINDOW, park[0], park[1])
                    self._cooling_conditions_since = None
                    self._heating_conditions_since = None
                    return self._build_state_dict()
                # Actively park the thermostat so it doesn't keep running on
                # its last setpoint. Cooling: push to max_temp so the AC
                # won't kick on. Heating: push to min_temp so heat won't run.
                if self.hvac_mode == HVACMode.COOL or (
                    self.hvac_mode in (HVACMode.OFF, None)
                    and self.season == SEASON_COOLING
                ):
                    park_temp = self.get_thermostat_max_temp()
                elif self.hvac_mode in (HVACMode.HEAT, HVACMode.HEAT_COOL) or (
                    self.hvac_mode in (HVACMode.OFF, None)
                    and self.season == SEASON_HEATING
                ):
                    park_temp = self.get_thermostat_min_temp()
                else:
                    park_temp = None
                if park_temp is not None and (
                    self._last_thermostat_temp is None
                    or abs(park_temp - self._last_thermostat_temp) >= TEMP_HYSTERESIS
                ):
                    await self._set_thermostat_temp(park_temp)
                    self._last_thermostat_temp = park_temp
                self._log_action(ACTION_REASON_WINDOW, park_temp or self.target_temp or 0)
                # Indoor readings mean nothing with a window open, and the
                # recommendation is not re-evaluated on this path: a running
                # countdown would keep "counting" hours nobody checked and
                # could switch the moment the window closes.
                self._cooling_conditions_since = None
                self._heating_conditions_since = None
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

            # Update season switch recommendation; auto-switches if enabled
            self._update_season_recommendation()

            if self.season == SEASON_HEAT_COOL:
                await self._update_heat_cool(active_zone)
                await self.async_save()
                return self._build_state_dict()

            # Determine target temperature (priority hierarchy)
            desired_temp, action_reason = self._calculate_desired_temp()

            overridden = self.manual_override and not self.manual_override.is_expired
            warm = None
            if self.season == SEASON_COOLING and not overridden:
                heat_goal, _ = self._calculate_desired_temp(SEASON_HEATING)
                warm = self._update_warm_zone(desired_temp, heat_goal, active_zone)
            else:
                self._update_warm_zone(None, None, None)
            if warm is not None:
                action_reason = ACTION_REASON_WARM_ZONE
            # A fan left running by heat/cool's lockout is handed back here
            await self._fan_release()

            # Calculate offset-adjusted target for the real thermostat.
            thermostat_target = self._calculate_thermostat_target(
                desired_temp, warm or active_zone
            )

            # Heat pump: a rise in the wall's heat setpoint goes in steps, so
            # the compressor carries it rather than the electric strips
            if thermostat_target is not None and self.hvac_mode == HVACMode.HEAT and not overridden:
                ramped = self._ramp_heat_setpoint(thermostat_target, self._last_thermostat_temp)
                if ramped != thermostat_target:
                    thermostat_target = ramped
                    action_reason = ACTION_REASON_HEAT_PUMP

            # Log the reason for this setpoint decision
            self._log_action(action_reason, desired_temp)

            # Startup: write nothing until the zone has a reading to steer by
            if thermostat_target is not None and not self._ready_to_write(warm or active_zone):
                thermostat_target = None

            # Apply to thermostat if changed beyond hysteresis threshold
            if thermostat_target is not None:
                if self._last_thermostat_temp is None or abs(
                    thermostat_target - self._last_thermostat_temp
                ) >= TEMP_HYSTERESIS:
                    if (
                        self._last_thermostat_temp is not None
                        and thermostat_target > self._last_thermostat_temp
                        and self.hvac_mode == HVACMode.HEAT
                    ):
                        self._last_heat_raise_at = datetime.now(timezone.utc)
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
            "schedule_entry": self._get_current_schedule_info(),
            "schedule_enabled": self.schedule_enabled,
            "override_active": override_active,
            "override_remaining": (
                self.manual_override.remaining_minutes if override_active else 0
            ),
            "override_source": (
                self.manual_override.source if override_active else None
            ),
            "heat_pump_detected": self.is_heat_pump,
            "outdoor_temp": self._outdoor_temp,
            "windows_open": self._are_windows_open(),
            "window_sensors": list(self.window_sensors),
            "windows_open_override": self.windows_open_override,
            "season": self.season,
            "suggest_season_switch": self.suggest_season_switch,
            "season_conditions_hours": self.season_conditions_hours,
            "season_threshold_hours": self.season_threshold_hours,
            "recommended_season": self.recommended_season,
            "auto_season_switch": self.auto_season_switch,
            "target_low": self.target_low,
            "target_high": self.target_high,
            "cool_locked_out": self.cool_locked_out,
            "warm_zone": self.warm_zone.name if self.warm_zone else None,
            "overheat_active": self.overheat_active,
            "gap_adjusted_from": self._gap_adjusted_from,
            "heat_cool_min_gap": self.heat_cool_min_gap,
            "vacation_mode": (
                self.vacation_mode.to_dict() if self.vacation_mode else None
            ),
            "hvac_action_reason": self._last_action_reason,
            "action_log": list(self.action_log[-50:]),  # last 50 entries for UI
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

    def _calculate_desired_temp(self, season: str | None = None) -> tuple[float, str]:
        """Determine target temp and the reason for it.

        Priority: manual_override > vacation > schedule > fallback.
        Returns (temperature, action_reason). ``season`` asks for one side's
        answer — heat/cool calls it once for each end of the band.
        """
        season = season or self.season
        in_cooling = season == SEASON_COOLING

        # 1. Manual override (highest priority)
        if self.manual_override and not self.manual_override.is_expired:
            reason = (
                ACTION_REASON_PHYSICAL_OVERRIDE
                if self.manual_override.is_physical
                else ACTION_REASON_OVERRIDE
            )
            return self.manual_override.target_temp, reason

        # 2. Vacation mode — global setback while away on vacation
        if self.vacation_mode and self.vacation_mode.is_active:
            return self.vacation_mode.setback_temp, ACTION_REASON_VACATION

        # 3. Schedule
        if self.schedule_enabled:
            entry = self.scheduler.get_current_entry()
            if entry:
                if in_cooling:
                    temp = (
                        entry.cooling_temp
                        if entry.cooling_temp is not None
                        else self.cooling_comfort
                    )
                    return temp, ACTION_REASON_SCHEDULE
                return entry.target_temp, ACTION_REASON_SCHEDULE

        # 4. Fall back to seasonal comfort or last known target
        if in_cooling:
            return self.cooling_comfort, ACTION_REASON_FALLBACK
        temp = self.target_temp if self.target_temp is not None else self._default_comfort_temp
        return temp, ACTION_REASON_FALLBACK

    # ------------------------------------------------------------------
    # Outdoor temperature integration
    # ------------------------------------------------------------------

    def _read_outdoor_temp(self) -> float | None:
        """Read the configured outdoor temperature sensor."""
        if not self.outdoor_temp_sensor:
            return None
        now = datetime.now(timezone.utc)
        try:
            state = self.hass.states.get(self.outdoor_temp_sensor)
            if state and state.state not in ("unavailable", "unknown"):
                value = float(state.state)
                self._outdoor_last = (value, now)
                return value
        except (ValueError, TypeError):
            pass
        # A dropped sensor must not read as "no idea how cold it is" — that
        # lifted the AC lockout and paused the season logic. Outdoor
        # temperature moves slowly; the last reading is good for a while.
        if self._outdoor_last is not None and now - self._outdoor_last[1] <= OUTDOOR_STALE_MAX:
            return self._outdoor_last[0]
        return None

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

        offset = self._zone_offset(active_zone)
        if offset is not None:
            # Cap offset to prevent extreme corrections
            offset = max(-MAX_TEMP_OFFSET, min(MAX_TEMP_OFFSET, offset))
            adjusted = desired_temp + offset
            # temp_min/temp_max bound the GOAL (dial, holds, schedule); the
            # wall target may sit an offset beyond them, or a warm upstairs
            # never reaches its cooling goal
            adjusted = max(
                self.temp_min - MAX_TEMP_OFFSET, min(self.temp_max + MAX_TEMP_OFFSET, adjusted)
            )
            return adjusted

        # No zone data available — fall back to direct control
        return desired_temp

    def _zone_offset(self, zone) -> float | None:
        """Wall reading minus zone reading, smoothed.

        The T6 reports whole degrees, so a raw offset jumps a full degree each
        time its display flickers 73↔74 — and every jump rewrote the setpoint.
        The thermostat starts or stops the compressor on a setpoint change
        (only a 5-min minimum OFF protects it), so the flicker was
        short-cycling it: 36 starts a day, a third under 5 minutes. An
        exponential average over OFFSET_TAU recovers the true fractional
        offset. When the zone's sensors drop out, the last offset is kept
        (and decays toward zero over hours) instead of steering by the wall.
        """
        if zone is None:
            return None
        now = datetime.now(timezone.utc)
        wall = self._get_thermostat_current_temp()
        reading = zone.current_temp
        prev = self._offset_filter.get(zone.id)
        if wall is None or reading is None:
            if prev is None:
                return None
            value, at = prev
            age = (now - at).total_seconds()
            return value * math.exp(-age / OFFSET_STALE_DECAY.total_seconds())
        raw = wall - reading
        if prev is None:
            value = raw
        else:
            value, at = prev
            dt = (now - at).total_seconds()
            if dt <= 0:
                return value
            value += (raw - value) * (1 - math.exp(-dt / OFFSET_TAU.total_seconds()))
        self._offset_filter[zone.id] = (value, now)
        return value

    def _restore_offsets(self, raw: Any) -> None:
        """Put back the smoothed wall−zone offsets saved before a restart."""
        if not isinstance(raw, dict):
            return
        for zid, pair in raw.items():
            try:
                value, at = float(pair[0]), datetime.fromisoformat(pair[1])
            except (TypeError, ValueError, IndexError):
                continue
            self._offset_filter[zid] = (value, at)

    def _skip_downtime(self, saved_at: Any) -> None:
        """Move the season clocks forward by the time Home Assistant was down.

        A countdown that was 1h into a 3h wait when HA stopped resumes at 1h,
        not at 1h plus the outage — nobody watched the house while it was
        down. The heat/cool "last call" stamps move too, so an outage is not
        read as days with one side of the equipment quiet.
        """
        if not saved_at:
            return
        try:
            gap = datetime.now(timezone.utc) - datetime.fromisoformat(saved_at)
        except (TypeError, ValueError):
            return
        if gap <= timedelta(0):
            return
        for key in (
            "_cooling_conditions_since",
            "_heating_conditions_since",
            "_last_heat_call",
            "_last_cool_call",
        ):
            stamp = getattr(self, key)
            if stamp is not None:
                setattr(self, key, stamp + gap)

    def _ready_to_write(self, zone) -> bool:
        """Whether GTTC may write the wall yet after starting.

        Not until the watched zone has a reading, or an offset saved from
        before the restart can steer — otherwise the first write is the bare
        goal and the next, seconds later, the offset goal. Never longer than
        STARTUP_WRITE_GRACE_MIN, so a dead zone sensor cannot freeze control.
        Once open, what the wall already holds is taken as the last write, so
        an unchanged target writes nothing at all.
        """
        if getattr(self, "_startup_ready", False):
            return True
        now = datetime.now(timezone.utc)
        if not (
            zone is None
            or zone.current_temp is not None
            or zone.id in self._offset_filter
            or now - self._started_at >= timedelta(minutes=STARTUP_WRITE_GRACE_MIN)
        ):
            return False
        self._startup_ready = True
        state = self.hass.states.get(self.thermostat_entity)
        attrs = state.attributes if state else {}
        if self._last_thermostat_temp is None:
            try:
                if attrs.get(ATTR_TEMPERATURE) is not None:
                    self._last_thermostat_temp = float(attrs[ATTR_TEMPERATURE])
            except (TypeError, ValueError):
                pass
        if self._last_thermostat_range is None:
            try:
                lo, hi = attrs.get("target_temp_low"), attrs.get("target_temp_high")
                if lo is not None and hi is not None:
                    self._last_thermostat_range = (float(lo), float(hi))
            except (TypeError, ValueError):
                pass
        return True

    def _ramp_heat_setpoint(self, target: float | None, last: float | None) -> float | None:
        """Step a rise in the wall's heat setpoint on a heat pump.

        A rise of more than HEAT_PUMP_RAMP_STEP goes up from what the wall
        already reads, one step at a time, no more often than every
        HEAT_PUMP_RAMP_INTERVAL_MIN. A step below the room's own reading
        does nothing, so steps start there rather than at an old setback.
        Falls are never slowed: they only ever turn the heat off.
        """
        if target is None or last is None or not self.is_heat_pump:
            return target
        if target <= last:
            return target
        wall = self._get_thermostat_current_temp()
        base = max(last, wall) if wall is not None else last
        if target <= base + HEAT_PUMP_RAMP_STEP:
            return target
        now = datetime.now(timezone.utc)
        if self._last_heat_raise_at is not None and now - self._last_heat_raise_at < timedelta(
            minutes=HEAT_PUMP_RAMP_INTERVAL_MIN
        ):
            return last
        stepped = round(base + HEAT_PUMP_RAMP_STEP, 1)
        _LOGGER.info(
            "Heat pump ramp: wall goal %.1f°, stepping %.1f° → %.1f°",
            target, last, stepped,
        )
        return stepped

    def _get_current_schedule_info(self) -> dict[str, Any] | None:
        if not self.schedule_enabled:
            return None
        entry = self.scheduler.get_current_entry()
        if entry:
            # Must match _calculate_desired_temp: in cooling season an entry
            # without its own cooling_temp runs at cooling_comfort, not at its
            # heating number.
            if self.season == SEASON_COOLING:
                effective_temp = (
                    entry.cooling_temp
                    if entry.cooling_temp is not None
                    else self.cooling_comfort
                )
            else:
                effective_temp = entry.target_temp
            info = {
                "time_start": entry.time_start,
                "time_end": entry.time_end,
                "target_temp": entry.target_temp,
                "cooling_temp": entry.cooling_temp,
                "effective_temp": effective_temp,
                "zone_id": entry.zone_id,
            }
            if self.season == SEASON_HEAT_COOL:
                info["effective_low"] = entry.target_temp
                info["effective_high"] = (
                    entry.cooling_temp if entry.cooling_temp is not None else self.cooling_comfort
                )
            return info
        return None

    async def async_set_temperature(self, temperature: float) -> None:
        """Handle a temperature set from the virtual climate entity (manual adjustment)."""
        if self.season == SEASON_HEAT_COOL:
            # One number in heat/cool re-centres the band around it
            low = self.target_low if self.target_low is not None else temperature - self.heat_cool_min_gap / 2
            high = self.target_high if self.target_high is not None else temperature + self.heat_cool_min_gap / 2
            half = max(self.heat_cool_min_gap, high - low) / 2
            await self.async_set_range(temperature - half, temperature + half)
            return
        # Clamp to valid range
        temperature = max(self.temp_min, min(self.temp_max, temperature))

        self.target_temp = temperature

        # A hold, always. The schedule is only ever changed by someone editing
        # it — before v2.9.0 a third similar hold in the same block rewrote
        # the block, even with learning switched off.
        self.manual_override = ManualOverride(
            target_temp=temperature,
            started_at=datetime.now(timezone.utc).isoformat(),
            duration_minutes=self.manual_override_minutes,
            zone_id=self.zone_manager.active_zone_id,
        )

        # Apply immediately
        await self._set_thermostat_temp(temperature)
        self._last_thermostat_temp = temperature
        await self.async_save()

        self.async_set_updated_data(self._build_state_dict())

    async def async_set_range(self, low: float, high: float) -> None:
        """Hold a heat/cool band (from the climate entity or a dashboard)."""
        low = max(self.temp_min, min(self.temp_max, float(low)))
        high = max(self.temp_min, min(self.temp_max, float(high)))
        if high - low < self.heat_cool_min_gap:
            low = high - self.heat_cool_min_gap
        low, high = round(low, 1), round(high, 1)
        self.manual_override = ManualOverride(
            target_temp=round((low + high) / 2, 1),
            started_at=datetime.now(timezone.utc).isoformat(),
            duration_minutes=self.manual_override_minutes,
            zone_id=self.zone_manager.active_zone_id,
            target_low=low,
            target_high=high,
        )
        self.target_low, self.target_high = low, high
        if self.hvac_mode == HVACMode.HEAT_COOL:
            await self._set_thermostat_range(low, high)
            self._last_thermostat_range = (low, high)
        self._log_action(ACTION_REASON_OVERRIDE, low, high)
        await self.async_save()
        self.async_set_updated_data(self._build_state_dict())

    async def _set_thermostat_range(self, low: float, high: float) -> None:
        """Write both heat/cool setpoints, widening before narrowing.

        The thermostat applies the two setpoints one after the other and keeps
        them at least its Auto Differential apart. Moving a band up by writing
        the new heat end first would, for a moment, sit it inside the old cool
        end — and the thermostat would push the cool end away by itself. So a
        move first writes the union of old and new (always wide enough), then
        the new band.
        """
        if not self._available:
            _LOGGER.warning("Thermostat %s is not available", self.thermostat_entity)
            return
        low, high = round(low, 1), round(high, 1)
        steps: list[tuple[float, float]] = []
        prev = self._known_thermostat_range or self._read_thermostat_range()
        if prev is not None:
            wide = (min(prev[0], low), max(prev[1], high))
            if wide != (low, high) and wide != prev:
                steps.append(wide)
        steps.append((low, high))
        for step_low, step_high in steps:
            self._note_own_write(step_low)
            self._note_own_write(step_high)
            self._known_thermostat_range = (step_low, step_high)
            self._range_write_at = datetime.now(timezone.utc)
            try:
                await self.hass.services.async_call(
                    "climate",
                    "set_temperature",
                    {
                        "entity_id": self.thermostat_entity,
                        "target_temp_low": step_low,
                        "target_temp_high": step_high,
                    },
                    blocking=True,
                )
            except Exception as err:
                _LOGGER.error(
                    "Failed to set heat/cool band on %s to %.1f–%.1f: %s",
                    self.thermostat_entity,
                    step_low,
                    step_high,
                    err,
                )
                return

    def _update_warm_zone(self, cool_goal, heat_goal, active_zone):
        """The zone to cool against instead of the active one, or None.

        The schedule watches one zone; the people may be in another. When the
        warmest zone stays WARM_ZONE_MARGIN over the cool goal for
        WARM_ZONE_MINUTES, cool against it until it is within WARM_ZONE_CLEAR
        — unless that would chill the watched zone toward its heat goal.
        """
        now = datetime.now(timezone.utc)
        zones = [z for z in self.zone_manager.zones.values() if z.current_temp is not None]
        warm = max(zones, key=lambda z: z.current_temp, default=None)
        watched = active_zone.current_temp if active_zone is not None else None
        if (
            warm is None
            or cool_goal is None
            or (active_zone is not None and warm.id == active_zone.id)
        ):
            self._warm_zone_since = None
            self.warm_zone = None
            self._warm_zone_paused = False
            return None
        # Cooling the warm zone cools the watched one faster. Stop at the
        # watched zone's heat goal + WARM_ZONE_FLOOR_MARGIN, but PAUSE — keep
        # the clock and the engaged zone, resume 0.5° later — rather than
        # dropping out and waiting another ten minutes each time
        if watched is not None and heat_goal is not None:
            limit = heat_goal + WARM_ZONE_FLOOR_MARGIN + (0.5 if self._warm_zone_paused else 0.0)
            self._warm_zone_paused = watched <= limit
            if self._warm_zone_paused:
                return None
        if self.warm_zone is not None and self.warm_zone.id == warm.id:
            if warm.current_temp > cool_goal + WARM_ZONE_CLEAR:
                return warm
            self._warm_zone_since = None
            self.warm_zone = None
            return None
        if warm.current_temp <= cool_goal + WARM_ZONE_MARGIN:
            self._warm_zone_since = None
            self.warm_zone = None
            return None
        if self._warm_zone_since is None:
            self._warm_zone_since = now
        if now - self._warm_zone_since >= timedelta(minutes=WARM_ZONE_MINUTES):
            _LOGGER.info(
                "%s is %.1f° against a %.1f° cool goal — cooling against it",
                warm.name, warm.current_temp, cool_goal,
            )
            self.warm_zone = warm
            return warm
        self.warm_zone = None
        return None

    def _hottest_zone(self):
        zones = [z for z in self.zone_manager.zones.values() if z.current_temp is not None]
        return max(zones, key=lambda z: z.current_temp, default=None)

    def _update_overheat(self, cool_goal, heat_goal, active_zone, track: bool):
        """(engaged, zone to cool against) — the lockout's escape hatch.

        Any zone (the watched one included) OVERHEAT_MARGIN over the cool goal
        for WARM_ZONE_MINUTES lifts the lockout until it is within
        WARM_ZONE_CLEAR. ``track`` False (no lockout in force, or below the
        hard floor) clears it.
        """
        hot = self._hottest_zone()
        hot_temp = hot.current_temp if hot is not None else self.current_temp
        watched = active_zone.current_temp if active_zone is not None else None
        if not track or cool_goal is None or hot_temp is None:
            self._overheat_since = None
            self.overheat_active = False
            self._overheat_paused = False
            return False, None
        # Cooling a hot downstairs cools the watched floor faster (2.3 vs
        # 1.3 °F/h here). Let it go down to its heat goal, then PAUSE — keep
        # the timer and the engaged state, resume 0.5° later — instead of
        # dropping out and waiting another ten minutes each time.
        if hot is not None and active_zone is not None and hot.id != active_zone.id \
                and watched is not None and heat_goal is not None:
            limit = heat_goal + (0.5 if self._overheat_paused else 0.0)
            self._overheat_paused = watched <= limit
            if self._overheat_paused:
                return False, None
        if self.overheat_active:
            if hot_temp > cool_goal + WARM_ZONE_CLEAR:
                return True, hot
            self._overheat_since = None
            self.overheat_active = False
            return False, None
        if hot_temp <= cool_goal + OVERHEAT_MARGIN:
            self._overheat_since = None
            return False, None
        now = datetime.now(timezone.utc)
        if self._overheat_since is None:
            self._overheat_since = now
        if now - self._overheat_since >= timedelta(minutes=WARM_ZONE_MINUTES):
            _LOGGER.info(
                "%.1f° against a %.1f° cool goal on a cold day — lifting the AC lockout",
                hot_temp, cool_goal,
            )
            self.overheat_active = True
            return True, hot
        return False, None

    async def _update_heat_cool(self, active_zone) -> None:
        """One control cycle in heat/cool: compute both ends and write the band."""
        now = datetime.now(timezone.utc)
        gap = self.heat_cool_min_gap
        override = (
            self.manual_override
            if self.manual_override and not self.manual_override.is_expired
            else None
        )
        self._gap_adjusted_from = None

        if override is not None:
            reason = (
                ACTION_REASON_PHYSICAL_OVERRIDE if override.is_physical else ACTION_REASON_OVERRIDE
            )
            if override.is_range:
                low, high = override.target_low, override.target_high
            else:
                # A single-number hold from before the switch: centre a band on it
                low, high = override.target_temp - gap / 2, override.target_temp + gap / 2
            low_reason = high_reason = reason
        else:
            low, low_reason = self._calculate_desired_temp(SEASON_HEATING)
            high, high_reason = self._calculate_desired_temp(SEASON_COOLING)

        cur = self.current_temp
        reason = high_reason if cur is not None and cur > high else low_reason

        # Goal-level cool end the house is judged against (the lockout may
        # park what is written, never what "above the band" means)
        cool_goal = high
        # The AC stays off on a cold day; the fan moves the warm air instead.
        # A hold or a boost is someone asking for it — it always gets the AC.
        locked = (
            override is None
            and self._outdoor_temp is not None
            and self._outdoor_temp < self.cool_lockout_temp
        )
        # A real overheat (a party, the oven) lifts the lockout — except below
        # the hard floor, where only a hold runs the compressor
        over, over_zone = self._update_overheat(
            cool_goal, low, active_zone,
            track=locked and self._outdoor_temp >= COOL_HARD_FLOOR,
        )
        if over:
            locked = False
        self.cool_locked_out = locked
        warm = (
            self._update_warm_zone(cool_goal, low, active_zone)
            if override is None
            else self._update_warm_zone(None, None, None)
        )
        if over:
            warm = over_zone
        if locked:
            # Judge the fan by the warmest zone, not only the watched one
            hottest = max(
                (t for t in [cur] + [z.current_temp for z in self.zone_manager.zones.values()]
                 if t is not None),
                default=None,
            )
            want_fan = hottest is not None and hottest > cool_goal + 0.5
            if want_fan:
                await self._fan_run()
            else:
                await self._fan_release()
        else:
            await self._fan_release()
            if over:
                reason = ACTION_REASON_OVERHEAT
            elif warm is not None:
                reason = ACTION_REASON_WARM_ZONE

        t_low = self._calculate_thermostat_target(low, active_zone)
        t_high = self._calculate_thermostat_target(high, warm or active_zone)
        if locked:
            t_high = max(t_high, min(self.get_thermostat_max_temp(), COOL_LOCKOUT_PARK))
            if cur is not None and cur > cool_goal:
                reason = ACTION_REASON_COOL_LOCKOUT

        # Keep the thermostat's own minimum gap by lowering the heat end —
        # measured against the cool GOAL, so the heat end does not jump each
        # time fan pre-cool or the lockout raises what is written above it
        t_cool_goal = self._calculate_thermostat_target(cool_goal, warm or active_zone)
        if t_cool_goal - t_low < gap:
            shift = t_low - (t_cool_goal - gap)
            self._gap_adjusted_from = round(low, 1)
            low -= shift
            t_low -= shift

        # Heat pump: the heat end rises in steps, as in heat season
        if override is None:
            last_low = self._last_thermostat_range[0] if self._last_thermostat_range else None
            ramped = self._ramp_heat_setpoint(t_low, last_low)
            if ramped != t_low:
                t_low = ramped
                if not (cur is not None and cur > high):
                    reason = ACTION_REASON_HEAT_PUMP

        t_low, t_high = round(t_low, 1), round(t_high, 1)
        self.target_low, self.target_high = round(low, 1), round(cool_goal, 1)
        # target_temp keeps meaning "the heating goal" so the heating fallback
        # and boosts that read it behave as they do in heat season
        self.target_temp = self.target_low
        self._log_action(reason, self.target_low, self.target_high)

        if self.hvac_mode != HVACMode.HEAT_COOL:
            # Off, or mid-switch: never write a band into another mode
            return
        if not self._ready_to_write(active_zone):
            return

        last = self._last_thermostat_range
        if (
            last is None
            or abs(t_low - last[0]) >= TEMP_HYSTERESIS
            or abs(t_high - last[1]) >= TEMP_HYSTERESIS
        ):
            if last is not None and t_low > last[0]:
                self._last_heat_raise_at = datetime.now(timezone.utc)
            await self._set_thermostat_range(t_low, t_high)
            self._last_thermostat_range = (t_low, t_high)
            self._range_mismatch_since = None
            return

        # Did the thermostat keep what we wrote?
        reported = self._read_thermostat_range()
        mismatch = reported is not None and (
            abs(reported[0] - last[0]) >= PHYSICAL_CHANGE_THRESHOLD
            or abs(reported[1] - last[1]) >= PHYSICAL_CHANGE_THRESHOLD
        )
        if not mismatch or self._within_range_settle() or override is not None:
            self._range_mismatch_since = None
            return
        if self._range_mismatch_since is None:
            self._range_mismatch_since = now
            return
        if now - self._range_mismatch_since < RANGE_MISMATCH_GRACE:
            return
        if self._range_rewrite_at is not None and now - self._range_rewrite_at < RANGE_REWRITE_INTERVAL:
            return
        _LOGGER.warning(
            "Thermostat reports %.1f–%.1f° but GTTC wrote %.1f–%.1f° — writing again",
            reported[0],
            reported[1],
            last[0],
            last[1],
        )
        self._range_rewrite_at = now
        self._range_mismatch_since = None
        await self._set_thermostat_range(*last)

    async def _set_thermostat_temp(self, temperature: float) -> None:
        """Set the real thermostat's target temperature."""
        if not self._available:
            _LOGGER.warning("Thermostat %s is not available", self.thermostat_entity)
            return

        # Mark this as our own write before the call so the resulting state
        # change isn't mistaken for someone changing the wall unit.
        self._note_own_write(temperature)

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
        # The mode's stored setpoint is about to be reported back — make sure
        # it isn't taken for someone changing the wall unit.
        self._mode_changed_at = datetime.now(timezone.utc)
        self._own_mode_write_at = self._mode_changed_at
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
            # Invalidate the last-sent setpoint so the next update always
            # pushes the correct temp to the thermostat (old heat setpoint
            # is meaningless in cool mode and vice-versa).
            self._last_thermostat_temp = None
            self._last_thermostat_range = None
            self._known_thermostat_range = None
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
        if "outdoor_temp_sensor" in updates:
            self.outdoor_temp_sensor = updates["outdoor_temp_sensor"] or ""
        if "cooling_comfort" in updates:
            self.cooling_comfort = float(updates["cooling_comfort"])
        if "cooling_away_temp" in updates:
            self.cooling_away_temp = float(updates["cooling_away_temp"])
        if "seasonal_recommend_hours" in updates:
            self.seasonal_recommend_hours = float(updates["seasonal_recommend_hours"])
        if "auto_season_switch" in updates:
            self.auto_season_switch = bool(updates["auto_season_switch"])
        for key in ("cool_lockout_temp", "heat_cool_settle_days", "heat_cool_min_gap"):
            if key in updates:
                setattr(self, key, float(updates[key]))

        await self.async_save()
        self.async_set_updated_data(self._build_state_dict())

    # ------------------------------------------------------------------
    # Season management
    # ------------------------------------------------------------------

    def _heat_cool_quiet(self) -> tuple[str | None, datetime | None]:
        """In heat/cool: the season to leave for, and since when the other
        side of the equipment has been quiet. (None, None) while both sides are
        still working, or while neither is (mild weather is what heat/cool is
        for — nothing to leave for)."""
        hc, cc = self._last_heat_call, self._last_cool_call
        if hc is None or cc is None:
            return None, None
        window = timedelta(days=self.heat_cool_settle_days)
        now = datetime.now(timezone.utc)
        if cc <= hc and now - hc <= window:
            return SEASON_HEATING, cc
        if hc < cc and now - cc <= window:
            return SEASON_COOLING, hc
        return None, None

    @property
    def season_threshold_hours(self) -> float:
        """How long the current season's switch condition must hold."""
        if self.season == SEASON_HEAT_COOL:
            return round(self.heat_cool_settle_days * 24, 1)
        return self.seasonal_recommend_hours

    @property
    def recommended_season(self) -> str | None:
        """Where the current conditions point, whether or not they have held
        long enough yet."""
        if self.season == SEASON_HEATING and self._cooling_conditions_since is not None:
            return SEASON_COOLING
        if self.season == SEASON_COOLING and self._heating_conditions_since is not None:
            return SEASON_HEATING
        if self.season == SEASON_HEAT_COOL:
            return self._heat_cool_quiet()[0]
        return None

    @property
    def suggest_season_switch(self) -> bool:
        """True when outdoor conditions have been opposite to the current season
        for at least ``seasonal_recommend_hours``.  This is a signal to the user
        that it is likely time to switch — the system never acts on it
        automatically."""
        now = datetime.now(timezone.utc)
        if self.season == SEASON_HEAT_COOL:
            target, since = self._heat_cool_quiet()
            if target is None:
                return False
            return (now - since).total_seconds() / 3600 >= self.season_threshold_hours
        if self.season == SEASON_HEATING and self._cooling_conditions_since is not None:
            elapsed = (now - self._cooling_conditions_since).total_seconds() / 3600
            return elapsed >= self.season_threshold_hours
        if self.season == SEASON_COOLING and self._heating_conditions_since is not None:
            elapsed = (now - self._heating_conditions_since).total_seconds() / 3600
            return elapsed >= self.seasonal_recommend_hours
        return False

    @property
    def season_conditions_hours(self) -> float:
        """Hours that opposite-season conditions have been sustained.
        Returns 0.0 when conditions are neutral or no outdoor sensor is available."""
        now = datetime.now(timezone.utc)
        if self.season == SEASON_HEAT_COOL:
            target, since = self._heat_cool_quiet()
            return round((now - since).total_seconds() / 3600, 1) if target else 0.0
        if self.season == SEASON_HEATING and self._cooling_conditions_since is not None:
            return round(
                (now - self._cooling_conditions_since).total_seconds() / 3600, 1
            )
        if self.season == SEASON_COOLING and self._heating_conditions_since is not None:
            return round(
                (now - self._heating_conditions_since).total_seconds() / 3600, 1
            )
        return 0.0

    def _season_goal(self, season: str) -> float:
        """The temperature the given season would aim for right now."""
        entry = self.scheduler.get_current_entry() if self.schedule_enabled else None
        if season == SEASON_COOLING:
            if entry is not None and entry.cooling_temp is not None:
                return entry.cooling_temp
            return self.cooling_comfort
        if entry is not None:
            return entry.target_temp
        return self._default_comfort_temp

    def _update_season_recommendation(self) -> None:
        """Track how long outdoor conditions have been opposite to the current season.

        Updates the internal timestamps that power SeasonSwitchRecommendedBinarySensor
        and SeasonRecommendationSensor.  If auto_season_switch is enabled, triggers
        an automatic season change once the threshold is reached.

        Resets the countdown whenever conditions reverse, so a brief warm day
        in winter doesn't linger in the counter.
        """
        now = datetime.now(timezone.utc)
        if self.season == SEASON_HEAT_COOL:
            # Which side of the equipment is still doing any work
            if self.hvac_action == HVACAction.HEATING:
                self._last_heat_call = now
            elif self.hvac_action == HVACAction.COOLING:
                self._last_cool_call = now
            self._cooling_conditions_since = None
            self._heating_conditions_since = None
            self._maybe_auto_switch()
            return

        if self._outdoor_temp is None or self.current_temp is None:
            self._cooling_conditions_since = None
            self._heating_conditions_since = None
            return

        # Demand, not weather, decides. The house must be past the OTHER
        # season's goal by SEASON_DEMAND_MARGIN, with the current season's
        # equipment idle (if it is running, the house wants this season).
        #  - To cooling: the house alone. A heated house sitting at 75° with
        #    the heat idle needs cooling whatever the outdoor temperature —
        #    on 9/24–29 every manual switch to cool had outdoor COOLER than
        #    indoor, and fan pre-cool uses that cool air once in cool mode.
        #  - To heating: a cold house AND a cold outside, so a warm-day AC
        #    overshoot can never read as winter.
        if self.season == SEASON_HEATING:
            if (
                self.current_temp > self._season_goal(SEASON_COOLING) + SEASON_DEMAND_MARGIN
                and self.hvac_action != HVACAction.HEATING
            ):
                if self._cooling_conditions_since is None:
                    self._cooling_conditions_since = now
                    _LOGGER.debug(
                        "Cooling conditions started: indoor %.1f° > cool goal %.1f° + %.1f°",
                        self.current_temp,
                        self._season_goal(SEASON_COOLING),
                        SEASON_DEMAND_MARGIN,
                    )
                self._heating_conditions_since = None
            else:
                if self._cooling_conditions_since is not None:
                    _LOGGER.debug(
                        "Cooling conditions ended after %.1fh — resetting countdown",
                        self.season_conditions_hours,
                    )
                self._cooling_conditions_since = None
        else:  # SEASON_COOLING
            if (
                self._outdoor_temp < self.current_temp - SEASONAL_SWITCH_MARGIN
                and self.current_temp < self._season_goal(SEASON_HEATING) - SEASON_DEMAND_MARGIN
                and self.hvac_action != HVACAction.COOLING
            ):
                if self._heating_conditions_since is None:
                    self._heating_conditions_since = now
                    _LOGGER.debug(
                        "Heating conditions started: outdoor %.1f° < indoor %.1f° - %.1f°",
                        self._outdoor_temp,
                        self.current_temp,
                        SEASONAL_SWITCH_MARGIN,
                    )
                self._cooling_conditions_since = None
            else:
                if self._heating_conditions_since is not None:
                    _LOGGER.debug(
                        "Heating conditions ended after %.1fh — resetting countdown",
                        self.season_conditions_hours,
                    )
                self._heating_conditions_since = None

        self._maybe_auto_switch()

    def _maybe_auto_switch(self) -> None:
        """Act on a recommendation that has held long enough, if allowed."""
        if (
            self.auto_season_switch
            and self.suggest_season_switch
            and not self._auto_switch_pending
        ):
            target = self.recommended_season
            if target is None:
                return
            _LOGGER.info(
                "Auto-switching season %s → %s after %.1fh of sustained conditions",
                self.season,
                target,
                self.season_conditions_hours,
            )
            self._auto_switch_pending = True
            self.hass.async_create_task(self._do_auto_season_switch(target))

    async def _do_auto_season_switch(self, target_season: str) -> None:
        """Execute the auto season switch and clear the pending guard."""
        try:
            await self.async_set_season(target_season)
        finally:
            self._auto_switch_pending = False

    async def async_set_season(self, season: str, apply_hvac: bool = True) -> None:
        """Switch season and immediately update the real thermostat's HVAC mode.

        Called by SeasonModeSelect when the user deliberately changes the season.
        Clears any pending recommendation tracking so the countdown starts fresh
        from the new season baseline.
        """
        if season not in SEASONS:
            _LOGGER.warning("Invalid season value: %s", season)
            return
        if (
            season == SEASON_HEAT_COOL
            and apply_hvac
            and HVACMode.HEAT_COOL not in self.get_thermostat_hvac_modes()
        ):
            _LOGGER.warning(
                "Thermostat %s has no heat_cool mode — staying in %s season",
                self.thermostat_entity,
                self.season,
            )
            return

        old_season = self.season
        self.season = season
        if old_season != season:
            if season == SEASON_HEAT_COOL:
                now = datetime.now(timezone.utc)
                self._last_heat_call = now
                self._last_cool_call = now
            if old_season == SEASON_HEAT_COOL:
                self.target_low = self.target_high = None
                self.cool_locked_out = False
                self._gap_adjusted_from = None
                self._last_thermostat_range = None
                self._known_thermostat_range = None
                await self._fan_release()

        # Clear recommendation tracking — the user just made a deliberate call
        self._cooling_conditions_since = None
        self._heating_conditions_since = None

        if old_season != season:
            _LOGGER.info(
                "Season switched %s → %s — applying HVAC mode immediately",
                old_season,
                season,
            )
            # A hold or boost stores an absolute temperature chosen for the old
            # season: a Max Cool 70° carried into heat season heats to 70°.
            if self.manual_override is not None:
                _LOGGER.info(
                    "Cancelling %.1f° %s hold — it was set for %s season",
                    self.manual_override.target_temp,
                    self.manual_override.source,
                    old_season,
                )
                self.manual_override = None
            if apply_hvac:
                await self._apply_season_hvac_mode()
            else:
                # The wall already changed mode; still push the new season's
                # setpoint instead of the mode's stored one.
                self._last_thermostat_temp = None

        await self.async_save()
        # Full recalculation so the target temperature also updates immediately
        await self.async_request_refresh()

    async def _apply_season_hvac_mode(self) -> None:
        """Switch the real thermostat's HVAC mode to match the current season.

        Only acts when the thermostat is available, not in off mode, and the
        target mode is supported.  Falls back gracefully with a warning when
        the thermostat doesn't advertise the needed mode.
        """
        if not self._available:
            _LOGGER.debug(
                "Thermostat unavailable — deferring HVAC mode switch to next update"
            )
            return

        if self.hvac_mode in (HVACMode.OFF, None):
            _LOGGER.debug(
                "Thermostat is off — leaving HVAC mode unchanged for season switch"
            )
            return

        supported = self.get_thermostat_hvac_modes()

        if self.season == SEASON_COOLING:
            if HVACMode.COOL in supported:
                await self.async_set_hvac_mode(HVACMode.COOL)
                _LOGGER.info("HVAC mode → cool (cooling season)")
            else:
                _LOGGER.warning(
                    "Thermostat does not support cool mode — season set to cooling "
                    "but HVAC mode unchanged (%s)",
                    self.hvac_mode,
                )
        elif self.season == SEASON_HEAT_COOL:
            if HVACMode.HEAT_COOL in supported:
                await self.async_set_hvac_mode(HVACMode.HEAT_COOL)
                _LOGGER.info("HVAC mode → heat_cool (heat/cool season)")
            else:
                _LOGGER.warning(
                    "Thermostat does not support heat_cool — HVAC mode unchanged (%s)",
                    self.hvac_mode,
                )
        else:  # SEASON_HEATING
            if HVACMode.HEAT in supported:
                await self.async_set_hvac_mode(HVACMode.HEAT)
                _LOGGER.info("HVAC mode → heat (heating season)")
            elif HVACMode.HEAT_COOL in supported:
                await self.async_set_hvac_mode(HVACMode.HEAT_COOL)
                _LOGGER.info("HVAC mode → heat_cool (heating season, heat not available)")
            else:
                _LOGGER.warning(
                    "Thermostat does not support heat mode — season set to heating "
                    "but HVAC mode unchanged (%s)",
                    self.hvac_mode,
                )

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
        # A door opened to let the dog out is not a window left open: park
        # only once something has stayed open WINDOW_OPEN_GRACE. Parking
        # stops a running compressor, and the 5-min minimum off then costs a
        # restart for a 40-second door.
        if not self._window_raw_open():
            self._window_open_since = None
            return False
        now = datetime.now(timezone.utc)
        if self._window_open_since is None:
            self._window_open_since = now
        return now - self._window_open_since >= WINDOW_OPEN_GRACE

    def _window_raw_open(self) -> bool:
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

    # ------------------------------------------------------------------
    # Action log
    # ------------------------------------------------------------------

    def _log_action(
        self, reason: str, target_temp: float, target_high: float | None = None
    ) -> None:
        """Append a setpoint decision to the ring buffer."""
        self._last_action_reason = reason
        # Record decisions, not cycles: a 30s loop repeating the same reason and
        # temperature filled the 200-entry buffer in 100 minutes.
        rounded = round(target_temp, 1)
        high = round(target_high, 1) if target_high is not None else None
        if (
            self.action_log
            and self.action_log[-1]["reason"] == reason
            and self.action_log[-1]["target_temp"] == rounded
            and self.action_log[-1].get("target_high") == high
        ):
            return
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "reason": reason,
            "target_temp": rounded,
        }
        if high is not None:
            entry["target_high"] = high
        self.action_log.append(entry)
        if len(self.action_log) > ACTION_LOG_MAX:
            self.action_log.pop(0)

    # ------------------------------------------------------------------
    # Vacation mode
    # ------------------------------------------------------------------

    async def async_set_vacation(
        self,
        setback_temp: float,
        start_dt: str,
        end_dt: str,
        label: str = "Vacation",
    ) -> None:
        """Activate vacation mode with a return date."""
        self.vacation_mode = VacationMode(
            setback_temp=setback_temp,
            start_dt=start_dt,
            end_dt=end_dt,
            label=label,
        )
        await self.async_save()
        self.async_set_updated_data(self._build_state_dict())
        _LOGGER.info(
            "Vacation mode set: %.1f° from %s to %s",
            setback_temp, start_dt, end_dt,
        )

    async def async_clear_vacation(self) -> None:
        """Cancel vacation mode immediately."""
        self.vacation_mode = None
        await self.async_save()
        self.async_set_updated_data(self._build_state_dict())
        _LOGGER.info("Vacation mode cleared")

    # ------------------------------------------------------------------
    # Timed presets / boost buttons
    # ------------------------------------------------------------------

    async def async_activate_timed_preset(self, boost_type: str) -> None:
        """Activate a boost/warm-up/cool-down timed temperature adjustment."""
        if boost_type not in BOOST_TYPES:
            _LOGGER.warning("Unknown boost type: %s", boost_type)
            return
        cfg = BOOST_TYPES[boost_type]
        if self.season == SEASON_HEAT_COOL and self.target_low is not None and self.target_high is not None:
            await self.async_set_range(
                self.target_low + cfg["delta"], self.target_high + cfg["delta"]
            )
            if self.manual_override is not None:
                self.manual_override.duration_minutes = cfg["minutes"]
                await self.async_save()
            return
        base = self.target_temp or self._default_comfort_temp
        target = base + cfg["delta"]
        target = max(self.temp_min, min(self.temp_max, target))
        self.manual_override = ManualOverride(
            target_temp=target,
            started_at=datetime.now(timezone.utc).isoformat(),
            duration_minutes=cfg["minutes"],
            zone_id=self.zone_manager.active_zone_id,
        )
        await self._set_thermostat_temp(target)
        self._last_thermostat_temp = target
        await self.async_save()
        self.async_set_updated_data(self._build_state_dict())
        _LOGGER.info(
            "Timed preset '%s': %.1f° for %d min",
            cfg["label"], target, cfg["minutes"],
        )

    # ------------------------------------------------------------------
    # Fan control (the heat/cool lockout fan)
    # ------------------------------------------------------------------

    def _thermostat_fan_modes(self) -> list[str]:
        state = self.hass.states.get(self.thermostat_entity)
        if state is None:
            return []
        return list(state.attributes.get("fan_modes") or [])

    def _fan_on_mode(self) -> str | None:
        """The thermostat's own name for "fan running continuously".

        The T6 offers Auto low / Low / Circulation — there is no "on", and a
        set_fan_mode of "on" is refused (logged by HA, invisible to a
        non-blocking caller). Before v2.5.0 every fan pre-cool and lockout
        fan request was that refused "on".
        """
        modes = self._thermostat_fan_modes()
        for mode in FAN_ON_PREFERENCE:
            if mode in modes:
                return mode
        return None

    def _fan_auto_mode(self) -> str | None:
        for mode in self._thermostat_fan_modes():
            if "auto" in mode.lower():
                return mode
        return None

    async def _set_fan_mode(self, mode: str) -> bool:
        try:
            await self.hass.services.async_call(
                "climate",
                "set_fan_mode",
                {"entity_id": self.thermostat_entity, "fan_mode": mode},
                blocking=True,
            )
            return True
        except Exception as err:
            _LOGGER.warning("Thermostat refused fan mode %s: %s", mode, err)
            return False

    async def _fan_run(self) -> bool:
        """Run the fan continuously. False when the thermostat cannot."""
        if self._fan_running:
            return True
        mode = self._fan_on_mode()
        if mode is None:
            return False
        state = self.hass.states.get(self.thermostat_entity)
        current = state.attributes.get("fan_mode") if state else None
        if not await self._set_fan_mode(mode):
            return False
        self._fan_restore_mode = current if current != mode else self._fan_auto_mode()
        self._fan_running = True
        return True

    async def _fan_release(self) -> None:
        """Hand the fan back as it was — unless someone else changed it since."""
        if not self._fan_running:
            return
        self._fan_running = False
        state = self.hass.states.get(self.thermostat_entity)
        current = state.attributes.get("fan_mode") if state else None
        if current is not None and current != self._fan_on_mode():
            return  # a vacuum sweep, a person: theirs now
        modes = self._thermostat_fan_modes()
        restore = self._fan_restore_mode if self._fan_restore_mode in modes else self._fan_auto_mode()
        if restore:
            await self._set_fan_mode(restore)

    # ------------------------------------------------------------------
    # Runtime tracking & heating failure detection
    # ------------------------------------------------------------------

    async def _update_runtime_tracking(self) -> None:
        """Accumulate daily HVAC runtime and detect heating failures."""
        now = datetime.now(timezone.utc)
        # Local calendar day — a UTC day rolled the runtime over at 8 pm
        today = now.astimezone().strftime("%Y-%m-%d")

        # Roll over to a new day
        if self._today_date != today:
            if self._today_date:
                self._save_daily_runtime(self._today_date)
            self._today_date = today
            self._today_heating_min = 0.0
            self._today_cooling_min = 0.0
            self._today_outdoor_sum = 0.0
            self._today_outdoor_n = 0

        if self._outdoor_temp is not None:
            self._today_outdoor_sum += self._outdoor_temp
            self._today_outdoor_n += 1

        is_heating = self.hvac_action in (HVACAction.HEATING,)
        is_cooling = self.hvac_action in (HVACAction.COOLING,)
        is_active = is_heating or is_cooling

        # Accumulate runtime (30s update cycle → 0.5 min per cycle)
        if is_heating:
            self._today_heating_min += 0.5
        elif is_cooling:
            self._today_cooling_min += 0.5

        # Save every ten minutes so a restart loses at most that much
        if self._last_runtime_save is None or now - self._last_runtime_save >= timedelta(minutes=10):
            self._last_runtime_save = now
            await self.async_save()

        # Track start of HVAC run for failure detection — against the
        # thermostat's own reading, the one its setpoint is judged by
        wall = self._get_thermostat_current_temp()
        if is_active and self._hvac_run_start is None:
            self._hvac_run_start = now
            self._hvac_run_start_temp = wall
        elif not is_active:
            self._hvac_run_start = None
            self._hvac_run_start_temp = None

        # Heating failure: a long run that has not moved the wall AND is still
        # well short of the setpoint. A heat pump holding temperature on a
        # cold night runs for hours with no rise — that is not a failure.
        heat_sp = None
        if self.hvac_mode == HVACMode.HEAT:
            heat_sp = self._read_thermostat_setpoint()
        elif self.hvac_mode == HVACMode.HEAT_COOL:
            band = self._read_thermostat_range()
            heat_sp = band[0] if band else None
        if (
            is_heating
            and self._hvac_run_start is not None
            and self._hvac_run_start_temp is not None
            and wall is not None
            and heat_sp is not None
            and heat_sp - wall >= HEATING_FAILURE_SHORTFALL
            and (self._outdoor_temp is None or self._outdoor_temp >= HEATING_FAILURE_MIN_OUTDOOR)
        ):
            run_minutes = (now - self._hvac_run_start).total_seconds() / 60
            if run_minutes >= HEATING_FAILURE_RUN_MINUTES:
                temp_change = wall - self._hvac_run_start_temp
                recent = (
                    self._last_failure_alert is not None
                    and now - self._last_failure_alert < timedelta(hours=HEATING_FAILURE_COOLDOWN_H)
                )
                if temp_change < HEATING_FAILURE_TEMP_DELTA and not recent:
                    self._last_failure_alert = now
                    _LOGGER.warning(
                        "Heating failure detected: ran %.0f min, temp changed only %.1f°",
                        run_minutes, temp_change,
                    )
                    await self._notify_heating_failure(run_minutes, temp_change)
                    # Reset so we don't spam — check again after another full window
                    self._hvac_run_start = now
                    self._hvac_run_start_temp = wall

    def _restore_today_runtime(self, tr: Any) -> None:
        """Put back the day's minutes after a restart.

        The same day carries on where it stopped; a day that ended while Home
        Assistant was down is written to the history it never reached.
        """
        if not isinstance(tr, dict) or not tr.get("date"):
            return
        today = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d")
        try:
            heat = float(tr.get("heating_min") or 0)
            cool = float(tr.get("cooling_min") or 0)
            osum = float(tr.get("outdoor_sum") or 0)
            on = int(tr.get("outdoor_n") or 0)
        except (TypeError, ValueError):
            return
        self._today_heating_min, self._today_cooling_min = heat, cool
        self._today_outdoor_sum, self._today_outdoor_n = osum, on
        self._today_date = tr["date"]
        if tr["date"] != today:
            self._save_daily_runtime(tr["date"])
            self._today_date = today
            self._today_heating_min = self._today_cooling_min = 0.0
            self._today_outdoor_sum, self._today_outdoor_n = 0.0, 0

    def today_outdoor_avg(self) -> float | None:
        """Average outside reading so far today, or the live one before any sample."""
        if self._today_outdoor_n:
            return round(self._today_outdoor_sum / self._today_outdoor_n, 2)
        return self._outdoor_temp

    def _save_daily_runtime(self, date: str) -> None:
        """Append the current day's runtime totals to the history.

        A day already in the history (a restart can roll the same date over
        twice) is merged into its row rather than added as a second one.
        """
        row = {
            "date": date,
            "heating_min": round(self._today_heating_min, 1),
            "cooling_min": round(self._today_cooling_min, 1),
            "avg_outdoor": self.today_outdoor_avg(),
        }
        self.runtime_history = _merge_runtime_days(self.runtime_history + [row])
        while len(self.runtime_history) > RUNTIME_HISTORY_MAX_DAYS:
            self.runtime_history.pop(0)

    async def _notify_heating_failure(
        self, run_minutes: float, temp_change: float
    ) -> None:
        """Send a heating-failure notification to Brian only."""
        try:
            await self.hass.services.async_call(
                "notify",
                BRIAN_NOTIFY_SERVICE,
                {
                    "title": "⚠️ GTTC: Heating May Be Failing",
                    "message": (
                        f"Heating has run for {run_minutes:.0f} min but the temperature "
                        f"has only changed {temp_change:+.1f}°F. "
                        "Check filters, vents, or the furnace."
                    ),
                },
                blocking=False,
            )
        except Exception as err:
            _LOGGER.warning("Could not send heating failure notification: %s", err)
