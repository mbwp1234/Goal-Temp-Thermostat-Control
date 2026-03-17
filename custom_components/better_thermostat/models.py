"""Data models for Better Thermostat."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone
from typing import Any

_LOGGER = logging.getLogger(__name__)


def _parse_time(time_str: str) -> time:
    """Safely parse a HH:MM time string."""
    try:
        parts = time_str.split(":")
        if len(parts) != 2:
            raise ValueError(f"Expected HH:MM format, got: {time_str}")
        return time(int(parts[0]), int(parts[1]))
    except (ValueError, IndexError, TypeError) as err:
        _LOGGER.warning("Invalid time format '%s': %s, defaulting to 00:00", time_str, err)
        return time(0, 0)


def _utcnow() -> datetime:
    """Get current time as timezone-aware UTC."""
    return datetime.now(timezone.utc)


def _parse_iso(iso_str: str) -> datetime:
    """Safely parse an ISO format datetime string."""
    try:
        dt = datetime.fromisoformat(iso_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError) as err:
        _LOGGER.warning("Invalid ISO datetime '%s': %s, using now", iso_str, err)
        return _utcnow()


@dataclass
class Zone:
    """Represents a floor/room zone."""

    id: str
    name: str
    sensor_entities: list[str] = field(default_factory=list)
    occupancy_sensor_entities: list[str] = field(default_factory=list)
    area_id: str | None = None
    away_temp: float | None = None
    occupancy_override: bool = True
    current_temp: float | None = None
    is_occupied: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "sensor_entities": self.sensor_entities,
            "occupancy_sensor_entities": self.occupancy_sensor_entities,
            "area_id": self.area_id,
            "away_temp": self.away_temp,
            "occupancy_override": self.occupancy_override,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Zone:
        return cls(
            id=data.get("id", "unknown"),
            name=data.get("name", "Unknown Zone"),
            sensor_entities=data.get("sensor_entities", []),
            occupancy_sensor_entities=data.get("occupancy_sensor_entities", []),
            area_id=data.get("area_id"),
            away_temp=data.get("away_temp"),
            occupancy_override=data.get("occupancy_override", True),
        )


@dataclass
class ScheduleEntry:
    """A single schedule time slot."""

    time_start: str  # "HH:MM"
    time_end: str  # "HH:MM"
    target_temp: float
    zone_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "time_start": self.time_start,
            "time_end": self.time_end,
            "target_temp": self.target_temp,
            "zone_id": self.zone_id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScheduleEntry:
        return cls(
            time_start=data.get("time_start", "00:00"),
            time_end=data.get("time_end", "23:59"),
            target_temp=data.get("target_temp", 70),
            zone_id=data.get("zone_id"),
        )

    @property
    def start_time(self) -> time:
        return _parse_time(self.time_start)

    @property
    def end_time(self) -> time:
        return _parse_time(self.time_end)


@dataclass
class DaySchedule:
    """Schedule for a single day."""

    entries: list[ScheduleEntry] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"entries": [e.to_dict() for e in self.entries]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DaySchedule:
        entries = []
        for e in data.get("entries", []):
            try:
                entries.append(ScheduleEntry.from_dict(e))
            except Exception as err:
                _LOGGER.warning("Skipping invalid schedule entry %s: %s", e, err)
        return cls(entries=entries)


@dataclass
class Schedule:
    """Full schedule configuration."""

    mode: str = "weekday_weekend"
    weekday: DaySchedule = field(default_factory=DaySchedule)
    weekend: DaySchedule = field(default_factory=DaySchedule)
    per_day: dict[str, DaySchedule] = field(default_factory=dict)
    active_preset: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "weekday": self.weekday.to_dict(),
            "weekend": self.weekend.to_dict(),
            "per_day": {k: v.to_dict() for k, v in self.per_day.items()},
            "active_preset": self.active_preset,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Schedule:
        per_day = {}
        for k, v in data.get("per_day", {}).items():
            try:
                per_day[k] = DaySchedule.from_dict(v)
            except Exception as err:
                _LOGGER.warning("Skipping invalid per_day schedule %s: %s", k, err)

        return cls(
            mode=data.get("mode", "weekday_weekend"),
            weekday=DaySchedule.from_dict(data.get("weekday", {})),
            weekend=DaySchedule.from_dict(data.get("weekend", {})),
            per_day=per_day,
            active_preset=data.get("active_preset"),
        )


@dataclass
class PresetSchedule:
    """A named preset schedule."""

    name: str
    label: str
    schedule: dict[str, DaySchedule] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "schedule": {k: v.to_dict() for k, v in self.schedule.items()},
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PresetSchedule:
        schedule = {}
        for k, v in data.get("schedule", {}).items():
            try:
                schedule[k] = DaySchedule.from_dict(v)
            except Exception as err:
                _LOGGER.warning("Skipping invalid preset schedule %s: %s", k, err)

        return cls(
            name=data.get("name", "unknown"),
            label=data.get("label", "Unknown"),
            schedule=schedule,
        )


@dataclass
class LearningEvent:
    """A recorded manual adjustment for learning."""

    timestamp: str  # ISO format
    day_of_week: str
    time_of_day: str  # "HH:MM"
    target_temp: float
    zone_id: str | None = None
    previous_temp: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "day_of_week": self.day_of_week,
            "time_of_day": self.time_of_day,
            "target_temp": self.target_temp,
            "zone_id": self.zone_id,
            "previous_temp": self.previous_temp,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> LearningEvent:
        return cls(
            timestamp=data.get("timestamp", _utcnow().isoformat()),
            day_of_week=data.get("day_of_week", "monday"),
            time_of_day=data.get("time_of_day", "00:00"),
            target_temp=data.get("target_temp", 70),
            zone_id=data.get("zone_id"),
            previous_temp=data.get("previous_temp"),
        )


@dataclass
class ManualOverride:
    """Tracks an active manual override."""

    target_temp: float
    started_at: str  # ISO format
    duration_minutes: int
    zone_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "target_temp": self.target_temp,
            "started_at": self.started_at,
            "duration_minutes": self.duration_minutes,
            "zone_id": self.zone_id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ManualOverride:
        return cls(
            target_temp=data.get("target_temp", 70),
            started_at=data.get("started_at", _utcnow().isoformat()),
            duration_minutes=data.get("duration_minutes", 120),
            zone_id=data.get("zone_id"),
        )

    @property
    def is_expired(self) -> bool:
        started = _parse_iso(self.started_at)
        return _utcnow() > started + timedelta(minutes=self.duration_minutes)

    @property
    def remaining_minutes(self) -> int:
        started = _parse_iso(self.started_at)
        end = started + timedelta(minutes=self.duration_minutes)
        remaining = (end - _utcnow()).total_seconds() / 60
        return max(0, int(remaining))
