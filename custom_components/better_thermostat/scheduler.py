"""Schedule management for Better Thermostat."""
from __future__ import annotations

import logging
from datetime import datetime, time
from typing import Any

from .const import (
    ALL_DAYS,
    DEFAULT_AWAY_TEMP,
    PRESET_AWAY,
    PRESET_HOME,
    PRESET_SLEEP,
    PRESET_WORK_FROM_HOME,
    SCHEDULE_MODE_PER_DAY,
    SCHEDULE_MODE_WEEKDAY_WEEKEND,
    WEEKDAYS,
    WEEKEND,
)
from .models import DaySchedule, PresetSchedule, Schedule, ScheduleEntry

_LOGGER = logging.getLogger(__name__)


def _default_presets(temp_min: float, temp_max: float) -> dict[str, PresetSchedule]:
    """Create default preset schedules."""
    mid = round((temp_min + temp_max) / 2)
    comfort = mid + 4
    sleep_temp = mid - 2
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
        day_sched = DaySchedule(entries=list(entries))
        presets[name] = PresetSchedule(
            name=name,
            label=label,
            schedule={day: DaySchedule(entries=list(entries)) for day in ALL_DAYS},
        )

    return presets


class Scheduler:
    """Manages time-based temperature schedules."""

    def __init__(self, temp_min: float = 50, temp_max: float = 90) -> None:
        self.schedule = Schedule()
        self.presets: dict[str, PresetSchedule] = _default_presets(temp_min, temp_max)
        self.temp_min = temp_min
        self.temp_max = temp_max

    def get_current_entry(
        self, now: datetime | None = None
    ) -> ScheduleEntry | None:
        """Get the schedule entry active right now."""
        if now is None:
            now = datetime.now()

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

        # Weekday/weekend mode
        if day_name in WEEKDAYS:
            return self._find_entry_for_time(self.schedule.weekday, current_time)
        else:
            return self._find_entry_for_time(self.schedule.weekend, current_time)

    def _find_entry_for_time(
        self, day_schedule: DaySchedule, current_time: time
    ) -> ScheduleEntry | None:
        """Find the entry that covers the given time."""
        for entry in day_schedule.entries:
            start = entry.start_time
            end = entry.end_time

            if start <= end:
                # Normal range (e.g., 08:00 - 17:00)
                if start <= current_time < end:
                    return entry
            else:
                # Overnight range (e.g., 22:00 - 06:00)
                if current_time >= start or current_time < end:
                    return entry

        return None

    def set_schedule_mode(self, mode: str) -> None:
        self.schedule.mode = mode

    def set_weekday_schedule(self, entries: list[dict]) -> None:
        self.schedule.weekday = DaySchedule(
            entries=[ScheduleEntry.from_dict(e) for e in entries]
        )

    def set_weekend_schedule(self, entries: list[dict]) -> None:
        self.schedule.weekend = DaySchedule(
            entries=[ScheduleEntry.from_dict(e) for e in entries]
        )

    def set_day_schedule(self, day: str, entries: list[dict]) -> None:
        self.schedule.per_day[day] = DaySchedule(
            entries=[ScheduleEntry.from_dict(e) for e in entries]
        )

    def activate_preset(self, preset_name: str) -> bool:
        if preset_name in self.presets:
            self.schedule.active_preset = preset_name
            return True
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
            if day not in self.schedule.per_day:
                self.schedule.per_day[day] = DaySchedule()
            self.schedule.per_day[day].entries.append(entry)
            self._sort_entries(self.schedule.per_day[day])

    def _sort_entries(self, day_schedule: DaySchedule) -> None:
        day_schedule.entries.sort(key=lambda e: e.time_start)

    def load(self, data: dict[str, Any]) -> None:
        """Load schedule from stored data."""
        self.schedule = Schedule.from_dict(data.get("schedule", {}))
        if "presets" in data:
            self.presets = {
                k: PresetSchedule.from_dict(v)
                for k, v in data["presets"].items()
            }

    def save(self) -> dict[str, Any]:
        """Serialize for storage."""
        return {
            "schedule": self.schedule.to_dict(),
            "presets": {k: v.to_dict() for k, v in self.presets.items()},
        }
