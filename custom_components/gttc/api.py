"""WebSocket API for GTTC schedule panel."""
from __future__ import annotations

import copy
import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, PRESETS

_LOGGER = logging.getLogger(__name__)

# Undo/redo stacks keyed by coordinator entry_id (or "default")
_UNDO_STACKS: dict[str, list[dict]] = {}
_REDO_STACKS: dict[str, list[dict]] = {}
_MAX_UNDO = 20


def _get_undo_key(coordinator) -> str:
    """Get the undo stack key for a coordinator."""
    return coordinator.config_entry.entry_id


def _push_undo(coordinator) -> None:
    """Snapshot the current scheduler state onto the undo stack."""
    key = _get_undo_key(coordinator)
    if key not in _UNDO_STACKS:
        _UNDO_STACKS[key] = []
    snapshot = coordinator.scheduler.save()
    # Deep copy to avoid reference issues
    _UNDO_STACKS[key].append(copy.deepcopy(snapshot))
    if len(_UNDO_STACKS[key]) > _MAX_UNDO:
        _UNDO_STACKS[key].pop(0)
    # Clear redo stack on new action
    _REDO_STACKS[key] = []


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
    websocket_api.async_register_command(hass, ws_copy_day)
    websocket_api.async_register_command(hass, ws_create_custom_preset)
    websocket_api.async_register_command(hass, ws_delete_custom_preset)
    websocket_api.async_register_command(hass, ws_rename_custom_preset)
    websocket_api.async_register_command(hass, ws_export_schedule)
    websocket_api.async_register_command(hass, ws_import_schedule)
    websocket_api.async_register_command(hass, ws_undo_schedule)
    websocket_api.async_register_command(hass, ws_redo_schedule)
    websocket_api.async_register_command(hass, ws_get_diagnostics)
    websocket_api.async_register_command(hass, ws_add_window_sensor)
    websocket_api.async_register_command(hass, ws_remove_window_sensor)
    websocket_api.async_register_command(hass, ws_list_window_sensors)
    websocket_api.async_register_command(hass, ws_get_config)
    websocket_api.async_register_command(hass, ws_set_config)
    websocket_api.async_register_command(hass, ws_list_zones)
    websocket_api.async_register_command(hass, ws_save_zone)
    websocket_api.async_register_command(hass, ws_delete_zone)
    websocket_api.async_register_command(hass, ws_set_active_zone)
    websocket_api.async_register_command(hass, ws_list_persons)


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

    # Build preset labels including custom presets
    all_preset_labels = dict(PRESETS)
    for name, preset in scheduler.presets.items():
        if name not in all_preset_labels:
            all_preset_labels[name] = preset.label

    # Undo/redo availability
    undo_key = _get_undo_key(coordinator)
    can_undo = len(_UNDO_STACKS.get(undo_key, [])) > 0
    can_redo = len(_REDO_STACKS.get(undo_key, [])) > 0

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
        "preset_labels": all_preset_labels,
        "enabled": coordinator.schedule_enabled,
        "temp_min": coordinator.temp_min,
        "temp_max": coordinator.temp_max,
        "zones": zones_data,
        "active_zone_id": coordinator.zone_manager.active_zone_id,
        "can_undo": can_undo,
        "can_redo": can_redo,
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

    _push_undo(coordinator)

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

    # Check for time conflicts
    conflicts = _detect_conflicts(entries_list, new_entry, msg.get("old_time_start"), msg.get("old_time_end"))

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
    connection.send_result(msg["id"], {"success": True, "conflicts": conflicts})


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

    _push_undo(coordinator)

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
        "windows_open": coordinator._are_windows_open(),
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

    _push_undo(coordinator)
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

    _push_undo(coordinator)
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


# ── Copy entire day ─────────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/copy_day",
        vol.Required("source_day"): str,
        vol.Required("target_days"): [str],
        vol.Optional("preset"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_copy_day(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Copy all entries from one day to other days."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    _push_undo(coordinator)
    preset_name = msg.get("preset") or coordinator.scheduler.schedule.active_preset
    copied = coordinator.scheduler.copy_day_schedule(
        msg["source_day"], msg["target_days"], preset_name
    )
    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True, "copied_days": copied})


