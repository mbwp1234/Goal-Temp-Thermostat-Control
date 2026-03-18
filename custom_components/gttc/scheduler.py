"""Schedule management for GTTC."""
from __future__ import annotations

import logging
from datetime import datetime, time, timezone
from typing import Any

from .const import (
    ALL_DAYS,
    SCHEDULE_MODE_PER_DAY,
    SCHEDULE_MODE_WEEKDAY_WEEKEND,
    WEEKDAYS,
    WEEKEND,
    PRESET_AWAY,
    PRESET_HOME,
    PRESET_SLEEP,
    PRESET_WORK_FROM_HOME,
)
from .models import DaySchedule, PresetSchedule, Schedule, ScheduleEntry

_LOGGER = logging.getLogger(__name__)


def _default_presets(temp_min: float, temp_max: float) -> dict[str, PresetSchedule]:
    """Create default preset schedules.

    Temperatures follow DOE / ENERGY STAR guidelines:
    - Comfort (occupied): 68°F — the DOE-recommended winter setpoint.
    - Sleep:  62°F — DOE recommends 60-65°F while sleeping for up to
      10% annual savings on heating/cooling.
    - Away:   temp_min + 4 (≈54-62°F) — DOE recommends lowering the
      thermostat 7-10°F for 8+ hours when away.

    Previous defaults used ``mid + 4`` for comfort (74°F with 50-90
    range) and ``mid - 2`` (68°F) for sleep, which were warmer than
    optimal for energy efficiency.
    """
    mid = round((temp_min + temp_max) / 2)
    # DOE recommends 68°F for occupied heating; clamp to configured range
    comfort = max(temp_min, min(temp_max, 68.0))
    # DOE recommends 60-65°F for sleep; use 62°F as a good balance
    sleep_temp = max(temp_min, min(temp_max, comfort - 6))
    away_temp = temp_min + 4

    home_entries = [
        ScheduleEntry("06:00", "08:00", comfort),
        ScheduleEntry("08:00", "12:00", comfort),
        ScheduleEntry("12:00", "17:00", comfort),
        ScheduleEntry("17:00", "22:00", comfort),
        ScheduleEntry("22:00", "06:00", sleep_temp),
    ]

    wfh_entries = [
        ScheduleEntry("06:00", "08:00", comfort),
        ScheduleEntry("08:00", "18:00", comfort + 1),
        ScheduleEntry("18:00", "22:00", comfort),
        ScheduleEntry("22:00", "06:00", sleep_temp),
    ]

    away_entries = [
        ScheduleEntry("00:00", "23:59", away_temp),
    ]

    sleep_entries = [
        ScheduleEntry("00:00", "23:59", sleep_temp),
    ]

    presets = {}
    for name, label, entries in [
        (PRESET_HOME, "Home All Day", home_entries),
        (PRESET_WORK_FROM_HOME, "Work From Home", wfh_entries),
        (PRESET_AWAY, "Away", away_entries),
        (PRESET_SLEEP, "Sleep", sleep_entries),
    ]:
        presets[name] = PresetSchedule(
            name=name,
            label=label,
            schedule={day: DaySchedule(entries=list(entries)) for day in ALL_DAYS},
        )

    return presets


