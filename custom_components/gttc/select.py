"""Select entities for GTTC."""
from __future__ import annotations

import logging

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    CONF_NAME,
    DEFAULT_NAME,
    DOMAIN,
    SCHEDULE_MODE_PER_DAY,
    SCHEDULE_MODE_WEEKDAY_WEEKEND,
    SEASON_COOLING,
    SEASON_HEATING,
)
from .coordinator import GTTCCoordinator

_LOGGER = logging.getLogger(__name__)

_NO_ZONES = "No zones configured"


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: GTTCCoordinator = hass.data[DOMAIN][config_entry.entry_id]
    name = config_entry.data.get(CONF_NAME, DEFAULT_NAME)

    async_add_entities([
        ActiveZoneSelect(coordinator, config_entry, name),
        ScheduleModeSelect(coordinator, config_entry, name),
        SeasonModeSelect(coordinator, config_entry, name),
    ])


class ActiveZoneSelect(CoordinatorEntity, SelectEntity):
    """Select entity for choosing the active target zone."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:home-floor-a"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Active Zone"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_active_zone"

    @property
    def options(self) -> list[str]:
        zones = self.coordinator.zone_manager.get_all_zone_names()
        return list(zones.values()) if zones else [_NO_ZONES]

    @property
    def current_option(self) -> str | None:
        zone = self.coordinator.zone_manager.active_zone
        return zone.name if zone else None

    async def async_select_option(self, option: str) -> None:
        if option == _NO_ZONES:
            return
        for zone_id, zone_name in self.coordinator.zone_manager.get_all_zone_names().items():
            if zone_name == option:
                await self.coordinator.async_set_active_zone(zone_id)
                return
        _LOGGER.warning("Zone not found for option: %s", option)


class ScheduleModeSelect(CoordinatorEntity, SelectEntity):
    """Select entity for choosing the schedule mode."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Schedule Mode"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_schedule_mode"

    @property
    def options(self) -> list[str]:
        return ["Weekday/Weekend", "Per Day"]

    @property
    def current_option(self) -> str | None:
        mode = self.coordinator.scheduler.schedule.mode
        if mode == SCHEDULE_MODE_PER_DAY:
            return "Per Day"
        return "Weekday/Weekend"

    async def async_select_option(self, option: str) -> None:
        if option == "Per Day":
            self.coordinator.scheduler.set_schedule_mode(SCHEDULE_MODE_PER_DAY)
        else:
            self.coordinator.scheduler.set_schedule_mode(SCHEDULE_MODE_WEEKDAY_WEEKEND)
        await self.coordinator.async_save()


class SeasonModeSelect(CoordinatorEntity, SelectEntity):
    """Select entity for controlling the heating / cooling season.

    Switching season immediately updates the real thermostat's HVAC mode (heat
    or cool) and causes all schedule entries to use their season-appropriate
    target temperatures.  The system never switches automatically — this entity
    is always the authoritative control.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:weather-partly-cloudy"

    _OPTION_HEATING = "Heating"
    _OPTION_COOLING = "Cooling"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Season Mode"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_season_mode"

    @property
    def options(self) -> list[str]:
        return [self._OPTION_HEATING, self._OPTION_COOLING]

    @property
    def current_option(self) -> str | None:
        if self.coordinator.season == SEASON_COOLING:
            return self._OPTION_COOLING
        return self._OPTION_HEATING

    @property
    def extra_state_attributes(self):
        return {
            "suggest_switch": self.coordinator.suggest_season_switch,
            "conditions_sustained_hours": self.coordinator.season_conditions_hours,
            "recommend_hours_threshold": self.coordinator.seasonal_recommend_hours,
        }

    async def async_select_option(self, option: str) -> None:
        if option == self._OPTION_COOLING:
            await self.coordinator.async_set_season(SEASON_COOLING)
        elif option == self._OPTION_HEATING:
            await self.coordinator.async_set_season(SEASON_HEATING)
        else:
            _LOGGER.warning("Unknown season option: %s", option)
