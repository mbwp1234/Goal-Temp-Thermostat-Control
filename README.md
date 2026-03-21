# Goal Temp Thermostat Control (GTTC)

A smart, zone-aware thermostat integration for Home Assistant (HACS). Control your thermostat using temperature sensors from different rooms/floors, with intelligent scheduling, occupancy detection, TOU rate optimization, and automatic pattern learning.

## Features

- **Zone-Based Control** — Group temperature sensors by floor/room, average their readings, and target specific zones throughout the day
- **Auto-Discovery** — Automatically finds temperature and occupancy sensors from your Home Assistant areas, or add zones manually
- **Smart Scheduling** — Weekday/weekend schedules, per-day schedules, and built-in presets (Home, Away, Work From Home, Sleep). Drag-to-resize blocks, bulk add, copy entries or entire days, import/export as JSON, undo/redo
- **Pattern Learning** — Automatically detects when you make similar temperature adjustments at similar times and creates schedule entries for you (configurable threshold, default: 3 similar events)
- **Presence Detection** — Uses HA's built-in `person` entities (zone.home) and/or room occupancy sensors to detect if anyone is home. Three modes: Person entities only, Occupancy sensors only, or Both (recommended). Drops to away temperature when nobody is home, with per-zone overrides
- **Manual Override** — Any manual temperature change takes priority for a configurable period (default: 2 hours, configurable 15–480 min), then resumes automation
- **TOU Rate Optimization** — Adjusts the thermostat setpoint during on-peak electricity hours to reduce energy cost. Supports Dominion Energy Virginia's Off-Peak Plan schedule with correct summer/winter windows
- **Pre-conditioning** — Starts ramping toward the next schedule entry before it begins, so the house reaches comfort temperature right on time
- **Window/Door Sensors** — Automatically pauses heating and cooling when a window or door is detected open. Supports multiple sensors and a manual suspend toggle
- **Mirror HVAC Modes** — Exposes the same heat/cool/auto modes as your real thermostat, including heat pump and aux heat support
- **Command Center** — Sidebar panel with live automation toggles, zone temperatures, TOU rate display, temperature history chart with HVAC state and on-peak overlays, and the full schedule editor — all in one view

## Installation

### HACS (Recommended)

1. Open HACS in your Home Assistant instance
2. Click the three dots menu → **Custom repositories**
3. Add this repository URL and select **Integration** as the category
4. Search for "Goal Temp Thermostat Control" and install
5. Restart Home Assistant

### Manual

1. Copy the `custom_components/gttc` folder to your Home Assistant `config/custom_components/` directory
2. Restart Home Assistant

## Setup

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **Goal Temp Thermostat Control**
3. Follow the setup wizard:
   - **Step 1**: Name your thermostat, select your real thermostat entity, choose temperature units and range
   - **Step 2**: Configure zones — auto-discover from HA areas or add manually with temperature/occupancy sensors
   - **Step 3**: Enable/disable features — learning, occupancy, presence detection method, away temp, override duration

## Command Center

After installation a **GTTC** entry appears in the Home Assistant sidebar. The Command Center shows everything on one page:

- **Stat cards** — Live zone temperature, goal temperature, HVAC action, and active schedule entry
- **Automation Controls** — Toggle grid to enable/disable Schedule, Learning, Presence, TOU Optimization, Pre-conditioning, and Window Suspend without leaving the page. Each card shows a live status badge (e.g. current TOU rate period, pattern count, home/away state)
- **Quick Panel** — Active zone selector, override banner with cancel button, per-zone temperatures with occupancy indicators, current TOU rate period, and window sensor status
- **Temperature Chart** — 24-hour zone temperature history with:
  - Schedule goal step-function overlay
  - HVAC state bands (orange = heating, blue = cooling)
  - On-peak hour shading (when TOU is enabled)
- **Schedule Editor** — Full drag-and-drop schedule editor with preset selector, day tabs, week overview, and day detail — all without switching pages

## Entities Created

