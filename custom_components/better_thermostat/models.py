"""Data models for Better Thermostat."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time
from typing import Any


@dataclass
class Zone:
    """Represents a floor/room zone."""

    id: str
    name: str
    sensor_entities: list[str] = field(default_factory=list)
    occupancy_sensor_entities: list[str] = field(default_factory=list)
    area_id: str | None = None
    away_temp: float | None = None
    occupancy_override: bool = True  # whether occupancy affects this zone
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
            id=data["id"],
            name=data["name"],
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
    zone_id: str | None = None  # None = applies to active zone

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
            time_start=data["time_start"],
            time_end=data["time_end"],
            target_temp=data["target_temp"],
            zone_id=data.get("zone_id"),
        )

    @property
    def start_time(self) -> time:
        parts = self.time_start.split(":")
        return time(int(parts[0]), int(parts[1]))

    @property
    def end_time(self) -> time:
        parts = self.time_end.split(":")
        return time(int(parts[0]), int(parts[1]))


@dataclass
class DaySchedule:
    """Schedule for a single day."""

    entries: list[ScheduleEntry] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"entries": [e.to_dict() for e in self.entries]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DaySchedule:
        return cls(
            entries=[ScheduleEntry.from_dict(e) for e in data.get("entries", [])]
        )


@dataclass
class Schedule:
    """Full schedule configuration."""

    mode: str = "weekday_weekend"  # "weekday_weekend" or "per_day"
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
        return cls(
            mode=data.get("mode", "weekday_weekend"),
            weekday=DaySchedule.from_dict(data.get("weekday", {})),
            weekend=DaySchedule.from_dict(data.get("weekend", {})),
            per_day={
                k: DaySchedule.from_dict(v)
                for k, v in data.get("per_day", {}).items()
            },
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
        return cls(
            name=data["name"],
            label=data["label"],
            schedule={
                k: DaySchedule.from_dict(v)
                for k, v in data.get("schedule", {}).items()
            },
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
            timestamp=data["timestamp"],
            day_of_week=data["day_of_week"],
            time_of_day=data["time_of_day"],
            target_temp=data["target_temp"],
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
            target_temp=data["target_temp"],
            started_at=data["started_at"],
            duration_minutes=data["duration_minutes"],
            zone_id=data.get("zone_id"),
        )

    @property
    def is_expired(self) -> bool:
        from datetime import datetime, timedelta

        started = datetime.fromisoformat(self.started_at)
        return datetime.now() > started + timedelta(minutes=self.duration_minutes)

    @property
    def remaining_minutes(self) -> int:
        from datetime import datetime, timedelta

        started = datetime.fromisoformat(self.started_at)
        end = started + timedelta(minutes=self.duration_minutes)
        remaining = (end - datetime.now()).total_seconds() / 60
        return max(0, int(remaining))
