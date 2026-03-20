"""Time-of-Use (TOU) rate awareness for GTTC.

Supports Dominion Energy Virginia's Off-Peak Plan rate schedule
and provides a generic framework for other providers.

Dominion Energy Virginia TOU schedule (effective 2025-2026):
  Summer (May 1 – September 30):
    On-peak:       3:00 PM – 6:00 PM, weekdays
    Off-peak:      All other weekday hours + weekends/holidays
    Super off-peak: 12:00 AM – 5:00 AM, every day

  Winter (October 1 – April 30):
    On-peak:       6:00 AM – 9:00 AM and 5:00 PM – 8:00 PM, weekdays
    Off-peak:      All other weekday hours + weekends/holidays
    Super off-peak: 12:00 AM – 5:00 AM, every day

Strategy:
  - During off-peak/super-off-peak: pre-condition (pre-heat or pre-cool)
    so the house is at comfort temp before on-peak starts.
  - During on-peak: widen the allowed temperature band to reduce HVAC
    runtime.  In cooling mode raise the setpoint; in heating mode lower it.
  - The TOU adjustment is additive to the desired temperature and is
    capped to prevent comfort complaints.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timezone
from enum import Enum

_LOGGER = logging.getLogger(__name__)

# Public holidays observed by Dominion (treated as off-peak all day).
# Uses (month, day) tuples; floating holidays approximated by the most
# common date in a given year — the coordinator can refresh yearly.
DOMINION_FIXED_HOLIDAYS = {
    (1, 1),    # New Year's Day
    (7, 4),    # Independence Day
    (12, 25),  # Christmas Day
}


class RatePeriod(Enum):
    """Rate period classification."""
    ON_PEAK = "on_peak"
    OFF_PEAK = "off_peak"
    SUPER_OFF_PEAK = "super_off_peak"


class TOUProvider:
    """Base TOU provider — always returns off-peak (no-op)."""

    name: str = "none"

    def get_rate_period(self, now: datetime | None = None) -> RatePeriod:
        return RatePeriod.OFF_PEAK

    def minutes_until_on_peak(self, now: datetime | None = None) -> int | None:
        """Minutes until the next on-peak window starts.  None if no upcoming window today."""
        return None

    def minutes_until_off_peak(self, now: datetime | None = None) -> int | None:
        """Minutes until the current on-peak window ends.  None if already off-peak."""
        return None


class DominionEnergyVirginia(TOUProvider):
    """Dominion Energy Virginia Off-Peak Plan rate schedule."""

    name = "dominion_virginia"

    # Summer: May–September
    _SUMMER_MONTHS = {5, 6, 7, 8, 9}

    def _is_holiday(self, d: date) -> bool:
        """Check if the date is a Dominion-observed holiday."""
        return (d.month, d.day) in DOMINION_FIXED_HOLIDAYS

    def _is_memorial_day(self, d: date) -> bool:
        # Last Monday of May
        if d.month != 5 or d.weekday() != 0:
            return False
        return d.day > 24

    def _is_labor_day(self, d: date) -> bool:
        # First Monday of September
        if d.month != 9 or d.weekday() != 0:
            return False
        return d.day <= 7

    def _is_thanksgiving(self, d: date) -> bool:
        # Fourth Thursday of November
        if d.month != 11 or d.weekday() != 3:
            return False
        return 22 <= d.day <= 28

    def _is_off_peak_day(self, d: date) -> bool:
        """Weekends and holidays are off-peak all day."""
        if d.weekday() >= 5:  # Saturday/Sunday
            return True
        if self._is_holiday(d):
            return True
        if self._is_memorial_day(d):
            return True
        if self._is_labor_day(d):
            return True
        if self._is_thanksgiving(d):
            return True
        return False

    def _is_summer(self, d: date) -> bool:
        return d.month in self._SUMMER_MONTHS

    def get_rate_period(self, now: datetime | None = None) -> RatePeriod:
        if now is None:
            now = datetime.now(timezone.utc).astimezone()

        d = now.date()
        t = now.time()

        # Super off-peak: midnight to 5 AM every day
        if t < time(5, 0):
            return RatePeriod.SUPER_OFF_PEAK

        # Weekends/holidays: off-peak all day (after 5 AM)
        if self._is_off_peak_day(d):
            return RatePeriod.OFF_PEAK

        # Weekday on-peak windows
        if self._is_summer(d):
            # Summer: 3 PM – 6 PM
            if time(15, 0) <= t < time(18, 0):
                return RatePeriod.ON_PEAK
        else:
            # Winter: 6–9 AM and 5–8 PM
            if time(6, 0) <= t < time(9, 0):
                return RatePeriod.ON_PEAK
            if time(17, 0) <= t < time(20, 0):
                return RatePeriod.ON_PEAK

        return RatePeriod.OFF_PEAK

    def minutes_until_on_peak(self, now: datetime | None = None) -> int | None:
        if now is None:
            now = datetime.now(timezone.utc).astimezone()

        d = now.date()
        t = now.time()

        if self._is_off_peak_day(d):
            return None

        current_minutes = t.hour * 60 + t.minute

        if self._is_summer(d):
            on_peak_start = 15 * 60  # 15:00
            if current_minutes < on_peak_start:
                return on_peak_start - current_minutes
        else:
            # Winter has two windows
            morning_start = 6 * 60   # 6:00
            evening_start = 17 * 60  # 17:00
            if current_minutes < morning_start:
                return morning_start - current_minutes
            morning_end = 9 * 60
            if morning_end <= current_minutes < evening_start:
                return evening_start - current_minutes

        return None

    def minutes_until_off_peak(self, now: datetime | None = None) -> int | None:
        if now is None:
            now = datetime.now(timezone.utc).astimezone()

        d = now.date()
        t = now.time()
        current_minutes = t.hour * 60 + t.minute

        if self.get_rate_period(now) != RatePeriod.ON_PEAK:
            return None

        if self._is_summer(d):
            return 18 * 60 - current_minutes  # ends at 6 PM
        else:
            if current_minutes < 9 * 60:
                return 9 * 60 - current_minutes  # morning window ends 9 AM
            return 20 * 60 - current_minutes  # evening window ends 8 PM


# Registry of supported TOU providers
TOU_PROVIDERS: dict[str, type[TOUProvider]] = {
    "none": TOUProvider,
    "dominion_virginia": DominionEnergyVirginia,
}

# Default on-peak temperature adjustments (°F).
# Positive = warmer setpoint (saves cooling energy during on-peak).
# Negative = cooler setpoint (saves heating energy during on-peak).
TOU_ON_PEAK_COOLING_OFFSET = 3.0   # raise cooling setpoint by 3°F on-peak
TOU_ON_PEAK_HEATING_OFFSET = -2.0  # lower heating setpoint by 2°F on-peak

# How many minutes before on-peak to start pre-conditioning
TOU_PRECONDITION_WINDOW_MINUTES = 60