| Entity | Type | Description |
|--------|------|-------------|
| `climate.gttc` | Climate | Main virtual thermostat — set temp, change modes, activate presets |
| `select.gttc_active_zone` | Select | Pick which floor/room zone to target |
| `select.gttc_schedule_mode` | Select | Switch between Weekday/Weekend and Per Day scheduling |
| `switch.gttc_learning` | Switch | Toggle the pattern learning engine |
| `switch.gttc_occupancy_mode` | Switch | Toggle occupancy-based temperature control |
| `switch.gttc_schedule` | Switch | Toggle the schedule on/off |
| `switch.gttc_windows_open` | Switch | Manually suspend HVAC (windows open override) |
| `number.gttc_away_temperature` | Number | Set the away/eco temperature |
| `number.gttc_override_duration` | Number | Set how long manual overrides last (minutes) |
| `sensor.gttc_active_zone_temperature` | Sensor | Current averaged temp of the active zone |
| `sensor.gttc_*_temperature` | Sensor | Per-zone averaged temperature sensors |
| `sensor.gttc_override_remaining` | Sensor | Minutes remaining on manual override |
| `sensor.gttc_learned_patterns` | Sensor | Count of learned schedule patterns |

## Services

### `gttc.set_zone_temperature`
Set temperature for a specific zone.
```yaml
service: gttc.set_zone_temperature
data:
  zone_id: "living_room"
  temperature: 72
```

### `gttc.set_schedule`
Set schedule entries for a day or day group.
```yaml
service: gttc.set_schedule
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

### `gttc.set_preset`
Activate a schedule preset.
```yaml
service: gttc.set_preset
data:
  preset: work_from_home  # home, away, work_from_home, sleep
```

### `gttc.clear_learned_schedule`
Clear all learned patterns from the learning engine.
```yaml
service: gttc.clear_learned_schedule
```

## How It Works

### Priority System
Temperature decisions follow this priority (highest first):
1. **Windows Open** — If a window/door sensor is open (or manual suspend is on), HVAC is paused entirely
2. **Manual Override** — Any temp change you make holds for the override duration (default 2hr, configurable 15–480 min)
3. **Presence/Occupancy** — If enabled and nobody is detected home, drops to away temperature
4. **Schedule** — Follows the active schedule/preset
5. **Last Setting** — Maintains the last known target temperature

### TOU Rate Optimization
When enabled with the Dominion Energy Virginia provider, GTTC adjusts the thermostat setpoint during on-peak hours to reduce HVAC runtime and lower your electricity bill:

| Season | On-Peak Hours (Weekdays) |
|--------|--------------------------|
| Summer (May–Sep) | 3:00 PM – 6:00 PM |
| Winter (Oct–Apr) | 6:00 AM – 9:00 AM and 5:00 PM – 8:00 PM |

- Weekends and holidays (New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving, Christmas) are always off-peak
- Super off-peak (midnight–5 AM every day) is used for pre-conditioning
- On-peak windows are visually overlaid on the schedule editor and temperature chart

### Pre-conditioning
When pre-conditioning is enabled, GTTC begins ramping the thermostat toward the next schedule entry's target temperature before the entry starts (default: 60 minutes ahead). Combined with TOU awareness, this means the house reaches comfort temperature right as on-peak rates end.

### Presence Detection
Three modes for detecting if anyone is home:
- **Person entities + Occupancy sensors** (recommended) — Checks both HA's built-in `person.xxx` entities (which use `zone.home`) AND room-level occupancy/motion sensors. Either method confirming presence = someone is home
- **Person entities only** — Only uses HA person tracking (phone GPS, router, etc.)
- **Occupancy sensors only** — Only uses motion/occupancy/presence binary sensors assigned to zones

### Learning Engine
The learning engine watches for manual temperature adjustments. When you make similar changes (within 2°F and 30 minutes) at similar times of day on 3+ occasions, it automatically creates a schedule entry for that pattern. Patterns are visible in the `sensor.gttc_learned_patterns` entity and can be cleared with the `gttc.clear_learned_schedule` service.

### Zone Averaging
Each zone can have multiple temperature sensors. The integration averages all available readings to get a single zone temperature. If a sensor becomes unavailable, it is excluded from the average automatically.

## Settings

In the sidebar panel, go to the **Settings** tab to configure:

- **Temperature & Override** — Min/max range, away temperature, manual override duration
- **Learning** — Enable/disable, configure the repetition threshold
- **Occupancy** — Enable/disable, choose presence detection mode, select which `person` entities to track
- **Energy & Efficiency** — Enable pre-conditioning, enable TOU optimization, select provider, set outdoor temperature sensor
- **Window Sensors** — Add/remove contact sensors, manual suspend toggle
- **Zones** — Add, edit, delete, or auto-discover zones from HA areas. Set active zone, assign temperature and occupancy sensors, configure per-zone away temperature
