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