# ── Custom preset management ───────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/create_custom_preset",
        vol.Required("label"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_create_custom_preset(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Create a new custom preset."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    label = msg["label"].strip()
    if not label:
        connection.send_error(msg["id"], "invalid", "Preset label cannot be empty")
        return

    name = label.lower().replace(" ", "_")
    if not coordinator.scheduler.add_custom_preset(name, label):
        connection.send_error(msg["id"], "exists", f"Preset '{label}' already exists")
        return

    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True, "preset_name": name})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/delete_custom_preset",
        vol.Required("preset_name"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_delete_custom_preset(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Delete a custom (non-builtin) preset."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    if not coordinator.scheduler.remove_custom_preset(msg["preset_name"]):
        connection.send_error(msg["id"], "cannot_delete", "Cannot delete this preset (builtin or not found)")
        return

    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/rename_custom_preset",
        vol.Required("preset_name"): str,
        vol.Required("new_label"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_rename_custom_preset(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Rename a custom preset's label."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    if not coordinator.scheduler.rename_custom_preset(msg["preset_name"], msg["new_label"]):
        connection.send_error(msg["id"], "cannot_rename", "Cannot rename this preset (builtin or not found)")
        return

    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True})


# ── Export / Import schedule ───────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/export_schedule",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_export_schedule(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Export the full schedule as JSON."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    data = coordinator.scheduler.export_schedule()
    connection.send_result(msg["id"], {"success": True, "data": data})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/import_schedule",
        vol.Required("data"): dict,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_import_schedule(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Import a schedule from JSON data."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    _push_undo(coordinator)

    if not coordinator.scheduler.import_schedule(msg["data"]):
        connection.send_error(msg["id"], "import_failed", "Failed to import schedule data")
        return

    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True})


# ── Undo / Redo ────────────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/undo_schedule",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_undo_schedule(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Undo the last schedule change."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    key = _get_undo_key(coordinator)
    undo_stack = _UNDO_STACKS.get(key, [])
    if not undo_stack:
        connection.send_error(msg["id"], "nothing_to_undo", "No actions to undo")
        return

    # Save current state to redo stack
    if key not in _REDO_STACKS:
        _REDO_STACKS[key] = []
    _REDO_STACKS[key].append(copy.deepcopy(coordinator.scheduler.save()))

    # Restore previous state
    previous = undo_stack.pop()
    coordinator.scheduler.load(previous)
    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/redo_schedule",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_redo_schedule(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Redo a previously undone schedule change."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    key = _get_undo_key(coordinator)
    redo_stack = _REDO_STACKS.get(key, [])
    if not redo_stack:
        connection.send_error(msg["id"], "nothing_to_redo", "No actions to redo")
        return

    # Save current state to undo stack
    if key not in _UNDO_STACKS:
        _UNDO_STACKS[key] = []
    _UNDO_STACKS[key].append(copy.deepcopy(coordinator.scheduler.save()))

    # Restore next state
    next_state = redo_stack.pop()
    coordinator.scheduler.load(next_state)
    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True})


