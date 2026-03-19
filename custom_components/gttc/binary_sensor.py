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

from .const import CONF_NAME, DEFAULT_NAME, DOMAIN, SEASON_COOLING
from .coordinator import GTTCCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: GTTCCoordinator = hass.data[DOMAIN][config_entry.entry_id]
    name = config_entry.data.get(CONF_NAME, DEFAULT_NAME)
    async_add_entities([
        WindowsOpenSensor(coordinator, config_entry, name),
        CoolingSeasonBinarySensor(coordinator, config_entry, name),
        SeasonSwitchRecommendedBinarySensor(coordinator, config_entry, name),
    ])


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


class CoolingSeasonBinarySensor(CoordinatorEntity, BinarySensorEntity):
    """True when GTTC is currently in cooling season.

    Useful as a condition in automations, dashboard visibility cards,
    and any logic that should behave differently in summer vs. winter.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:snowflake-thermometer"

    def __init__(self, coordinator: GTTCCoordinator, config_entry, name: str) -> None:
        super().__init__(coordinator)
        self._attr_name = f"{name} Cooling Season"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_cooling_season"

    @property
    def is_on(self) -> bool:
        return self.coordinator.season == SEASON_COOLING

    @property
    def extra_state_attributes(self) -> dict:
        coord = self.coordinator
        return {
            "season": coord.season,
            "cooling_comfort": coord.cooling_comfort,
            "cooling_away_temp": coord.cooling_away_temp,
        }


class SeasonSwitchRecommendedBinarySensor(CoordinatorEntity, BinarySensorEntity):
    """True when outdoor conditions suggest switching to the opposite season.

    Fires after outdoor temp has been opposite to the current season by at
    least the configured margin for at least ``seasonal_recommend_hours``
    continuous hours.  The system never acts on this automatically — it is
    purely a notification signal.

    Use this in an HA automation to get a mobile notification when it is
    time to flip to cooling or heating.
    """

    _attr_has_entity_name = True
    _attr_icon = "mdi:thermometer-alert"

    def __init__(self, coordinator: GTTCCoordinator, config_entry, name: str) -> None:
        super().__init__(coordinator)
        self._attr_name = f"{name} Season Switch Recommended"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_season_switch_recommended"

    @property
    def is_on(self) -> bool:
        return self.coordinator.suggest_season_switch

    @property
    def extra_state_attributes(self) -> dict:
        coord = self.coordinator
        return {
            "current_season": coord.season,
            "recommended_season": (
                "cooling" if coord.season == "heating" else "heating"
            ),
            "conditions_sustained_hours": coord.season_conditions_hours,
            "threshold_hours": coord.seasonal_recommend_hours,
            "outdoor_temp": coord._outdoor_temp,
            "indoor_temp": coord.current_temp,
        }
