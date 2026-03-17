"""Climate entity for GTTC."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACAction,
    HVACMode,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_TEMPERATURE, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    ATTR_ACTIVE_ZONE,
    ATTR_ALL_ZONES,
    ATTR_CURRENT_SCHEDULE_ENTRY,
    ATTR_LEARNING_STATUS,
    ATTR_OCCUPANCY_STATUS,
    ATTR_OVERRIDE_ACTIVE,
    ATTR_OVERRIDE_REMAINING,
    ATTR_PRESENCE_HOME,
    ATTR_SCHEDULE_ACTIVE,
    ATTR_ZONE_DETAILS,
    ATTR_ZONE_TEMPS,
    CONF_NAME,
    CONF_TEMP_UNIT,
    DEFAULT_NAME,
    DEFAULT_TEMP_UNIT,
    DOMAIN,
    PRESET_LABEL_TO_KEY,
    PRESETS,
)
from .coordinator import GTTCCoordinator

_LOGGER = logging.getLogger(__name__)

PRESET_NONE = "None"


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up GTTC climate entity."""
    coordinator: GTTCCoordinator = hass.data[DOMAIN][config_entry.entry_id]
    name = config_entry.data.get(CONF_NAME, DEFAULT_NAME)
    temp_unit = config_entry.data.get(CONF_TEMP_UNIT, DEFAULT_TEMP_UNIT)

    async_add_entities(
        [GTTCClimate(coordinator, config_entry, name, temp_unit)]
    )


class GTTCClimate(CoordinatorEntity, ClimateEntity):
    """Virtual climate entity that controls the real thermostat via zone-aware scheduling."""

    _attr_has_entity_name = True
    _attr_target_temperature_step = 1.0
    _enable_turn_on_off_backwards_compat = False

    def __init__(
        self,
        coordinator: GTTCCoordinator,
        config_entry: ConfigEntry,
        name: str,
        temp_unit: str,
    ) -> None:
        super().__init__(coordinator)
        self._config_entry = config_entry
        self._attr_name = name
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_climate"
        self._temp_unit = temp_unit
        self._attr_preset_modes = list(PRESETS.values()) + [PRESET_NONE]

    @property
    def available(self) -> bool:
        """Entity is available when the real thermostat is reachable."""
        return self.coordinator.available

    @property
    def temperature_unit(self) -> str:
        if self._temp_unit == "°C":
            return UnitOfTemperature.CELSIUS
        return UnitOfTemperature.FAHRENHEIT

    @property
    def supported_features(self) -> ClimateEntityFeature:
        return (
            ClimateEntityFeature.TARGET_TEMPERATURE
            | ClimateEntityFeature.PRESET_MODE
            | ClimateEntityFeature.TURN_ON
            | ClimateEntityFeature.TURN_OFF
        )

    @property
    def hvac_modes(self) -> list[HVACMode]:
        return self.coordinator.get_thermostat_hvac_modes()

    @property
    def hvac_mode(self) -> HVACMode | None:
        return self.coordinator.hvac_mode

    @property
    def hvac_action(self) -> HVACAction | None:
        return self.coordinator.hvac_action

    @property
    def current_temperature(self) -> float | None:
        return self.coordinator.current_temp

    @property
    def target_temperature(self) -> float | None:
        return self.coordinator.target_temp

    @property
    def min_temp(self) -> float:
        return self.coordinator.get_thermostat_min_temp()

    @property
    def max_temp(self) -> float:
        return self.coordinator.get_thermostat_max_temp()

    @property
    def preset_mode(self) -> str | None:
        active = self.coordinator.scheduler.schedule.active_preset
        if active and active in PRESETS:
            return PRESETS[active]
        return PRESET_NONE

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        data = self.coordinator.data or {}
        return {
            ATTR_ACTIVE_ZONE: data.get("active_zone"),
            ATTR_ZONE_TEMPS: data.get("zone_temps", {}),
            ATTR_SCHEDULE_ACTIVE: data.get("schedule_enabled", False)
            and data.get("schedule_entry") is not None,
            ATTR_CURRENT_SCHEDULE_ENTRY: data.get("schedule_entry"),
            ATTR_OCCUPANCY_STATUS: data.get("zone_occupancy", {}),
            ATTR_PRESENCE_HOME: data.get("presence_home", True),
            ATTR_LEARNING_STATUS: data.get("learning_status", {}),
            ATTR_OVERRIDE_ACTIVE: data.get("override_active", False),
            ATTR_OVERRIDE_REMAINING: data.get("override_remaining", 0),
            ATTR_ALL_ZONES: self.coordinator.zone_manager.get_all_zone_names(),
            ATTR_ZONE_DETAILS: self.coordinator.zone_manager.get_zone_details(),
        }

    async def async_set_temperature(self, **kwargs: Any) -> None:
        temp = kwargs.get(ATTR_TEMPERATURE)
        if temp is not None:
            await self.coordinator.async_set_temperature(float(temp))

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        await self.coordinator.async_set_hvac_mode(hvac_mode)

    async def async_set_preset_mode(self, preset_mode: str) -> None:
        if preset_mode == PRESET_NONE:
            self.coordinator.scheduler.deactivate_preset()
        else:
            key = PRESET_LABEL_TO_KEY.get(preset_mode)
            if key:
                self.coordinator.scheduler.activate_preset(key)
            else:
                _LOGGER.warning("Unknown preset mode: %s", preset_mode)

    async def async_turn_on(self) -> None:
        modes = self.hvac_modes
        for preferred in (HVACMode.AUTO, HVACMode.HEAT_COOL, HVACMode.HEAT):
            if preferred in modes:
                await self.async_set_hvac_mode(preferred)
                return

    async def async_turn_off(self) -> None:
        await self.async_set_hvac_mode(HVACMode.OFF)