# ── Get diagnostics ───────────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/get_diagnostics",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_diagnostics(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Return comprehensive GTTC diagnostics for the status panel."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    # Look up entity IDs via entity registry
    from homeassistant.helpers import entity_registry as er
    ent_reg = er.async_get(hass)
    reg_entries = er.async_entries_for_config_entry(ent_reg, coordinator.config_entry.entry_id)
    climate_entity_id = None
    active_zone_temp_entity_id = None
    for reg_entry in reg_entries:
        if reg_entry.domain == "climate":
            climate_entity_id = reg_entry.entity_id
        if reg_entry.domain == "sensor" and "active_zone_temp" in reg_entry.unique_id:
            active_zone_temp_entity_id = reg_entry.entity_id

    # Thermostat state
    thermostat_state = hass.states.get(coordinator.thermostat_entity)
    thermostat_temp = None
    thermostat_setpoint = None
    thermostat_action = None
    if thermostat_state:
        attrs = thermostat_state.attributes
        thermostat_temp = attrs.get("current_temperature")
        thermostat_setpoint = attrs.get("temperature")
        raw_action = attrs.get("hvac_action")
        thermostat_action = str(raw_action) if raw_action else None

    # Zone details
    zones = []
    for zone in coordinator.zone_manager.zones.values():
        zones.append({
            "id": zone.id,
            "name": zone.name,
            "current_temp": zone.current_temp,
            "is_occupied": zone.is_occupied,
            "is_active": zone.id == coordinator.zone_manager.active_zone_id,
            "sensor_count": len(zone.sensor_entities),
        })

    override = coordinator.manual_override
    override_active = override is not None and not override.is_expired
    current_entry = coordinator.scheduler.get_current_entry()

    result = {
        "current_temp": coordinator.current_temp,
        "target_temp": coordinator.target_temp,
        "hvac_mode": coordinator.hvac_mode.value if coordinator.hvac_mode else None,
        "hvac_action": coordinator.hvac_action.value if coordinator.hvac_action else None,
        "override_active": override_active,
        "override_remaining_minutes": override.remaining_minutes if override_active else 0,
        "override_target_temp": override.target_temp if override_active else None,
        "override_started_at": override.started_at if override_active else None,
        "schedule_enabled": coordinator.schedule_enabled,
        "current_entry": current_entry.to_dict() if current_entry else None,
        "active_zone_name": coordinator.zone_manager.active_zone.name if coordinator.zone_manager.active_zone else None,
        "zones": zones,
        "learning": {
            "enabled": coordinator.learning_enabled,
            "events_recorded": len(coordinator.learning.events),
            "patterns_learned": len(coordinator.learning.learned_entries),
        },
        "features": {
            "tou_enabled": coordinator.tou_enabled,
            "tou_rate": (
                coordinator.tou_provider.get_rate_period().value
                if coordinator.tou_enabled else None
            ),
            "precondition_enabled": coordinator.precondition_enabled,
            "precondition_active": coordinator._is_preconditioning(),
            "occupancy_enabled": coordinator.occupancy_enabled,
            "heat_pump_detected": coordinator.is_heat_pump,
            "outdoor_temp": coordinator._outdoor_temp,
            "presence_home": coordinator.zone_manager.is_anyone_home(),
        },
        "thermostat_entity": coordinator.thermostat_entity,
        "thermostat_temp": thermostat_temp,
        "thermostat_setpoint": thermostat_setpoint,
        "thermostat_action": thermostat_action,
        "config": {
            "temp_min": coordinator.temp_min,
            "temp_max": coordinator.temp_max,
            "away_temp": coordinator.away_temp,
            "override_minutes": coordinator.manual_override_minutes,
        },
        "entity_ids": {
            "climate": climate_entity_id,
            "active_zone_temp": active_zone_temp_entity_id,
        },
        "windows": {
            "open": coordinator._are_windows_open(),
            "sensors": list(coordinator.window_sensors),
            "open_sensors": coordinator.get_open_window_sensors(),
            "manual_override": coordinator.windows_open_override,
        },
    }
    connection.send_result(msg["id"], result)


