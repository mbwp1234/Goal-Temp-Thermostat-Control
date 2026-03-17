"""Constants for Better Thermostat."""
from __future__ import annotations

DOMAIN = "better_thermostat"
PLATFORMS = ["climate", "sensor", "select", "switch", "number"]

# Config keys
CONF_THERMOSTAT = "thermostat_entity"
CONF_NAME = "name"
CONF_TEMP_UNIT = "temp_unit"
CONF_TEMP_MIN = "temp_min"
CONF_TEMP_MAX = "temp_max"
CONF_ZONES = "zones"
CONF_SCHEDULE = "schedule"
CONF_LEARNING_ENABLED = "learning_enabled"
CONF_LEARNING_THRESHOLD = "learning_threshold"
CONF_OCCUPANCY_ENABLED = "occupancy_enabled"
CONF_PRESENCE_DETECTION = "presence_detection"
CONF_AWAY_TEMP = "away_temp"
CONF_MANUAL_OVERRIDE_MINUTES = "manual_override_minutes"
CONF_ACTIVE_ZONE = "active_zone"
CONF_SCHEDULE_MODE = "schedule_mode"
CONF_SCHEDULE_ENABLED = "schedule_enabled"

# Zone config keys
CONF_ZONE_NAME = "zone_name"
CONF_ZONE_SENSORS = "zone_sensors"
CONF_ZONE_OCCUPANCY_SENSORS = "zone_occupancy_sensors"
CONF_ZONE_AREA_ID = "zone_area_id"
CONF_ZONE_AWAY_TEMP = "zone_away_temp"
CONF_ZONE_OCCUPANCY_OVERRIDE = "zone_occupancy_override"

# Presence detection modes
PRESENCE_MODE_OCCUPANCY = "occupancy_sensors"
PRESENCE_MODE_PERSON = "person_entities"
PRESENCE_MODE_BOTH = "both"

# Schedule modes
SCHEDULE_MODE_WEEKDAY_WEEKEND = "weekday_weekend"
SCHEDULE_MODE_PER_DAY = "per_day"

# Presets
PRESET_HOME = "home"
PRESET_AWAY = "away"
PRESET_WORK_FROM_HOME = "work_from_home"
PRESET_SLEEP = "sleep"

PRESETS = {
    PRESET_HOME: "Home All Day",
    PRESET_AWAY: "Away",
    PRESET_WORK_FROM_HOME: "Work From Home",
    PRESET_SLEEP: "Sleep",
}

# Reverse lookup: label -> key
PRESET_LABEL_TO_KEY = {v: k for k, v in PRESETS.items()}

# Days
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"]
WEEKEND = ["saturday", "sunday"]
ALL_DAYS = WEEKDAYS + WEEKEND

# Defaults
DEFAULT_NAME = "Better Thermostat"
DEFAULT_TEMP_MIN = 50.0
DEFAULT_TEMP_MAX = 90.0
DEFAULT_AWAY_TEMP = 62.0
DEFAULT_LEARNING_THRESHOLD = 3
DEFAULT_MANUAL_OVERRIDE_MINUTES = 120
DEFAULT_TEMP_UNIT = "°F"
DEFAULT_PRESENCE_MODE = PRESENCE_MODE_BOTH

# Learning
LEARNING_TIME_WINDOW_MINUTES = 30
LEARNING_TEMP_TOLERANCE = 2.0

# Storage keys
STORAGE_KEY = f"{DOMAIN}_data"
STORAGE_VERSION = 1

# Services
SERVICE_SET_ZONE_TEMP = "set_zone_temperature"
SERVICE_SET_SCHEDULE = "set_schedule"
SERVICE_CLEAR_LEARNED = "clear_learned_schedule"
SERVICE_SET_PRESET = "set_preset"

# Attributes
ATTR_ACTIVE_ZONE = "active_zone"
ATTR_ZONE_TEMPS = "zone_temperatures"
ATTR_SCHEDULE_ACTIVE = "schedule_active"
ATTR_CURRENT_SCHEDULE_ENTRY = "current_schedule_entry"
ATTR_OCCUPANCY_STATUS = "occupancy_status"
ATTR_PRESENCE_HOME = "presence_home"
ATTR_LEARNING_STATUS = "learning_status"
ATTR_OVERRIDE_ACTIVE = "override_active"
ATTR_OVERRIDE_REMAINING = "override_remaining_minutes"
ATTR_ALL_ZONES = "all_zones"
