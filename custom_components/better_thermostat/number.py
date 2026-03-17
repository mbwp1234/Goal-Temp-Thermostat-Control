"""Number entities for Better Thermostat."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_NAME, DEFAULT_NAME, DOMAIN
from .coordinator import BetterThermostatCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Better Thermostat number entities."""
    coordinator: BetterThermostatCoordinator = hass.data[DOMAIN][config_entry.entry_id]
    name = config_entry.data.get(CONF_NAME, DEFAULT_NAME)

    async_add_entities([
        AwayTempNumber(coordinator, config_entry, name),
        OverrideDurationNumber(coordinator, config_entry, name),
    ])


class AwayTempNumber(CoordinatorEntity, NumberEntity):
    """Set the away/eco temperature."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:home-export-outline"
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Away Temperature"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_away_temp"
        self._attr_native_min_value = coordinator.temp_min
        self._attr_native_max_value = coordinator.temp_max
        self._attr_native_step = 1.0

    @property
    def native_value(self) -> float:
        return self.coordinator.away_temp

    async def async_set_native_value(self, value: float) -> None:
        self.coordinator.away_temp = value
        self.async_write_ha_state()


class OverrideDurationNumber(CoordinatorEntity, NumberEntity):
    """Set how long manual overrides last (in minutes)."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:timer-cog-outline"
    _attr_mode = NumberMode.BOX
    _attr_native_unit_of_measurement = "min"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Override Duration"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_override_duration"
        self._attr_native_min_value = 15
        self._attr_native_max_value = 480
        self._attr_native_step = 15

    @property
    def native_value(self) -> float:
        return self.coordinator.manual_override_minutes

    async def async_set_native_value(self, value: float) -> None:
        self.coordinator.manual_override_minutes = int(value)
        self.async_write_ha_state()
