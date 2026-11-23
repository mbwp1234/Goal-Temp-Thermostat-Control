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
CONF_AWAY_TEMP = "away_temp"
CONF_MANUAL_OVERRIDE_MINUTES = "manual_override_minutes"
CONF_ACTIVE_ZONE = "active_zone"
CONF_SCHEDULE_MODE = "schedule_mode"
CONF_SCHEDULE_ENABLED = "schedule_enabled"
CONF_OUTDOOR_TEMP_SENSOR = "outdoor_temp_sensor"
CONF_WINDOW_SENSORS = "window_sensors"

# Zone config keys
CONF_ZONE_NAME = "zone_name"
CONF_ZONE_SENSORS = "zone_sensors"
CONF_ZONE_AREA_ID = "zone_area_id"
CONF_ZONE_AWAY_TEMP = "zone_away_temp"

# Schedule modes
SCHEDULE_MODE_WEEKDAY_WEEKEND = "weekday_weekend"
SCHEDULE_MODE_PER_DAY = "per_day"

# Presets
PRESET_HOME = "home"
PRESET_AWAY = "away"
PRESET_SLEEP = "sleep"

PRESETS = {
    PRESET_HOME: "Home All Day",
    PRESET_AWAY: "Away",
    PRESET_SLEEP: "Sleep",
}

# Built-in plans that no longer exist; dropped from storage on load (v2.9.0)
RETIRED_PRESETS = ("work_from_home",)

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
DEFAULT_MANUAL_OVERRIDE_MINUTES = 120
DEFAULT_TEMP_UNIT = "°F"

# Season management
SEASON_HEATING = "heating"
SEASON_COOLING = "cooling"
# Both at once: the thermostat runs in heat_cool with a heat setpoint below and
# a cool setpoint above, and the house drifts for free between them.
SEASON_HEAT_COOL = "heat_cool"
SEASONS = (SEASON_HEATING, SEASON_COOLING, SEASON_HEAT_COOL)

# Config keys for seasonal / warm-weather settings
CONF_COOLING_COMFORT = "cooling_comfort"
CONF_COOLING_AWAY_TEMP = "cooling_away_temp"
CONF_SEASONAL_RECOMMEND_HOURS = "seasonal_recommend_hours"
CONF_AUTO_SEASON_SWITCH = "auto_season_switch"
CONF_COOL_LOCKOUT_TEMP = "cool_lockout_temp"
CONF_HEAT_COOL_SETTLE_DAYS = "heat_cool_settle_days"
CONF_HEAT_COOL_MIN_GAP = "heat_cool_min_gap"

# In heat/cool the AC is held off below this outdoor temperature (°F) and the
# fan circulates instead — unless someone asks for cooling (a hold or a boost
# always gets it). 55 was too high: a full house on a 54° evening needs the AC.
DEFAULT_COOL_LOCKOUT_TEMP = 50.0
# The default before v2.4.2. A stored value equal to it was never chosen by
# anyone, so it moves to the new default once (tracked by cool_lockout_rev).
LEGACY_COOL_LOCKOUT_TEMP = 55.0
COOL_LOCKOUT_REV = 2
# A zone the schedule is not watching can still be hot — a full downstairs
# while the evening blocks watch the bedrooms. When the warmest zone sits this
# far over the cool goal for WARM_ZONE_MINUTES, GTTC cools against it until it
# is back within WARM_ZONE_CLEAR of the goal.
WARM_ZONE_MARGIN = 1.5
WARM_ZONE_MINUTES = 10
WARM_ZONE_CLEAR = 0.5
# ...and stops early if the watched zone would drop this close to its heat goal.
WARM_ZONE_FLOOR_MARGIN = 0.0
# The lockout is "don't run the AC to shave a degree on a cold night", not
# "never cool": a party or the oven can push a zone well past its goal with
# 49° outside. Any zone this far over the cool goal for WARM_ZONE_MINUTES
# lifts the lockout until it is back within WARM_ZONE_CLEAR.
OVERHEAT_MARGIN = 3.0
# Below this outdoor temperature the AC never runs on GTTC's own say-so —
# most heat pumps are not rated to cool here (coil icing). A hold still does.
COOL_HARD_FLOOR = 40.0
# Leave heat/cool for a single season after this many days with only one side
# of the equipment running.
DEFAULT_HEAT_COOL_SETTLE_DAYS = 5.0
# The thermostat keeps heat and cool setpoints at least this far apart (the T6
# calls it Auto Differential). GTTC lowers the heat goal to keep it — writing
# a narrower band makes the thermostat move a setpoint on its own, which then
# reads as someone at the wall.
DEFAULT_HEAT_COOL_MIN_GAP = 3.0
# Parking band for an open window in heat/cool: neither side runs unless the
# house is genuinely freezing or baking.
HEAT_COOL_PARK_LOW = 50.0
HEAT_COOL_PARK_HIGH = 90.0
# Cooling setpoint while the AC is locked out on a cold day.
COOL_LOCKOUT_PARK = 85.0

# Warm-weather (cooling season) defaults (°F)
DEFAULT_COOLING_COMFORT = 74.0   # comfort setpoint when AC is running (daytime)
DEFAULT_COOLING_SLEEP = 72.0     # overnight cooling target
DEFAULT_COOLING_AWAY = 76.0      # nobody-home setback (UP, not down, in summer)

