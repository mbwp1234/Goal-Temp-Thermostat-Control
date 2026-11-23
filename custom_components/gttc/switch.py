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
        ScheduleSwitch(coordinator, config_entry, name),
        WindowsOpenSwitch(coordinator, config_entry, name),
        AutoSeasonSwitch(coordinator, config_entry, name),
    ])


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


class AutoSeasonSwitch(CoordinatorEntity, SwitchEntity):
    """Allow GTTC to automatically switch heating/cooling season.

    When on, the coordinator will switch the season once outdoor conditions
    have been opposite to the current season for at least the configured
    threshold (default 3 hours), instead of only surfacing a recommendation.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:autorenew"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Auto Season Switch"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_auto_season_switch"

    @property
    def is_on(self) -> bool:
        return self.coordinator.auto_season_switch

    @property
    def extra_state_attributes(self):
        data = self.coordinator.data or {}
        return {
            "current_season": data.get("season"),
            "suggest_switch": data.get("suggest_season_switch", False),
            "conditions_sustained_hours": data.get("season_conditions_hours", 0),
            "threshold_hours": self.coordinator.season_threshold_hours,
        }

    async def async_turn_on(self, **kwargs) -> None:
        self.coordinator.auto_season_switch = True
        await self.coordinator.async_save()
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        self.coordinator.auto_season_switch = False
        await self.coordinator.async_save()
        self.async_write_ha_state()
