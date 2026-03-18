/**
 * GTTC Schedule Panel — Custom sidebar panel for Home Assistant.
 *
 * Provides a visual weekly schedule editor with:
 *   - Day tabs with 24-hour timeline
 *   - Colored temperature blocks
 *   - Click-to-edit with inline form
 *   - Preset selector
 *   - Current status display
 */

const DAYS_ORDERED = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];
const DAY_LABELS = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};
const HOURS = Array.from({ length: 25 }, (_, i) => i); // 0-24 for labels

// ── Temp-to-color mapping ───────────────────────────────────────────────────
function tempColor(temp, min = 50, max = 90) {
  const ratio = Math.max(0, Math.min(1, (temp - min) / (max - min)));
  // Blue (cold) → Teal → Green → Orange → Red (hot)
  if (ratio < 0.25) return `hsl(${200 + ratio * 4 * 20}, 70%, 50%)`;
  if (ratio < 0.5)  return `hsl(${160 - (ratio - 0.25) * 4 * 40}, 65%, 45%)`;
  if (ratio < 0.75) return `hsl(${40 - (ratio - 0.5) * 4 * 10}, 80%, 50%)`;
  return `hsl(${10 - (ratio - 0.75) * 4 * 10}, 85%, 48%)`;
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatTime12(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ── Main Panel Element ──────────────────────────────────────────────────────
class GttcPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._schedule = null;
    this._status = null;
    this._selectedDay = null;
    this._editingEntry = null; // {entry, isNew}
    this._activePreset = null;
    this._viewMode = "week"; // "week" or "day"
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._schedule) {
      this._loadData();
    }
  }

  set panel(panel) {
    this._config = panel.config || {};
  }

  async _loadData() {
    if (!this._hass) return;
    try {
      const [schedule, status] = await Promise.all([
        this._hass.callWS({ type: "gttc/get_schedule" }),
        this._hass.callWS({ type: "gttc/get_status" }),
      ]);
      this._schedule = schedule;
      this._status = status;
      this._activePreset = schedule.active_preset;
      if (!this._selectedDay) {
        const today = DAYS_ORDERED[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
        this._selectedDay = today;
      }
      this._render();
    } catch (err) {
      console.error("GTTC: Failed to load schedule data", err);
      this.shadowRoot.innerHTML = `
        <div style="padding:24px;color:var(--primary-text-color,#333)">
          <h2>GTTC Schedule</h2>
          <p style="color:var(--error-color,#c00)">Failed to load schedule data. Make sure GTTC is configured.</p>
          <pre>${err.message || err}</pre>
        </div>`;
    }
  }

  _getEntriesForDay(day) {
    const s = this._schedule;
    if (!s) return [];

    // Active preset takes priority
    if (s.active_preset && s.presets[s.active_preset]) {
      const preset = s.presets[s.active_preset];
      return preset.schedule[day] || [];
    }

    if (s.mode === "per_day") {
      return s.per_day[day] || [];
    }

    // weekday/weekend
    const isWeekend = ["saturday", "sunday"].includes(day);
    return isWeekend ? s.weekend : s.weekday;
  }

  _render() {
    if (!this._schedule) return;
    const s = this._schedule;

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <div class="panel">
        <header class="header">
          <div class="header-left">
            <ha-icon icon="mdi:calendar-clock" class="header-icon"></ha-icon>
            <h1>GTTC Schedule</h1>
          </div>
          <div class="header-right">
            ${this._renderStatus()}
            ${this._renderPresetSelector()}
          </div>
        </header>

        <div class="content">
          <div class="day-tabs">
            ${DAYS_ORDERED.map(d => `
              <button class="day-tab ${d === this._selectedDay ? "active" : ""}"
                      data-day="${d}">
                <span class="day-short">${DAY_LABELS[d]}</span>
              </button>
            `).join("")}
          </div>

          <div class="schedule-view">
            ${this._renderWeekOverview()}
            ${this._renderDayDetail()}
          </div>
        </div>

        ${this._editingEntry ? this._renderEditModal() : ""}
      </div>
    `;

    this._attachListeners();
  }

  _renderStatus() {
    const st = this._status;
    if (!st) return "";
    const parts = [];
    if (st.current_temp != null) parts.push(`<span class="status-item">Now: ${st.current_temp.toFixed(1)}°</span>`);
    if (st.target_temp != null) parts.push(`<span class="status-item">Goal: ${st.target_temp.toFixed(1)}°</span>`);
    if (st.active_zone) parts.push(`<span class="status-item">${st.active_zone}</span>`);
    if (st.override_active) parts.push(`<span class="status-item override">Override: ${st.override_remaining}m</span>`);
    return `<div class="status-bar">${parts.join("")}</div>`;
  }

  _renderPresetSelector() {
    const s = this._schedule;
    const presets = s.preset_labels || {};
    return `
      <select class="preset-select" id="presetSelect">
        <option value="" ${!s.active_preset ? "selected" : ""}>Custom Schedule</option>
        ${Object.entries(presets).map(([key, label]) =>
          `<option value="${key}" ${s.active_preset === key ? "selected" : ""}>${label}</option>`
        ).join("")}
      </select>
    `;
  }

  _renderWeekOverview() {
    const s = this._schedule;
    return `
      <div class="week-overview">
        <div class="time-axis">
          <div class="time-axis-label"></div>
          ${[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `
            <div class="time-mark" style="left:${(h / 24) * 100}%">
              ${h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? h + "a" : h === 24 ? "" : (h-12) + "p"}
            </div>
          `).join("")}
        </div>
        ${DAYS_ORDERED.map(day => {
          const entries = this._getEntriesForDay(day);
          const isSelected = day === this._selectedDay;
          return `
            <div class="week-row ${isSelected ? "selected" : ""}" data-day="${day}">
              <div class="week-row-label">${DAY_LABELS[day]}</div>
              <div class="week-row-timeline">
                ${this._renderTimelineBlocks(entries, day, true)}
                <div class="now-line" style="left:${this._nowPercent()}%"></div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  _renderDayDetail() {
    const day = this._selectedDay;
    if (!day) return "";
    const entries = this._getEntriesForDay(day);

    return `
      <div class="day-detail">
        <div class="day-detail-header">
          <h2>${day.charAt(0).toUpperCase() + day.slice(1)} Schedule</h2>
          <button class="btn btn-add" id="addEntryBtn">+ Add Entry</button>
        </div>
        <div class="day-timeline-container">
          <div class="day-timeline-hours">
            ${HOURS.map(h => `
              <div class="hour-mark" style="left:${(h / 24) * 100}%">
                <span class="hour-label">${h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? h + "am" : (h-12) + "pm"}</span>
                <div class="hour-line"></div>
              </div>
            `).join("")}
          </div>
          <div class="day-timeline">
            ${this._renderTimelineBlocks(entries, day, false)}
          </div>
        </div>
        <div class="entries-list">
          ${entries.length === 0
            ? `<p class="no-entries">No schedule entries for this day. Click "+ Add Entry" to create one.</p>`
            : entries.map((e, i) => this._renderEntryCard(e, i, day)).join("")}
        </div>
      </div>
    `;
  }

  _renderTimelineBlocks(entries, day, compact) {
    if (!entries || entries.length === 0) return "";
    const s = this._schedule;

    return entries.map((entry, i) => {
      let startMin = timeToMinutes(entry.time_start);
      let endMin = timeToMinutes(entry.time_end);
      // Handle overnight
      if (endMin <= startMin) endMin = 1440;

      const leftPct = (startMin / 1440) * 100;
      const widthPct = ((endMin - startMin) / 1440) * 100;
      const color = tempColor(entry.target_temp, s.temp_min, s.temp_max);
      const textColor = this._contrastColor(color);

      return `
        <div class="timeline-block ${compact ? "compact" : ""}"
             style="left:${leftPct}%;width:${widthPct}%;background:${color};color:${textColor}"
             data-day="${day}" data-index="${i}"
             title="${formatTime12(entry.time_start)} - ${formatTime12(entry.time_end)}: ${entry.target_temp}°F">
          ${compact
            ? `<span class="block-temp">${entry.target_temp}°</span>`
            : `<span class="block-temp">${entry.target_temp}°F</span>
               <span class="block-time">${formatTime12(entry.time_start)} - ${formatTime12(entry.time_end)}</span>`
          }
        </div>
      `;
    }).join("");
  }

  _renderEntryCard(entry, index, day) {
    const s = this._schedule;
    const color = tempColor(entry.target_temp, s.temp_min, s.temp_max);
    return `
      <div class="entry-card" data-day="${day}" data-index="${index}">
        <div class="entry-color" style="background:${color}"></div>
        <div class="entry-info">
          <span class="entry-time">${formatTime12(entry.time_start)} — ${formatTime12(entry.time_end)}</span>
          <span class="entry-temp">${entry.target_temp}°F</span>
        </div>
        <div class="entry-actions">
          <button class="btn btn-sm btn-edit" data-action="edit" data-day="${day}" data-index="${index}">Edit</button>
          <button class="btn btn-sm btn-delete" data-action="delete" data-day="${day}" data-index="${index}">Delete</button>
        </div>
      </div>
    `;
  }

  _renderEditModal() {
    const e = this._editingEntry;
    const entry = e.entry || {};
    const s = this._schedule;
    const title = e.isNew ? "Add Schedule Entry" : "Edit Schedule Entry";

    return `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal">
          <h3>${title}</h3>
          <form id="entryForm">
            <div class="form-row">
              <label>Start Time</label>
              <input type="time" id="editStart" value="${entry.time_start || "08:00"}" required>
            </div>
            <div class="form-row">
              <label>End Time</label>
              <input type="time" id="editEnd" value="${entry.time_end || "17:00"}" required>
            </div>
            <div class="form-row">
              <label>Temperature (°F)</label>
              <div class="temp-input-row">
                <input type="range" id="editTempRange" min="${s.temp_min}" max="${s.temp_max}" step="1"
                       value="${entry.target_temp || 70}">
                <input type="number" id="editTemp" min="${s.temp_min}" max="${s.temp_max}" step="0.5"
                       value="${entry.target_temp || 70}" required>
                <span class="temp-unit">°F</span>
              </div>
              <div class="temp-preview" id="tempPreview"
                   style="background:${tempColor(entry.target_temp || 70, s.temp_min, s.temp_max)}">
                ${entry.target_temp || 70}°F
              </div>
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn-cancel" id="cancelEdit">Cancel</button>
              <button type="submit" class="btn btn-save">Save</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  _attachListeners() {
    const root = this.shadowRoot;

    // Day tabs
    root.querySelectorAll(".day-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        this._selectedDay = btn.dataset.day;
        this._editingEntry = null;
        this._render();
      });
    });

    // Week row clicks
    root.querySelectorAll(".week-row").forEach(row => {
      row.addEventListener("click", () => {
        this._selectedDay = row.dataset.day;
        this._editingEntry = null;
        this._render();
      });
    });

    // Timeline block clicks (edit)
    root.querySelectorAll(".timeline-block").forEach(block => {
      block.addEventListener("click", (e) => {
        e.stopPropagation();
        const day = block.dataset.day;
        const idx = parseInt(block.dataset.index);
        const entries = this._getEntriesForDay(day);
        if (entries[idx]) {
          this._selectedDay = day;
          this._editingEntry = { entry: { ...entries[idx] }, isNew: false, day, index: idx };
          this._render();
        }
      });
    });

    // Entry card buttons
    root.querySelectorAll("[data-action='edit']").forEach(btn => {
      btn.addEventListener("click", () => {
        const day = btn.dataset.day;
        const idx = parseInt(btn.dataset.index);
        const entries = this._getEntriesForDay(day);
        if (entries[idx]) {
          this._editingEntry = { entry: { ...entries[idx] }, isNew: false, day, index: idx };
          this._render();
        }
      });
    });

    root.querySelectorAll("[data-action='delete']").forEach(btn => {
      btn.addEventListener("click", () => {
        const day = btn.dataset.day;
        const idx = parseInt(btn.dataset.index);
        const entries = this._getEntriesForDay(day);
        if (entries[idx]) {
          this._deleteEntry(day, entries[idx]);
        }
      });
    });

    // Add entry button
    const addBtn = root.getElementById("addEntryBtn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        this._editingEntry = {
          entry: { time_start: "08:00", time_end: "17:00", target_temp: 70 },
          isNew: true,
          day: this._selectedDay,
        };
        this._render();
      });
    }

    // Preset selector
    const presetSelect = root.getElementById("presetSelect");
    if (presetSelect) {
      presetSelect.addEventListener("change", () => {
        this._setPreset(presetSelect.value);
      });
    }

    // Modal
    const overlay = root.getElementById("modalOverlay");
    if (overlay) {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) {
          this._editingEntry = null;
          this._render();
        }
      });
    }

    const cancelBtn = root.getElementById("cancelEdit");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        this._editingEntry = null;
        this._render();
      });
    }

    // Temperature slider/input sync
    const tempRange = root.getElementById("editTempRange");
    const tempInput = root.getElementById("editTemp");
    const tempPreview = root.getElementById("tempPreview");
    if (tempRange && tempInput) {
      const syncTemp = (val) => {
        const s = this._schedule;
        tempRange.value = val;
        tempInput.value = val;
        if (tempPreview) {
          tempPreview.style.background = tempColor(parseFloat(val), s.temp_min, s.temp_max);
          tempPreview.textContent = `${val}°F`;
        }
      };
      tempRange.addEventListener("input", () => syncTemp(tempRange.value));
      tempInput.addEventListener("input", () => syncTemp(tempInput.value));
    }

    // Form submit
    const form = root.getElementById("entryForm");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        this._saveEntry();
      });
    }
  }

  async _saveEntry() {
    const root = this.shadowRoot;
    const start = root.getElementById("editStart").value;
    const end = root.getElementById("editEnd").value;
    const temp = parseFloat(root.getElementById("editTemp").value);
    const e = this._editingEntry;

    const msg = {
      type: "gttc/update_entry",
      day: e.day,
      time_start: start,
      time_end: end,
      target_temp: temp,
    };

    if (!e.isNew && e.entry) {
      msg.old_time_start = e.entry.time_start;
      msg.old_time_end = e.entry.time_end;
    }

    const s = this._schedule;
    if (s.active_preset) {
      msg.preset = s.active_preset;
    }

    try {
      await this._hass.callWS(msg);
      this._editingEntry = null;
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to save entry", err);
      alert("Failed to save: " + (err.message || err));
    }
  }

  async _deleteEntry(day, entry) {
    if (!confirm(`Delete ${formatTime12(entry.time_start)} - ${formatTime12(entry.time_end)} (${entry.target_temp}°F)?`)) {
      return;
    }

    const msg = {
      type: "gttc/delete_entry",
      day: day,
      time_start: entry.time_start,
      time_end: entry.time_end,
    };

    const s = this._schedule;
    if (s.active_preset) {
      msg.preset = s.active_preset;
    }

    try {
      await this._hass.callWS(msg);
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to delete entry", err);
      alert("Failed to delete: " + (err.message || err));
    }
  }

  async _setPreset(presetName) {
    try {
      if (presetName) {
        await this._hass.callService("gttc", "set_preset", { preset: presetName });
      }
      // Reload data
      await new Promise(r => setTimeout(r, 500));
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to set preset", err);
    }
  }

  _nowPercent() {
    const now = new Date();
    return ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
  }

  _contrastColor(bgColor) {
    // Simple: use white for dark backgrounds, dark for light
    // Parse HSL from our tempColor function
    return "rgba(255,255,255,0.95)";
  }

  _styles() {
    return `
      :host {
        display: block;
        --primary: var(--primary-color, #03a9f4);
        --primary-text: var(--primary-text-color, #212121);
        --secondary-text: var(--secondary-text-color, #727272);
        --card-bg: var(--ha-card-background, var(--card-background-color, #fff));
        --divider: var(--divider-color, #e0e0e0);
        --bg: var(--primary-background-color, #fafafa);
        --error: var(--error-color, #db4437);
        --success: var(--success-color, #43a047);
        font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
      }

      .panel {
        max-width: 1200px;
        margin: 0 auto;
        padding: 16px;
        color: var(--primary-text);
      }

      /* Header */
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        padding: 16px 0;
        border-bottom: 1px solid var(--divider);
        margin-bottom: 16px;
      }
      .header-left {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .header-icon {
        --mdc-icon-size: 28px;
        color: var(--primary);
      }
      .header h1 {
        margin: 0;
        font-size: 22px;
        font-weight: 500;
      }
      .header-right {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }

      /* Status bar */
      .status-bar {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .status-item {
        font-size: 13px;
        background: var(--card-bg);
        padding: 4px 10px;
        border-radius: 12px;
        border: 1px solid var(--divider);
      }
      .status-item.override {
        background: #fff3e0;
        border-color: #ff9800;
        color: #e65100;
      }

      /* Preset selector */
      .preset-select {
        padding: 6px 12px;
        border-radius: 8px;
        border: 1px solid var(--divider);
        background: var(--card-bg);
        color: var(--primary-text);
        font-size: 14px;
        cursor: pointer;
      }

      /* Day tabs */
      .day-tabs {
        display: flex;
        gap: 4px;
        margin-bottom: 16px;
      }
      .day-tab {
        flex: 1;
        padding: 8px 4px;
        border: 1px solid var(--divider);
        border-radius: 8px;
        background: var(--card-bg);
        color: var(--primary-text);
        cursor: pointer;
        text-align: center;
        font-size: 14px;
        font-weight: 500;
        transition: all 0.15s;
      }
      .day-tab:hover {
        background: var(--primary);
        color: #fff;
        border-color: var(--primary);
      }
      .day-tab.active {
        background: var(--primary);
        color: #fff;
        border-color: var(--primary);
      }

      /* Week overview */
      .week-overview {
        background: var(--card-bg);
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 20px;
        border: 1px solid var(--divider);
      }
      .time-axis {
        position: relative;
        height: 20px;
        margin-left: 48px;
        margin-bottom: 4px;
        font-size: 11px;
        color: var(--secondary-text);
      }
      .time-mark {
        position: absolute;
        transform: translateX(-50%);
      }
      .week-row {
        display: flex;
        align-items: center;
        height: 36px;
        margin-bottom: 2px;
        cursor: pointer;
        border-radius: 6px;
        transition: background 0.1s;
      }
      .week-row:hover {
        background: rgba(0,0,0,0.04);
      }
      .week-row.selected {
        background: rgba(3,169,244,0.08);
      }
      .week-row-label {
        width: 48px;
        font-size: 13px;
        font-weight: 500;
        color: var(--secondary-text);
        flex-shrink: 0;
        text-align: right;
        padding-right: 8px;
      }
      .week-row-timeline {
        flex: 1;
        position: relative;
        height: 28px;
        background: var(--bg);
        border-radius: 4px;
        overflow: hidden;
      }

      /* Timeline blocks */
      .timeline-block {
        position: absolute;
        top: 2px;
        bottom: 2px;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        cursor: pointer;
        font-weight: 500;
        transition: filter 0.1s, transform 0.1s;
        overflow: hidden;
        box-shadow: 0 1px 2px rgba(0,0,0,0.15);
        z-index: 1;
      }
      .timeline-block:hover {
        filter: brightness(1.1);
        transform: scaleY(1.15);
        z-index: 2;
      }
      .timeline-block.compact .block-temp {
        font-size: 11px;
      }
      .block-temp {
        font-size: 13px;
        font-weight: 600;
        text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      }
      .block-time {
        font-size: 10px;
        opacity: 0.85;
        text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      }

      /* Now line */
      .now-line {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--error);
        z-index: 3;
        opacity: 0.7;
      }

      /* Day detail */
      .day-detail {
        background: var(--card-bg);
        border-radius: 12px;
        padding: 16px;
        border: 1px solid var(--divider);
      }
      .day-detail-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }
      .day-detail h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 500;
      }

      /* Day timeline */
      .day-timeline-container {
        position: relative;
        margin-bottom: 20px;
      }
      .day-timeline-hours {
        position: relative;
        height: 20px;
        font-size: 11px;
        color: var(--secondary-text);
      }
      .hour-mark {
        position: absolute;
        transform: translateX(-50%);
      }
      .hour-label {
        white-space: nowrap;
      }
      .day-timeline {
        position: relative;
        height: 48px;
        background: var(--bg);
        border-radius: 8px;
        overflow: hidden;
        margin-top: 4px;
      }
      .day-timeline .timeline-block {
        top: 4px;
        bottom: 4px;
      }
      .day-timeline .block-temp {
        font-size: 14px;
      }
      .day-timeline .block-time {
        font-size: 11px;
      }

      /* Entry cards */
      .entries-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .no-entries {
        color: var(--secondary-text);
        font-style: italic;
        text-align: center;
        padding: 20px;
      }
      .entry-card {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--divider);
        background: var(--bg);
      }
      .entry-color {
        width: 6px;
        height: 32px;
        border-radius: 3px;
        flex-shrink: 0;
      }
      .entry-info {
        flex: 1;
        display: flex;
        gap: 16px;
        align-items: center;
      }
      .entry-time {
        font-size: 14px;
        font-weight: 500;
      }
      .entry-temp {
        font-size: 16px;
        font-weight: 600;
      }
      .entry-actions {
        display: flex;
        gap: 6px;
      }

      /* Buttons */
      .btn {
        padding: 8px 16px;
        border-radius: 8px;
        border: none;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        transition: background 0.15s;
      }
      .btn-add {
        background: var(--primary);
        color: #fff;
      }
      .btn-add:hover {
        filter: brightness(0.9);
      }
      .btn-sm {
        padding: 4px 10px;
        font-size: 12px;
        border-radius: 6px;
      }
      .btn-edit {
        background: var(--primary);
        color: #fff;
      }
      .btn-delete {
        background: transparent;
        color: var(--error);
        border: 1px solid var(--error);
      }
      .btn-delete:hover {
        background: var(--error);
        color: #fff;
      }
      .btn-cancel {
        background: transparent;
        color: var(--primary-text);
        border: 1px solid var(--divider);
      }
      .btn-save {
        background: var(--primary);
        color: #fff;
      }

      /* Modal */
      .modal-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .modal {
        background: var(--card-bg);
        border-radius: 16px;
        padding: 24px;
        min-width: 340px;
        max-width: 420px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2);
      }
      .modal h3 {
        margin: 0 0 16px;
        font-size: 18px;
        font-weight: 500;
      }
      .form-row {
        margin-bottom: 14px;
      }
      .form-row label {
        display: block;
        font-size: 13px;
        font-weight: 500;
        color: var(--secondary-text);
        margin-bottom: 4px;
      }
      .form-row input[type="time"],
      .form-row input[type="number"] {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--divider);
        border-radius: 8px;
        font-size: 16px;
        background: var(--bg);
        color: var(--primary-text);
        box-sizing: border-box;
      }
      .temp-input-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .temp-input-row input[type="range"] {
        flex: 1;
      }
      .temp-input-row input[type="number"] {
        width: 72px;
        flex: none;
      }
      .temp-unit {
        font-weight: 500;
        color: var(--secondary-text);
      }
      .temp-preview {
        margin-top: 8px;
        padding: 6px 12px;
        border-radius: 8px;
        text-align: center;
        font-weight: 600;
        font-size: 16px;
        color: rgba(255,255,255,0.95);
        text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      }
      .form-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 20px;
      }

      /* Responsive */
      @media (max-width: 600px) {
        .header {
          flex-direction: column;
          align-items: flex-start;
        }
        .entry-info {
          flex-direction: column;
          gap: 4px;
        }
        .day-tabs {
          flex-wrap: wrap;
        }
        .day-tab {
          min-width: 42px;
        }
      }
    `;
  }
}

customElements.define("gttc-panel", GttcPanel);
