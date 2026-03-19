"""Constants for Goal Temp Thermostat Control (GTTC)."""
from __future__ import annotations

DOMAIN = "gttc"
PLATFORMS = ["climate", "sensor", "select", "switch", "number", "binary_sensor"]

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
CONF_OUTDOOR_TEMP_SENSOR = "outdoor_temp_sensor"
CONF_TOU_PROVIDER = "tou_provider"
CONF_TOU_ENABLED = "tou_enabled"
CONF_PRECONDITION_ENABLED = "precondition_enabled"
CONF_WINDOW_SENSORS = "window_sensors"

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
DEFAULT_NAME = "GTTC"
DEFAULT_TEMP_MIN = 50.0
DEFAULT_TEMP_MAX = 90.0
DEFAULT_AWAY_TEMP = 62.0
DEFAULT_LEARNING_THRESHOLD = 3
DEFAULT_MANUAL_OVERRIDE_MINUTES = 120
DEFAULT_TEMP_UNIT = "°F"
DEFAULT_PRESENCE_MODE = PRESENCE_MODE_BOTH

# Pre-conditioning: minutes before a schedule transition to start ramping
# toward the next entry's target temperature.
DEFAULT_PRECONDITION_MINUTES = 30

# Season management
SEASON_HEATING = "heating"
SEASON_COOLING = "cooling"

# Config keys for seasonal / warm-weather settings
CONF_COOLING_COMFORT = "cooling_comfort"
CONF_COOLING_AWAY_TEMP = "cooling_away_temp"
CONF_SEASONAL_RECOMMEND_HOURS = "seasonal_recommend_hours"

# Warm-weather (cooling season) defaults (°F)
DEFAULT_COOLING_COMFORT = 75.0   # comfort setpoint when AC is running
DEFAULT_COOLING_SLEEP = 72.0     # overnight cooling target
DEFAULT_COOLING_AWAY = 78.0      # nobody-home setback (UP, not down, in summer)

# Outdoor temp must exceed indoor temp by this many °F before the season
# switch recommendation countdown starts.
SEASONAL_SWITCH_MARGIN = 3.0

# How many hours of sustained opposite-season conditions before the
# SeasonSwitchRecommended binary sensor fires.  12 hours = "it's been warm
# all day", not just a warm afternoon.
SEASONAL_RECOMMEND_HOURS = 12.0

# Outdoor temperature thresholds for heat pump optimization (°F).
# Below OUTDOOR_COLD_THRESHOLD the heat pump is struggling, so setbacks
# are further limited to avoid long recovery times / aux heat.
# Above OUTDOOR_MILD_THRESHOLD recovery is cheap, so deeper setbacks are OK.
OUTDOOR_COLD_THRESHOLD = 30.0
OUTDOOR_MILD_THRESHOLD = 45.0

# Heat pump efficiency
# Maximum setback (°F) from comfort temp before recovery triggers expensive
# auxiliary/strip heat.  DOE and ENERGY STAR recommend keeping heat-pump
# setbacks to 5°F or less to avoid aux heat activation during recovery.
HEAT_PUMP_MAX_SETBACK = 5.0
# When recovering from a setback on a heat pump, limit each step to this many
# degrees to prevent the thermostat from engaging aux heat (most systems
# trigger aux heat when the differential exceeds 2-3°F).
HEAT_PUMP_RECOVERY_STEP = 2.0

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
SERVICE_ASSIGN_SENSOR = "assign_sensor_to_zone"
SERVICE_REMOVE_SENSOR = "remove_sensor_from_zone"
SERVICE_CANCEL_OVERRIDE = "cancel_override"
SERVICE_TOGGLE_SCHEDULE = "toggle_schedule"

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
ATTR_ZONE_DETAILS = "zone_details"
ATTR_WINDOWS_OPEN = "windows_open"
