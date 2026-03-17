"""Zone management for Better Thermostat."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar, entity_registry as er

from .const import DOMAIN, PRESENCE_MODE_BOTH, PRESENCE_MODE_OCCUPANCY, PRESENCE_MODE_PERSON
from .models import Zone

_LOGGER = logging.getLogger(__name__)


class ZoneManager:
    """Manages floor/room zones with sensor grouping and averaging."""

    def __init__(self, hass: HomeAssistant, config_entry_id: str) -> None:
        self.hass = hass
        self.config_entry_id = config_entry_id
        self.zones: dict[str, Zone] = {}
        self._active_zone_id: str | None = None
        self.presence_mode: str = PRESENCE_MODE_BOTH

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
        _LOGGER.warning("Zone '%s' not found, cannot set as active", zone_id)
        return False

    def add_zone(self, zone: Zone) -> None:
        if zone.id in self.zones:
            _LOGGER.debug("Overwriting existing zone '%s'", zone.id)
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

    async def discover_areas(self) -> list[dict[str, Any]]:
        """Discover Home Assistant areas that could be zones."""
        try:
            area_reg = ar.async_get(self.hass)
            ent_reg = er.async_get(self.hass)
        except Exception as err:
            _LOGGER.error("Failed to access registries for area discovery: %s", err)
            return []

        discovered = []
        for area in area_reg.async_list_areas():
            temp_sensors = []
            occupancy_sensors = []
            try:
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
            except Exception as err:
                _LOGGER.warning("Error scanning area '%s': %s", area.name, err)

            discovered.append(
                {
                    "area_id": area.id,
                    "name": area.name,
                    "floor_id": getattr(area, "floor_id", None),
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
            try:
                state = self.hass.states.get(entity_id)
                if state and state.state not in ("unknown", "unavailable"):
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
        """Check occupancy status for a zone from its binary sensors."""
        zone = self.zones.get(zone_id)
        if not zone or not zone.occupancy_sensor_entities:
            zone.is_occupied = None
            return None

        for entity_id in zone.occupancy_sensor_entities:
            try:
                state = self.hass.states.get(entity_id)
                if state and state.state == "on":
                    zone.is_occupied = True
                    return True
            except Exception as err:
                _LOGGER.debug("Error reading occupancy sensor %s: %s", entity_id, err)

        zone.is_occupied = False
        return False

    def update_all_zones(self) -> None:
        """Update temperatures and occupancy for all zones."""
        for zone_id in list(self.zones.keys()):
            try:
                self.update_zone_temperature(zone_id)
                self.update_zone_occupancy(zone_id)
            except Exception as err:
                _LOGGER.warning("Error updating zone '%s': %s", zone_id, err)

    def is_anyone_home(self) -> bool:
        """Check if anyone is home using configured presence detection method.

        Uses HA person entities (zone.home detection), occupancy sensors, or both.
        """
        occupancy_detected = self._check_occupancy_sensors()
        person_home = self._check_person_entities()

        if self.presence_mode == PRESENCE_MODE_OCCUPANCY:
            # Only use occupancy sensors; if none configured, assume home
            if not self._has_any_occupancy_sensors():
                return True
            return occupancy_detected

        if self.presence_mode == PRESENCE_MODE_PERSON:
            return person_home

        # BOTH mode: either method can confirm presence
        if not self._has_any_occupancy_sensors():
            # No occupancy sensors, rely on person entities
            return person_home
        return occupancy_detected or person_home

    def _check_occupancy_sensors(self) -> bool:
        """Check if any zone has occupancy detected."""
        for zone in self.zones.values():
            if zone.occupancy_sensor_entities and zone.is_occupied:
                return True
        return False

    def _has_any_occupancy_sensors(self) -> bool:
        return any(z.occupancy_sensor_entities for z in self.zones.values())

    def _check_person_entities(self) -> bool:
        """Check if any person entity is 'home' (using HA's built-in zone.home)."""
        try:
            person_states = self.hass.states.async_all("person")
            for person in person_states:
                if person.state == "home":
                    return True
            # If no person entities exist, assume home
            if not person_states:
                return True
            return False
        except Exception as err:
            _LOGGER.debug("Error checking person entities: %s", err)
            return True  # Fail-safe: assume home

    def get_zone_temperatures(self) -> dict[str, float | None]:
        return {zone.name: zone.current_temp for zone in self.zones.values()}

    def get_zone_occupancy(self) -> dict[str, bool | None]:
        return {zone.name: zone.is_occupied for zone in self.zones.values()}

    def load_zones(self, zone_data: list[dict[str, Any]]) -> None:
        """Load zones from stored config."""
        self.zones.clear()
        for data in zone_data:
            try:
                zone = Zone.from_dict(data)
                self.zones[zone.id] = zone
            except Exception as err:
                _LOGGER.warning("Skipping invalid zone data %s: %s", data, err)

    def save_zones(self) -> list[dict[str, Any]]:
        return [zone.to_dict() for zone in self.zones.values()]
