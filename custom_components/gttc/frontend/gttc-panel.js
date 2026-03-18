/**
 * GTTC Schedule Panel — Custom sidebar panel for Home Assistant.
 *
 * Features:
 *   - Day tabs with 24-hour timeline
 *   - Colored temperature blocks with drag-to-resize
 *   - Click-to-edit with inline form
 *   - Preset selector with deactivate + custom preset creation
 *   - Copy entry to other days
 *   - Bulk add entry to multiple days
 *   - Copy entire day to other days
 *   - Cancel override button
 *   - Zone/room selector per entry
 *   - Schedule mode toggle (weekday/weekend vs per-day)
 *   - Time conflict detection with warnings
 *   - Import/export schedule as JSON
 *   - Undo/redo support
 */

const DAYS_ORDERED = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];
const DAY_LABELS = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};
const DAY_LABELS_FULL = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday",
  friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};
const HOURS = Array.from({ length: 25 }, (_, i) => i);

// ── Temp-to-color mapping ───────────────────────────────────────────────────
function tempColor(temp, min = 50, max = 90) {
  const ratio = Math.max(0, Math.min(1, (temp - min) / (max - min)));
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
    this._editingEntry = null;
    this._activePreset = null;
    this._viewMode = "week";
    // Copy entry state
    this._copyingEntry = null;
    this._showCopyModal = false;
    this._copyTargetDays = new Set();
    // Copy day state
    this._showCopyDayModal = false;
    this._copyDayTargetDays = new Set();
    // Custom preset modal
    this._showPresetModal = false;
    this._presetModalMode = "create"; // "create" | "rename" | "delete"
    this._presetModalTarget = null;
    // Import/export
    this._showExportModal = false;
    this._exportData = "";
    this._showImportModal = false;
    // Drag state
    this._dragging = null;
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
    if (s.active_preset && s.presets[s.active_preset]) {
      const preset = s.presets[s.active_preset];
      return preset.schedule[day] || [];
    }
    if (s.mode === "per_day") {
      return s.per_day[day] || [];
    }
    const isWeekend = ["saturday", "sunday"].includes(day);
    return isWeekend ? s.weekend : s.weekday;
  }

  _render() {
    if (!this._schedule) return;
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
            ${this._renderUndoRedo()}
            ${this._renderScheduleMode()}
            ${this._renderPresetSelector()}
            ${this._renderToolbar()}
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
        ${this._showCopyModal ? this._renderCopyModal() : ""}
        ${this._showCopyDayModal ? this._renderCopyDayModal() : ""}
        ${this._showPresetModal ? this._renderPresetModal() : ""}
        ${this._showExportModal ? this._renderExportModal() : ""}
        ${this._showImportModal ? this._renderImportModal() : ""}
      </div>
    `;
    this._attachListeners();
  }

  // ── Status bar ────────────────────────────────────────────────────────────

  _renderStatus() {
    const st = this._status;
    if (!st) return "";
    const parts = [];
    if (st.current_temp != null) parts.push(`<span class="status-item">Now: ${st.current_temp.toFixed(1)}\u00b0</span>`);
    if (st.target_temp != null) parts.push(`<span class="status-item">Goal: ${st.target_temp.toFixed(1)}\u00b0</span>`);
    if (st.active_zone) parts.push(`<span class="status-item">${st.active_zone}</span>`);
    if (st.override_active) {
      parts.push(`<span class="status-item override">Override: ${st.override_remaining}m
        <button class="btn-cancel-override" id="cancelOverrideBtn" title="Cancel Override">\u2715</button>
      </span>`);
    }
    return `<div class="status-bar">${parts.join("")}</div>`;
  }

  // ── Undo / Redo buttons ───────────────────────────────────────────────────

  _renderUndoRedo() {
    const s = this._schedule;
    return `
      <div class="undo-redo">
        <button class="btn btn-icon" id="undoBtn" title="Undo" ${s.can_undo ? "" : "disabled"}>
          <ha-icon icon="mdi:undo"></ha-icon>
        </button>
        <button class="btn btn-icon" id="redoBtn" title="Redo" ${s.can_redo ? "" : "disabled"}>
          <ha-icon icon="mdi:redo"></ha-icon>
        </button>
      </div>
    `;
  }

  // ── Schedule mode toggle ──────────────────────────────────────────────────

  _renderScheduleMode() {
    const s = this._schedule;
    if (s.active_preset) return "";
    return `
      <select class="mode-select" id="modeSelect">
        <option value="weekday_weekend" ${s.mode === "weekday_weekend" ? "selected" : ""}>Weekday / Weekend</option>
        <option value="per_day" ${s.mode === "per_day" ? "selected" : ""}>Per Day</option>
      </select>
    `;
  }

  // ── Preset selector ───────────────────────────────────────────────────────

  _renderPresetSelector() {
    const s = this._schedule;
    const presets = s.preset_labels || {};
    const presetData = s.presets || {};
    return `
      <div class="preset-group">
        <select class="preset-select" id="presetSelect">
          <option value="" ${!s.active_preset ? "selected" : ""}>Custom Schedule</option>
          ${Object.entries(presets).map(([key, label]) =>
            `<option value="${key}" ${s.active_preset === key ? "selected" : ""}>${label}</option>`
          ).join("")}
        </select>
        <button class="btn btn-icon btn-small" id="createPresetBtn" title="Create Custom Preset">+</button>
        ${s.active_preset && presetData[s.active_preset] && !presetData[s.active_preset].is_builtin ? `
          <button class="btn btn-icon btn-small btn-danger" id="deletePresetBtn" title="Delete This Preset">\u2715</button>
          <button class="btn btn-icon btn-small" id="renamePresetBtn" title="Rename This Preset">
            <ha-icon icon="mdi:pencil"></ha-icon>
          </button>
        ` : ""}
      </div>
    `;
  }

  // ── Toolbar (export/import) ───────────────────────────────────────────────

  _renderToolbar() {
    return `
      <div class="toolbar-group">
        <button class="btn btn-icon btn-small" id="exportBtn" title="Export Schedule">
          <ha-icon icon="mdi:export"></ha-icon>
        </button>
        <button class="btn btn-icon btn-small" id="importBtn" title="Import Schedule">
          <ha-icon icon="mdi:import"></ha-icon>
        </button>
      </div>
    `;
  }

  // ── Week overview ─────────────────────────────────────────────────────────

  _renderWeekOverview() {
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

  // ── Day detail ────────────────────────────────────────────────────────────

  _renderDayDetail() {
    const day = this._selectedDay;
    if (!day) return "";
    const entries = this._getEntriesForDay(day);
    return `
      <div class="day-detail">
        <div class="day-detail-header">
          <h2>${day.charAt(0).toUpperCase() + day.slice(1)} Schedule</h2>
          <div class="day-actions">
            <button class="btn btn-add" id="addEntryBtn">+ Add Entry</button>
            <button class="btn btn-outline" id="bulkAddBtn">+ Bulk Add</button>
            <button class="btn btn-outline" id="copyDayBtn" title="Copy this day's schedule to other days">Copy Day</button>
          </div>
        </div>
        <div class="day-timeline-container">
          <div class="day-timeline-hours">
            ${HOURS.map(h => `
              <div class="hour-mark" style="left:${(h / 24) * 100}%">
                <span class="hour-label">${h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? h + "am" : (h-12) + "pm"}</span>
              </div>
            `).join("")}
          </div>
          <div class="day-timeline" id="dayTimeline" data-day="${day}">
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

  // ── Timeline blocks ───────────────────────────────────────────────────────

  _renderTimelineBlocks(entries, day, compact) {
    if (!entries || entries.length === 0) return "";
    const s = this._schedule;
    return entries.map((entry, i) => {
      let startMin = timeToMinutes(entry.time_start);
      let endMin = timeToMinutes(entry.time_end);
      if (endMin <= startMin) endMin = 1440;
      const leftPct = (startMin / 1440) * 100;
      const widthPct = ((endMin - startMin) / 1440) * 100;
      const color = tempColor(entry.target_temp, s.temp_min, s.temp_max);
      const textColor = "rgba(255,255,255,0.95)";
      const zoneLabel = entry.zone_id ? ` [${this._getZoneName(entry.zone_id)}]` : "";
      return `
        <div class="timeline-block ${compact ? "compact" : ""}"
             style="left:${leftPct}%;width:${widthPct}%;background:${color};color:${textColor}"
             data-day="${day}" data-index="${i}"
             title="${formatTime12(entry.time_start)} - ${formatTime12(entry.time_end)}: ${entry.target_temp}\u00b0F${zoneLabel}">
          ${compact
            ? `<span class="block-temp">${entry.target_temp}\u00b0</span>`
            : `<span class="block-temp">${entry.target_temp}\u00b0F</span>
               <span class="block-time">${formatTime12(entry.time_start)} - ${formatTime12(entry.time_end)}</span>`
          }
          ${!compact ? `
            <div class="drag-handle drag-handle-left" data-edge="left" data-day="${day}" data-index="${i}"></div>
            <div class="drag-handle drag-handle-right" data-edge="right" data-day="${day}" data-index="${i}"></div>
          ` : ""}
        </div>
      `;
    }).join("");
  }

  // ── Entry cards ───────────────────────────────────────────────────────────

  _renderEntryCard(entry, index, day) {
    const s = this._schedule;
    const color = tempColor(entry.target_temp, s.temp_min, s.temp_max);
    const zoneLabel = entry.zone_id ? this._getZoneName(entry.zone_id) : "";
    return `
      <div class="entry-card" data-day="${day}" data-index="${index}">
        <div class="entry-color" style="background:${color}"></div>
        <div class="entry-info">
          <span class="entry-time">${formatTime12(entry.time_start)} \u2014 ${formatTime12(entry.time_end)}</span>
          <span class="entry-temp">${entry.target_temp}\u00b0F</span>
          ${zoneLabel ? `<span class="entry-zone">${zoneLabel}</span>` : ""}
        </div>
        <div class="entry-actions">
          <button class="btn btn-sm btn-copy" data-action="copy" data-day="${day}" data-index="${index}" title="Copy to other days">Copy</button>
          <button class="btn btn-sm btn-edit" data-action="edit" data-day="${day}" data-index="${index}">Edit</button>
          <button class="btn btn-sm btn-delete" data-action="delete" data-day="${day}" data-index="${index}">Delete</button>
        </div>
      </div>
    `;
  }

  _getZoneName(zoneId) {
    const s = this._schedule;
    if (!s || !s.zones) return zoneId;
    const zone = s.zones.find(z => z.id === zoneId);
    return zone ? zone.name : zoneId;
  }

  // ── Edit modal ────────────────────────────────────────────────────────────

  _renderEditModal() {
    const e = this._editingEntry;
    const entry = e.entry || {};
    const s = this._schedule;
    const isBulk = !!e.isBulk;
    const title = isBulk ? "Bulk Add Entry" : (e.isNew ? "Add Schedule Entry" : "Edit Schedule Entry");
    const zones = s.zones || [];
    const hasZones = zones.length > 0;

    return `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal">
          <h3>${title}</h3>
          <form id="entryForm">
            ${isBulk ? this._renderDayCheckboxes("bulkDayCheckboxes", e.targetDays, null) : ""}
            <div class="form-row">
              <label>Start Time</label>
              <input type="time" id="editStart" value="${entry.time_start || "08:00"}" required>
            </div>
            <div class="form-row">
              <label>End Time</label>
              <input type="time" id="editEnd" value="${entry.time_end || "17:00"}" required>
            </div>
            <div class="form-row">
              <label>Temperature (\u00b0F)</label>
              <div class="temp-input-row">
                <input type="range" id="editTempRange" min="${s.temp_min}" max="${s.temp_max}" step="1"
                       value="${entry.target_temp || 70}">
                <input type="number" id="editTemp" min="${s.temp_min}" max="${s.temp_max}" step="0.5"
                       value="${entry.target_temp || 70}" required>
                <span class="temp-unit">\u00b0F</span>
              </div>
              <div class="temp-preview" id="tempPreview"
                   style="background:${tempColor(entry.target_temp || 70, s.temp_min, s.temp_max)}">
                ${entry.target_temp || 70}\u00b0F
              </div>
            </div>
            ${hasZones ? `
              <div class="form-row">
                <label>Zone / Room (optional)</label>
                <select id="editZone" class="zone-select">
                  <option value="">All Zones (default)</option>
                  ${zones.map(z => `
                    <option value="${z.id}" ${entry.zone_id === z.id ? "selected" : ""}>${z.name}</option>
                  `).join("")}
                </select>
              </div>
            ` : ""}
            <div id="conflictWarning" class="conflict-warning" style="display:none"></div>
            <div class="form-actions">
              <button type="button" class="btn btn-cancel" id="cancelEdit">Cancel</button>
              <button type="submit" class="btn btn-save">${isBulk ? "Add to Selected Days" : "Save"}</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // ── Copy entry modal ──────────────────────────────────────────────────────

  _renderCopyModal() {
    const entry = this._copyingEntry;
    if (!entry) return "";
    return `
      <div class="modal-overlay" id="copyModalOverlay">
        <div class="modal">
          <h3>Copy Entry to Other Days</h3>
          <p class="copy-info">
            ${formatTime12(entry.entry.time_start)} \u2014 ${formatTime12(entry.entry.time_end)} at ${entry.entry.target_temp}\u00b0F
          </p>
          ${this._renderDayCheckboxes("copyDayCheckboxes", this._copyTargetDays, entry.sourceDay)}
          <div class="form-actions">
            <button type="button" class="btn btn-cancel" id="cancelCopy">Cancel</button>
            <button type="button" class="btn btn-save" id="confirmCopy">Copy</button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Copy day modal ────────────────────────────────────────────────────────

  _renderCopyDayModal() {
    const day = this._selectedDay;
    const entries = this._getEntriesForDay(day);
    return `
      <div class="modal-overlay" id="copyDayModalOverlay">
        <div class="modal">
          <h3>Copy Entire Day</h3>
          <p class="copy-info">
            Copy all ${entries.length} entries from <strong>${DAY_LABELS_FULL[day]}</strong> to:
          </p>
          ${this._renderDayCheckboxes("copyDayDayCheckboxes", this._copyDayTargetDays, day)}
          <div class="form-actions">
            <button type="button" class="btn btn-cancel" id="cancelCopyDay">Cancel</button>
            <button type="button" class="btn btn-save" id="confirmCopyDay">Copy Day</button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Preset management modal ───────────────────────────────────────────────

  _renderPresetModal() {
    const mode = this._presetModalMode;
    const target = this._presetModalTarget;
    const s = this._schedule;
    let title, body;

    if (mode === "create") {
      title = "Create Custom Preset";
      body = `
        <div class="form-row">
          <label>Preset Name</label>
          <input type="text" id="presetNameInput" placeholder="e.g. Vacation, Evening Routine" required maxlength="40">
        </div>
      `;
    } else if (mode === "rename") {
      const currentLabel = s.presets[target] ? s.presets[target].label : "";
      title = "Rename Preset";
      body = `
        <div class="form-row">
          <label>New Name</label>
          <input type="text" id="presetNameInput" value="${currentLabel}" required maxlength="40">
        </div>
      `;
    } else {
      const label = s.presets[target] ? s.presets[target].label : target;
      title = "Delete Preset";
      body = `<p>Are you sure you want to delete the preset <strong>"${label}"</strong>? This cannot be undone.</p>`;
    }

    return `
      <div class="modal-overlay" id="presetModalOverlay">
        <div class="modal">
          <h3>${title}</h3>
          ${body}
          <div class="form-actions">
            <button type="button" class="btn btn-cancel" id="cancelPresetModal">Cancel</button>
            <button type="button" class="btn ${mode === "delete" ? "btn-danger-fill" : "btn-save"}" id="confirmPresetModal">
              ${mode === "create" ? "Create" : mode === "rename" ? "Rename" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Export modal ──────────────────────────────────────────────────────────

  _renderExportModal() {
    return `
      <div class="modal-overlay" id="exportModalOverlay">
        <div class="modal modal-wide">
          <h3>Export Schedule</h3>
          <p class="modal-hint">Copy this JSON to save or share your schedule.</p>
          <textarea class="export-textarea" id="exportTextarea" readonly>${this._exportData}</textarea>
          <div class="form-actions">
            <button type="button" class="btn btn-cancel" id="cancelExport">Close</button>
            <button type="button" class="btn btn-save" id="copyExport">Copy to Clipboard</button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Import modal ──────────────────────────────────────────────────────────

  _renderImportModal() {
    return `
      <div class="modal-overlay" id="importModalOverlay">
        <div class="modal modal-wide">
          <h3>Import Schedule</h3>
          <p class="modal-hint">Paste exported JSON below to import a schedule. This will merge with existing presets.</p>
          <textarea class="export-textarea" id="importTextarea" placeholder="Paste JSON here..."></textarea>
          <div id="importError" class="conflict-warning" style="display:none"></div>
          <div class="form-actions">
            <button type="button" class="btn btn-cancel" id="cancelImport">Cancel</button>
            <button type="button" class="btn btn-save" id="confirmImport">Import</button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Shared day checkboxes component ───────────────────────────────────────

  _renderDayCheckboxes(containerId, selectedSet, sourceDay) {
    return `
      <div class="form-row">
        <label>${sourceDay ? "Copy to:" : "Select Days"}</label>
        <div class="day-checkboxes" id="${containerId}">
          ${DAYS_ORDERED.map(d => `
            <label class="day-checkbox-label">
              <input type="checkbox" value="${d}"
                ${d === sourceDay ? "disabled" : ""}
                ${selectedSet && selectedSet.has(d) ? "checked" : ""}>
              <span class="${d === sourceDay ? "source-day" : ""}">${DAY_LABELS_FULL[d]}${d === sourceDay ? " (source)" : ""}</span>
            </label>
          `).join("")}
          <div class="quick-select">
            <button type="button" class="btn btn-xs" data-qs="weekdays" data-container="${containerId}">Weekdays</button>
            <button type="button" class="btn btn-xs" data-qs="weekend" data-container="${containerId}">Weekend</button>
            <button type="button" class="btn btn-xs" data-qs="${sourceDay ? "all_others" : "all"}" data-container="${containerId}">${sourceDay ? "All Others" : "All"}</button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Event listeners ───────────────────────────────────────────────────────

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
        // Don't open edit if we were dragging
        if (this._wasDragging) { this._wasDragging = false; return; }
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

    // Drag handles for resize
    root.querySelectorAll(".drag-handle").forEach(handle => {
      handle.addEventListener("mousedown", (e) => this._startDrag(e, handle));
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
        if (entries[idx]) this._deleteEntry(day, entries[idx]);
      });
    });

    root.querySelectorAll("[data-action='copy']").forEach(btn => {
      btn.addEventListener("click", () => {
        const day = btn.dataset.day;
        const idx = parseInt(btn.dataset.index);
        const entries = this._getEntriesForDay(day);
        if (entries[idx]) {
          this._copyingEntry = { entry: { ...entries[idx] }, sourceDay: day };
          this._copyTargetDays = new Set();
          this._showCopyModal = true;
          this._render();
        }
      });
    });

    // Add / Bulk / Copy Day buttons
    this._addClick("addEntryBtn", () => {
      this._editingEntry = {
        entry: { time_start: "08:00", time_end: "17:00", target_temp: 70 },
        isNew: true, day: this._selectedDay,
      };
      this._render();
    });

    this._addClick("bulkAddBtn", () => {
      this._editingEntry = {
        entry: { time_start: "08:00", time_end: "17:00", target_temp: 70 },
        isNew: true, isBulk: true, targetDays: new Set([this._selectedDay]), day: this._selectedDay,
      };
      this._render();
    });

    this._addClick("copyDayBtn", () => {
      this._copyDayTargetDays = new Set();
      this._showCopyDayModal = true;
      this._render();
    });

    // Preset selector
    const presetSelect = root.getElementById("presetSelect");
    if (presetSelect) {
      presetSelect.addEventListener("change", () => this._setPreset(presetSelect.value));
    }

    // Schedule mode selector
    const modeSelect = root.getElementById("modeSelect");
    if (modeSelect) {
      modeSelect.addEventListener("change", () => this._setScheduleMode(modeSelect.value));
    }

    // Cancel override
    this._addClick("cancelOverrideBtn", () => this._cancelOverride(), true);

    // Undo / Redo
    this._addClick("undoBtn", () => this._undo());
    this._addClick("redoBtn", () => this._redo());

    // Preset management
    this._addClick("createPresetBtn", () => {
      this._presetModalMode = "create";
      this._presetModalTarget = null;
      this._showPresetModal = true;
      this._render();
    });
    this._addClick("deletePresetBtn", () => {
      this._presetModalMode = "delete";
      this._presetModalTarget = this._schedule.active_preset;
      this._showPresetModal = true;
      this._render();
    });
    this._addClick("renamePresetBtn", () => {
      this._presetModalMode = "rename";
      this._presetModalTarget = this._schedule.active_preset;
      this._showPresetModal = true;
      this._render();
    });

    // Export / Import
    this._addClick("exportBtn", () => this._exportSchedule());
    this._addClick("importBtn", () => {
      this._showImportModal = true;
      this._render();
    });

    // Modal overlays — close on background click
    ["modalOverlay", "copyModalOverlay", "copyDayModalOverlay", "presetModalOverlay", "exportModalOverlay", "importModalOverlay"].forEach(id => {
      const el = root.getElementById(id);
      if (el) el.addEventListener("click", (e) => {
        if (e.target === el) this._closeAllModals();
      });
    });

    // Cancel buttons
    this._addClick("cancelEdit", () => { this._editingEntry = null; this._render(); });
    this._addClick("cancelCopy", () => { this._showCopyModal = false; this._copyingEntry = null; this._render(); });
    this._addClick("cancelCopyDay", () => { this._showCopyDayModal = false; this._render(); });
    this._addClick("cancelPresetModal", () => { this._showPresetModal = false; this._render(); });
    this._addClick("cancelExport", () => { this._showExportModal = false; this._render(); });
    this._addClick("cancelImport", () => { this._showImportModal = false; this._render(); });

    // Confirm buttons
    this._addClick("confirmCopy", () => this._executeCopy());
    this._addClick("confirmCopyDay", () => this._executeCopyDay());
    this._addClick("confirmPresetModal", () => this._executePresetAction());
    this._addClick("copyExport", () => this._copyExportToClipboard());
    this._addClick("confirmImport", () => this._executeImport());

    // Quick-select buttons (generic handler)
    root.querySelectorAll("[data-qs]").forEach(btn => {
      btn.addEventListener("click", () => {
        this._quickSelectDays(btn.dataset.qs, btn.dataset.container);
      });
    });

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
          tempPreview.textContent = `${val}\u00b0F`;
        }
      };
      tempRange.addEventListener("input", () => syncTemp(tempRange.value));
      tempInput.addEventListener("input", () => syncTemp(tempInput.value));
    }

    // Conflict detection on time change
    const editStart = root.getElementById("editStart");
    const editEnd = root.getElementById("editEnd");
    if (editStart && editEnd) {
      const checkConflicts = () => this._checkConflicts();
      editStart.addEventListener("change", checkConflicts);
      editEnd.addEventListener("change", checkConflicts);
    }

    // Form submit
    const form = root.getElementById("entryForm");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (this._editingEntry && this._editingEntry.isBulk) {
          this._saveBulkEntry();
        } else {
          this._saveEntry();
        }
      });
    }

    // Track checkbox changes in copy/copyDay modals
    this._trackCheckboxes("copyDayCheckboxes", this._copyTargetDays);
    this._trackCheckboxes("copyDayDayCheckboxes", this._copyDayTargetDays);
  }

  _addClick(id, handler, stopProp = false) {
    const el = this.shadowRoot.getElementById(id);
    if (el) el.addEventListener("click", (e) => { if (stopProp) e.stopPropagation(); handler(); });
  }

  _trackCheckboxes(containerId, targetSet) {
    const container = this.shadowRoot.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll("input[type='checkbox']").forEach(cb => {
      cb.addEventListener("change", () => {
        if (cb.checked) targetSet.add(cb.value);
        else targetSet.delete(cb.value);
      });
    });
  }

  _closeAllModals() {
    this._editingEntry = null;
    this._showCopyModal = false;
    this._copyingEntry = null;
    this._showCopyDayModal = false;
    this._showPresetModal = false;
    this._showExportModal = false;
    this._showImportModal = false;
    this._render();
  }

  // ── Drag-to-resize ────────────────────────────────────────────────────────

  _startDrag(e, handle) {
    e.preventDefault();
    e.stopPropagation();

    const edge = handle.dataset.edge; // "left" or "right"
    const day = handle.dataset.day;
    const idx = parseInt(handle.dataset.index);
    const entries = this._getEntriesForDay(day);
    if (!entries[idx]) return;

    const timeline = this.shadowRoot.getElementById("dayTimeline");
    if (!timeline) return;
    const timelineRect = timeline.getBoundingClientRect();

    const entry = entries[idx];
    const origStart = entry.time_start;
    const origEnd = entry.time_end;
    this._wasDragging = false;

    const onMove = (me) => {
      this._wasDragging = true;
      const x = me.clientX - timelineRect.left;
      const pct = Math.max(0, Math.min(1, x / timelineRect.width));
      const minutes = Math.round(pct * 1440 / 15) * 15; // snap to 15 min
      const newTime = minutesToTime(minutes);

      const block = handle.closest(".timeline-block");
      if (!block) return;

      if (edge === "left") {
        const endMin = timeToMinutes(origEnd);
        if (minutes < endMin) {
          block.style.left = `${(minutes / 1440) * 100}%`;
          block.style.width = `${((endMin - minutes) / 1440) * 100}%`;
          block.dataset.dragStart = newTime;
        }
      } else {
        const startMin = timeToMinutes(origStart);
        if (minutes > startMin) {
          block.style.width = `${((minutes - startMin) / 1440) * 100}%`;
          block.dataset.dragEnd = newTime;
        }
      }
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      if (!this._wasDragging) return;

      const block = handle.closest(".timeline-block");
      const newStart = block ? block.dataset.dragStart || origStart : origStart;
      const newEnd = block ? block.dataset.dragEnd || origEnd : origEnd;

      if (newStart !== origStart || newEnd !== origEnd) {
        this._resizeEntry(day, origStart, origEnd, newStart, newEnd, entry.target_temp, entry.zone_id);
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  async _resizeEntry(day, oldStart, oldEnd, newStart, newEnd, temp, zoneId) {
    const msg = {
      type: "gttc/update_entry",
      day, time_start: newStart, time_end: newEnd, target_temp: temp,
      old_time_start: oldStart, old_time_end: oldEnd,
    };
    if (zoneId) msg.zone_id = zoneId;
    const s = this._schedule;
    if (s.active_preset) msg.preset = s.active_preset;

    try {
      await this._hass.callWS(msg);
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to resize entry", err);
    }
  }

  // ── Conflict detection ────────────────────────────────────────────────────

  _checkConflicts() {
    const root = this.shadowRoot;
    const warning = root.getElementById("conflictWarning");
    if (!warning) return;

    const start = root.getElementById("editStart").value;
    const end = root.getElementById("editEnd").value;
    if (!start || !end) return;

    const e = this._editingEntry;
    const entries = this._getEntriesForDay(e.day);
    const startMin = timeToMinutes(start);
    let endMin = timeToMinutes(end);
    if (endMin <= startMin) endMin += 1440;

    const conflicts = [];
    for (const entry of entries) {
      // Skip the entry being edited
      if (!e.isNew && entry.time_start === e.entry.time_start && entry.time_end === e.entry.time_end) continue;

      let eStart = timeToMinutes(entry.time_start);
      let eEnd = timeToMinutes(entry.time_end);
      if (eEnd <= eStart) eEnd += 1440;

      if (startMin < eEnd && eStart < endMin) {
        conflicts.push(`${formatTime12(entry.time_start)} - ${formatTime12(entry.time_end)} (${entry.target_temp}\u00b0F)`);
      }
    }

    if (conflicts.length > 0) {
      warning.style.display = "block";
      warning.innerHTML = `<strong>Warning:</strong> Overlaps with: ${conflicts.join(", ")}`;
    } else {
      warning.style.display = "none";
    }
  }

  // ── Quick select ──────────────────────────────────────────────────────────

  _quickSelectDays(mode, containerId) {
    const container = this.shadowRoot.getElementById(containerId);
    if (!container) return;
    const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday"];
    const weekend = ["saturday", "sunday"];
    const sourceDay = this._copyingEntry ? this._copyingEntry.sourceDay : this._selectedDay;

    container.querySelectorAll("input[type='checkbox']").forEach(cb => {
      if (cb.disabled) return;
      const day = cb.value;
      if (mode === "weekdays") cb.checked = weekdays.includes(day);
      else if (mode === "weekend") cb.checked = weekend.includes(day);
      else if (mode === "all") cb.checked = true;
      else if (mode === "all_others") cb.checked = day !== sourceDay;

      // Update tracking sets
      const targetSet =
        containerId === "copyDayCheckboxes" ? this._copyTargetDays :
        containerId === "copyDayDayCheckboxes" ? this._copyDayTargetDays : null;
      if (targetSet) {
        if (cb.checked) targetSet.add(day);
        else targetSet.delete(day);
      }
    });
  }

  // ── Save entry ────────────────────────────────────────────────────────────

  async _saveEntry() {
    const root = this.shadowRoot;
    const start = root.getElementById("editStart").value;
    const end = root.getElementById("editEnd").value;
    const temp = parseFloat(root.getElementById("editTemp").value);
    const zoneSelect = root.getElementById("editZone");
    const zoneId = zoneSelect ? zoneSelect.value || undefined : undefined;
    const e = this._editingEntry;

    const msg = { type: "gttc/update_entry", day: e.day, time_start: start, time_end: end, target_temp: temp };
    if (zoneId) msg.zone_id = zoneId;
    if (!e.isNew && e.entry) {
      msg.old_time_start = e.entry.time_start;
      msg.old_time_end = e.entry.time_end;
    }
    if (this._schedule.active_preset) msg.preset = this._schedule.active_preset;

    try {
      const result = await this._hass.callWS(msg);
      // Show conflicts as a non-blocking notification
      if (result.conflicts && result.conflicts.length > 0) {
        const conflictMsg = result.conflicts.map(c =>
          `${formatTime12(c.time_start)}-${formatTime12(c.time_end)} (${c.target_temp}\u00b0F)`
        ).join(", ");
        console.warn("GTTC: Entry saved but overlaps with:", conflictMsg);
      }
      this._editingEntry = null;
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to save entry", err);
      alert("Failed to save: " + (err.message || err));
    }
  }

  async _saveBulkEntry() {
    const root = this.shadowRoot;
    const start = root.getElementById("editStart").value;
    const end = root.getElementById("editEnd").value;
    const temp = parseFloat(root.getElementById("editTemp").value);
    const zoneSelect = root.getElementById("editZone");
    const zoneId = zoneSelect ? zoneSelect.value || undefined : undefined;

    const container = root.getElementById("bulkDayCheckboxes");
    const days = [];
    if (container) {
      container.querySelectorAll("input[type='checkbox']:checked").forEach(cb => days.push(cb.value));
    }
    if (days.length === 0) { alert("Please select at least one day."); return; }

    const msg = { type: "gttc/bulk_add_entry", days, time_start: start, time_end: end, target_temp: temp };
    if (zoneId) msg.zone_id = zoneId;
    if (this._schedule.active_preset) msg.preset = this._schedule.active_preset;

    try {
      await this._hass.callWS(msg);
      this._editingEntry = null;
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to bulk add entry", err);
      alert("Failed to add: " + (err.message || err));
    }
  }

  // ── Copy entry ────────────────────────────────────────────────────────────

  async _executeCopy() {
    const entry = this._copyingEntry;
    if (!entry) return;
    const targetDays = Array.from(this._copyTargetDays);
    if (targetDays.length === 0) { alert("Please select at least one target day."); return; }

    const msg = {
      type: "gttc/copy_entry_to_days",
      source_day: entry.sourceDay, time_start: entry.entry.time_start,
      time_end: entry.entry.time_end, target_days: targetDays,
    };
    if (this._schedule.active_preset) msg.preset = this._schedule.active_preset;

    try {
      await this._hass.callWS(msg);
      this._showCopyModal = false;
      this._copyingEntry = null;
      this._copyTargetDays = new Set();
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to copy entry", err);
      alert("Failed to copy: " + (err.message || err));
    }
  }

  // ── Copy entire day ───────────────────────────────────────────────────────

  async _executeCopyDay() {
    const targetDays = Array.from(this._copyDayTargetDays);
    if (targetDays.length === 0) { alert("Please select at least one target day."); return; }

    const msg = {
      type: "gttc/copy_day", source_day: this._selectedDay, target_days: targetDays,
    };
    if (this._schedule.active_preset) msg.preset = this._schedule.active_preset;

    try {
      await this._hass.callWS(msg);
      this._showCopyDayModal = false;
      this._copyDayTargetDays = new Set();
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to copy day", err);
      alert("Failed to copy day: " + (err.message || err));
    }
  }

  // ── Delete entry ──────────────────────────────────────────────────────────

  async _deleteEntry(day, entry) {
    if (!confirm(`Delete ${formatTime12(entry.time_start)} - ${formatTime12(entry.time_end)} (${entry.target_temp}\u00b0F)?`)) return;
    const msg = { type: "gttc/delete_entry", day, time_start: entry.time_start, time_end: entry.time_end };
    if (this._schedule.active_preset) msg.preset = this._schedule.active_preset;

    try {
      await this._hass.callWS(msg);
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to delete entry", err);
      alert("Failed to delete: " + (err.message || err));
    }
  }

  // ── Preset / mode / override actions ──────────────────────────────────────

  async _setPreset(presetName) {
    try {
      if (presetName) {
        await this._hass.callService("gttc", "set_preset", { preset: presetName });
      } else {
        await this._hass.callWS({ type: "gttc/deactivate_preset" });
      }
      await new Promise(r => setTimeout(r, 500));
      await this._loadData();
    } catch (err) { console.error("GTTC: Failed to set preset", err); }
  }

  async _setScheduleMode(mode) {
    try {
      await this._hass.callWS({ type: "gttc/set_schedule_mode", mode });
      await new Promise(r => setTimeout(r, 300));
      await this._loadData();
    } catch (err) { console.error("GTTC: Failed to set schedule mode", err); }
  }

  async _cancelOverride() {
    try {
      await this._hass.callWS({ type: "gttc/cancel_override" });
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to cancel override", err);
      alert("Failed to cancel override: " + (err.message || err));
    }
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  async _undo() {
    try {
      await this._hass.callWS({ type: "gttc/undo_schedule" });
      await this._loadData();
    } catch (err) {
      if (err.code !== "nothing_to_undo") console.error("GTTC: Undo failed", err);
    }
  }

  async _redo() {
    try {
      await this._hass.callWS({ type: "gttc/redo_schedule" });
      await this._loadData();
    } catch (err) {
      if (err.code !== "nothing_to_redo") console.error("GTTC: Redo failed", err);
    }
  }

  // ── Custom preset actions ─────────────────────────────────────────────────

  async _executePresetAction() {
    const mode = this._presetModalMode;
    const target = this._presetModalTarget;

    if (mode === "create") {
      const input = this.shadowRoot.getElementById("presetNameInput");
      const label = input ? input.value.trim() : "";
      if (!label) { alert("Please enter a preset name."); return; }
      try {
        const result = await this._hass.callWS({ type: "gttc/create_custom_preset", label });
        this._showPresetModal = false;
        await this._loadData();
        // Auto-activate the new preset
        await this._setPreset(result.preset_name);
      } catch (err) {
        alert("Failed to create preset: " + (err.message || err));
      }
    } else if (mode === "rename") {
      const input = this.shadowRoot.getElementById("presetNameInput");
      const newLabel = input ? input.value.trim() : "";
      if (!newLabel) { alert("Please enter a name."); return; }
      try {
        await this._hass.callWS({ type: "gttc/rename_custom_preset", preset_name: target, new_label: newLabel });
        this._showPresetModal = false;
        await this._loadData();
      } catch (err) {
        alert("Failed to rename preset: " + (err.message || err));
      }
    } else if (mode === "delete") {
      try {
        await this._hass.callWS({ type: "gttc/delete_custom_preset", preset_name: target });
        this._showPresetModal = false;
        await this._loadData();
      } catch (err) {
        alert("Failed to delete preset: " + (err.message || err));
      }
    }
  }

  // ── Export / Import ───────────────────────────────────────────────────────

  async _exportSchedule() {
    try {
      const result = await this._hass.callWS({ type: "gttc/export_schedule" });
      this._exportData = JSON.stringify(result.data, null, 2);
      this._showExportModal = true;
      this._render();
    } catch (err) {
      alert("Failed to export: " + (err.message || err));
    }
  }

  _copyExportToClipboard() {
    const textarea = this.shadowRoot.getElementById("exportTextarea");
    if (textarea) {
      textarea.select();
      navigator.clipboard.writeText(textarea.value).then(() => {
        const btn = this.shadowRoot.getElementById("copyExport");
        if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy to Clipboard"; }, 2000); }
      }).catch(() => {
        // Fallback
        document.execCommand("copy");
      });
    }
  }

  async _executeImport() {
    const textarea = this.shadowRoot.getElementById("importTextarea");
    const errorEl = this.shadowRoot.getElementById("importError");
    if (!textarea) return;

    let data;
    try {
      data = JSON.parse(textarea.value.trim());
    } catch (err) {
      if (errorEl) { errorEl.style.display = "block"; errorEl.textContent = "Invalid JSON. Please check the format."; }
      return;
    }

    try {
      await this._hass.callWS({ type: "gttc/import_schedule", data });
      this._showImportModal = false;
      await this._loadData();
    } catch (err) {
      if (errorEl) { errorEl.style.display = "block"; errorEl.textContent = "Import failed: " + (err.message || err); }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _nowPercent() {
    const now = new Date();
    return ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
  }

  _contrastColor(bgColor) {
    return "rgba(255,255,255,0.95)";
  }

  // ── Styles ────────────────────────────────────────────────────────────────

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
      .panel { max-width: 1200px; margin: 0 auto; padding: 16px; color: var(--primary-text); }

      /* Header */
      .header {
        display: flex; align-items: center; justify-content: space-between;
        flex-wrap: wrap; gap: 12px; padding: 16px 0;
        border-bottom: 1px solid var(--divider); margin-bottom: 16px;
      }
      .header-left { display: flex; align-items: center; gap: 8px; }
      .header-icon { --mdc-icon-size: 28px; color: var(--primary); }
      .header h1 { margin: 0; font-size: 22px; font-weight: 500; }
      .header-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

      /* Status */
      .status-bar { display: flex; gap: 8px; align-items: center; }
      .status-item {
        font-size: 13px; background: var(--card-bg); padding: 4px 10px;
        border-radius: 12px; border: 1px solid var(--divider);
        display: flex; align-items: center; gap: 6px;
      }
      .status-item.override { background: #fff3e0; border-color: #ff9800; color: #e65100; }
      .btn-cancel-override {
        background: none; border: 1px solid #e65100; color: #e65100;
        border-radius: 50%; width: 20px; height: 20px; font-size: 12px;
        cursor: pointer; display: inline-flex; align-items: center;
        justify-content: center; padding: 0; line-height: 1;
      }
      .btn-cancel-override:hover { background: #e65100; color: #fff; }

      /* Undo/redo */
      .undo-redo { display: flex; gap: 4px; }

      /* Selects */
      .preset-select, .mode-select {
        padding: 6px 12px; border-radius: 8px; border: 1px solid var(--divider);
        background: var(--card-bg); color: var(--primary-text); font-size: 14px; cursor: pointer;
      }
      .preset-group, .toolbar-group { display: flex; align-items: center; gap: 4px; }

      /* Day tabs */
      .day-tabs { display: flex; gap: 4px; margin-bottom: 16px; }
      .day-tab {
        flex: 1; padding: 8px 4px; border: 1px solid var(--divider); border-radius: 8px;
        background: var(--card-bg); color: var(--primary-text); cursor: pointer;
        text-align: center; font-size: 14px; font-weight: 500; transition: all 0.15s;
      }
      .day-tab:hover, .day-tab.active { background: var(--primary); color: #fff; border-color: var(--primary); }

      /* Week overview */
      .week-overview {
        background: var(--card-bg); border-radius: 12px; padding: 16px;
        margin-bottom: 20px; border: 1px solid var(--divider);
      }
      .time-axis { position: relative; height: 20px; margin-left: 48px; margin-bottom: 4px; font-size: 11px; color: var(--secondary-text); }
      .time-mark { position: absolute; transform: translateX(-50%); }
      .week-row {
        display: flex; align-items: center; height: 36px; margin-bottom: 2px;
        cursor: pointer; border-radius: 6px; transition: background 0.1s;
      }
      .week-row:hover { background: rgba(0,0,0,0.04); }
      .week-row.selected { background: rgba(3,169,244,0.08); }
      .week-row-label { width: 48px; font-size: 13px; font-weight: 500; color: var(--secondary-text); flex-shrink: 0; text-align: right; padding-right: 8px; }
      .week-row-timeline { flex: 1; position: relative; height: 28px; background: var(--bg); border-radius: 4px; overflow: hidden; }

      /* Timeline blocks */
      .timeline-block {
        position: absolute; top: 2px; bottom: 2px; border-radius: 3px;
        display: flex; align-items: center; justify-content: center; gap: 4px;
        cursor: pointer; font-weight: 500; transition: filter 0.1s;
        overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.15); z-index: 1;
      }
      .timeline-block:hover { filter: brightness(1.1); z-index: 2; }
      .timeline-block.compact .block-temp { font-size: 11px; }
      .block-temp { font-size: 13px; font-weight: 600; text-shadow: 0 1px 2px rgba(0,0,0,0.3); }
      .block-time { font-size: 10px; opacity: 0.85; text-shadow: 0 1px 2px rgba(0,0,0,0.3); }

      /* Drag handles */
      .drag-handle {
        position: absolute; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 5;
      }
      .drag-handle-left { left: 0; }
      .drag-handle-right { right: 0; }
      .drag-handle:hover { background: rgba(255,255,255,0.3); }

      /* Now line */
      .now-line { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--error); z-index: 3; opacity: 0.7; }

      /* Day detail */
      .day-detail { background: var(--card-bg); border-radius: 12px; padding: 16px; border: 1px solid var(--divider); }
      .day-detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
      .day-detail h2 { margin: 0; font-size: 18px; font-weight: 500; }
      .day-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .day-timeline-container { position: relative; margin-bottom: 20px; }
      .day-timeline-hours { position: relative; height: 20px; font-size: 11px; color: var(--secondary-text); }
      .hour-mark { position: absolute; transform: translateX(-50%); }
      .hour-label { white-space: nowrap; }
      .day-timeline { position: relative; height: 48px; background: var(--bg); border-radius: 8px; overflow: hidden; margin-top: 4px; }
      .day-timeline .timeline-block { top: 4px; bottom: 4px; }
      .day-timeline .block-temp { font-size: 14px; }
      .day-timeline .block-time { font-size: 11px; }

      /* Entry cards */
      .entries-list { display: flex; flex-direction: column; gap: 8px; }
      .no-entries { color: var(--secondary-text); font-style: italic; text-align: center; padding: 20px; }
      .entry-card { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--divider); background: var(--bg); }
      .entry-color { width: 6px; height: 32px; border-radius: 3px; flex-shrink: 0; }
      .entry-info { flex: 1; display: flex; gap: 16px; align-items: center; }
      .entry-time { font-size: 14px; font-weight: 500; }
      .entry-temp { font-size: 16px; font-weight: 600; }
      .entry-zone { font-size: 12px; color: var(--secondary-text); background: var(--card-bg); padding: 2px 8px; border-radius: 10px; border: 1px solid var(--divider); }
      .entry-actions { display: flex; gap: 6px; }

      /* Buttons */
      .btn {
        padding: 8px 16px; border-radius: 8px; border: none;
        cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.15s;
      }
      .btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .btn-add { background: var(--primary); color: #fff; }
      .btn-add:hover { filter: brightness(0.9); }
      .btn-outline { background: transparent; color: var(--primary); border: 1px solid var(--primary); }
      .btn-outline:hover { background: var(--primary); color: #fff; }
      .btn-icon {
        padding: 6px; border-radius: 6px; background: transparent;
        border: 1px solid var(--divider); color: var(--primary-text); cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .btn-icon:hover:not(:disabled) { background: var(--primary); color: #fff; border-color: var(--primary); }
      .btn-icon ha-icon { --mdc-icon-size: 18px; }
      .btn-small { padding: 4px 8px; font-size: 14px; }
      .btn-sm { padding: 4px 10px; font-size: 12px; border-radius: 6px; }
      .btn-xs {
        padding: 3px 8px; font-size: 11px; border-radius: 4px;
        background: var(--bg); color: var(--primary-text); border: 1px solid var(--divider); cursor: pointer;
      }
      .btn-xs:hover { background: var(--primary); color: #fff; border-color: var(--primary); }
      .btn-edit { background: var(--primary); color: #fff; }
      .btn-copy { background: transparent; color: var(--primary); border: 1px solid var(--primary); }
      .btn-copy:hover { background: var(--primary); color: #fff; }
      .btn-delete { background: transparent; color: var(--error); border: 1px solid var(--error); }
      .btn-delete:hover { background: var(--error); color: #fff; }
      .btn-cancel { background: transparent; color: var(--primary-text); border: 1px solid var(--divider); }
      .btn-save { background: var(--primary); color: #fff; }
      .btn-danger { color: var(--error); border-color: var(--error); }
      .btn-danger:hover { background: var(--error); color: #fff; }
      .btn-danger-fill { background: var(--error); color: #fff; border: none; }
      .btn-danger-fill:hover { filter: brightness(0.9); }

      /* Modal */
      .modal-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5); display: flex; align-items: center;
        justify-content: center; z-index: 1000;
      }
      .modal {
        background: var(--card-bg); border-radius: 16px; padding: 24px;
        min-width: 340px; max-width: 460px; box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        max-height: 90vh; overflow-y: auto;
      }
      .modal-wide { max-width: 600px; min-width: 400px; }
      .modal h3 { margin: 0 0 16px; font-size: 18px; font-weight: 500; }
      .modal-hint { font-size: 13px; color: var(--secondary-text); margin: 0 0 12px; }
      .copy-info {
        font-size: 14px; color: var(--secondary-text); margin: 0 0 12px;
        padding: 8px 12px; background: var(--bg); border-radius: 8px; border: 1px solid var(--divider);
      }
      .form-row { margin-bottom: 14px; }
      .form-row label { display: block; font-size: 13px; font-weight: 500; color: var(--secondary-text); margin-bottom: 4px; }
      .form-row input[type="time"], .form-row input[type="number"], .form-row input[type="text"], .form-row select {
        width: 100%; padding: 8px 12px; border: 1px solid var(--divider); border-radius: 8px;
        font-size: 16px; background: var(--bg); color: var(--primary-text); box-sizing: border-box;
      }
      .zone-select { font-size: 14px; cursor: pointer; }
      .temp-input-row { display: flex; align-items: center; gap: 8px; }
      .temp-input-row input[type="range"] { flex: 1; }
      .temp-input-row input[type="number"] { width: 72px; flex: none; }
      .temp-unit { font-weight: 500; color: var(--secondary-text); }
      .temp-preview {
        margin-top: 8px; padding: 6px 12px; border-radius: 8px; text-align: center;
        font-weight: 600; font-size: 16px; color: rgba(255,255,255,0.95);
        text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      }
      .form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

      /* Conflict warning */
      .conflict-warning {
        background: #fff3e0; border: 1px solid #ff9800; border-radius: 8px;
        padding: 8px 12px; margin-top: 8px; font-size: 13px; color: #e65100;
      }

      /* Day checkboxes */
      .day-checkboxes { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }
      .day-checkbox-label {
        display: flex; align-items: center; gap: 8px; font-size: 14px;
        cursor: pointer; padding: 4px 8px; border-radius: 6px; transition: background 0.1s;
      }
      .day-checkbox-label:hover { background: var(--bg); }
      .day-checkbox-label input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; }
      .source-day { color: var(--secondary-text); font-style: italic; }
      .quick-select { display: flex; gap: 6px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--divider); }

      /* Export/import textarea */
      .export-textarea {
        width: 100%; min-height: 200px; padding: 12px; border: 1px solid var(--divider);
        border-radius: 8px; font-family: monospace; font-size: 12px; resize: vertical;
        background: var(--bg); color: var(--primary-text); box-sizing: border-box;
      }

      /* Responsive */
      @media (max-width: 600px) {
        .header { flex-direction: column; align-items: flex-start; }
        .entry-info { flex-direction: column; gap: 4px; }
        .day-tabs { flex-wrap: wrap; }
        .day-tab { min-width: 42px; }
        .day-actions { flex-direction: column; gap: 4px; }
        .entry-actions { flex-direction: column; gap: 4px; }
      }
    `;
  }
}

customElements.define("gttc-panel", GttcPanel);
