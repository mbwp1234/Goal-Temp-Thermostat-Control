# Goal Temp Thermostat Control (GTTC)

A zone-aware thermostat integration for Home Assistant (HACS). GTTC steers your real thermostat by the temperature of the room you care about, on a schedule, and is written to be gentle on a heat pump.

## Features

- **Zone-Based Control** — Group temperature sensors by floor/room, average their readings, and target a specific zone per schedule block. The wall setpoint is offset so the *zone* reaches the goal; the offset is smoothed (the wall reports whole degrees) and saved across restarts.
- **Scheduling** — Plans (Home, Away, Sleep, plus your own), weekday/weekend or per-day, overnight blocks as one block, import/export as JSON, undo/redo
- **Holds** — Any change you make, on a dashboard or at the wall, holds for a configurable period (default 2 hours, 15–480 min) and then the plan resumes. A hold never rewrites the plan.
- **Seasons** — Heat, Cool, or Heat/Cool (both at once), with an optional demand-based automatic switch
- **Heat-pump friendly** — A rise in the heat setpoint is stepped in 0.5° at a time, at most every 10 minutes, starting from the room's own reading, so the compressor carries it rather than the electric strips. Holds and boosts skip the ramp. Boosts are small (+2° / +1°).
- **Quiet restarts** — After a restart nothing is written until the watched zone has a reading (or a saved offset to steer by), so the wall does not see the bare goal and then the offset goal seconds later.
- **Window/Door Sensors** — Parks heating and cooling while a window or door is open
- **Vacation** — A dated setback that ends by itself
- **Sidebar panel** — Now (dial, steppers, mode), Schedule, History (week and year) and Settings, built for a phone first

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
   - **Step 2**: Configure zones — auto-discover from HA areas or add manually
   - **Step 3**: Away temperatures, hold duration, outdoor sensor

## The panel

A **Climate** entry appears in the sidebar:

- **Now** — the zone temperature on a dial with the goal as its handle, − / + to hold, Heat · Both · Cool · Off, the plan, room and pause, every room's temperature, today's plan, and boosts
- **Schedule** — every plan, the week as colour bars, and a sheet to edit a block; each save is one undo step
- **History** — heating/cooling time per day against the outside temperature, by week or by year; tap a chart to read it
- **Settings** — goals, range, hold length, the season switch, rooms, windows and the outdoor sensor

## Entities Created

| Entity | Type | Description |
|--------|------|-------------|
| `climate.gttc` | Climate | Main virtual thermostat — set temp, change modes, activate presets |
| `select.gttc_active_zone` | Select | Pick which floor/room zone to target |
| `select.gttc_schedule_mode` | Select | Switch between Weekday/Weekend and Per Day scheduling |
| `switch.gttc_schedule` | Switch | Toggle the schedule on/off |
| `switch.gttc_windows_open` | Switch | Manually suspend HVAC (windows open override) |
| `number.gttc_away_temperature` | Number | Set the away/eco temperature |
| `number.gttc_override_duration` | Number | Set how long manual overrides last (minutes) |
| `sensor.gttc_active_zone_temperature` | Sensor | Current averaged temp of the active zone |
| `sensor.gttc_*_temperature` | Sensor | Per-zone averaged temperature sensors |
| `sensor.gttc_override_remaining` | Sensor | Minutes remaining on manual override |

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
  preset: sleep  # home, away, sleep, or a plan of your own
```

## How It Works

### Priority System
Temperature decisions follow this priority (highest first):
1. **Windows Open** — If a window/door sensor is open (or manual suspend is on), HVAC is paused entirely
2. **Hold** — Any temp change you make holds for the hold duration (default 2hr, configurable 15–480 min). Changes made on the physical thermostat count too — GTTC watches the real thermostat's setpoint and promotes any change it didn't make into a hold
3. **Vacation** — A dated setback
4. **Schedule** — Follows the running plan
5. **Last Setting** — Keeps the last goal (cooling: the cooling backup goal)

### Seasons: Heat, Heat/Cool, Cool

A season picks which of a schedule block's two numbers runs (its heating target or its cooling target) and puts the thermostat in that mode. **Heat/Cool** runs both at once: the thermostat's `heat_cool` mode with the heating target below and the cooling target above, and the house drifts for free in between. It needs a thermostat that offers `heat_cool`; GTTC refuses the season otherwise.

- **Minimum gap** (`heat_cool_min_gap`, default 3°F): set it to your thermostat's own auto-changeover differential. A block narrower than that has its heating end lowered, because a thermostat given a narrower band moves a setpoint by itself.
- **No AC below** (`cool_lockout_temp`, default 50°F outside): in Heat/Cool the cooling setpoint is parked and the fan circulates instead. A hold always gets the AC.
- **Leaving Heat/Cool**: with the auto switch on, Heat/Cool hands over to a single season once only one side of the equipment has run for `heat_cool_settle_days` (default 5).
- Automatic switches are demand-based. From Heat, the trigger is the house sitting 1° above the cooling goal with the heat idle. From Cool, it is the house 1° below the heating goal, on a cold day, with the AC idle. The house must hold there for the recommend threshold, and an open window resets the count. Time Home Assistant was down does not count.
- A band changed at the wall is held like any other thermostat hold. Band writes widen before they narrow so the thermostat never sees a band narrower than its differential.

### Heat pumps
On a heat pump, most thermostats bring on the electric backup (aux) heat when the setpoint jumps well above the room. GTTC raises the heat setpoint in 0.5° steps no more than every 10 minutes, starting from the thermostat's own reading, so a morning change of two or three degrees reaches the wall over half an hour or so and the compressor does the work. Falls are never slowed. Holds and boosts go straight through — they are someone asking for heat now. For the backup heat itself, set the thermostat's own aux settings (droop, outdoor lockout) to suit your equipment.

### Zone Averaging
Each zone can have multiple temperature sensors. The integration averages all available readings to get a single zone temperature. If a sensor becomes unavailable, it is excluded from the average automatically.

## Settings

In the sidebar panel's **Settings** tab:

- **Goals** — Away temperatures for heat and cool, the Heat/Cool gap, the cooling backup goal
- **Range** — The lowest and highest the wall is ever set to
- **Changes** — How long a hold lasts
- **Season switch** — Automatic switching, how long to wait, and the Heat/Cool settings
- **Rooms, Windows, Outside** — Zones and their sensors, window/door sensors, the outdoor temperature sensor
