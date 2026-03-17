"""Learning engine for GTTC - detects patterns and auto-creates schedules."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from .const import (
    DEFAULT_LEARNING_THRESHOLD,
    LEARNING_TEMP_TOLERANCE,
    LEARNING_TIME_WINDOW_MINUTES,
    WEEKDAYS,
    WEEKEND,
)
from .models import LearningEvent, ScheduleEntry

_LOGGER = logging.getLogger(__name__)


class LearningEngine:
    """Tracks manual adjustments and detects recurring patterns."""

    def __init__(self, threshold: int = DEFAULT_LEARNING_THRESHOLD) -> None:
        self.threshold = max(2, threshold)
        self.events: list[LearningEvent] = []
        self.learned_entries: list[dict[str, Any]] = []
        self._max_events = 500

    def record_event(
        self,
        target_temp: float,
        zone_id: str | None = None,
        previous_temp: float | None = None,
    ) -> dict[str, Any] | None:
        """Record a manual temperature adjustment. Returns a learned entry if pattern detected."""
        try:
            now = datetime.now(timezone.utc).astimezone()
            event = LearningEvent(
                timestamp=now.isoformat(),
                day_of_week=now.strftime("%A").lower(),
                time_of_day=now.strftime("%H:%M"),
                target_temp=target_temp,
                zone_id=zone_id,
                previous_temp=previous_temp,
            )
            self.events.append(event)

            # Trim old events
            if len(self.events) > self._max_events:
                self.events = self.events[-self._max_events :]

            return self._detect_pattern(event)
        except Exception as err:
            _LOGGER.warning("Error recording learning event: %s", err)
            return None

    def _detect_pattern(self, new_event: LearningEvent) -> dict[str, Any] | None:
        """Check if this event completes a recurring pattern."""
        try:
            similar = self._find_similar_events(new_event)

            if len(similar) < self.threshold:
                return None

            avg_temp = round(sum(e.target_temp for e in similar) / len(similar), 1)
            avg_minutes = self._average_time_minutes(similar)
            avg_hour = avg_minutes // 60
            avg_min = avg_minutes % 60
            time_str = f"{avg_hour:02d}:{avg_min:02d}"

            days = [e.day_of_week for e in similar]
            day_type = self._classify_days(days)

            # Check if we already learned this pattern
            for learned in self.learned_entries:
                learned_minutes = self._time_to_minutes(learned.get("time", "00:00"))
                if (
                    abs(learned_minutes - avg_minutes) < LEARNING_TIME_WINDOW_MINUTES
                    and abs(learned.get("temp", 0) - avg_temp) < LEARNING_TEMP_TOLERANCE
                    and learned.get("day_type") == day_type
                ):
                    return None  # Already known

            learned = {
                "time": time_str,
                "temp": avg_temp,
                "day_type": day_type,
                "zone_id": new_event.zone_id,
                "confidence": round(len(similar) / self.threshold, 2),
                "sample_count": len(similar),
            }
            self.learned_entries.append(learned)

            _LOGGER.info(
                "Learned pattern: %.1f at %s on %s (confidence: %.1f, samples: %d)",
                avg_temp,
                time_str,
                day_type,
                learned["confidence"],
                len(similar),
            )
            return learned
        except Exception as err:
            _LOGGER.warning("Error detecting pattern: %s", err)
            return None

    def _find_similar_events(self, target: LearningEvent) -> list[LearningEvent]:
        """Find events similar in time-of-day and temperature."""
        target_minutes = self._time_to_minutes(target.time_of_day)
        similar = []

        for event in self.events:
            event_minutes = self._time_to_minutes(event.time_of_day)
            time_diff = abs(event_minutes - target_minutes)
            # Handle midnight wrap
            if time_diff > 720:
                time_diff = 1440 - time_diff

            temp_diff = abs(event.target_temp - target.target_temp)

            if (
                time_diff <= LEARNING_TIME_WINDOW_MINUTES
                and temp_diff <= LEARNING_TEMP_TOLERANCE
            ):
                similar.append(event)

        return similar

    def _average_time_minutes(self, events: list[LearningEvent]) -> int:
        """Calculate average time of day in minutes."""
        if not events:
            return 0
        minutes = [self._time_to_minutes(e.time_of_day) for e in events]
        return round(sum(minutes) / len(minutes))

    def _time_to_minutes(self, time_str: str) -> int:
        """Parse HH:MM to total minutes, with error handling."""
        try:
            parts = time_str.split(":")
            if len(parts) != 2:
                return 0
            h, m = int(parts[0]), int(parts[1])
            return max(0, min(1439, h * 60 + m))
        except (ValueError, TypeError, IndexError):
            _LOGGER.debug("Invalid time format: %s", time_str)
            return 0

    def _classify_days(self, days: list[str]) -> str:
        weekday_count = sum(1 for d in days if d in WEEKDAYS)
        weekend_count = sum(1 for d in days if d in WEEKEND)

        if weekday_count > 0 and weekend_count > 0:
            return "daily"
        elif weekend_count > 0:
            return "weekend"
        else:
            return "weekday"

    def get_suggested_entries(self) -> list[ScheduleEntry]:
        """Convert learned patterns into schedule entries."""
        entries = []
        for learned in self.learned_entries:
            minutes = self._time_to_minutes(learned.get("time", "00:00"))
            start_min = max(0, minutes - 30)
            end_min = min(1439, minutes + 30)

            entry = ScheduleEntry(
                time_start=f"{start_min // 60:02d}:{start_min % 60:02d}",
                time_end=f"{end_min // 60:02d}:{end_min % 60:02d}",
                target_temp=learned.get("temp", 70),
                zone_id=learned.get("zone_id"),
            )
            entries.append(entry)

        return entries

    def clear_learned(self) -> None:
        self.learned_entries.clear()

    def clear_events(self) -> None:
        self.events.clear()
        self.learned_entries.clear()

    def load(self, data: dict[str, Any]) -> None:
        """Load from stored data."""
        try:
            self.events = []
            for e in data.get("events", []):
                try:
                    self.events.append(LearningEvent.from_dict(e))
                except Exception:
                    pass  # Skip corrupt events
            self.learned_entries = data.get("learned_entries", [])
        except Exception as err:
            _LOGGER.error("Error loading learning data, starting fresh: %s", err)
            self.events = []
            self.learned_entries = []

    def save(self) -> dict[str, Any]:
        return {
            "events": [e.to_dict() for e in self.events],
            "learned_entries": self.learned_entries,
        }
