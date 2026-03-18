"""Binary sensor entities for GTTC."""
from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_NAME, DEFAULT_NAME, DOMAIN
from .coordinator import GTTCCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: GTTCCoordinator = hass.data[DOMAIN][config_entry.entry_id]
    name = config_entry.data.get(CONF_NAME, DEFAULT_NAME)
    async_add_entities([WindowsOpenSensor(coordinator, config_entry, name)])


class WindowsOpenSensor(CoordinatorEntity, BinarySensorEntity):
    """True when any configured window sensor is open (or the manual override is set)."""

    _attr_has_entity_name = True
    _attr_device_class = BinarySensorDeviceClass.WINDOW
    _attr_icon = "mdi:window-open-variant"

    def __init__(self, coordinator: GTTCCoordinator, config_entry, name: str) -> None:
        super().__init__(coordinator)
        self._attr_name = f"{name} Windows Open"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_windows_open"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("windows_open", False))

    @property
    def extra_state_attributes(self) -> dict:
        coord = self.coordinator
        return {
            "monitored_sensors": list(coord.window_sensors),
            "open_sensors": coord.get_open_window_sensors(),
            "manual_override": coord.windows_open_override,
        }
