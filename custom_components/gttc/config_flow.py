"""Config flow for GTTC."""
from __future__ import annotations

import logging
import uuid
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.components.climate import DOMAIN as CLIMATE_DOMAIN
from homeassistant.components.sensor import DOMAIN as SENSOR_DOMAIN
from homeassistant.components.binary_sensor import DOMAIN as BINARY_SENSOR_DOMAIN
from homeassistant.core import callback
from homeassistant.helpers import (
    area_registry as ar,
    entity_registry as er,
    selector,
)

from .const import (
    CONF_AWAY_TEMP,
    CONF_LEARNING_ENABLED,
    CONF_LEARNING_THRESHOLD,
    CONF_MANUAL_OVERRIDE_MINUTES,
    CONF_NAME,
    CONF_OCCUPANCY_ENABLED,
    CONF_PRESENCE_DETECTION,
    CONF_TEMP_MAX,
    CONF_TEMP_MIN,
    CONF_TEMP_UNIT,
    CONF_THERMOSTAT,
    CONF_ZONES,
    DEFAULT_AWAY_TEMP,
    DEFAULT_LEARNING_THRESHOLD,
    DEFAULT_MANUAL_OVERRIDE_MINUTES,
    DEFAULT_NAME,
    DEFAULT_PRESENCE_MODE,
    DEFAULT_TEMP_MAX,
    DEFAULT_TEMP_MIN,
    DEFAULT_TEMP_UNIT,
    DOMAIN,
    PRESENCE_MODE_BOTH,
    PRESENCE_MODE_OCCUPANCY,
    PRESENCE_MODE_PERSON,
)

_LOGGER = logging.getLogger(__name__)


class GTTCConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for GTTC."""

    VERSION = 1

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}
        self._zones: list[dict[str, Any]] = []

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Step 1: Basic setup - name, thermostat, units."""
        errors = {}

        if user_input is not None:
            thermostat = user_input.get(CONF_THERMOSTAT, "")
            state = self.hass.states.get(thermostat)
            if state is None:
                errors[CONF_THERMOSTAT] = "thermostat_not_found"
            elif state.state in ("unavailable", "unknown"):
                errors[CONF_THERMOSTAT] = "thermostat_unavailable"
            else:
                # Check for duplicate entries using same thermostat
                await self.async_set_unique_id(thermostat)
                self._abort_if_unique_id_configured()

                # Validate temp range
                temp_min = float(user_input.get(CONF_TEMP_MIN, DEFAULT_TEMP_MIN))
                temp_max = float(user_input.get(CONF_TEMP_MAX, DEFAULT_TEMP_MAX))
                if temp_min >= temp_max:
                    errors[CONF_TEMP_MIN] = "invalid_temp_range"
                else:
                    self._data.update(user_input)
                    return await self.async_step_zones()

        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default=DEFAULT_NAME): str,
                vol.Required(CONF_THERMOSTAT): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain=CLIMATE_DOMAIN)
                ),
                vol.Required(CONF_TEMP_UNIT, default=DEFAULT_TEMP_UNIT): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=["°F", "°C"],
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Required(CONF_TEMP_MIN, default=DEFAULT_TEMP_MIN): vol.Coerce(float),
                vol.Required(CONF_TEMP_MAX, default=DEFAULT_TEMP_MAX): vol.Coerce(float),
            }
        )

        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def async_step_zones(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Step 2: Zone setup - auto-discover or manual."""
        if user_input is not None:
            zone_method = user_input.get("zone_method", "auto")
            if zone_method == "auto":
                return await self.async_step_auto_zones()
            elif zone_method == "manual":
                return await self.async_step_add_zone()
            else:
                return await self.async_step_features()

        schema = vol.Schema(
            {
                vol.Required("zone_method", default="auto"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=[
                            selector.SelectOptionDict(
                                value="auto",
                                label="Auto-discover from Home Assistant areas",
                            ),
                            selector.SelectOptionDict(
                                value="manual", label="Manually add zones"
                            ),
                            selector.SelectOptionDict(
                                value="skip", label="Skip (configure later)"
                            ),
                        ],
                        mode=selector.SelectSelectorMode.LIST,
                    )
                ),
            }
        )

        return self.async_show_form(step_id="zones", data_schema=schema)

    async def async_step_auto_zones(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Auto-discover zones from HA areas."""
        if user_input is not None:
            selected_areas = user_input.get("selected_areas", [])
            try:
                area_reg = ar.async_get(self.hass)
                ent_reg = er.async_get(self.hass)

                for area_id in selected_areas:
                    area = area_reg.async_get_area(area_id)
                    if area is None:
                        continue

                    temp_sensors = []
                    occ_sensors = []
                    for entity in er.async_entries_for_area(ent_reg, area_id):
                        state = self.hass.states.get(entity.entity_id)
                        if state is None:
                            continue
                        dc = state.attributes.get("device_class", "")
                        if entity.domain == "sensor" and dc == "temperature":
                            temp_sensors.append(entity.entity_id)
                        elif entity.domain == "binary_sensor" and dc in (
                            "occupancy",
                            "motion",
                            "presence",
                        ):
                            occ_sensors.append(entity.entity_id)

                    floor_id = getattr(area, "floor_id", None)
                    self._zones.append(
                        {
                            "id": area_id,
                            "name": area.name,
                            "sensor_entities": temp_sensors,
                            "occupancy_sensor_entities": occ_sensors,
                            "area_id": area_id,
                            "floor_id": floor_id,
                            "away_temp": None,
                            "occupancy_override": True,
                        }
                    )
            except Exception as err:
                _LOGGER.error("Error discovering areas: %s", err)

            return await self.async_step_features()

        # Get available areas
        try:
            area_reg = ar.async_get(self.hass)
            areas = area_reg.async_list_areas()
            area_options = [
                selector.SelectOptionDict(value=a.id, label=a.name) for a in areas
            ]
        except Exception as err:
            _LOGGER.error("Error loading areas: %s", err)
            area_options = []

        if not area_options:
            return await self.async_step_add_zone()

        schema = vol.Schema(
            {
                vol.Required("selected_areas"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=area_options,
                        multiple=True,
                        mode=selector.SelectSelectorMode.LIST,
                    )
                ),
            }
        )

        return self.async_show_form(step_id="auto_zones", data_schema=schema)

    async def async_step_add_zone(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Manually add a zone."""
        errors = {}

        if user_input is not None:
            zone_name = user_input.get("zone_name", "").strip()
            if not zone_name:
                errors["zone_name"] = "name_required"
            else:
                zone_id = str(uuid.uuid4())[:8]
                self._zones.append(
                    {
                        "id": zone_id,
                        "name": zone_name,
                        "sensor_entities": user_input.get("temp_sensors", []),
                        "occupancy_sensor_entities": user_input.get(
                            "occupancy_sensors", []
                        ),
                        "area_id": None,
                        "floor_id": user_input.get("floor_id"),
                        "away_temp": user_input.get("zone_away_temp"),
                        "occupancy_override": user_input.get(
                            "zone_occupancy_override", True
                        ),
                    }
                )

                if user_input.get("add_another", False):
                    return await self.async_step_add_zone()
                return await self.async_step_features()

        schema = vol.Schema(
            {
                vol.Required("zone_name"): str,
                vol.Optional("floor_id"): str,
                vol.Optional("temp_sensors"): selector.EntitySelector(
                    selector.EntitySelectorConfig(
                        domain=SENSOR_DOMAIN,
                        device_class="temperature",
                        multiple=True,
                    )
                ),
                vol.Optional("occupancy_sensors"): selector.EntitySelector(
                    selector.EntitySelectorConfig(
                        domain=BINARY_SENSOR_DOMAIN,
                        device_class="occupancy",
                        multiple=True,
                    )
                ),
                vol.Optional("zone_away_temp"): vol.Coerce(float),
                vol.Optional("zone_occupancy_override", default=True): bool,
                vol.Optional("add_another", default=False): bool,
            }
        )

        return self.async_show_form(
            step_id="add_zone", data_schema=schema, errors=errors
        )

    async def async_step_features(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Step 3: Feature toggles and settings."""
        errors = {}

        if user_input is not None:
            # Validate away temp is within configured range
            away_temp = float(user_input.get(CONF_AWAY_TEMP, DEFAULT_AWAY_TEMP))
            temp_min = float(self._data.get(CONF_TEMP_MIN, DEFAULT_TEMP_MIN))
            temp_max = float(self._data.get(CONF_TEMP_MAX, DEFAULT_TEMP_MAX))
            if not temp_min <= away_temp <= temp_max:
                errors[CONF_AWAY_TEMP] = "away_temp_out_of_range"
            else:
                self._data.update(user_input)
                self._data[CONF_ZONES] = self._zones
                return self.async_create_entry(
                    title=self._data.get(CONF_NAME, DEFAULT_NAME),
                    data=self._data,
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_LEARNING_ENABLED, default=True): bool,
                vol.Required(
                    CONF_LEARNING_THRESHOLD, default=DEFAULT_LEARNING_THRESHOLD
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=2,
                        max=10,
                        step=1,
                        mode=selector.NumberSelectorMode.SLIDER,
                    )
                ),
                vol.Required(CONF_OCCUPANCY_ENABLED, default=True): bool,
                vol.Required(
                    CONF_PRESENCE_DETECTION, default=DEFAULT_PRESENCE_MODE
                ): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=[
                            selector.SelectOptionDict(
                                value=PRESENCE_MODE_BOTH,
                                label="Person entities + Occupancy sensors (Recommended)",
                            ),
                            selector.SelectOptionDict(
                                value=PRESENCE_MODE_PERSON,
                                label="Person entities only (zone.home)",
                            ),
                            selector.SelectOptionDict(
                                value=PRESENCE_MODE_OCCUPANCY,
                                label="Occupancy sensors only",
                            ),
                        ],
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Required(
                    CONF_AWAY_TEMP, default=DEFAULT_AWAY_TEMP
                ): vol.Coerce(float),
                vol.Required(
                    CONF_MANUAL_OVERRIDE_MINUTES,
                    default=DEFAULT_MANUAL_OVERRIDE_MINUTES,
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=15,
                        max=480,
                        step=15,
                        mode=selector.NumberSelectorMode.SLIDER,
                        unit_of_measurement="min",
                    )
                ),
            }
        )

        return self.async_show_form(
            step_id="features", data_schema=schema, errors=errors
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> GTTCOptionsFlow:
        return GTTCOptionsFlow(config_entry)


class GTTCOptionsFlow(config_entries.OptionsFlow):
    """Options flow for reconfiguring GTTC."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._config_entry = config_entry
        self._selected_zone_id: str | None = None

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Main options menu."""
        if user_input is not None:
            action = user_input.get("action", "settings")
            if action == "settings":
                return await self.async_step_settings()
            elif action == "zones":
                return await self.async_step_manage_zones()
            elif action == "schedule":
                return await self.async_step_schedule()

        schema = vol.Schema(
            {
                vol.Required("action", default="settings"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=[
                            selector.SelectOptionDict(
                                value="settings", label="General Settings"
                            ),
                            selector.SelectOptionDict(
                                value="zones", label="Manage Zones"
                            ),
                            selector.SelectOptionDict(
                                value="schedule", label="Configure Schedule"
                            ),
                        ],
                        mode=selector.SelectSelectorMode.LIST,
                    )
                ),
            }
        )

        return self.async_show_form(step_id="init", data_schema=schema)

    async def async_step_settings(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """General settings."""
        errors = {}

        if user_input is not None:
            # Validate away temp
            data = self._config_entry.data
            temp_min = float(data.get(CONF_TEMP_MIN, DEFAULT_TEMP_MIN))
            temp_max = float(data.get(CONF_TEMP_MAX, DEFAULT_TEMP_MAX))
            away_temp = float(
                user_input.get(CONF_AWAY_TEMP, DEFAULT_AWAY_TEMP)
            )
            if not temp_min <= away_temp <= temp_max:
                errors[CONF_AWAY_TEMP] = "away_temp_out_of_range"
            else:
                new_data = {**self._config_entry.data, **user_input}
                self.hass.config_entries.async_update_entry(
                    self._config_entry, data=new_data
                )
                return self.async_create_entry(title="", data={})

        data = self._config_entry.data
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_LEARNING_ENABLED,
                    default=data.get(CONF_LEARNING_ENABLED, True),
                ): bool,
                vol.Required(
                    CONF_LEARNING_THRESHOLD,
                    default=data.get(
                        CONF_LEARNING_THRESHOLD, DEFAULT_LEARNING_THRESHOLD
                    ),
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(min=2, max=10, step=1)
                ),
                vol.Required(
                    CONF_OCCUPANCY_ENABLED,
                    default=data.get(CONF_OCCUPANCY_ENABLED, True),
                ): bool,
                vol.Required(
                    CONF_PRESENCE_DETECTION,
                    default=data.get(CONF_PRESENCE_DETECTION, DEFAULT_PRESENCE_MODE),
                ): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=[
                            selector.SelectOptionDict(
                                value=PRESENCE_MODE_BOTH,
                                label="Person entities + Occupancy sensors",
                            ),
                            selector.SelectOptionDict(
                                value=PRESENCE_MODE_PERSON,
                                label="Person entities only",
                            ),
                            selector.SelectOptionDict(
                                value=PRESENCE_MODE_OCCUPANCY,
                                label="Occupancy sensors only",
                            ),
                        ],
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Required(
                    CONF_AWAY_TEMP,
                    default=data.get(CONF_AWAY_TEMP, DEFAULT_AWAY_TEMP),
                ): vol.Coerce(float),
                vol.Required(
                    CONF_MANUAL_OVERRIDE_MINUTES,
                    default=data.get(
                        CONF_MANUAL_OVERRIDE_MINUTES,
                        DEFAULT_MANUAL_OVERRIDE_MINUTES,
                    ),
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=15, max=480, step=15, unit_of_measurement="min"
                    )
                ),
            }
        )

        return self.async_show_form(
            step_id="settings", data_schema=schema, errors=errors
        )

    async def async_step_manage_zones(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Zone management menu: add, edit, or delete zones."""
        if user_input is not None:
            action = user_input.get("zone_action", "add")
            if action == "add":
                return await self.async_step_add_zone()
            elif action == "edit":
                return await self.async_step_select_zone_to_edit()
            elif action == "delete":
                return await self.async_step_delete_zone()

        zones = self._config_entry.data.get(CONF_ZONES, [])
        zone_summary = ", ".join(z.get("name", "?") for z in zones) if zones else "None"

        options = [
            selector.SelectOptionDict(value="add", label="Add a new zone"),
        ]
        if zones:
            options.append(
                selector.SelectOptionDict(value="edit", label="Edit an existing zone")
            )
            options.append(
                selector.SelectOptionDict(value="delete", label="Delete a zone")
            )

        schema = vol.Schema(
            {
                vol.Required("zone_action", default="add"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=options,
                        mode=selector.SelectSelectorMode.LIST,
                    )
                ),
            }
        )

        return self.async_show_form(
            step_id="manage_zones",
            data_schema=schema,
            description_placeholders={"zones": zone_summary},
        )

    async def async_step_add_zone(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Add a new zone via options flow."""
        errors = {}

        if user_input is not None:
            zone_name = user_input.get("zone_name", "").strip()
            if not zone_name:
                errors["zone_name"] = "name_required"
            else:
                zone_id = str(uuid.uuid4())[:8]
                zones = list(self._config_entry.data.get(CONF_ZONES, []))
                zones.append(
                    {
                        "id": zone_id,
                        "name": zone_name,
                        "sensor_entities": user_input.get("temp_sensors", []),
                        "occupancy_sensor_entities": user_input.get(
                            "occupancy_sensors", []
                        ),
                        "area_id": None,
                        "floor_id": user_input.get("floor_id"),
                        "away_temp": user_input.get("zone_away_temp"),
                        "occupancy_override": user_input.get(
                            "zone_occupancy_override", True
                        ),
                    }
                )

                new_data = {**self._config_entry.data, CONF_ZONES: zones}
                self.hass.config_entries.async_update_entry(
                    self._config_entry, data=new_data
                )

                if user_input.get("add_another", False):
                    return await self.async_step_add_zone()
                return self.async_create_entry(title="", data={})

        schema = vol.Schema(
            {
                vol.Required("zone_name"): str,
                vol.Optional("floor_id"): str,
                vol.Optional("temp_sensors"): selector.EntitySelector(
                    selector.EntitySelectorConfig(
                        domain=SENSOR_DOMAIN,
                        device_class="temperature",
                        multiple=True,
                    )
                ),
                vol.Optional("occupancy_sensors"): selector.EntitySelector(
                    selector.EntitySelectorConfig(
                        domain=BINARY_SENSOR_DOMAIN,
                        device_class="occupancy",
                        multiple=True,
                    )
                ),
                vol.Optional("zone_away_temp"): vol.Coerce(float),
                vol.Optional("zone_occupancy_override", default=True): bool,
                vol.Optional("add_another", default=False): bool,
            }
        )

        return self.async_show_form(
            step_id="add_zone", data_schema=schema, errors=errors
        )

    async def async_step_select_zone_to_edit(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Select which zone to edit."""
        zones = self._config_entry.data.get(CONF_ZONES, [])
        if not zones:
            return await self.async_step_manage_zones()

        if user_input is not None:
            self._selected_zone_id = user_input.get("zone_id")
            return await self.async_step_edit_zone()

        zone_options = [
            selector.SelectOptionDict(
                value=z["id"],
                label=f"{z.get('name', 'Unknown')} ({len(z.get('sensor_entities', []))} sensors)",
            )
            for z in zones
        ]

        schema = vol.Schema(
            {
                vol.Required("zone_id"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=zone_options,
                        mode=selector.SelectSelectorMode.LIST,
                    )
                ),
            }
        )

        return self.async_show_form(step_id="select_zone_to_edit", data_schema=schema)

    async def async_step_edit_zone(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Edit an existing zone: rename, reassign sensors, change settings."""
        errors = {}
        zones = list(self._config_entry.data.get(CONF_ZONES, []))
        zone = next((z for z in zones if z["id"] == self._selected_zone_id), None)
        if not zone:
            return await self.async_step_manage_zones()

        if user_input is not None:
            zone_name = user_input.get("zone_name", "").strip()
            if not zone_name:
                errors["zone_name"] = "name_required"
            else:
                # Update the zone in place
                zone["name"] = zone_name
                zone["sensor_entities"] = user_input.get(
                    "temp_sensors", zone.get("sensor_entities", [])
                )
                zone["occupancy_sensor_entities"] = user_input.get(
                    "occupancy_sensors", zone.get("occupancy_sensor_entities", [])
                )
                zone["floor_id"] = user_input.get("floor_id", zone.get("floor_id"))
                zone["away_temp"] = user_input.get("zone_away_temp")
                zone["occupancy_override"] = user_input.get(
                    "zone_occupancy_override", True
                )

                new_data = {**self._config_entry.data, CONF_ZONES: zones}
                self.hass.config_entries.async_update_entry(
                    self._config_entry, data=new_data
                )
                return self.async_create_entry(title="", data={})

        schema = vol.Schema(
            {
                vol.Required(
                    "zone_name", default=zone.get("name", "")
                ): str,
                vol.Optional(
                    "floor_id", default=zone.get("floor_id") or vol.UNDEFINED
                ): str,
                vol.Optional(
                    "temp_sensors",
                    default=zone.get("sensor_entities", []),
                ): selector.EntitySelector(
                    selector.EntitySelectorConfig(
                        domain=SENSOR_DOMAIN,
                        device_class="temperature",
                        multiple=True,
                    )
                ),
                vol.Optional(
                    "occupancy_sensors",
                    default=zone.get("occupancy_sensor_entities", []),
                ): selector.EntitySelector(
                    selector.EntitySelectorConfig(
                        domain=BINARY_SENSOR_DOMAIN,
                        device_class="occupancy",
                        multiple=True,
                    )
                ),
                vol.Optional(
                    "zone_away_temp",
                    default=zone.get("away_temp") or vol.UNDEFINED,
                ): vol.Coerce(float),
                vol.Optional(
                    "zone_occupancy_override",
                    default=zone.get("occupancy_override", True),
                ): bool,
            }
        )

        return self.async_show_form(
            step_id="edit_zone",
            data_schema=schema,
            errors=errors,
            description_placeholders={"zone_name": zone.get("name", "")},
        )

    async def async_step_delete_zone(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Delete a zone."""
        zones = list(self._config_entry.data.get(CONF_ZONES, []))
        if not zones:
            return await self.async_step_manage_zones()

        if user_input is not None:
            zone_id = user_input.get("zone_id")
            if user_input.get("confirm_delete", False) and zone_id:
                zones = [z for z in zones if z["id"] != zone_id]
                new_data = {**self._config_entry.data, CONF_ZONES: zones}
                self.hass.config_entries.async_update_entry(
                    self._config_entry, data=new_data
                )
            return self.async_create_entry(title="", data={})

        zone_options = [
            selector.SelectOptionDict(value=z["id"], label=z.get("name", "Unknown"))
            for z in zones
        ]

        schema = vol.Schema(
            {
                vol.Required("zone_id"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=zone_options,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Required("confirm_delete", default=False): bool,
            }
        )

        return self.async_show_form(step_id="delete_zone", data_schema=schema)

    async def async_step_schedule(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Schedule configuration info."""
        if user_input is not None:
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="schedule",
            data_schema=vol.Schema({}),
            description_placeholders={
                "info": "Use the Schedule Mode select entity and the gttc.set_schedule service to configure schedules. Presets can be activated via the climate entity's preset modes."
            },
        )