# Whether to automatically switch season when recommend threshold is reached.
# When enabled the system acts on suggest_season_switch rather than just
# surfacing it as a recommendation.
DEFAULT_AUTO_SEASON_SWITCH = False

# Heating season only counts toward a switch to heat when outdoor is at least
# this many °F colder than indoor (a cold house on a cold night).
SEASONAL_SWITCH_MARGIN = 3.0

# The house must be this far past the OTHER season's goal before the switch
# countdown runs: above cool goal + margin (heat idle) → cooling; below heat
# goal - margin (AC idle) → heating. Heat and cool goals sit 0.7–3° apart, so
# without it an AC overshoot or an afternoon's drift counts as a new season.
SEASON_DEMAND_MARGIN = 1.0

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
# A heat pump's thermostat brings on the electric strips when the setpoint
# jumps well above the room. So in heat, a RISE in what GTTC writes to the
# wall goes in steps of HEAT_PUMP_RAMP_STEP, at most one every
# HEAT_PUMP_RAMP_INTERVAL, starting from the wall's own reading (a step that
# is still below the room does nothing). The 6:00 change of 72.2 → 74.4 in
# one write (11/21) becomes ~4 steps over 40 min. Holds and boosts are
# someone asking for heat now and skip the ramp.
HEAT_PUMP_RAMP_STEP = 0.5
HEAT_PUMP_RAMP_INTERVAL_MIN = 10

# Action reason tags — attached to every setpoint decision for "why" history
ACTION_REASON_SCHEDULE = "schedule"
ACTION_REASON_OVERRIDE = "manual_override"
ACTION_REASON_PHYSICAL_OVERRIDE = "physical_override"

# Where a ManualOverride originated
OVERRIDE_SOURCE_MANUAL = "manual"  # Dashboard / climate entity
OVERRIDE_SOURCE_PHYSICAL = "physical"  # Setpoint changed on the wall unit
ACTION_REASON_VACATION = "vacation"
ACTION_REASON_HEAT_PUMP = "heat_pump_step"
ACTION_REASON_FALLBACK = "fallback"
ACTION_REASON_WINDOW = "window_open"
ACTION_REASON_COOL_LOCKOUT = "cool_lockout"
ACTION_REASON_WARM_ZONE = "warm_zone"
ACTION_REASON_OVERHEAT = "overheat"

# In-memory ring buffer size for the action log
ACTION_LOG_MAX = 200

# Startup: GTTC writes nothing to the wall until the watched zone has a
# reading (or a saved offset to steer by), and at most this long after
# starting. Before v2.9.0 every restart wrote the bare goal, then the
# offset goal seconds later — 70.8 → 70 → 69 → 70 → 71.8 in 50 s on 11/22.
STARTUP_WRITE_GRACE_MIN = 5

# Fan modes that mean "run continuously", in order of preference. The T6 Pro
# calls it "Low"; generic thermostats "on".
FAN_ON_PREFERENCE = ("on", "On", "Low", "low", "On Low", "on_low", "Circulation", "circulation")

# Heating failure detection
HEATING_FAILURE_RUN_MINUTES = 45   # HVAC must run this long before we check
HEATING_FAILURE_TEMP_DELTA = 0.5   # minimum expected temperature change (°F)
HEATING_FAILURE_SHORTFALL = 1.5    # ...while still this far below the heat setpoint
HEATING_FAILURE_MIN_OUTDOOR = 25.0 # colder than this, a heat pump falling short is expected
HEATING_FAILURE_COOLDOWN_H = 12    # at most one alert per this many hours
BRIAN_NOTIFY_SERVICE = "mobile_app_brians_iphone"

# Timed presets / boost buttons
BOOST_TYPES = {
    # Heat boosts stay small: on a heat pump a big jump is a job for the
    # electric strips (v2.9.0 — was +4 / +3)
    "boost": {"label": "Boost +2°", "delta": 2.0, "minutes": 90, "icon": "🔥"},
    "warm_up": {"label": "Warm Up +1°", "delta": 1.0, "minutes": 60, "icon": "🌡"},
    "cool_down": {"label": "Cool Down -3°", "delta": -3.0, "minutes": 60, "icon": "❄️"},
    # Cooling-season counterpart of "boost"; the panel offers boost/warm_up in
    # heating season and max_cool/cool_down in cooling season.
    "max_cool": {"label": "Max Cool -4°", "delta": -4.0, "minutes": 90, "icon": "❄️"},
}

# Daily runtime history
# A year and a bit, so the panel can draw a whole year of days (v2.8.0)
RUNTIME_HISTORY_MAX_DAYS = 400

# Storage keys
STORAGE_KEY = f"{DOMAIN}_data"
STORAGE_VERSION = 1

# Services
SERVICE_SET_ZONE_TEMP = "set_zone_temperature"
SERVICE_SET_SCHEDULE = "set_schedule"
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
ATTR_OVERRIDE_ACTIVE = "override_active"
ATTR_OVERRIDE_REMAINING = "override_remaining_minutes"
ATTR_OVERRIDE_SOURCE = "override_source"
ATTR_ALL_ZONES = "all_zones"
ATTR_ZONE_DETAILS = "zone_details"
ATTR_WINDOWS_OPEN = "windows_open"
