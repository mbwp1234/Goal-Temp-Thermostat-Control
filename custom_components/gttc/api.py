"""WebSocket API for GTTC schedule panel."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, PRESETS

_LOGGER = logging.getLogger(__name__)


def async_register_api(hass: HomeAssistant) -> None:
    """Register all WebSocket commands."""
    websocket_api.async_register_command(hass, ws_get_schedule)
    websocket_api.async_register_command(hass, ws_update_entry)
    websocket_api.async_register_command(hass, ws_delete_entry)
    websocket_api.async_register_command(hass, ws_get_status)
    websocket_api.async_register_command(hass, ws_bulk_add_entry)
    websocket_api.async_register_command(hass, ws_copy_entry_to_days)
    websocket_api.async_register_command(hass, ws_cancel_override)
    websocket_api.async_register_command(hass, ws_deactivate_preset)
    websocket_api.async_register_command(hass, ws_set_schedule_mode)


def _get_coordinator(hass: HomeAssistant, entry_id: str | None = None):
    """Get the first (or specified) GTTC coordinator."""
    entries = hass.data.get(DOMAIN, {})
    if not entries:
        return None
    if entry_id:
        return entries.get(entry_id)
    for coord in entries.values():
        return coord
    return None


# ── Get full schedule ────────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/get_schedule",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_schedule(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Return the full schedule configuration."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    scheduler = coordinator.scheduler
    schedule = scheduler.schedule

    # Build preset data
    presets_data = {}
    for name, preset in scheduler.presets.items():
        presets_data[name] = {
            "name": preset.name,
            "label": preset.label,
            "schedule": {
                day: [e.to_dict() for e in ds.entries]
                for day, ds in preset.schedule.items()
            },
        }

    # Build zone data for the frontend
    zones_data = []
    for zone in coordinator.zone_manager.zones.values():
        zones_data.append(zone.to_dict())

    result = {
        "mode": schedule.mode,
        "active_preset": schedule.active_preset,
        "weekday": [e.to_dict() for e in schedule.weekday.entries],
        "weekend": [e.to_dict() for e in schedule.weekend.entries],
        "per_day": {
            day: [e.to_dict() for e in ds.entries]
            for day, ds in schedule.per_day.items()
        },
        "presets": presets_data,
        "preset_labels": PRESETS,
        "enabled": coordinator.schedule_enabled,
        "temp_min": coordinator.temp_min,
        "temp_max": coordinator.temp_max,
        "zones": zones_data,
        "active_zone_id": coordinator.zone_manager.active_zone_id,
    }
    connection.send_result(msg["id"], result)


# ── Update / add entry ──────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/update_entry",
        vol.Required("day"): str,
        vol.Required("time_start"): str,
        vol.Required("time_end"): str,
        vol.Required("target_temp"): vol.Coerce(float),
        vol.Optional("zone_id"): str,
        vol.Optional("old_time_start"): str,
        vol.Optional("old_time_end"): str,
        vol.Optional("preset"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_update_entry(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Add or update a schedule entry."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    scheduler = coordinator.scheduler
    preset_name = msg.get("preset") or scheduler.schedule.active_preset
    day = msg["day"]

    from .models import ScheduleEntry

    new_entry = ScheduleEntry(
        time_start=msg["time_start"],
        time_end=msg["time_end"],
        target_temp=msg["target_temp"],
        zone_id=msg.get("zone_id"),
    )

    # Determine which entry list to modify
    entries_list = _get_entries_list(scheduler, preset_name, day)
    if entries_list is None:
        connection.send_error(msg["id"], "invalid_day", f"Cannot find schedule for day '{day}'")
        return

    # If old_time_start provided, find and replace existing entry
    old_start = msg.get("old_time_start")
    old_end = msg.get("old_time_end")
    replaced = False
    if old_start and old_end:
        for i, entry in enumerate(entries_list):
            if entry.time_start == old_start and entry.time_end == old_end:
                entries_list[i] = new_entry
                replaced = True
                break

    if not replaced:
        entries_list.append(new_entry)

    # Sort by start time
    entries_list.sort(key=lambda e: e.time_start)

    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True})


# ── Delete entry ─────────────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/delete_entry",
        vol.Required("day"): str,
        vol.Required("time_start"): str,
        vol.Required("time_end"): str,
        vol.Optional("preset"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_delete_entry(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Delete a schedule entry."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    scheduler = coordinator.scheduler
    preset_name = msg.get("preset") or scheduler.schedule.active_preset
    day = msg["day"]

    entries_list = _get_entries_list(scheduler, preset_name, day)
    if entries_list is None:
        connection.send_error(msg["id"], "invalid_day", f"Cannot find schedule for day '{day}'")
        return

    original_len = len(entries_list)
    entries_list[:] = [
        e
        for e in entries_list
        if not (e.time_start == msg["time_start"] and e.time_end == msg["time_end"])
    ]

    if len(entries_list) == original_len:
        connection.send_error(msg["id"], "not_found", "Entry not found")
        return

    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True})


# ── Get current status ───────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/get_status",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_status(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Return current GTTC status."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    active_zone = coordinator.zone_manager.active_zone
    current_entry = coordinator.scheduler.get_current_entry()

    result = {
        "target_temp": coordinator.target_temp,
        "current_temp": coordinator.current_temp,
        "active_zone": active_zone.name if active_zone else None,
        "override_active": (
            coordinator.manual_override is not None
            and not coordinator.manual_override.is_expired
        ),
        "override_remaining": (
            coordinator.manual_override.remaining_minutes
            if coordinator.manual_override and not coordinator.manual_override.is_expired
            else 0
        ),
        "current_entry": current_entry.to_dict() if current_entry else None,
        "schedule_enabled": coordinator.schedule_enabled,
    }
    connection.send_result(msg["id"], result)


# ── Bulk add entry to multiple days ──────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/bulk_add_entry",
        vol.Required("days"): [str],
        vol.Required("time_start"): str,
        vol.Required("time_end"): str,
        vol.Required("target_temp"): vol.Coerce(float),
        vol.Optional("zone_id"): str,
        vol.Optional("preset"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_bulk_add_entry(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Add a schedule entry to multiple days at once."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    scheduler = coordinator.scheduler
    preset_name = msg.get("preset") or scheduler.schedule.active_preset

    from .models import ScheduleEntry

    added_days = []
    failed_days = []

    for day in msg["days"]:
        new_entry = ScheduleEntry(
            time_start=msg["time_start"],
            time_end=msg["time_end"],
            target_temp=msg["target_temp"],
            zone_id=msg.get("zone_id"),
        )
        entries_list = _get_entries_list(scheduler, preset_name, day)
        if entries_list is None:
            failed_days.append(day)
            continue
        entries_list.append(new_entry)
        entries_list.sort(key=lambda e: e.time_start)
        added_days.append(day)

    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True, "added_days": added_days, "failed_days": failed_days})


# ── Copy entry to other days ────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/copy_entry_to_days",
        vol.Required("source_day"): str,
        vol.Required("time_start"): str,
        vol.Required("time_end"): str,
        vol.Required("target_days"): [str],
        vol.Optional("preset"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_copy_entry_to_days(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Copy a schedule entry from one day to other days."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    scheduler = coordinator.scheduler
    preset_name = msg.get("preset") or scheduler.schedule.active_preset

    # Find source entry
    source_list = _get_entries_list(scheduler, preset_name, msg["source_day"])
    if source_list is None:
        connection.send_error(msg["id"], "invalid_day", f"Cannot find schedule for day '{msg['source_day']}'")
        return

    source_entry = None
    for entry in source_list:
        if entry.time_start == msg["time_start"] and entry.time_end == msg["time_end"]:
            source_entry = entry
            break

    if source_entry is None:
        connection.send_error(msg["id"], "not_found", "Source entry not found")
        return

    from .models import ScheduleEntry

    copied_days = []
    for day in msg["target_days"]:
        target_list = _get_entries_list(scheduler, preset_name, day)
        if target_list is None:
            continue
        new_entry = ScheduleEntry(
            time_start=source_entry.time_start,
            time_end=source_entry.time_end,
            target_temp=source_entry.target_temp,
            zone_id=source_entry.zone_id,
        )
        target_list.append(new_entry)
        target_list.sort(key=lambda e: e.time_start)
        copied_days.append(day)

    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True, "copied_days": copied_days})


# ── Cancel override via WebSocket ───────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/cancel_override",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_cancel_override(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Cancel the active manual override."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    await coordinator.async_cancel_override()
    connection.send_result(msg["id"], {"success": True})


# ── Deactivate preset ──────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/deactivate_preset",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_deactivate_preset(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Deactivate the current preset and return to custom schedule."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    coordinator.scheduler.deactivate_preset()
    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True})


# ── Set schedule mode ───────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/set_schedule_mode",
        vol.Required("mode"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_set_schedule_mode(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Switch schedule mode between weekday_weekend and per_day."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    coordinator.scheduler.set_schedule_mode(msg["mode"])
    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True})


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_entries_list(scheduler, preset_name, day):
    """Get the mutable entries list for a given preset/day combo."""
    from .const import WEEKDAYS, WEEKEND, ALL_DAYS

    if preset_name and preset_name in scheduler.presets:
        preset = scheduler.presets[preset_name]
        day_lower = day.lower()
        if day_lower in preset.schedule:
            return preset.schedule[day_lower].entries
        return None

    day_lower = day.lower()
    if scheduler.schedule.mode == "per_day":
        if day_lower in scheduler.schedule.per_day:
            return scheduler.schedule.per_day[day_lower].entries
        return None

    # weekday/weekend mode
    if day_lower in ("weekday",) or day_lower in WEEKDAYS:
        return scheduler.schedule.weekday.entries
    if day_lower in ("weekend",) or day_lower in WEEKEND:
        return scheduler.schedule.weekend.entries

    return None
