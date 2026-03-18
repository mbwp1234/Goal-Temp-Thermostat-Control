"""Goal Temp Thermostat Control (GTTC) - Smart zone-aware thermostat with learning and scheduling."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_TEMPERATURE
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .api import async_register_api
from .const import (
    CONF_ZONES,
    DOMAIN,
    PLATFORMS,
    SERVICE_ASSIGN_SENSOR,
    SERVICE_CANCEL_OVERRIDE,
    SERVICE_CLEAR_LEARNED,
    SERVICE_REMOVE_SENSOR,
    SERVICE_SET_PRESET,
    SERVICE_SET_SCHEDULE,
    SERVICE_SET_ZONE_TEMP,
    SERVICE_TOGGLE_SCHEDULE,
)
from .coordinator import GTTCCoordinator
from .models import Zone

_LOGGER = logging.getLogger(__name__)

PANEL_URL = "/gttc_panel"
PANEL_ICON = "mdi:calendar-clock"
PANEL_TITLE = "GTTC Schedule"
FRONTEND_DIR = Path(__file__).parent / "frontend"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up GTTC from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    coordinator = GTTCCoordinator(hass, entry)

    # Load zones from config
    zones_data = entry.data.get(CONF_ZONES, [])
    for zone_data in zones_data:
        try:
            zone = Zone.from_dict(zone_data)
            coordinator.zone_manager.add_zone(zone)
        except Exception as err:
            _LOGGER.warning("Skipping invalid zone config: %s", err)

    # Initialize (loads stored state)
    await coordinator.async_initialize()

    # Do first refresh
    await coordinator.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    # Set up platforms
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Register services (idempotent)
    _register_services(hass)

    # Register WebSocket API and sidebar panel (idempotent)
    await _async_register_panel(hass)

    # Listen for options updates
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)

    # Unregister services if no more entries
    if not hass.data.get(DOMAIN):
        for service in (
            SERVICE_SET_ZONE_TEMP,
            SERVICE_SET_SCHEDULE,
            SERVICE_CLEAR_LEARNED,
            SERVICE_SET_PRESET,
            SERVICE_ASSIGN_SENSOR,
            SERVICE_REMOVE_SENSOR,
            SERVICE_CANCEL_OVERRIDE,
            SERVICE_TOGGLE_SCHEDULE,
        ):
            hass.services.async_remove(DOMAIN, service)

    return unload_ok


async def _async_update_listener(
    hass: HomeAssistant, entry: ConfigEntry
) -> None:
    """Handle options update - reload the integration."""
    await hass.config_entries.async_reload(entry.entry_id)


def _get_coordinator(
    hass: HomeAssistant, entry_id: str | None = None
) -> GTTCCoordinator | None:
    """Safely get a coordinator instance."""
    entries = hass.data.get(DOMAIN, {})
    if not entries:
        return None

    if entry_id:
        coordinator = entries.get(entry_id)
        if isinstance(coordinator, GTTCCoordinator):
            return coordinator
        return None

    # Return the first coordinator found
    for coordinator in entries.values():
        if isinstance(coordinator, GTTCCoordinator):
            return coordinator
    return None


async def _async_register_panel(hass: HomeAssistant) -> None:
    """Register the sidebar panel and WebSocket API (idempotent)."""
    # Register WebSocket commands
    async_register_api(hass)

    # Serve the frontend JS file
    await hass.http.async_register_static_paths(
        [StaticPathConfig(PANEL_URL, str(FRONTEND_DIR / "gttc-panel.js"), False)]
    )

    # Register the sidebar panel
    hass.components.frontend.async_register_panel(
        component_name="custom",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        frontend_url_path="gttc-schedule",
        config={"_panel_custom": {"name": "gttc-panel", "js_url": PANEL_URL}},
        require_admin=False,
    )


def _register_services(hass: HomeAssistant) -> None:
    """Register custom services (idempotent)."""
    if hass.services.has_service(DOMAIN, SERVICE_SET_ZONE_TEMP):
        return

    async def handle_set_zone_temp(call: ServiceCall) -> None:
        zone_id = call.data["zone_id"]
        temperature = call.data[ATTR_TEMPERATURE]
        coordinator = _get_coordinator(hass, call.data.get("entry_id"))
        if coordinator is None:
            _LOGGER.error("No GTTC instance found")
            return
        zone = coordinator.zone_manager.get_zone(zone_id)
        if zone is None:
            _LOGGER.error("Zone '%s' not found", zone_id)
            return
        await coordinator.async_set_active_zone(zone_id)
        await coordinator.async_set_temperature(temperature)

    async def handle_set_schedule(call: ServiceCall) -> None:
        day = call.data["day"]
        entries = call.data["entries"]
        coordinator = _get_coordinator(hass, call.data.get("entry_id"))
        if coordinator is None:
            _LOGGER.error("No GTTC instance found")
            return
        if not entries:
            _LOGGER.warning("Empty schedule entries for day '%s'", day)
            return
        if day == "weekday":
            coordinator.scheduler.set_weekday_schedule(entries)
        elif day == "weekend":
            coordinator.scheduler.set_weekend_schedule(entries)
        else:
            coordinator.scheduler.set_day_schedule(day, entries)
        await coordinator.async_save()

    async def handle_clear_learned(call: ServiceCall) -> None:
        coordinator = _get_coordinator(hass, call.data.get("entry_id"))
        if coordinator is None:
            _LOGGER.error("No GTTC instance found")
            return
        coordinator.learning.clear_learned()
        await coordinator.async_save()

    async def handle_set_preset(call: ServiceCall) -> None:
        preset = call.data["preset"]
        coordinator = _get_coordinator(hass, call.data.get("entry_id"))
        if coordinator is None:
            _LOGGER.error("No GTTC instance found")
            return
        if not coordinator.scheduler.activate_preset(preset):
            _LOGGER.error("Unknown preset '%s'", preset)
        await coordinator.async_save()

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

    async def handle_assign_sensor(call: ServiceCall) -> None:
        zone_id = call.data["zone_id"]
        sensor_entity = call.data["sensor_entity"]
        sensor_type = call.data.get("sensor_type", "temperature")
        coordinator = _get_coordinator(hass, call.data.get("entry_id"))
        if coordinator is None:
            _LOGGER.error("No GTTC instance found")
            return
        if coordinator.zone_manager.assign_sensor_to_zone(
            zone_id, sensor_entity, sensor_type
        ):
            await coordinator.async_save()
            coordinator.async_set_updated_data(coordinator._build_state_dict())
        else:
            _LOGGER.error("Failed to assign sensor '%s' to zone '%s'", sensor_entity, zone_id)

    async def handle_remove_sensor(call: ServiceCall) -> None:
        zone_id = call.data["zone_id"]
        sensor_entity = call.data["sensor_entity"]
        sensor_type = call.data.get("sensor_type", "temperature")
        coordinator = _get_coordinator(hass, call.data.get("entry_id"))
        if coordinator is None:
            _LOGGER.error("No GTTC instance found")
            return
        if coordinator.zone_manager.remove_sensor_from_zone(
            zone_id, sensor_entity, sensor_type
        ):
            await coordinator.async_save()
            coordinator.async_set_updated_data(coordinator._build_state_dict())
        else:
            _LOGGER.error("Sensor '%s' not found in zone '%s'", sensor_entity, zone_id)

    hass.services.async_register(
        DOMAIN,
        SERVICE_ASSIGN_SENSOR,
        handle_assign_sensor,
        schema=vol.Schema(
            {
                vol.Required("zone_id"): cv.string,
                vol.Required("sensor_entity"): cv.string,
                vol.Optional("sensor_type", default="temperature"): vol.In(
                    ["temperature", "occupancy"]
                ),
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )

    hass.services.async_register(
        DOMAIN,
        SERVICE_REMOVE_SENSOR,
        handle_remove_sensor,
        schema=vol.Schema(
            {
                vol.Required("zone_id"): cv.string,
                vol.Required("sensor_entity"): cv.string,
                vol.Optional("sensor_type", default="temperature"): vol.In(
                    ["temperature", "occupancy"]
                ),
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )

    async def handle_cancel_override(call: ServiceCall) -> None:
        coordinator = _get_coordinator(hass, call.data.get("entry_id"))
        if coordinator is None:
            _LOGGER.error("No GTTC instance found")
            return
        await coordinator.async_cancel_override()

    async def handle_toggle_schedule(call: ServiceCall) -> None:
        enabled = call.data["enabled"]
        coordinator = _get_coordinator(hass, call.data.get("entry_id"))
        if coordinator is None:
            _LOGGER.error("No GTTC instance found")
            return
        await coordinator.async_set_schedule_enabled(enabled)

    hass.services.async_register(
        DOMAIN,
        SERVICE_CANCEL_OVERRIDE,
        handle_cancel_override,
        schema=vol.Schema(
            {
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )

    hass.services.async_register(
        DOMAIN,
        SERVICE_TOGGLE_SCHEDULE,
        handle_toggle_schedule,
        schema=vol.Schema(
            {
                vol.Required("enabled"): cv.boolean,
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
