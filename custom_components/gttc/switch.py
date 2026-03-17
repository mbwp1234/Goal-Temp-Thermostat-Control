"""Switch entities for GTTC."""
from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
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

    async_add_entities([
        LearningSwitch(coordinator, config_entry, name),
        OccupancySwitch(coordinator, config_entry, name),
        ScheduleSwitch(coordinator, config_entry, name),
    ])


class LearningSwitch(CoordinatorEntity, SwitchEntity):
    """Toggle the learning engine on/off."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:brain"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Learning"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_learning"

    @property
    def is_on(self) -> bool:
        return self.coordinator.learning_enabled

    async def async_turn_on(self, **kwargs) -> None:
        self.coordinator.learning_enabled = True
        await self.coordinator.async_save()
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self.coordinator.learning_enabled = False
        await self.coordinator.async_save()
        self.async_write_ha_state()


class OccupancySwitch(CoordinatorEntity, SwitchEntity):
    """Toggle occupancy-based adjustments on/off."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:account-check"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Occupancy Mode"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_occupancy"

    @property
    def is_on(self) -> bool:
        return self.coordinator.occupancy_enabled

    async def async_turn_on(self, **kwargs) -> None:
        self.coordinator.occupancy_enabled = True
        await self.coordinator.async_save()
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self.coordinator.occupancy_enabled = False
        await self.coordinator.async_save()
        self.async_write_ha_state()


class ScheduleSwitch(CoordinatorEntity, SwitchEntity):
    """Toggle schedule on/off (when off, only manual control)."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:calendar-check"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Schedule"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_schedule_active"

    @property
    def is_on(self) -> bool:
        return self.coordinator.schedule_enabled

    async def async_turn_on(self, **kwargs) -> None:
        self.coordinator.set_schedule_enabled(True)
        await self.coordinator.async_save()
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self.coordinator.set_schedule_enabled(False)
        await self.coordinator.async_save()
        self.async_write_ha_state()
