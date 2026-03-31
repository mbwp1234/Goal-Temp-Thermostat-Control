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
        TOUSwitch(coordinator, config_entry, name),
        PreconditionSwitch(coordinator, config_entry, name),
        WindowsOpenSwitch(coordinator, config_entry, name),
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


class TOUSwitch(CoordinatorEntity, SwitchEntity):
    """Toggle time-of-use rate optimization on/off."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:lightning-bolt-circle"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} TOU Optimization"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_tou"

    @property
    def is_on(self) -> bool:
        return self.coordinator.tou_enabled

    @property
    def extra_state_attributes(self):
        data = self.coordinator.data or {}
        return {
            "rate_period": data.get("tou_rate_period"),
            "provider": self.coordinator.tou_provider.name,
        }

    async def async_turn_on(self, **kwargs) -> None:
        self.coordinator.tou_enabled = True
        await self.coordinator.async_save()
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self.coordinator.tou_enabled = False
        await self.coordinator.async_save()
        self.async_write_ha_state()


class PreconditionSwitch(CoordinatorEntity, SwitchEntity):
    """Toggle pre-conditioning (early temperature ramp before schedule changes)."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:thermometer-chevron-up"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Pre-conditioning"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_precondition"

    @property
    def is_on(self) -> bool:
        return self.coordinator.precondition_enabled

    @property
    def extra_state_attributes(self):
        data = self.coordinator.data or {}
        return {"precondition_active": data.get("precondition_active", False)}

    async def async_turn_on(self, **kwargs) -> None:
        self.coordinator.precondition_enabled = True
        await self.coordinator.async_save()
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self.coordinator.precondition_enabled = False
        await self.coordinator.async_save()
        self.async_write_ha_state()


class WindowsOpenSwitch(CoordinatorEntity, SwitchEntity):
    """Manually mark windows as open to suspend thermostat control.

    Useful when you don't have window sensors but want to pause GTTC
    (e.g. while airing out the house).  Turning this on has the same
    effect as a window sensor reporting open — heating/cooling stops.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:window-open-variant"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Windows Open"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_windows_open_override"

    @property
    def is_on(self) -> bool:
        data = self.coordinator.data or {}
        return bool(data.get("windows_open", False))

    @property
    def extra_state_attributes(self):
        data = self.coordinator.data or {}
        return {
            "any_window_open": data.get("windows_open", False),
            "monitored_sensors": list(self.coordinator.window_sensors),
            "open_sensors": self.coordinator.get_open_window_sensors(),
        }

    async def async_turn_on(self, **kwargs) -> None:
        self.coordinator.windows_open_override = True
        await self.coordinator.async_save()
        self.coordinator.async_set_updated_data(
            self.coordinator._build_state_dict()
        )
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self.coordinator.windows_open_override = False
        await self.coordinator.async_save()
        self.coordinator.async_set_updated_data(
            self.coordinator._build_state_dict()
        )
        self.async_write_ha_state()
