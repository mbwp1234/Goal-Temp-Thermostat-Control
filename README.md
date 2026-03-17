Goal Temp Thermostat Control

A smart, zone-aware thermostat integration for Home Assistant (HACS). Control your thermostat using temperature sensors from different rooms/floors, with intelligent scheduling, occupancy detection, and automatic pattern learning.

## Features

- **Zone-Based Control** — Group temperature sensors by floor/room, average their readings, and target specific zones throughout the day
- **Auto-Discovery** — Automatically finds temperature and occupancy sensors from your Home Assistant areas, or add zones manually
- **Smart Scheduling** — Weekday/weekend schedules, per-day schedules, and built-in presets (Home, Away, Work From Home, Sleep)
- **Pattern Learning** — Automatically detects when you make similar temperature adjustments at similar times and creates schedule entries for you (configurable threshold, default: 3 similar events)
- **Presence Detection** — Uses HA's built-in `person` entities (zone.home) and/or room occupancy sensors to detect if anyone is home. Three modes: Person entities only, Occupancy sensors only, or Both (recommended). Drops to away temperature when nobody is home, with per-room overrides
- **Manual Override** — Any manual temperature change takes priority for a configurable period (default: 2 hours), then resumes automation
- **Mirror HVAC Modes** — Exposes the same heat/cool/auto modes as your real thermostat, including heat pump and aux heat support
- **Full Zone Control** — Select entity to pick the active target zone, plus per-zone temperature sensors

## Installation

### HACS (Recommended)

1. Open HACS in your Home Assistant instance
2. Click the three dots menu → **Custom repositories**
3. Add this repository URL and select **Integration** as the category
4. Search for "Better Thermostat" and install
5. Restart Home Assistant

### Manual

1. Copy the `custom_components/better_thermostat` folder to your Home Assistant `config/custom_components/` directory
2. Restart Home Assistant

## Setup

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **Better Thermostat**
3. Follow the setup wizard:
   - **Step 1**: Name your thermostat, select your real thermostat entity, choose temperature units and range
   - **Step 2**: Configure zones — auto-discover from HA areas or add manually with temperature/occupancy sensors
   - **Step 3**: Enable/disable features — learning, occupancy, presence detection method, away temp, override duration

## Entities Created

| Entity | Type | Description |
|--------|------|-------------|
| `climate.better_thermostat` | Climate | Main virtual thermostat — set temp, change modes, activate presets |
| `select.better_thermostat_active_zone` | Select | Pick which floor/room zone to target |
| `select.better_thermostat_schedule_mode` | Select | Switch between Weekday/Weekend and Per Day scheduling |
| `switch.better_thermostat_learning` | Switch | Toggle the pattern learning engine |
| `switch.better_thermostat_occupancy_mode` | Switch | Toggle occupancy-based temperature control |
| `switch.better_thermostat_schedule` | Switch | Toggle the schedule on/off |
| `number.better_thermostat_away_temperature` | Number | Set the away/eco temperature |
| `number.better_thermostat_override_duration` | Number | Set how long manual overrides last (minutes) |
| `sensor.better_thermostat_active_zone_temperature` | Sensor | Current averaged temp of the active zone |
| `sensor.better_thermostat_*_temperature` | Sensor | Per-zone averaged temperature sensors |
| `sensor.better_thermostat_override_remaining` | Sensor | Minutes remaining on manual override |
| `sensor.better_thermostat_learned_patterns` | Sensor | Count of learned schedule patterns |

## Services

### `better_thermostat.set_zone_temperature`
Set temperature for a specific zone.
```yaml
service: better_thermostat.set_zone_temperature
data:
  zone_id: "living_room"
  temperature: 72
```

### `better_thermostat.set_schedule`
Set schedule entries for a day or day group.
```yaml
service: better_thermostat.set_schedule
data:
  day: weekday
  entries:
    - time_start: "06:00"
      time_end: "08:00"
      target_temp: 72
    - time_start: "08:00"
      time_end: "17:00"
      target_temp: 68
    - time_start: "17:00"
      time_end: "22:00"
      target_temp: 72
    - time_start: "22:00"
      time_end: "06:00"
      target_temp: 65
```

### `better_thermostat.set_preset`
Activate a schedule preset.
```yaml
service: better_thermostat.set_preset
data:
  preset: work_from_home  # home, away, work_from_home, sleep
```

### `better_thermostat.clear_learned_schedule`
Clear all learned patterns from the learning engine.
```yaml
service: better_thermostat.clear_learned_schedule
```

## How It Works

### Priority System
Temperature decisions follow this priority (highest first):
1. **Manual Override** — Any temp change you make holds for the override duration (default 2hr, configurable 15-480 min)
2. **Presence/Occupancy** — If enabled and nobody is detected home, drops to away temperature. Uses HA `person` entities, room occupancy sensors, or both
3. **Schedule** — Follows the active schedule/preset
4. **Last Setting** — Maintains the last known target temperature

### Presence Detection
Three modes for detecting if anyone is home:
- **Person entities + Occupancy sensors** (recommended) — Checks both HA's built-in `person.xxx` entities (which use `zone.home`) AND room-level occupancy/motion sensors. Either method confirming presence = someone is home
- **Person entities only** — Only uses HA person tracking (phone GPS, router, etc.)
- **Occupancy sensors only** — Only uses motion/occupancy/presence binary sensors assigned to zones

### Learning Engine
The learning engine watches for manual temperature adjustments. When you make similar changes (within 2°F and 30 minutes) at similar times of day on 3+ occasions, it automatically creates a schedule entry for that pattern. You'll see learned patterns in the `sensor.better_thermostat_learned_patterns` entity.

### Zone Averaging
Each zone can have multiple temperature sensors. The integration averages all available readings to get a single zone temperature. If a sensor becomes unavailable, it's excluded from the average.

## Configuration Options

After setup, go to the integration's **Configure** button to:
- Adjust learning threshold, occupancy settings, away temp, override duration
- Add new zones with sensors
- View schedule configuration info