# ── Window sensor management ──────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/add_window_sensor",
        vol.Required("entity_id"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_add_window_sensor(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Add a binary sensor entity to the window sensor list."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    entity_id = msg["entity_id"]
    if entity_id not in coordinator.window_sensors:
        coordinator.window_sensors.append(entity_id)
        await coordinator.async_save()
    connection.send_result(
        msg["id"],
        {"success": True, "window_sensors": list(coordinator.window_sensors)},
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/remove_window_sensor",
        vol.Required("entity_id"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_remove_window_sensor(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Remove a binary sensor entity from the window sensor list."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    entity_id = msg["entity_id"]
    try:
        coordinator.window_sensors.remove(entity_id)
        await coordinator.async_save()
    except ValueError:
        pass  # Already not in the list
    connection.send_result(
        msg["id"],
        {"success": True, "window_sensors": list(coordinator.window_sensors)},
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/list_window_sensors",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_list_window_sensors(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Return window sensors and their current open/closed state."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    sensors = []
    for entity_id in coordinator.window_sensors:
        state = hass.states.get(entity_id)
        sensors.append({
            "entity_id": entity_id,
            "state": state.state if state else "unavailable",
            "friendly_name": (
                state.attributes.get("friendly_name", entity_id) if state else entity_id
            ),
            "is_open": state.state == "on" if state else False,
        })

    connection.send_result(
        msg["id"],
        {
            "sensors": sensors,
            "any_open": coordinator._are_windows_open(),
            "manual_override": coordinator.windows_open_override,
        },
    )


# ── Get / Set configuration ────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/get_config",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_config(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Return the full live coordinator configuration."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    connection.send_result(
        msg["id"],
        {
            "temp_min": coordinator.temp_min,
            "temp_max": coordinator.temp_max,
            "away_temp": coordinator.away_temp,
            "manual_override_minutes": coordinator.manual_override_minutes,
            "learning_enabled": coordinator.learning_enabled,
            "learning_threshold": coordinator.learning.threshold,
            "occupancy_enabled": coordinator.occupancy_enabled,
            "presence_detection": coordinator.zone_manager.presence_mode,
            "precondition_enabled": coordinator.precondition_enabled,
            "tou_enabled": coordinator.tou_enabled,
            "tou_provider": (
                coordinator.tou_provider.name
                if hasattr(coordinator.tou_provider, "name")
                else "none"
            ),
            "outdoor_temp_sensor": coordinator.outdoor_temp_sensor or "",
            "window_sensors": list(coordinator.window_sensors),
            "windows_open_override": coordinator.windows_open_override,
            "tracked_persons": list(coordinator.zone_manager.tracked_persons),
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/set_config",
        vol.Optional("entry_id"): str,
        vol.Optional("temp_min"): vol.Coerce(float),
        vol.Optional("temp_max"): vol.Coerce(float),
        vol.Optional("away_temp"): vol.Coerce(float),
        vol.Optional("manual_override_minutes"): vol.All(
            vol.Coerce(int), vol.Range(min=15, max=480)
        ),
        vol.Optional("learning_enabled"): bool,
        vol.Optional("learning_threshold"): vol.All(
            vol.Coerce(int), vol.Range(min=2, max=10)
        ),
        vol.Optional("occupancy_enabled"): bool,
        vol.Optional("presence_detection"): vol.In(
            ["both", "occupancy_sensors", "person_entities"]
        ),
        vol.Optional("precondition_enabled"): bool,
        vol.Optional("tou_enabled"): bool,
        vol.Optional("tou_provider"): vol.In(["none", "dominion_virginia"]),
        vol.Optional("outdoor_temp_sensor"): str,
        vol.Optional("tracked_persons"): [str],
    }
)
@websocket_api.async_response
async def ws_set_config(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Update one or more coordinator configuration values."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    skip = {"type", "id", "entry_id"}
    updates = {k: v for k, v in msg.items() if k not in skip}

    # Cross-field validation
    temp_min = float(updates.get("temp_min", coordinator.temp_min))
    temp_max = float(updates.get("temp_max", coordinator.temp_max))
    if temp_min >= temp_max:
        connection.send_error(
            msg["id"], "validation_error", "temp_min must be less than temp_max"
        )
        return

    if "away_temp" in updates:
        away = float(updates["away_temp"])
        if not temp_min <= away <= temp_max:
            connection.send_error(
                msg["id"], "validation_error",
                f"away_temp ({away}) must be within temp range ({temp_min}–{temp_max})",
            )
            return

    await coordinator.async_update_config(updates)

    # Persist applicable keys to config_entry.data
    config_keys = {
        "temp_min", "temp_max", "away_temp", "manual_override_minutes",
        "learning_enabled", "learning_threshold", "occupancy_enabled",
        "presence_detection", "outdoor_temp_sensor", "tou_enabled",
        "tou_provider", "precondition_enabled",
    }
    entry_updates = {k: v for k, v in updates.items() if k in config_keys}
    if entry_updates:
        new_data = {**coordinator.config_entry.data, **entry_updates}
        hass.config_entries.async_update_entry(coordinator.config_entry, data=new_data)

    connection.send_result(msg["id"], {"success": True})


# ── Zone management ────────────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/list_zones",
        vol.Optional("entry_id"): str,
        vol.Optional("include_areas"): bool,
    }
)
@websocket_api.async_response
async def ws_list_zones(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Return all zones with full details, optionally including HA area discovery."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    active_id = coordinator.zone_manager.active_zone_id
    zones = []
    for zone in coordinator.zone_manager.zones.values():
        zones.append({
            "id": zone.id,
            "name": zone.name,
            "sensor_entities": zone.sensor_entities,
            "occupancy_sensor_entities": zone.occupancy_sensor_entities,
            "area_id": zone.area_id,
            "floor_id": zone.floor_id,
            "away_temp": zone.away_temp,
            "occupancy_override": zone.occupancy_override,
            "current_temp": zone.current_temp,
            "is_occupied": zone.is_occupied,
            "is_active": zone.id == active_id,
        })

    areas = []
    if msg.get("include_areas"):
        areas = await coordinator.zone_manager.discover_areas()

    connection.send_result(
        msg["id"],
        {
            "zones": zones,
            "active_zone_id": active_id,
            "areas": areas,
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/save_zone",
        vol.Required("name"): str,
        vol.Optional("entry_id"): str,
        vol.Optional("zone_id"): str,
        vol.Optional("sensor_entities"): [str],
        vol.Optional("occupancy_sensor_entities"): [str],
        vol.Optional("area_id"): vol.Any(str, None),
        vol.Optional("floor_id"): vol.Any(str, None),
        vol.Optional("away_temp"): vol.Any(vol.Coerce(float), None),
        vol.Optional("occupancy_override"): bool,
        vol.Optional("set_active"): bool,
    }
)
@websocket_api.async_response
async def ws_save_zone(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Create or update a zone (upsert by zone_id)."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    name = msg["name"].strip()
    if not name:
        connection.send_error(msg["id"], "invalid", "Zone name cannot be empty")
        return

    from .models import Zone
    import uuid

    zone_id = msg.get("zone_id") or str(uuid.uuid4())[:8]
    zone = Zone(
        id=zone_id,
        name=name,
        sensor_entities=msg.get("sensor_entities", []),
        occupancy_sensor_entities=msg.get("occupancy_sensor_entities", []),
        area_id=msg.get("area_id"),
        floor_id=msg.get("floor_id"),
        away_temp=msg.get("away_temp"),
        occupancy_override=msg.get("occupancy_override", True),
    )
    coordinator.zone_manager.add_zone(zone)
    if msg.get("set_active"):
        coordinator.zone_manager.set_active_zone(zone_id)

    await coordinator.async_save()
    new_data = {**coordinator.config_entry.data, "zones": coordinator.zone_manager.save_zones()}
    hass.config_entries.async_update_entry(coordinator.config_entry, data=new_data)

    connection.send_result(msg["id"], {"success": True, "zone_id": zone_id})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/delete_zone",
        vol.Required("zone_id"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_delete_zone(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Delete a zone by ID."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    if not coordinator.zone_manager.remove_zone(msg["zone_id"]):
        connection.send_error(msg["id"], "not_found", f"Zone '{msg['zone_id']}' not found")
        return

    await coordinator.async_save()
    new_data = {**coordinator.config_entry.data, "zones": coordinator.zone_manager.save_zones()}
    hass.config_entries.async_update_entry(coordinator.config_entry, data=new_data)

    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/set_active_zone",
        vol.Required("zone_id"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_set_active_zone(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Set the active zone for temperature control."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    if not coordinator.zone_manager.set_active_zone(msg["zone_id"]):
        connection.send_error(msg["id"], "not_found", f"Zone '{msg['zone_id']}' not found")
        return

    await coordinator.async_save()
    connection.send_result(msg["id"], {"success": True})


# ── Person entity discovery ────────────────────────────────────────────────────

@websocket_api.websocket_command(
    {
        vol.Required("type"): "gttc/list_persons",
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_list_persons(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Return all HA person entities with their current state."""
    coordinator = _get_coordinator(hass, msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No GTTC instance found")
        return

    persons = []
    for state in hass.states.async_all("person"):
        persons.append({
            "entity_id": state.entity_id,
            "name": state.attributes.get("friendly_name", state.entity_id),
            "state": state.state,
            "is_home": state.state == "home",
        })

    connection.send_result(
        msg["id"],
        {
            "persons": persons,
            "tracked_persons": list(coordinator.zone_manager.tracked_persons),
        },
    )


# ── Helpers ──────────────────────────────────────────────────────────────────

def _detect_conflicts(entries_list, new_entry, old_start=None, old_end=None):
    """Detect time overlaps between new_entry and existing entries.

    Returns a list of conflict descriptions (empty if no conflicts).
    Skips the entry being edited (identified by old_start/old_end).
    """
    conflicts = []
    new_start_min = _time_to_min(new_entry.time_start)
    new_end_min = _time_to_min(new_entry.time_end)
    # Handle overnight
    if new_end_min <= new_start_min:
        new_end_min += 1440

    for entry in entries_list:
        # Skip the entry being edited
        if old_start and old_end and entry.time_start == old_start and entry.time_end == old_end:
            continue

        e_start = _time_to_min(entry.time_start)
        e_end = _time_to_min(entry.time_end)
        if e_end <= e_start:
            e_end += 1440

        # Check overlap: two ranges overlap if one starts before the other ends
        if new_start_min < e_end and e_start < new_end_min:
            conflicts.append({
                "time_start": entry.time_start,
                "time_end": entry.time_end,
                "target_temp": entry.target_temp,
            })

    return conflicts


def _time_to_min(time_str):
    """Convert HH:MM to minutes since midnight."""
    parts = time_str.split(":")
    return int(parts[0]) * 60 + int(parts[1])


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
