"""Better Thermostat - Smart zone-aware thermostat with learning and scheduling."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_TEMPERATURE
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .const import (
    CONF_ZONES,
    DOMAIN,
    PLATFORMS,
    SERVICE_CLEAR_LEARNED,
    SERVICE_SET_PRESET,
    SERVICE_SET_SCHEDULE,
    SERVICE_SET_ZONE_TEMP,
)
from .coordinator import BetterThermostatCoordinator
from .models import Zone

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Better Thermostat from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    coordinator = BetterThermostatCoordinator(hass, entry)

    # Load zones from config
    zones_data = entry.data.get(CONF_ZONES, [])
    for zone_data in zones_data:
        zone = Zone.from_dict(zone_data)
        coordinator.zone_manager.add_zone(zone)

    # Initialize (loads stored state)
    await coordinator.async_initialize()

    # Do first refresh
    await coordinator.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    # Set up platforms
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Register services
    await _async_register_services(hass)

    # Listen for options updates
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok


async def _async_update_listener(
    hass: HomeAssistant, entry: ConfigEntry
) -> None:
    """Handle options update - reload the integration."""
    await hass.config_entries.async_reload(entry.entry_id)


async def _async_register_services(hass: HomeAssistant) -> None:
    """Register custom services."""
    if hass.services.has_service(DOMAIN, SERVICE_SET_ZONE_TEMP):
        return  # Already registered

    async def handle_set_zone_temp(call: ServiceCall) -> None:
        """Set target temperature for a specific zone."""
        zone_id = call.data["zone_id"]
        temperature = call.data[ATTR_TEMPERATURE]
        entry_id = call.data.get("entry_id")

        for eid, coordinator in hass.data[DOMAIN].items():
            if entry_id and eid != entry_id:
                continue
            if isinstance(coordinator, BetterThermostatCoordinator):
                zone = coordinator.zone_manager.get_zone(zone_id)
                if zone:
                    await coordinator.async_set_active_zone(zone_id)
                    await coordinator.async_set_temperature(temperature)
                    return

    async def handle_set_schedule(call: ServiceCall) -> None:
        """Set schedule entries for a day."""
        day = call.data["day"]
        entries = call.data["entries"]
        entry_id = call.data.get("entry_id")

        for eid, coordinator in hass.data[DOMAIN].items():
            if entry_id and eid != entry_id:
                continue
            if isinstance(coordinator, BetterThermostatCoordinator):
                if day == "weekday":
                    coordinator.scheduler.set_weekday_schedule(entries)
                elif day == "weekend":
                    coordinator.scheduler.set_weekend_schedule(entries)
                else:
                    coordinator.scheduler.set_day_schedule(day, entries)
                return

    async def handle_clear_learned(call: ServiceCall) -> None:
        """Clear learned schedule patterns."""
        entry_id = call.data.get("entry_id")

        for eid, coordinator in hass.data[DOMAIN].items():
            if entry_id and eid != entry_id:
                continue
            if isinstance(coordinator, BetterThermostatCoordinator):
                coordinator.learning.clear_learned()
                return

    async def handle_set_preset(call: ServiceCall) -> None:
        """Activate a schedule preset."""
        preset = call.data["preset"]
        entry_id = call.data.get("entry_id")

        for eid, coordinator in hass.data[DOMAIN].items():
            if entry_id and eid != entry_id:
                continue
            if isinstance(coordinator, BetterThermostatCoordinator):
                coordinator.scheduler.activate_preset(preset)
                return

    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_ZONE_TEMP,
        handle_set_zone_temp,
        schema=vol.Schema(
            {
                vol.Required("zone_id"): cv.string,
                vol.Required(ATTR_TEMPERATURE): vol.Coerce(float),
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )

    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_SCHEDULE,
        handle_set_schedule,
        schema=vol.Schema(
            {
                vol.Required("day"): cv.string,
                vol.Required("entries"): vol.All(
                    cv.ensure_list,
                    [
                        vol.Schema(
                            {
                                vol.Required("time_start"): cv.string,
                                vol.Required("time_end"): cv.string,
                                vol.Required("target_temp"): vol.Coerce(float),
                                vol.Optional("zone_id"): cv.string,
                            }
                        )
                    ],
                ),
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )

    hass.services.async_register(
        DOMAIN,
        SERVICE_CLEAR_LEARNED,
        handle_clear_learned,
        schema=vol.Schema(
            {
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )

    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_PRESET,
        handle_set_preset,
        schema=vol.Schema(
            {
                vol.Required("preset"): cv.string,
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
