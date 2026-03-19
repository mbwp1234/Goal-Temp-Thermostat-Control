"""Number entities for GTTC."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    CONF_NAME,
    DEFAULT_NAME,
    DEFAULT_COOLING_COMFORT,
    DEFAULT_COOLING_AWAY,
    DOMAIN,
)
from .coordinator import GTTCCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: GTTCCoordinator = hass.data[DOMAIN][config_entry.entry_id]
    name = config_entry.data.get(CONF_NAME, DEFAULT_NAME)

    async_add_entities([
        AwayTempNumber(coordinator, config_entry, name),
        OverrideDurationNumber(coordinator, config_entry, name),
        CoolingComfortNumber(coordinator, config_entry, name),
        CoolingAwayTempNumber(coordinator, config_entry, name),
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
        value = max(self._attr_native_min_value, min(self._attr_native_max_value, value))
        self.coordinator.away_temp = value
        await self.coordinator.async_save()
        self.async_write_ha_state()


class OverrideDurationNumber(CoordinatorEntity, NumberEntity):
    """Set how long manual overrides last (in minutes)."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:timer-cog-outline"
    _attr_mode = NumberMode.BOX
    _attr_native_unit_of_measurement = "min"
    _attr_native_min_value = 15
    _attr_native_max_value = 480
    _attr_native_step = 15

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Override Duration"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_override_duration"

    @property
    def native_value(self) -> float:
        return float(self.coordinator.manual_override_minutes)

    async def async_set_native_value(self, value: float) -> None:
        value = max(15, min(480, value))
        self.coordinator.manual_override_minutes = int(value)
        await self.coordinator.async_save()
        self.async_write_ha_state()


class CoolingComfortNumber(CoordinatorEntity, NumberEntity):
    """Set the default comfort temperature used during cooling season.

    Applied when a schedule entry has no explicit cooling_temp set, and as
    the fallback when no schedule is active.  Equivalent to AwayTempNumber
    but for summer comfort rather than winter away.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:thermometer-high"
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Cooling Comfort Temperature"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_cooling_comfort"
        self._attr_native_min_value = coordinator.temp_min
        self._attr_native_max_value = coordinator.temp_max
        self._attr_native_step = 1.0

    @property
    def native_value(self) -> float:
        return self.coordinator.cooling_comfort

    async def async_set_native_value(self, value: float) -> None:
        value = max(self._attr_native_min_value, min(self._attr_native_max_value, value))
        self.coordinator.cooling_comfort = value
        await self.coordinator.async_save()
        self.async_write_ha_state()


class CoolingAwayTempNumber(CoordinatorEntity, NumberEntity):
    """Set the away temperature used during cooling season.

    When nobody is home in summer, the thermostat setpoint is raised to this
    value (rather than lowered as in winter).  Default 78°F keeps the house
    from getting too hot without running the AC constantly while empty.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:home-export-outline"
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Cooling Away Temperature"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_cooling_away_temp"
        self._attr_native_min_value = coordinator.temp_min
        self._attr_native_max_value = coordinator.temp_max
        self._attr_native_step = 1.0

    @property
    def native_value(self) -> float:
        return self.coordinator.cooling_away_temp

    async def async_set_native_value(self, value: float) -> None:
        value = max(self._attr_native_min_value, min(self._attr_native_max_value, value))
        self.coordinator.cooling_away_temp = value
        await self.coordinator.async_save()
        self.async_write_ha_state()
