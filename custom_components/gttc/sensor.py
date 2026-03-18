"""Sensor entities for GTTC."""
from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_NAME, CONF_TEMP_UNIT, DEFAULT_NAME, DEFAULT_TEMP_UNIT, DOMAIN
from .coordinator import GTTCCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: GTTCCoordinator = hass.data[DOMAIN][config_entry.entry_id]
    name = config_entry.data.get(CONF_NAME, DEFAULT_NAME)
    temp_unit = config_entry.data.get(CONF_TEMP_UNIT, DEFAULT_TEMP_UNIT)

    entities: list[SensorEntity] = [
        ActiveZoneTempSensor(coordinator, config_entry, name, temp_unit),
        OverrideRemainingSensor(coordinator, config_entry, name),
        LearnedPatternsSensor(coordinator, config_entry, name),
        OutdoorTempSensor(coordinator, config_entry, name, temp_unit),
        TOURateSensor(coordinator, config_entry, name),
    ]

    # Create a temperature sensor per zone
    for zone_id, zone in coordinator.zone_manager.zones.items():
        entities.append(
            ZoneTempSensor(coordinator, config_entry, zone.name, zone_id, temp_unit)
        )

    async_add_entities(entities)


class ActiveZoneTempSensor(CoordinatorEntity, SensorEntity):
    """Shows the active zone's averaged temperature."""

    _attr_has_entity_name = True
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator, config_entry, name, temp_unit):
        super().__init__(coordinator)
        self._attr_name = f"{name} Active Zone Temperature"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_active_zone_temp"
        self._attr_native_unit_of_measurement = (
            UnitOfTemperature.CELSIUS if temp_unit == "°C" else UnitOfTemperature.FAHRENHEIT
        )

    @property
    def available(self) -> bool:
        return self.coordinator.available

    @property
    def native_value(self) -> float | None:
        return self.coordinator.current_temp


class ZoneTempSensor(CoordinatorEntity, SensorEntity):
    """Shows a specific zone's averaged temperature."""

    _attr_has_entity_name = True
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator, config_entry, zone_name, zone_id, temp_unit):
        super().__init__(coordinator)
        self._zone_id = zone_id
        self._attr_name = f"{zone_name} Temperature"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_zone_{zone_id}_temp"
        self._attr_native_unit_of_measurement = (
            UnitOfTemperature.CELSIUS if temp_unit == "°C" else UnitOfTemperature.FAHRENHEIT
        )

    @property
    def native_value(self) -> float | None:
        zone = self.coordinator.zone_manager.get_zone(self._zone_id)
        return zone.current_temp if zone else None


class OverrideRemainingSensor(CoordinatorEntity, SensorEntity):
    """Shows remaining minutes of manual override."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:timer-outline"
    _attr_native_unit_of_measurement = "min"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Override Remaining"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_override_remaining"

    @property
    def native_value(self) -> int:
        data = self.coordinator.data or {}
        return data.get("override_remaining", 0)


class LearnedPatternsSensor(CoordinatorEntity, SensorEntity):
    """Shows the number of learned schedule patterns."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:brain"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} Learned Patterns"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_learned_patterns"

    @property
    def native_value(self) -> int:
        return len(self.coordinator.learning.learned_entries)

    @property
    def extra_state_attributes(self):
        return {
            "patterns": self.coordinator.learning.learned_entries,
            "total_events": len(self.coordinator.learning.events),
        }


class OutdoorTempSensor(CoordinatorEntity, SensorEntity):
    """Shows the outdoor temperature used for heat pump optimization."""

    _attr_has_entity_name = True
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:thermometer"

    def __init__(self, coordinator, config_entry, name, temp_unit):
        super().__init__(coordinator)
        self._attr_name = f"{name} Outdoor Temperature"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_outdoor_temp"
        self._attr_native_unit_of_measurement = (
            UnitOfTemperature.CELSIUS if temp_unit == "°C" else UnitOfTemperature.FAHRENHEIT
        )

    @property
    def available(self) -> bool:
        return self.coordinator._outdoor_temp is not None

    @property
    def native_value(self) -> float | None:
        return self.coordinator._outdoor_temp

    @property
    def extra_state_attributes(self):
        from .const import OUTDOOR_COLD_THRESHOLD, OUTDOOR_MILD_THRESHOLD
        outdoor = self.coordinator._outdoor_temp
        if outdoor is None:
            status = "unavailable"
        elif outdoor < OUTDOOR_COLD_THRESHOLD:
            status = "cold (setbacks minimized)"
        elif outdoor > OUTDOOR_MILD_THRESHOLD:
            status = "mild (full setbacks allowed)"
        else:
            status = "moderate"
        return {
            "optimization_status": status,
            "cold_threshold": OUTDOOR_COLD_THRESHOLD,
            "mild_threshold": OUTDOOR_MILD_THRESHOLD,
            "sensor_entity": self.coordinator.outdoor_temp_sensor,
        }


class TOURateSensor(CoordinatorEntity, SensorEntity):
    """Shows the current TOU rate period."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:cash-clock"

    def __init__(self, coordinator, config_entry, name):
        super().__init__(coordinator)
        self._attr_name = f"{name} TOU Rate Period"
        self._attr_unique_id = f"{DOMAIN}_{config_entry.entry_id}_tou_rate"

    @property
    def native_value(self) -> str | None:
        data = self.coordinator.data or {}
        return data.get("tou_rate_period")

    @property
    def extra_state_attributes(self):
        provider = self.coordinator.tou_provider
        minutes_to_peak = provider.minutes_until_on_peak()
        minutes_to_off = provider.minutes_until_off_peak()
        return {
            "provider": provider.name,
            "enabled": self.coordinator.tou_enabled,
            "minutes_until_on_peak": minutes_to_peak,
            "minutes_until_off_peak": minutes_to_off,
        }