class Scheduler:
    """Manages time-based temperature schedules."""

    def __init__(self, temp_min: float = 50.0, temp_max: float = 90.0) -> None:
        self.schedule = Schedule()
        self.presets: dict[str, PresetSchedule] = _default_presets(temp_min, temp_max)
        self.temp_min = temp_min
        self.temp_max = temp_max
        self.enabled = True

    def get_current_entry(self, now: datetime | None = None) -> ScheduleEntry | None:
        """Get the schedule entry active right now."""
        if not self.enabled:
            return None

        try:
            if now is None:
                now = datetime.now(timezone.utc).astimezone()

            day_name = now.strftime("%A").lower()
            current_time = now.time()

            # If a preset is active, use the preset schedule
            if self.schedule.active_preset and self.schedule.active_preset in self.presets:
                preset = self.presets[self.schedule.active_preset]
                day_schedule = preset.schedule.get(day_name)
                if day_schedule:
                    return self._find_entry_for_time(day_schedule, current_time)

            # Per-day mode
            if self.schedule.mode == SCHEDULE_MODE_PER_DAY:
                day_schedule = self.schedule.per_day.get(day_name)
                if day_schedule:
                    return self._find_entry_for_time(day_schedule, current_time)
                return None

            # Weekday/weekend mode (default)
            if day_name in WEEKDAYS:
                return self._find_entry_for_time(self.schedule.weekday, current_time)
            else:
                return self._find_entry_for_time(self.schedule.weekend, current_time)
        except Exception as err:
            _LOGGER.warning("Error getting current schedule entry: %s", err)
            return None

    def _find_entry_for_time(
        self, day_schedule: DaySchedule, current_time: time
    ) -> ScheduleEntry | None:
        """Find the entry that covers the given time."""
        for entry in day_schedule.entries:
            try:
                start = entry.start_time
                end = entry.end_time

                if start <= end:
                    if start <= current_time < end:
                        return entry
                else:
                    # Overnight range (e.g., 22:00 - 06:00)
                    if current_time >= start or current_time < end:
                        return entry
            except Exception as err:
                _LOGGER.debug("Error evaluating schedule entry: %s", err)
                continue

        return None

    def set_schedule_mode(self, mode: str) -> None:
        if mode in (SCHEDULE_MODE_WEEKDAY_WEEKEND, SCHEDULE_MODE_PER_DAY):
            self.schedule.mode = mode
        else:
            _LOGGER.warning("Invalid schedule mode: %s", mode)

    def set_weekday_schedule(self, entries: list[dict]) -> None:
        self.schedule.weekday = DaySchedule(
            entries=[ScheduleEntry.from_dict(e) for e in entries]
        )
        self._sort_entries(self.schedule.weekday)

    def set_weekend_schedule(self, entries: list[dict]) -> None:
        self.schedule.weekend = DaySchedule(
            entries=[ScheduleEntry.from_dict(e) for e in entries]
        )
        self._sort_entries(self.schedule.weekend)

    def set_day_schedule(self, day: str, entries: list[dict]) -> None:
        day = day.lower()
        if day not in ALL_DAYS:
            _LOGGER.warning("Invalid day name: %s", day)
            return
        self.schedule.per_day[day] = DaySchedule(
            entries=[ScheduleEntry.from_dict(e) for e in entries]
        )
        self._sort_entries(self.schedule.per_day[day])

    def activate_preset(self, preset_name: str) -> bool:
        if preset_name in self.presets:
            self.schedule.active_preset = preset_name
            return True
        _LOGGER.warning("Unknown preset: %s", preset_name)
        return False

    def deactivate_preset(self) -> None:
        self.schedule.active_preset = None

    def add_entry_to_day(
        self, day: str, entry: ScheduleEntry, mode: str | None = None
    ) -> None:
        """Add a schedule entry to a specific day or day group."""
        target_mode = mode or self.schedule.mode

        if target_mode == SCHEDULE_MODE_WEEKDAY_WEEKEND:
            if day in WEEKDAYS or day == "weekday":
                self.schedule.weekday.entries.append(entry)
                self._sort_entries(self.schedule.weekday)
            elif day in WEEKEND or day == "weekend":
                self.schedule.weekend.entries.append(entry)
                self._sort_entries(self.schedule.weekend)
            else:
                _LOGGER.warning("Unknown day '%s' for weekday/weekend mode", day)
        else:
            if day not in self.schedule.per_day:
                self.schedule.per_day[day] = DaySchedule()
            self.schedule.per_day[day].entries.append(entry)
            self._sort_entries(self.schedule.per_day[day])

    def add_custom_preset(self, name: str, label: str) -> bool:
        """Create a new custom preset with empty schedules for each day."""
        key = name.lower().replace(" ", "_")
        if key in self.presets:
            return False
        self.presets[key] = PresetSchedule(
            name=key,
            label=label,
            schedule={day: DaySchedule() for day in ALL_DAYS},
            is_builtin=False,
        )
        return True

    def remove_custom_preset(self, name: str) -> bool:
        """Remove a custom (non-builtin) preset."""
        if name not in self.presets:
            return False
        if self.presets[name].is_builtin:
            return False
        if self.schedule.active_preset == name:
            self.schedule.active_preset = None
        del self.presets[name]
        return True

    def rename_custom_preset(self, name: str, new_label: str) -> bool:
        """Rename a custom preset's label."""
        if name not in self.presets:
            return False
        if self.presets[name].is_builtin:
            return False
        self.presets[name].label = new_label
        return True

    def copy_day_schedule(
        self, source_day: str, target_days: list[str], preset_name: str | None = None
    ) -> list[str]:
        """Copy all entries from one day to other days. Returns list of successfully copied days."""
        copied = []
        if preset_name and preset_name in self.presets:
            preset = self.presets[preset_name]
            source = preset.schedule.get(source_day.lower())
            if not source:
                return copied
            for day in target_days:
                day_lower = day.lower()
                if day_lower in preset.schedule and day_lower != source_day.lower():
                    preset.schedule[day_lower] = DaySchedule(
                        entries=[
                            ScheduleEntry(
                                time_start=e.time_start,
                                time_end=e.time_end,
                                target_temp=e.target_temp,
                                zone_id=e.zone_id,
                            )
                            for e in source.entries
                        ]
                    )
                    copied.append(day_lower)
            return copied

        # Non-preset mode
        source_day_lower = source_day.lower()
        if self.schedule.mode == "per_day":
            source_ds = self.schedule.per_day.get(source_day_lower)
            if not source_ds:
                return copied
            for day in target_days:
                day_lower = day.lower()
                if day_lower != source_day_lower and day_lower in ALL_DAYS:
                    self.schedule.per_day[day_lower] = DaySchedule(
                        entries=[
                            ScheduleEntry(
                                time_start=e.time_start,
                                time_end=e.time_end,
                                target_temp=e.target_temp,
                                zone_id=e.zone_id,
                            )
                            for e in source_ds.entries
                        ]
                    )
                    copied.append(day_lower)
        else:
            # weekday/weekend mode: copy between weekday and weekend
            if source_day_lower in WEEKDAYS or source_day_lower == "weekday":
                source_ds = self.schedule.weekday
            elif source_day_lower in WEEKEND or source_day_lower == "weekend":
                source_ds = self.schedule.weekend
            else:
                return copied
            for day in target_days:
                day_lower = day.lower()
                if day_lower in WEEKDAYS or day_lower == "weekday":
                    self.schedule.weekday = DaySchedule(
                        entries=[
                            ScheduleEntry(
                                time_start=e.time_start,
                                time_end=e.time_end,
                                target_temp=e.target_temp,
                                zone_id=e.zone_id,
                            )
                            for e in source_ds.entries
                        ]
                    )
                    copied.append(day_lower)
                elif day_lower in WEEKEND or day_lower == "weekend":
                    self.schedule.weekend = DaySchedule(
                        entries=[
                            ScheduleEntry(
                                time_start=e.time_start,
                                time_end=e.time_end,
                                target_temp=e.target_temp,
                                zone_id=e.zone_id,
                            )
                            for e in source_ds.entries
                        ]
                    )
                    copied.append(day_lower)
        return copied

    def export_schedule(self) -> dict[str, Any]:
        """Export the full schedule and presets as a JSON-serializable dict."""
        return {
            "version": 1,
            "schedule": self.schedule.to_dict(),
            "presets": {k: v.to_dict() for k, v in self.presets.items()},
            "enabled": self.enabled,
        }

    def import_schedule(self, data: dict[str, Any]) -> bool:
        """Import a schedule from exported JSON data. Returns True on success."""
        try:
            if "schedule" in data:
                self.schedule = Schedule.from_dict(data["schedule"])
            if "presets" in data:
                imported_presets = {
                    k: PresetSchedule.from_dict(v)
                    for k, v in data["presets"].items()
                }
                self.presets.update(imported_presets)
            if "enabled" in data:
                self.enabled = data["enabled"]
            return True
        except Exception as err:
            _LOGGER.error("Error importing schedule: %s", err)
            return False

    def _sort_entries(self, day_schedule: DaySchedule) -> None:
        try:
            day_schedule.entries.sort(key=lambda e: e.time_start)
        except Exception as err:
            _LOGGER.debug("Error sorting schedule entries: %s", err)

    def load(self, data: dict[str, Any]) -> None:
        """Load schedule from stored data."""
        try:
            self.schedule = Schedule.from_dict(data.get("schedule", {}))
            if "presets" in data:
                self.presets = {
                    k: PresetSchedule.from_dict(v)
                    for k, v in data["presets"].items()
                }
            self.enabled = data.get("enabled", True)
        except Exception as err:
            _LOGGER.error("Error loading scheduler data, using defaults: %s", err)
            self.schedule = Schedule()
            self.presets = _default_presets(self.temp_min, self.temp_max)

    def save(self) -> dict[str, Any]:
        return {
            "schedule": self.schedule.to_dict(),
            "presets": {k: v.to_dict() for k, v in self.presets.items()},
            "enabled": self.enabled,
        }
