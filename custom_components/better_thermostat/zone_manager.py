"""Zone management for Better Thermostat."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, entity_registry as er

from .const import DOMAIN
from .models import Zone

_LOGGER = logging.getLogger(__name__)


class ZoneManager:
    """Manages floor/room zones with sensor grouping and averaging."""

    def __init__(self, hass: HomeAssistant, config_entry_id: str) -> None:
        self.hass = hass
        self.config_entry_id = config_entry_id
        self.zones: dict[str, Zone] = {}
        self._active_zone_id: str | None = None

    @property
    def active_zone(self) -> Zone | None:
        if self._active_zone_id and self._active_zone_id in self.zones:
            return self.zones[self._active_zone_id]
        if self.zones:
            return next(iter(self.zones.values()))
        return None

    @property
    def active_zone_id(self) -> str | None:
        if self._active_zone_id and self._active_zone_id in self.zones:
            return self._active_zone_id
        if self.zones:
            return next(iter(self.zones.keys()))
        return None

    def set_active_zone(self, zone_id: str) -> bool:
        if zone_id in self.zones:
            self._active_zone_id = zone_id
            return True
        return False

    def add_zone(self, zone: Zone) -> None:
        self.zones[zone.id] = zone
        if self._active_zone_id is None:
            self._active_zone_id = zone.id

    def remove_zone(self, zone_id: str) -> bool:
        if zone_id in self.zones:
            del self.zones[zone_id]
            if self._active_zone_id == zone_id:
                self._active_zone_id = (
                    next(iter(self.zones.keys())) if self.zones else None
                )
            return True
        return False

    def get_zone(self, zone_id: str) -> Zone | None:
        return self.zones.get(zone_id)

    def get_all_zone_names(self) -> dict[str, str]:
        return {z.id: z.name for z in self.zones.values()}

    async def discover_areas(self) -> list[dict[str, str]]:
        """Discover Home Assistant areas that could be zones."""
        area_reg = ar.async_get(self.hass)
        ent_reg = er.async_get(self.hass)

        discovered = []
        for area in area_reg.async_list_areas():
            # Find temperature sensors in this area
            temp_sensors = []
            occupancy_sensors = []
            for entity in er.async_entries_for_area(ent_reg, area.id):
                state = self.hass.states.get(entity.entity_id)
                if state is None:
                    continue
                device_class = state.attributes.get("device_class", "")
                if entity.domain == "sensor" and device_class == "temperature":
                    temp_sensors.append(entity.entity_id)
                elif entity.domain == "binary_sensor" and device_class in (
                    "occupancy",
                    "motion",
                    "presence",
                ):
                    occupancy_sensors.append(entity.entity_id)

            discovered.append(
                {
                    "area_id": area.id,
                    "name": area.name,
                    "floor_id": area.floor_id,
                    "temp_sensors": temp_sensors,
                    "occupancy_sensors": occupancy_sensors,
                }
            )

        return discovered

    def update_zone_temperature(self, zone_id: str) -> float | None:
        """Calculate average temperature for a zone from its sensors."""
        zone = self.zones.get(zone_id)
        if not zone or not zone.sensor_entities:
            return None

        temps = []
        for entity_id in zone.sensor_entities:
            state = self.hass.states.get(entity_id)
            if state and state.state not in ("unknown", "unavailable"):
                try:
                    temps.append(float(state.state))
                except (ValueError, TypeError):
                    _LOGGER.debug("Could not parse temp from %s", entity_id)

        if not temps:
            zone.current_temp = None
            return None

        avg_temp = round(sum(temps) / len(temps), 1)
        zone.current_temp = avg_temp
        return avg_temp

    def update_zone_occupancy(self, zone_id: str) -> bool | None:
        """Check occupancy status for a zone."""
        zone = self.zones.get(zone_id)
        if not zone or not zone.occupancy_sensor_entities:
            zone.is_occupied = None
            return None

        for entity_id in zone.occupancy_sensor_entities:
            state = self.hass.states.get(entity_id)
            if state and state.state == "on":
                zone.is_occupied = True
                return True

        zone.is_occupied = False
        return False

    def update_all_zones(self) -> None:
        """Update temperatures and occupancy for all zones."""
        for zone_id in self.zones:
            self.update_zone_temperature(zone_id)
            self.update_zone_occupancy(zone_id)

    def is_anyone_home(self) -> bool:
        """Check if any zone has occupancy detected."""
        for zone in self.zones.values():
            if zone.occupancy_sensor_entities and zone.is_occupied:
                return True
        # If no occupancy sensors configured at all, assume home
        has_any_occupancy = any(
            z.occupancy_sensor_entities for z in self.zones.values()
        )
        return not has_any_occupancy

    def get_zone_temperatures(self) -> dict[str, float | None]:
        """Get current temperatures for all zones."""
        return {
            zone.name: zone.current_temp for zone in self.zones.values()
        }

    def get_zone_occupancy(self) -> dict[str, bool | None]:
        """Get occupancy status for all zones."""
        return {
            zone.name: zone.is_occupied for zone in self.zones.values()
        }

    def load_zones(self, zone_data: list[dict[str, Any]]) -> None:
        """Load zones from stored config."""
        self.zones.clear()
        for data in zone_data:
            zone = Zone.from_dict(data)
            self.zones[zone.id] = zone

    def save_zones(self) -> list[dict[str, Any]]:
        """Serialize zones for storage."""
        return [zone.to_dict() for zone in self.zones.values()]
