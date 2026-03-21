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
    // Status tab
    this._activeMainTab = "command";
    this._diagData = null;
    this._historyData = null;
    this._hvacHistory = null;
    this._statusLoading = false;
    this._debugExpanded = false;
    this._statusError = null;
    // Settings tab
    this._settingsData = null;
    this._settingsLoading = false;
    this._settingsError = null;
    this._configData = null;
    this._toast = null;
    this._toastTimer = null;
    // Zone management
    this._editingZoneId = null;
    this._zoneFormData = null;
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
      const [schedule, status, diagData, configData] = await Promise.all([
        this._hass.callWS({ type: "gttc/get_schedule" }),
        this._hass.callWS({ type: "gttc/get_status" }),
        this._hass.callWS({ type: "gttc/get_diagnostics" }).catch(() => null),
        this._hass.callWS({ type: "gttc/get_config" }).catch(() => null),
      ]);
      this._schedule = schedule;
      this._status = status;
      this._diagData = diagData;
      this._configData = configData;
      this._activePreset = schedule.active_preset;
      if (!this._selectedDay) {
        const today = DAYS_ORDERED[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
        this._selectedDay = today;
      }
      this._render();
      // Load history async (non-blocking) — only on first load or explicit refresh
      const entityId = diagData?.entity_ids?.active_zone_temp;
      const climateId = diagData?.entity_ids?.climate;
      if (entityId && !this._historyData) {
        const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        Promise.all([
          this._hass.callApi("GET",
            `history/period/${start}?filter_entity_id=${entityId}&minimal_response=true&no_attributes=true`
          ),
          climateId
            ? this._hass.callApi("GET", `history/period/${start}?filter_entity_id=${climateId}`)
            : Promise.resolve(null),
        ]).then(([tempResult, hvacResult]) => {
          this._historyData = tempResult?.[0] || [];
          this._hvacHistory = hvacResult?.[0] || [];
          this._render();
        }).catch(() => {
          this._historyData = [];
          this._hvacHistory = [];
        });
      }
    } catch (err) {
      console.error("GTTC: Failed to load data", err);
      this.shadowRoot.innerHTML = `
        <div style="padding:24px;color:var(--primary-text-color,#333)">
          <h2>GTTC</h2>
          <p style="color:var(--error-color,#c00)">Failed to load data. Make sure GTTC is configured.</p>
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
            <h1>GTTC</h1>
          </div>
          <div class="header-right">
            ${this._renderStatus()}
          </div>
        </header>

        ${this._renderMainTabBar()}

        <div class="content">
          ${this._activeMainTab === "command"
            ? this._renderCommandCenterTab()
            : this._renderSettingsTab()
          }
        </div>

        ${this._editingEntry ? this._renderEditModal() : ""}
        ${this._showCopyModal ? this._renderCopyModal() : ""}
        ${this._showCopyDayModal ? this._renderCopyDayModal() : ""}
        ${this._showPresetModal ? this._renderPresetModal() : ""}
        ${this._showExportModal ? this._renderExportModal() : ""}
        ${this._showImportModal ? this._renderImportModal() : ""}
        ${this._toast ? this._renderToast() : ""}
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
    if (st.windows_open) {
      parts.push(`<span class="status-item windows-open"><ha-icon icon="mdi:window-open-variant"></ha-icon> Windows open</span>`);
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
                ${this._renderOnPeakOverlay(day)}
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
            ${this._renderOnPeakOverlay(day)}
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

    // Main tab bar
    root.querySelectorAll(".main-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.mainTab;
        if (tab === this._activeMainTab) return;
        this._activeMainTab = tab;
        if (tab !== "settings") {
          this._editingZoneId = null;
          this._zoneFormData = null;
        }
        if (tab === "settings") {
          this._loadSettingsData();
        } else {
          this._render();
        }
      });
    });

    // Command center refresh
    this._addClick("statusRefreshBtn", () => {
      this._historyData = null;
      this._hvacHistory = null;
      this._loadData();
    });

    // Automation toggles
    root.querySelectorAll(".automation-toggle").forEach(toggle => {
      toggle.addEventListener("change", () => {
        this._handleAutomationToggle(toggle.dataset.toggleId, toggle.checked);
      });
    });

    // Active zone quick selector
    const activeZoneSelect = root.getElementById("activeZoneSelect");
    if (activeZoneSelect) {
      activeZoneSelect.addEventListener("change", async () => {
        try {
          await this._hass.callWS({ type: "gttc/set_active_zone", zone_id: activeZoneSelect.value });
          await this._loadData();
        } catch (err) { this._showToast("Failed to change zone.", "error"); }
      });
    }

    // "Manage in Settings" link
    this._addClick("goToWindowSettings", () => {
      this._activeMainTab = "settings";
      this._loadSettingsData();
    });

    this._attachSettingsListeners();

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

  // ── Command Center ────────────────────────────────────────────────────────

  _renderCommandCenterTab() {
    if (!this._schedule) {
      return `<div class="status-loading"><ha-icon icon="mdi:loading"></ha-icon> Loading...</div>`;
    }
    const d = this._diagData;
    return `
      <div class="command-center">
        ${d ? this._renderStatCards(d) : ""}
        <div class="cc-main-row">
          ${this._renderAutomationToggles()}
          ${this._renderQuickPanel()}
        </div>
        ${this._renderTempChart()}
        <div class="schedule-section">
          <div class="schedule-section-header">
            <div class="section-label"><ha-icon icon="mdi:calendar-clock"></ha-icon> Schedule</div>
            <div class="schedule-controls-row">
              ${this._renderUndoRedo()}
              ${this._renderScheduleMode()}
              ${this._renderPresetSelector()}
              ${this._renderToolbar()}
            </div>
          </div>
          <div class="schedule-section-body">
            <div class="day-tabs">
              ${DAYS_ORDERED.map(day => `
                <button class="day-tab ${day === this._selectedDay ? "active" : ""}" data-day="${day}">
                  <span class="day-short">${DAY_LABELS[day]}</span>
                </button>
              `).join("")}
            </div>
            <div class="schedule-view">
              ${this._renderWeekOverview()}
              ${this._renderDayDetail()}
            </div>
          </div>
        </div>
        <div class="cc-footer">
          <button class="btn btn-outline" id="statusRefreshBtn">
            <ha-icon icon="mdi:refresh"></ha-icon> Refresh
          </button>
          ${d ? `<span class="status-updated">Updated ${new Date().toLocaleTimeString()}</span>` : ""}
        </div>
      </div>
    `;
  }

  _renderAutomationToggles() {
    const d = this._diagData;
    const cfg = this._configData;
    const f = d?.features || {};
    const windows = d?.windows || {};

    const toggles = [
      {
        id: "schedule",
        icon: "mdi:calendar-check",
        label: "Schedule",
        desc: "Follow temperature time blocks",
        enabled: d?.schedule_enabled ?? false,
        badge: null,
      },
      {
        id: "learning",
        icon: "mdi:brain",
        label: "Learning",
        desc: "Auto-adapt from repeated changes",
        enabled: d?.learning?.enabled ?? cfg?.learning_enabled ?? false,
        badge: d?.learning?.patterns_learned > 0 ? `${d.learning.patterns_learned} patterns` : null,
        badgeType: "neutral",
      },
      {
        id: "occupancy",
        icon: "mdi:account-check",
        label: "Presence",
        desc: "Away temp when no one is home",
        enabled: cfg?.occupancy_enabled ?? false,
        badge: f.presence_home != null ? (f.presence_home ? "Home" : "Away") : null,
        badgeType: f.presence_home ? "success" : "warn",
      },
      {
        id: "tou",
        icon: "mdi:lightning-bolt-circle",
        label: "TOU Optimization",
        desc: "Shift setpoint during peak rate hours",
        enabled: f.tou_enabled ?? cfg?.tou_enabled ?? false,
        badge: f.tou_enabled && f.tou_rate ? this._touRateLabel(f.tou_rate) : null,
        badgeType: this._touRateBadgeType(f.tou_rate),
      },
      {
        id: "precondition",
        icon: "mdi:weather-partly-cloudy",
        label: "Pre-conditioning",
        desc: "Ramp toward next schedule entry early",
        enabled: f.precondition_enabled ?? cfg?.precondition_enabled ?? false,
        badge: f.precondition_active ? "Active" : null,
        badgeType: "success",
      },
      {
        id: "windows",
        icon: "mdi:window-open-variant",
        label: "Windows Suspend",
        desc: "Pause HVAC when windows open",
        enabled: windows.manual_override ?? false,
        badge: windows.open
          ? `${windows.open_sensors?.length ?? 1} open`
          : (windows.sensors?.length > 0 ? "All closed" : null),
        badgeType: windows.open ? "warn" : "success",
      },
    ];

    return `
      <div class="automation-panel">
        <div class="panel-title"><ha-icon icon="mdi:tune"></ha-icon> Automation Controls</div>
        <div class="toggle-grid">
          ${toggles.map(t => `
            <div class="toggle-card ${t.enabled ? "toggle-card-on" : "toggle-card-off"}">
              <div class="toggle-icon-wrap ${t.enabled ? "icon-active" : "icon-idle"}">
                <ha-icon icon="${t.icon}"></ha-icon>
              </div>
              <div class="toggle-card-body">
                <div class="toggle-card-label">${t.label}</div>
                <div class="toggle-card-desc">${t.desc}</div>
                ${t.badge ? `<span class="toggle-badge badge-${t.badgeType || "neutral"}">${t.badge}</span>` : ""}
              </div>
              <label class="toggle-switch">
                <input type="checkbox" class="automation-toggle" data-toggle-id="${t.id}" ${t.enabled ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  _renderQuickPanel() {
    const d = this._diagData;
    const sc = this._schedule;
    if (!d && !sc) return "";
    const zones = sc?.zones || [];
    const f = d?.features || {};

    return `
      <div class="quick-panel">
        ${zones.length > 1 ? `
          <div class="qp-section">
            <div class="qp-label">Active Zone</div>
            <select class="qp-select" id="activeZoneSelect">
              ${zones.map(z => `
                <option value="${z.id}" ${z.is_active ? "selected" : ""}>${z.name}</option>
              `).join("")}
            </select>
          </div>
        ` : ""}
        ${d?.override_active ? `
          <div class="override-banner">
            <ha-icon icon="mdi:clock-edit"></ha-icon>
            <div class="override-info">
              <span class="override-label">Override Active</span>
              <span class="override-sub">${d.override_target_temp}° &middot; ${d.override_remaining_minutes}m left</span>
            </div>
            <button class="btn-cancel-override" id="cancelOverrideBtn" title="Cancel">&#x2715;</button>
          </div>
        ` : ""}
        ${d?.zones?.length > 0 ? `
          <div class="qp-section">
            <div class="qp-label">Zone Temperatures</div>
            <div class="mini-zones">
              ${d.zones.map(z => `
                <div class="mini-zone ${z.is_active ? "mini-zone-active" : ""}">
                  <span class="mz-dot">${z.is_active ? "&#9679;" : "&#9675;"}</span>
                  <span class="mz-name">${z.name}</span>
                  ${z.is_occupied != null ? `<span class="mz-occ ${z.is_occupied ? "occ-yes" : ""}">${z.is_occupied ? "occ" : ""}</span>` : ""}
                  <span class="mz-temp">${z.current_temp != null ? z.current_temp.toFixed(1) + "°" : "—"}</span>
                </div>
              `).join("")}
            </div>
          </div>
        ` : ""}
        ${f.tou_enabled && f.tou_rate ? `
          <div class="qp-section">
            <div class="qp-label">Current Rate Period</div>
            <div class="tou-rate-row">
              <span class="tou-rate-badge badge-${this._touRateBadgeType(f.tou_rate)}">${this._touRateLabel(f.tou_rate)}</span>
              ${f.precondition_active ? `<span class="tou-note">Pre-conditioning active</span>` : ""}
            </div>
          </div>
        ` : ""}
        ${d ? `
          <div class="qp-section">
            <div class="qp-label">System</div>
            <table class="sys-table">
              <tr><td class="sys-label">Outdoor</td><td class="sys-val">${f.outdoor_temp != null ? f.outdoor_temp.toFixed(1) + "°" : "—"}</td></tr>
              <tr><td class="sys-label">Heat pump</td><td class="sys-val">${f.heat_pump_detected ? "Yes" : "No"}</td></tr>
              <tr><td class="sys-label">Presence</td><td class="sys-val">${f.presence_home != null ? (f.presence_home ? "Home" : "Away") : "—"}</td></tr>
            </table>
          </div>
        ` : ""}
        ${d?.windows?.sensors?.length > 0 ? `
          <div class="qp-section">
            <div class="qp-label">Windows</div>
            <div class="win-status ${d.windows.open ? "win-open" : "win-closed"}">
              <ha-icon icon="${d.windows.open ? "mdi:window-open-variant" : "mdi:window-closed-variant"}"></ha-icon>
              <span>${d.windows.open ? `${d.windows.open_sensors.length} open` : "All closed"}</span>
              ${d.windows.open ? `<span class="win-badge">HVAC paused</span>` : ""}
            </div>
            <div style="margin-top:8px">
              <button class="btn btn-outline btn-sm" id="goToWindowSettings">
                <ha-icon icon="mdi:cog"></ha-icon> Manage
              </button>
            </div>
          </div>
        ` : ""}
      </div>
    `;
  }

  _touRateLabel(rate) {
    if (rate === "on_peak") return "On-Peak";
    if (rate === "super_off_peak") return "Super Off-Peak";
    return "Off-Peak";
  }

  _touRateBadgeType(rate) {
    if (rate === "on_peak") return "danger";
    if (rate === "super_off_peak") return "info";
    return "success";
  }

  async _handleAutomationToggle(toggleId, enabled) {
    const labels = {
      schedule: "Schedule", learning: "Learning", occupancy: "Presence",
      tou: "TOU optimization", precondition: "Pre-conditioning", windows: "Windows suspend",
    };
    const label = labels[toggleId] || toggleId;
    try {
      switch (toggleId) {
        case "schedule":
          await this._hass.callService("switch", enabled ? "turn_on" : "turn_off", { entity_id: "switch.gttc_schedule" });
          break;
        case "learning":
          await this._hass.callWS({ type: "gttc/set_config", learning_enabled: enabled });
          break;
        case "occupancy":
          await this._hass.callWS({ type: "gttc/set_config", occupancy_enabled: enabled });
          break;
        case "tou":
          await this._hass.callWS({ type: "gttc/set_config", tou_enabled: enabled });
          break;
        case "precondition":
          await this._hass.callWS({ type: "gttc/set_config", precondition_enabled: enabled });
          break;
        case "windows":
          await this._hass.callService("switch", enabled ? "turn_on" : "turn_off", { entity_id: "switch.gttc_windows_open" });
          break;
      }
      this._showToast(`${label} ${enabled ? "enabled" : "disabled"}.`);
      await this._loadData();
    } catch (err) {
      this._showToast(`Failed to update: ${err.message || err}`, "error");
      this._render();
    }
  }

  // ── Main tab bar ──────────────────────────────────────────────────────────

  _renderMainTabBar() {
    return `
      <div class="main-tab-bar">
        <button class="main-tab ${this._activeMainTab === "command" ? "active" : ""}" data-main-tab="command">
          <ha-icon icon="mdi:view-dashboard"></ha-icon> Command Center
        </button>
        <button class="main-tab ${this._activeMainTab === "settings" ? "active" : ""}" data-main-tab="settings">
          <ha-icon icon="mdi:cog"></ha-icon> Settings
        </button>
      </div>
    `;
  }

  // ── Status tab ────────────────────────────────────────────────────────────

  _renderStatusTab() {
    if (this._statusLoading) {
      return `<div class="status-loading"><ha-icon icon="mdi:loading"></ha-icon> Loading...</div>`;
    }
    if (!this._diagData) {
      return `
        <div class="status-error-box">
          <div class="status-error-msg">
            <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
            ${this._statusError
              ? `Failed to load: <code>${this._statusError}</code><br><small>If this says "unknown_command", restart Home Assistant to register the new API endpoint.</small>`
              : "No data available."}
          </div>
          <button class="btn btn-outline" id="statusRefreshBtn">Retry</button>
        </div>`;
    }
    const d = this._diagData;
    return `
      <div class="status-tab">
        ${this._renderStatCards(d)}
        ${this._renderTempChart()}
        <div class="status-row-2">
          ${this._renderZonesCard(d)}
          ${this._renderSystemCard(d)}
        </div>
        ${this._renderWindowCard(d)}
        ${this._renderDebugCard(d)}
        <div class="status-footer">
          <button class="btn btn-outline" id="statusRefreshBtn">
            <ha-icon icon="mdi:refresh"></ha-icon> Refresh
          </button>
          <span class="status-updated">Updated ${new Date().toLocaleTimeString()}</span>
        </div>
      </div>
    `;
  }

  _renderStatCards(d) {
    const hvacIcon = d.hvac_action === "heating" ? "mdi:fire" : d.hvac_action === "cooling" ? "mdi:snowflake" : "mdi:thermometer-check";
    const hvacLabel = d.hvac_action ? (d.hvac_action.charAt(0).toUpperCase() + d.hvac_action.slice(1)) : "—";
    const hvacClass = d.hvac_action === "heating" ? "heating" : d.hvac_action === "cooling" ? "cooling" : "";

    const schedEntry = d.current_entry;
    const entryLabel = schedEntry
      ? `${this._fmt12(schedEntry.time_start)}–${this._fmt12(schedEntry.time_end)} @ ${schedEntry.target_temp}°`
      : "No active entry";

    return `
      <div class="stat-cards">
        <div class="stat-card">
          <div class="stat-icon"><ha-icon icon="mdi:thermometer"></ha-icon></div>
          <div class="stat-body">
            <div class="stat-label">Zone Temp</div>
            <div class="stat-value">${d.current_temp != null ? d.current_temp.toFixed(1) + "°" : "—"}</div>
            <div class="stat-sub">${d.active_zone_name || "—"}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon"><ha-icon icon="mdi:target"></ha-icon></div>
          <div class="stat-body">
            <div class="stat-label">Goal</div>
            <div class="stat-value">${d.target_temp != null ? d.target_temp.toFixed(1) + "°" : "—"}</div>
            <div class="stat-sub">${d.override_active ? `Override · ${d.override_remaining_minutes}m left` : (d.schedule_enabled ? "Schedule" : "Manual")}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon ${hvacClass}"><ha-icon icon="${hvacIcon}"></ha-icon></div>
          <div class="stat-body">
            <div class="stat-label">HVAC</div>
            <div class="stat-value stat-value-md ${hvacClass}">${hvacLabel}</div>
            <div class="stat-sub">${d.thermostat_action ? "T-stat: " + d.thermostat_action : ""}</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon"><ha-icon icon="mdi:calendar-check"></ha-icon></div>
          <div class="stat-body">
            <div class="stat-label">Schedule</div>
            <div class="stat-value stat-value-sm">${entryLabel}</div>
            <div class="stat-sub">${d.schedule_enabled ? "Active" : "Disabled"}</div>
          </div>
        </div>
      </div>
    `;
  }

  _renderTempChart() {
    const hist = this._historyData;

    if (!hist || hist.length === 0) {
      return `
        <div class="chart-card">
          <div class="chart-title">Temperature — last 24h</div>
          <div class="chart-empty">No history data available</div>
        </div>
      `;
    }

    const points = hist
      .filter(p => p.state !== "unavailable" && p.state !== "unknown" && !isNaN(parseFloat(p.state)))
      .map(p => ({ t: new Date(p.last_changed).getTime(), v: parseFloat(p.state) }))
      .sort((a, b) => a.t - b.t);

    if (points.length < 2) {
      return `<div class="chart-card"><div class="chart-title">Temperature — last 24h</div><div class="chart-empty">Not enough data</div></div>`;
    }

    const W = 800, H = 200, PAD = { top: 12, right: 16, bottom: 28, left: 40 };
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;

    const tMin = points[0].t, tMax = points[points.length - 1].t;

    const goalSteps = this._buildScheduleGoalSteps(tMin, tMax);

    const goalTemps = goalSteps.map(s => s.temp);
    const temps = points.map(p => p.v).concat(goalTemps);
    const vMin = Math.floor(Math.min(...temps) - 1);
    const vMax = Math.ceil(Math.max(...temps) + 1);

    const xScale = t => PAD.left + ((t - tMin) / (tMax - tMin)) * innerW;
    const yScale = v => PAD.top + (1 - (v - vMin) / (vMax - vMin)) * innerH;

    // Area fill path (always primary color gradient)
    const mainPathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`).join(" ");
    const areaD = mainPathD + ` L${xScale(tMax).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${xScale(tMin).toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`;

    // Build HVAC state lookup from history (binary search by timestamp)
    const hvacPts = (this._hvacHistory || [])
      .filter(p => p.state !== "unavailable" && p.state !== "unknown")
      .map(p => ({ t: new Date(p.last_changed).getTime(), action: p.attributes?.hvac_action || "idle" }))
      .sort((a, b) => a.t - b.t);

    const getHvacAction = (ts) => {
      let lo = 0, hi = hvacPts.length - 1, result = "idle";
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (hvacPts[mid].t <= ts) { result = hvacPts[mid].action; lo = mid + 1; }
        else hi = mid - 1;
      }
      return result;
    };

    // Split actual temp line into colored segments by HVAC state
    const COLOR_IDLE = "var(--primary-color,#03a9f4)";
    const COLOR_HEATING = "#f57c00";
    const COLOR_COOLING = "#0288d1";
    const getLineColor = (action) => action === "heating" ? COLOR_HEATING : action === "cooling" ? COLOR_COOLING : COLOR_IDLE;

    let actualLineSvg;
    let hvacHasHeating = false, hvacHasCooling = false;
    if (hvacPts.length > 0) {
      // Group consecutive points sharing the same HVAC action
      const colorSegs = [];
      let segStart = 0;
      let curAction = getHvacAction(points[0].t);
      for (let i = 1; i < points.length; i++) {
        const a = getHvacAction(points[i].t);
        if (a !== curAction) {
          colorSegs.push({ from: segStart, to: i, action: curAction });
          segStart = i; curAction = a;
        }
      }
      colorSegs.push({ from: segStart, to: points.length - 1, action: curAction });

      hvacHasHeating = colorSegs.some(s => s.action === "heating");
      hvacHasCooling = colorSegs.some(s => s.action === "cooling");

      actualLineSvg = colorSegs.map(seg => {
        const pts = points.slice(seg.from, seg.to + 1);
        if (pts.length < 2) {
          const p = pts[0];
          return `<circle cx="${xScale(p.t).toFixed(1)}" cy="${yScale(p.v).toFixed(1)}" r="2" fill="${getLineColor(seg.action)}"/>`;
        }
        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`).join(" ");
        return `<path d="${d}" fill="none" stroke="${getLineColor(seg.action)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      }).join("");
    } else {
      actualLineSvg = `<path d="${mainPathD}" fill="none" stroke="${COLOR_IDLE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }

    // Build on-peak time intervals [tStart_ms, tEnd_ms]
    const onPeakIntervals = [];
    if (this._configData?.tou_enabled && this._configData?.tou_provider === "dominion_virginia") {
      const SUMMER_MONTHS = new Set([5, 6, 7, 8, 9]);
      for (let dayOffset = -1; dayOffset <= 0; dayOffset++) {
        const opDate = new Date();
        opDate.setDate(opDate.getDate() + dayOffset);
        opDate.setHours(0, 0, 0, 0);
        const dow = opDate.getDay();
        if (dow === 0 || dow === 6) continue;
        const isSummer = SUMMER_MONTHS.has(opDate.getMonth() + 1);
        const windows = isSummer ? [{ h: 15, eh: 18 }] : [{ h: 6, eh: 9 }, { h: 17, eh: 20 }];
        for (const w of windows) {
          const wStart = new Date(opDate); wStart.setHours(w.h, 0, 0, 0);
          const wEnd = new Date(opDate); wEnd.setHours(w.eh, 0, 0, 0);
          onPeakIntervals.push([wStart.getTime(), wEnd.getTime()]);
        }
      }
    }
    const isOnPeakTime = (t) => onPeakIntervals.some(([s, e]) => t >= s && t < e);

    // Split goal step-function into on-peak/off-peak colored segments
    let goalLineSvg = "";
    let hasOnPeakGoal = false;
    if (goalSteps.length > 0) {
      const goalPaths = [];
      for (const step of goalSteps) {
        // Collect sub-interval boundaries within this step from on-peak windows
        const bounds = new Set([step.tStart, step.tEnd]);
        for (const [opS, opE] of onPeakIntervals) {
          if (opS > step.tStart && opS < step.tEnd) bounds.add(opS);
          if (opE > step.tStart && opE < step.tEnd) bounds.add(opE);
        }
        const bArr = [...bounds].sort((a, b) => a - b);
        for (let i = 0; i < bArr.length - 1; i++) {
          const tS = bArr[i], tE = bArr[i + 1];
          const onPeak = isOnPeakTime((tS + tE) / 2);
          if (onPeak) hasOnPeakGoal = true;
          const x1 = xScale(tS).toFixed(1), x2 = xScale(tE).toFixed(1);
          const y = yScale(step.temp).toFixed(1);
          if (onPeak) {
            goalPaths.push(`<path d="M${x1},${y} L${x2},${y}" fill="none" stroke="#e53935" stroke-width="2.5" stroke-dasharray="6,4" opacity="0.95"/>`);
          } else {
            goalPaths.push(`<path d="M${x1},${y} L${x2},${y}" fill="none" stroke="var(--success-color,#43a047)" stroke-width="2" stroke-dasharray="6,4" opacity="0.9"/>`);
          }
        }
      }
      // Vertical connectors between adjacent steps
      for (let i = 0; i < goalSteps.length - 1; i++) {
        const curr = goalSteps[i], next = goalSteps[i + 1];
        if (Math.abs(curr.tEnd - next.tStart) < 60000) {
          const x = xScale(curr.tEnd).toFixed(1);
          const onPeak = isOnPeakTime(curr.tEnd);
          goalPaths.push(`<line x1="${x}" y1="${yScale(curr.temp).toFixed(1)}" x2="${x}" y2="${yScale(next.temp).toFixed(1)}" stroke="${onPeak ? "#e53935" : "var(--success-color,#43a047)"}" stroke-width="1.5" opacity="0.7"/>`);
        }
      }
      goalLineSvg = goalPaths.join("");
    }

    // Y-axis ticks
    const yTicks = [];
    const step = (vMax - vMin) <= 6 ? 1 : 2;
    for (let v = Math.ceil(vMin / step) * step; v <= vMax; v += step) {
      yTicks.push(v);
    }

    // X-axis ticks (every 4h)
    const xTicks = [];
    const startHour = new Date(tMin);
    startHour.setMinutes(0, 0, 0);
    startHour.setHours(startHour.getHours() + (startHour.getTime() < tMin ? 1 : 0));
    for (let t = startHour.getTime(); t <= tMax; t += 4 * 3600 * 1000) {
      if (t >= tMin && t <= tMax) xTicks.push(t);
    }

    return `
      <div class="chart-card">
        <div class="chart-title">
          Zone Temperature — last 24h
          <span class="chart-legend"><span class="legend-dot actual"></span> Actual</span>
          ${goalSteps.length > 0 ? `<span class="chart-legend"><span class="legend-dot goal"></span> Schedule goal</span>` : ""}
          ${hasOnPeakGoal ? `<span class="chart-legend"><span class="legend-dot on-peak"></span> On-Peak goal</span>` : ""}
          ${hvacHasHeating ? `<span class="chart-legend"><span class="legend-dot hvac-heat"></span> Heating</span>` : ""}
          ${hvacHasCooling ? `<span class="chart-legend"><span class="legend-dot hvac-cool"></span> Cooling</span>` : ""}
        </div>
        <svg class="temp-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <defs>
            <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--primary-color,#03a9f4)" stop-opacity="0.25"/>
              <stop offset="100%" stop-color="var(--primary-color,#03a9f4)" stop-opacity="0.02"/>
            </linearGradient>
          </defs>
          <!-- Grid lines -->
          ${yTicks.map(v => `
            <line x1="${PAD.left}" y1="${yScale(v).toFixed(1)}" x2="${PAD.left + innerW}" y2="${yScale(v).toFixed(1)}"
                  stroke="var(--divider-color,#e0e0e0)" stroke-width="1"/>
            <text x="${PAD.left - 6}" y="${(yScale(v) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--secondary-text-color,#727272)">${v}°</text>
          `).join("")}
          <!-- Area fill -->
          <path d="${areaD}" fill="url(#areaGrad)"/>
          <!-- Schedule goal (green off-peak, red on-peak) -->
          ${goalLineSvg}
          <!-- Actual temp line (colored by HVAC state) -->
          ${actualLineSvg}
          <!-- X-axis ticks -->
          ${xTicks.map(t => {
            const x = xScale(t).toFixed(1);
            const d = new Date(t);
            const h = d.getHours();
            const label = h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? h + "a" : (h - 12) + "p";
            return `
              <line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${PAD.top + innerH}" stroke="var(--divider-color,#e0e0e0)" stroke-width="0.5" opacity="0.5"/>
              <text x="${x}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--secondary-text-color,#727272)">${label}</text>
            `;
          }).join("")}
          <!-- Border -->
          <rect x="${PAD.left}" y="${PAD.top}" width="${innerW}" height="${innerH}" fill="none" stroke="var(--divider-color,#e0e0e0)" stroke-width="1"/>
        </svg>
      </div>
    `;
  }

  _getOnPeakWindows(day) {
    const cfg = this._configData;
    if (!cfg?.tou_enabled || cfg?.tou_provider !== "dominion_virginia") return [];
    if (["saturday", "sunday"].includes(day)) return [];
    const SUMMER_MONTHS = new Set([5, 6, 7, 8, 9]);
    const isSummer = SUMMER_MONTHS.has(new Date().getMonth() + 1);
    return isSummer
      ? [{ start: 15 * 60, end: 18 * 60 }]
      : [{ start: 6 * 60, end: 9 * 60 }, { start: 17 * 60, end: 20 * 60 }];
  }

  _renderOnPeakOverlay(day) {
    const windows = this._getOnPeakWindows(day);
    if (!windows.length) return "";
    return windows.map(w => {
      const leftPct = ((w.start / 1440) * 100).toFixed(2);
      const widthPct = (((w.end - w.start) / 1440) * 100).toFixed(2);
      return `<div class="on-peak-band" style="left:${leftPct}%;width:${widthPct}%" title="On-Peak hours"></div>`;
    }).join("");
  }

  _buildScheduleGoalSteps(tMin, tMax) {
    // Returns [{tStart, tEnd, temp, zone_id}] segments from schedule entries
    // covering the [tMin, tMax] window, sorted by tStart.
    const s = this._schedule;
    if (!s) return [];

    const steps = [];

    // Check yesterday and today to cover the full 24h window
    for (let dayOffset = -1; dayOffset <= 0; dayOffset++) {
      const date = new Date();
      date.setDate(date.getDate() + dayOffset);
      date.setHours(0, 0, 0, 0);

      const dow = date.getDay(); // 0=Sun
      const dayName = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][dow];
      const isWeekend = dow === 0 || dow === 6;

      let entries;
      if (s.active_preset && s.presets[s.active_preset]) {
        entries = s.presets[s.active_preset].schedule[dayName] || [];
      } else if (s.mode === "per_day") {
        entries = (s.per_day && s.per_day[dayName]) || [];
      } else {
        entries = isWeekend ? (s.weekend || []) : (s.weekday || []);
      }

      for (const entry of entries) {
        const [sh, sm] = entry.time_start.split(":").map(Number);
        const [eh, em] = entry.time_end.split(":").map(Number);

        const entryStart = new Date(date);
        entryStart.setHours(sh, sm, 0, 0);
        const entryEnd = new Date(date);
        entryEnd.setHours(eh, em, 0, 0);

        // Handle overnight entries
        if (entryEnd.getTime() <= entryStart.getTime()) {
          entryEnd.setDate(entryEnd.getDate() + 1);
        }

        const eStart = entryStart.getTime();
        const eEnd = entryEnd.getTime();

        // Only include if it overlaps with our window
        if (eStart < tMax && eEnd > tMin) {
          steps.push({
            tStart: Math.max(eStart, tMin),
            tEnd: Math.min(eEnd, tMax),
            temp: entry.target_temp,
            zone_id: entry.zone_id || null,
          });
        }
      }
    }

    return steps.sort((a, b) => a.tStart - b.tStart);
  }

  _renderZonesCard(d) {
    return `
      <div class="status-card">
        <div class="status-card-title"><ha-icon icon="mdi:home-thermometer"></ha-icon> Zones</div>
        ${d.zones.map(z => `
          <div class="zone-row ${z.is_active ? "zone-active" : ""}">
            <span class="zone-indicator">${z.is_active ? "●" : "○"}</span>
            <span class="zone-name">${z.name}</span>
            <span class="zone-temp">${z.current_temp != null ? z.current_temp.toFixed(1) + "°" : "—"}</span>
            ${z.is_occupied != null ? `<span class="zone-occ">${z.is_occupied ? "occupied" : "vacant"}</span>` : ""}
          </div>
        `).join("")}
      </div>
    `;
  }

  _renderSystemCard(d) {
    const f = d.features;
    const rows = [
      ["Learning", d.learning.enabled ? `${d.learning.events_recorded} events · ${d.learning.patterns_learned} patterns` : "Disabled"],
      ["Presence", f.presence_home != null ? (f.presence_home ? "Home" : "Away") : "—"],
      ["Outdoor", f.outdoor_temp != null ? f.outdoor_temp.toFixed(1) + "°" : "—"],
      ["TOU", f.tou_enabled ? (f.tou_rate || "on") : "Disabled"],
      ["Pre-cond", f.precondition_enabled ? (f.precondition_active ? "Active" : "Standby") : "Disabled"],
      ["Heat pump", f.heat_pump_detected ? "Yes" : "No"],
    ];
    return `
      <div class="status-card">
        <div class="status-card-title"><ha-icon icon="mdi:cog"></ha-icon> System</div>
        <table class="sys-table">
          ${rows.map(([label, val]) => `
            <tr><td class="sys-label">${label}</td><td class="sys-val">${val}</td></tr>
          `).join("")}
        </table>
      </div>
    `;
  }

  _renderDebugCard(d) {
    const exp = this._debugExpanded;
    return `
      <div class="debug-card">
        <button class="debug-toggle" id="debugToggleBtn">
          <ha-icon icon="mdi:${exp ? "chevron-down" : "chevron-right"}"></ha-icon>
          Debug Info
        </button>
        ${exp ? `
          <div class="debug-body">
            <div class="debug-grid">
              <div class="debug-section">
                <div class="debug-section-title">Thermostat</div>
                <div class="debug-row"><span>Entity</span><span class="debug-val mono">${d.thermostat_entity}</span></div>
                <div class="debug-row"><span>T-stat reads</span><span class="debug-val">${d.thermostat_temp != null ? d.thermostat_temp.toFixed(1) + "°" : "—"}</span></div>
                <div class="debug-row"><span>Setpoint sent</span><span class="debug-val">${d.thermostat_setpoint != null ? d.thermostat_setpoint + "°" : "—"}</span></div>
                <div class="debug-row"><span>T-stat action</span><span class="debug-val">${d.thermostat_action || "—"}</span></div>
              </div>
              <div class="debug-section">
                <div class="debug-section-title">Override</div>
                <div class="debug-row"><span>Active</span><span class="debug-val">${d.override_active ? "Yes" : "No"}</span></div>
                ${d.override_active ? `
                  <div class="debug-row"><span>Target</span><span class="debug-val">${d.override_target_temp}°</span></div>
                  <div class="debug-row"><span>Remaining</span><span class="debug-val">${d.override_remaining_minutes} min</span></div>
                ` : ""}
              </div>
              <div class="debug-section">
                <div class="debug-section-title">Schedule</div>
                <div class="debug-row"><span>Enabled</span><span class="debug-val">${d.schedule_enabled ? "Yes" : "No"}</span></div>
                ${d.current_entry ? `
                  <div class="debug-row"><span>Entry</span><span class="debug-val">${d.current_entry.time_start}–${d.current_entry.time_end}</span></div>
                  <div class="debug-row"><span>Entry goal</span><span class="debug-val">${d.current_entry.target_temp}°</span></div>
                ` : `<div class="debug-row"><span>Entry</span><span class="debug-val">None</span></div>`}
              </div>
              <div class="debug-section">
                <div class="debug-section-title">Config</div>
                <div class="debug-row"><span>Temp range</span><span class="debug-val">${d.config.temp_min}° – ${d.config.temp_max}°</span></div>
                <div class="debug-row"><span>Away temp</span><span class="debug-val">${d.config.away_temp}°</span></div>
                <div class="debug-row"><span>Override dur.</span><span class="debug-val">${d.config.override_minutes} min</span></div>
              </div>
            </div>
            <div class="debug-entities">
              <div class="debug-section-title">Entity IDs</div>
              <div class="debug-row"><span>Climate</span><span class="debug-val mono">${d.entity_ids.climate || "—"}</span></div>
              <div class="debug-row"><span>Zone temp</span><span class="debug-val mono">${d.entity_ids.active_zone_temp || "—"}</span></div>
            </div>
          </div>
        ` : ""}
      </div>
    `;
  }

  // ── Settings tab ──────────────────────────────────────────────────────────

  async _loadSettingsData() {
    if (this._settingsLoading) return;
    this._settingsLoading = true;
    this._render();
    try {
      this._settingsError = null;
      const [cfg, zonesResult, personsResult] = await Promise.all([
        this._hass.callWS({ type: "gttc/get_config" }),
        this._hass.callWS({ type: "gttc/list_zones" }),
        this._hass.callWS({ type: "gttc/list_persons" }),
      ]);
      this._settingsData = {
        ...cfg,
        zones: zonesResult.zones || [],
        all_persons: personsResult.persons || [],
      };
    } catch (err) {
      this._settingsData = null;
      this._settingsError = err.message || err.code || String(err);
    } finally {
      this._settingsLoading = false;
      this._render();
    }
  }

  _showToast(message, type = "success") {
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toast = { message, type };
    this._render();
    this._toastTimer = setTimeout(() => {
      this._toast = null;
      this._toastTimer = null;
      this._render();
    }, 3000);
  }

  _renderToast() {
    const { message, type } = this._toast;
    return `<div class="toast toast-${type}">${message}</div>`;
  }

  _renderSettingsTab() {
    if (this._settingsLoading) {
      return `<div class="status-loading"><ha-icon icon="mdi:loading"></ha-icon> Loading...</div>`;
    }
    if (!this._settingsData) {
      return `
        <div class="status-error-box">
          <div class="status-error-msg">
            <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
            ${this._settingsError
              ? `Failed to load: <code>${this._settingsError}</code>`
              : "No config data available."}
          </div>
          <button class="btn btn-outline" id="settingsRetryBtn">Retry</button>
        </div>`;
    }
    const d = this._settingsData;
    return `
      <div class="settings-tab">
        <div class="settings-sections">
          ${this._renderSettingsTemperatureCard(d)}
          ${this._renderSettingsLearningCard(d)}
          ${this._renderSettingsOccupancyCard(d)}
          ${this._renderSettingsEnergyCard(d)}
          ${this._renderSettingsWindowsCard(d)}
          ${this._renderSettingsZonesCard(d)}
        </div>
      </div>
    `;
  }

  _renderSettingsTemperatureCard(d) {
    return `
      <div class="settings-card">
        <div class="settings-card-title">
          <ha-icon icon="mdi:thermometer-lines"></ha-icon> Temperature &amp; Override
        </div>
        <div class="settings-card-body">
          <div class="settings-row">
            <div class="settings-field">
              <label>Minimum temperature (°F)</label>
              <input type="number" id="cfg-temp-min" value="${d.temp_min}" min="32" max="99" step="0.5" />
            </div>
            <div class="settings-field">
              <label>Maximum temperature (°F)</label>
              <input type="number" id="cfg-temp-max" value="${d.temp_max}" min="33" max="100" step="0.5" />
            </div>
            <div class="settings-field">
              <label>Away temperature (°F)</label>
              <input type="number" id="cfg-away-temp" value="${d.away_temp}" min="32" max="100" step="0.5" />
              <div class="settings-hint">Must be within the min/max range.</div>
            </div>
          </div>
          <div class="settings-field">
            <label>Manual override duration — <strong id="cfg-override-label">${d.manual_override_minutes} min</strong></label>
            <input type="range" id="cfg-override-range" min="15" max="480" step="15" value="${d.manual_override_minutes}" />
          </div>
        </div>
        <div class="settings-card-footer">
          <button class="btn btn-primary" id="saveTemperatureBtn">Save</button>
        </div>
      </div>
    `;
  }

  _renderSettingsLearningCard(d) {
    return `
      <div class="settings-card">
        <div class="settings-card-title">
          <ha-icon icon="mdi:brain"></ha-icon> Learning
        </div>
        <div class="settings-card-body">
          <div class="settings-field settings-field-toggle">
            <div>
              <label>Enable learning engine</label>
              <div class="settings-hint">Automatically adapts the schedule based on repeated manual overrides.</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="cfg-learning-enabled" ${d.learning_enabled ? "checked" : ""} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-field ${d.learning_enabled ? "" : "settings-field-disabled"}">
            <label>Threshold — <strong id="cfg-learning-label">${d.learning_threshold}</strong> override${d.learning_threshold !== 1 ? "s" : ""} before schedule adapts</label>
            <input type="range" id="cfg-learning-range" min="2" max="10" step="1" value="${d.learning_threshold}" ${d.learning_enabled ? "" : "disabled"} />
          </div>
        </div>
        <div class="settings-card-footer">
          <button class="btn btn-primary" id="saveLearningBtn">Save</button>
        </div>
      </div>
    `;
  }

  _renderSettingsOccupancyCard(d) {
    const allPersons = d.all_persons || [];
    const trackedPersons = new Set(d.tracked_persons || []);
    const showPersons = d.presence_detection !== "occupancy_sensors";

    return `
      <div class="settings-card">
        <div class="settings-card-title">
          <ha-icon icon="mdi:account-check"></ha-icon> Occupancy
        </div>
        <div class="settings-card-body">
          <div class="settings-field settings-field-toggle">
            <div>
              <label>Enable occupancy-based control</label>
              <div class="settings-hint">Sets away temperature when nobody is home.</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="cfg-occupancy-enabled" ${d.occupancy_enabled ? "checked" : ""} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-field ${d.occupancy_enabled ? "" : "settings-field-disabled"}">
            <label>Presence detection mode</label>
            <select id="cfg-presence-detection" ${d.occupancy_enabled ? "" : "disabled"}>
              <option value="both" ${d.presence_detection === "both" ? "selected" : ""}>Person entities + Occupancy sensors (Recommended)</option>
              <option value="person_entities" ${d.presence_detection === "person_entities" ? "selected" : ""}>Person entities only</option>
              <option value="occupancy_sensors" ${d.presence_detection === "occupancy_sensors" ? "selected" : ""}>Occupancy sensors only</option>
            </select>
          </div>
          <div class="settings-field ${showPersons ? "" : "settings-field-disabled"}" id="person-entities-field">
            <label>Tracked person entities</label>
            <div class="settings-hint">
              Check the people GTTC should monitor. Leave all unchecked to track everyone.
            </div>
            ${allPersons.length === 0
              ? `<div class="person-empty">No person entities found in Home Assistant.</div>`
              : `<div class="person-list">
                  ${allPersons.map(p => `
                    <label class="person-row ${p.is_home ? "person-home" : ""}">
                      <input type="checkbox" class="person-chk" data-entity="${p.entity_id}"
                        ${trackedPersons.has(p.entity_id) ? "checked" : ""}
                        ${!showPersons ? "disabled" : ""} />
                      <div class="person-info">
                        <span class="person-name">${p.name}</span>
                        <span class="person-entity">${p.entity_id}</span>
                      </div>
                      <span class="person-badge ${p.is_home ? "person-badge-home" : "person-badge-away"}">
                        ${p.is_home ? "home" : p.state}
                      </span>
                    </label>
                  `).join("")}
                </div>`}
          </div>
        </div>
        <div class="settings-card-footer">
          <button class="btn btn-primary" id="saveOccupancyBtn">Save</button>
        </div>
      </div>
    `;
  }

  _renderSettingsEnergyCard(d) {
    return `
      <div class="settings-card">
        <div class="settings-card-title">
          <ha-icon icon="mdi:lightning-bolt-circle"></ha-icon> Energy &amp; Efficiency
        </div>
        <div class="settings-card-body">
          <div class="settings-field settings-field-toggle">
            <div>
              <label>Enable pre-conditioning</label>
              <div class="settings-hint">Starts ramping toward the next schedule entry before it begins.</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="cfg-precondition-enabled" ${d.precondition_enabled ? "checked" : ""} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-field settings-field-toggle">
            <div>
              <label>Enable TOU rate optimization</label>
              <div class="settings-hint">Adjusts setpoint during on-peak electricity hours to reduce cost.</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="cfg-tou-enabled" ${d.tou_enabled ? "checked" : ""} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-field ${d.tou_enabled ? "" : "settings-field-disabled"}">
            <label>TOU provider</label>
            <select id="cfg-tou-provider" ${d.tou_enabled ? "" : "disabled"}>
              <option value="none" ${d.tou_provider === "none" ? "selected" : ""}>None (disabled)</option>
              <option value="dominion_virginia" ${d.tou_provider === "dominion_virginia" ? "selected" : ""}>Dominion Energy Virginia</option>
            </select>
          </div>
          <div class="settings-field">
            <label>Outdoor temperature sensor</label>
            <input type="text" id="cfg-outdoor-sensor" value="${d.outdoor_temp_sensor || ""}"
              placeholder="sensor.openweathermap_temperature" spellcheck="false" autocomplete="off" />
            <div class="settings-hint">Used for heat pump setback optimization. Leave blank to disable.</div>
          </div>
        </div>
        <div class="settings-card-footer">
          <button class="btn btn-primary" id="saveEnergyBtn">Save</button>
        </div>
      </div>
    `;
  }

  _renderSettingsWindowsCard(d) {
    const sensors = d.window_sensors || [];
    const openSensors = [];
    // We don't have live sensor states in settings data; Status tab shows live state
    return `
      <div class="settings-card win-card">
        <div class="settings-card-title">
          <ha-icon icon="mdi:window-open-variant"></ha-icon> Window Sensors
        </div>
        <div class="settings-card-body">
          <div class="settings-field settings-field-toggle">
            <div>
              <label>Manually suspend thermostat</label>
              <div class="settings-hint">Pauses heating/cooling without needing a physical sensor.</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="winManualChk" ${d.windows_open_override ? "checked" : ""} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-field">
            <label>Window / door contact sensors</label>
            <div class="win-sensor-list">
              ${sensors.length === 0
                ? `<div class="win-empty">No sensors added yet.</div>`
                : sensors.map(entityId => `
                    <div class="win-sensor-row">
                      <ha-icon icon="mdi:window-closed"></ha-icon>
                      <span class="win-sensor-id">${entityId}</span>
                      <button class="win-remove-btn" data-sensor="${entityId}" title="Remove">
                        <ha-icon icon="mdi:close"></ha-icon>
                      </button>
                    </div>
                  `).join("")}
            </div>
            <div class="win-add-row">
              <input class="win-input" id="winSensorInput" type="text"
                placeholder="binary_sensor.bedroom_window" spellcheck="false" autocomplete="off" />
              <button class="btn btn-sm" id="winAddBtn">Add Sensor</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  _renderSettingsZonesCard(d) {
    const zones = d.zones || [];
    if (this._editingZoneId) {
      return this._renderZoneForm(zones);
    }
    return `
      <div class="settings-card">
        <div class="settings-card-title">
          <ha-icon icon="mdi:map-marker-radius"></ha-icon> Zones
        </div>
        <div class="settings-card-body">
          ${zones.length === 0
            ? `<div class="settings-hint">No zones configured yet. Add a zone or discover from HA areas.</div>`
            : `<div class="zone-list">
                ${zones.map(z => `
                  <div class="zone-row ${z.is_active ? "zone-active" : ""}">
                    <div class="zone-info">
                      <div class="zone-name">
                        ${z.is_active ? `<ha-icon icon="mdi:star" class="zone-active-icon"></ha-icon>` : ""}
                        ${z.name}
                      </div>
                      <div class="zone-meta">
                        ${z.sensor_entities.length} temp sensor${z.sensor_entities.length !== 1 ? "s" : ""}
                        ${z.occupancy_sensor_entities.length > 0
                          ? ` &middot; ${z.occupancy_sensor_entities.length} occupancy`
                          : ""}
                        ${z.current_temp != null ? ` &middot; ${z.current_temp.toFixed(1)}&deg;` : ""}
                        ${z.away_temp != null ? ` &middot; away ${z.away_temp}&deg;` : ""}
                      </div>
                    </div>
                    <div class="zone-actions">
                      ${!z.is_active
                        ? `<button class="btn btn-sm" data-zone-activate="${z.id}">Set Active</button>`
                        : ""}
                      <button class="btn btn-sm btn-icon" data-zone-edit="${z.id}" title="Edit zone">
                        <ha-icon icon="mdi:pencil"></ha-icon>
                      </button>
                      <button class="btn btn-sm btn-icon btn-danger" data-zone-delete="${z.id}" title="Delete zone">
                        <ha-icon icon="mdi:delete"></ha-icon>
                      </button>
                    </div>
                  </div>
                `).join("")}
              </div>`}
        </div>
        <div class="settings-card-footer zone-card-footer">
          <button class="btn btn-outline" id="discoverAreasBtn">
            <ha-icon icon="mdi:magnify"></ha-icon> Discover HA Areas
          </button>
          <button class="btn btn-primary" id="addZoneBtn">
            <ha-icon icon="mdi:plus"></ha-icon> Add Zone
          </button>
        </div>
      </div>
    `;
  }

  _renderZoneForm(zones) {
    const isNew = this._editingZoneId === "new";
    const existing = isNew ? null : zones.find(z => z.id === this._editingZoneId);
    const fd = this._zoneFormData || {};
    const name = fd.name !== undefined ? fd.name : (existing?.name || "");
    const sensors = fd.sensor_entities !== undefined ? fd.sensor_entities : (existing?.sensor_entities || []);
    const occSensors = fd.occupancy_sensor_entities !== undefined
      ? fd.occupancy_sensor_entities
      : (existing?.occupancy_sensor_entities || []);
    const awayTemp = fd.away_temp !== undefined ? fd.away_temp : (existing?.away_temp ?? "");

    return `
      <div class="settings-card">
        <div class="settings-card-title">
          <ha-icon icon="mdi:map-marker-radius"></ha-icon>
          ${isNew ? "Add Zone" : `Edit Zone: ${existing?.name || ""}`}
        </div>
        <div class="settings-card-body">
          <div class="settings-field">
            <label>Zone name</label>
            <input type="text" id="zone-form-name" value="${name}" placeholder="Living Room" />
          </div>
          <div class="settings-field">
            <label>Temperature sensors</label>
            <div class="win-sensor-list">
              ${sensors.length === 0
                ? `<div class="win-empty">No sensors added yet.</div>`
                : sensors.map(s => `
                    <div class="win-sensor-row">
                      <ha-icon icon="mdi:thermometer"></ha-icon>
                      <span class="win-sensor-id">${s}</span>
                      <button class="zone-remove-temp-sensor win-remove-btn" data-sensor="${s}" title="Remove">
                        <ha-icon icon="mdi:close"></ha-icon>
                      </button>
                    </div>
                  `).join("")}
            </div>
            <div class="win-add-row">
              <input type="text" id="zone-temp-sensor-input" class="win-input"
                placeholder="sensor.living_room_temp" spellcheck="false" autocomplete="off" />
              <button class="btn btn-sm" id="zone-add-temp-sensor">Add</button>
            </div>
          </div>
          <div class="settings-field">
            <label>Occupancy sensors <span class="settings-hint-inline">(optional)</span></label>
            <div class="win-sensor-list">
              ${occSensors.length === 0
                ? `<div class="win-empty">None added.</div>`
                : occSensors.map(s => `
                    <div class="win-sensor-row">
                      <ha-icon icon="mdi:motion-sensor"></ha-icon>
                      <span class="win-sensor-id">${s}</span>
                      <button class="zone-remove-occ-sensor win-remove-btn" data-sensor="${s}" title="Remove">
                        <ha-icon icon="mdi:close"></ha-icon>
                      </button>
                    </div>
                  `).join("")}
            </div>
            <div class="win-add-row">
              <input type="text" id="zone-occ-sensor-input" class="win-input"
                placeholder="binary_sensor.living_room_motion" spellcheck="false" autocomplete="off" />
              <button class="btn btn-sm" id="zone-add-occ-sensor">Add</button>
            </div>
          </div>
          <div class="settings-field">
            <label>Away temperature override (°F) <span class="settings-hint-inline">(optional)</span></label>
            <input type="number" id="zone-form-away-temp" value="${awayTemp}"
              min="32" max="100" step="0.5" placeholder="Uses global away temp if blank" />
            <div class="settings-hint">Leave blank to use the global away temperature.</div>
          </div>
        </div>
        <div class="settings-card-footer">
          <button class="btn btn-outline" id="cancelZoneBtn">Cancel</button>
          <button class="btn btn-primary" id="saveZoneBtn">${isNew ? "Create Zone" : "Save Changes"}</button>
        </div>
      </div>
    `;
  }

  _attachSettingsListeners() {
    const root = this.shadowRoot;

    this._addClick("settingsRetryBtn", () => this._loadSettingsData());

    // Temperature section
    const overrideRange = root.getElementById("cfg-override-range");
    const overrideLabel = root.getElementById("cfg-override-label");
    if (overrideRange && overrideLabel) {
      overrideRange.addEventListener("input", () => {
        overrideLabel.textContent = overrideRange.value + " min";
      });
    }
    this._addClick("saveTemperatureBtn", async () => {
      const tempMin = parseFloat(root.getElementById("cfg-temp-min")?.value);
      const tempMax = parseFloat(root.getElementById("cfg-temp-max")?.value);
      const awayTemp = parseFloat(root.getElementById("cfg-away-temp")?.value);
      const overrideMins = parseInt(root.getElementById("cfg-override-range")?.value);
      if (isNaN(tempMin) || isNaN(tempMax) || isNaN(awayTemp) || isNaN(overrideMins)) return;
      if (tempMin >= tempMax) {
        this._showToast("Min temperature must be less than max.", "error"); return;
      }
      if (awayTemp < tempMin || awayTemp > tempMax) {
        this._showToast("Away temperature must be within min/max range.", "error"); return;
      }
      try {
        await this._hass.callWS({ type: "gttc/set_config",
          temp_min: tempMin, temp_max: tempMax, away_temp: awayTemp,
          manual_override_minutes: overrideMins });
        this._settingsData = { ...this._settingsData,
          temp_min: tempMin, temp_max: tempMax, away_temp: awayTemp,
          manual_override_minutes: overrideMins };
        this._showToast("Temperature settings saved.");
      } catch (err) { this._showToast(err.message || "Failed to save.", "error"); }
    });

    // Learning section
    const learningRange = root.getElementById("cfg-learning-range");
    const learningLabel = root.getElementById("cfg-learning-label");
    if (learningRange && learningLabel) {
      learningRange.addEventListener("input", () => {
        const v = parseInt(learningRange.value);
        learningLabel.textContent = String(v);
        // update the suffix text — easier to just update the label
      });
    }
    const learningChk = root.getElementById("cfg-learning-enabled");
    if (learningChk) {
      learningChk.addEventListener("change", () => {
        const field = root.getElementById("cfg-learning-range")?.closest(".settings-field");
        if (field) field.classList.toggle("settings-field-disabled", !learningChk.checked);
        if (learningRange) learningRange.disabled = !learningChk.checked;
      });
    }
    this._addClick("saveLearningBtn", async () => {
      const enabled = root.getElementById("cfg-learning-enabled")?.checked ?? true;
      const threshold = parseInt(root.getElementById("cfg-learning-range")?.value);
      if (isNaN(threshold)) return;
      try {
        await this._hass.callWS({ type: "gttc/set_config",
          learning_enabled: enabled, learning_threshold: threshold });
        this._settingsData = { ...this._settingsData,
          learning_enabled: enabled, learning_threshold: threshold };
        this._showToast("Learning settings saved.");
      } catch (err) { this._showToast(err.message || "Failed to save.", "error"); }
    });

    // Occupancy section
    const occChk = root.getElementById("cfg-occupancy-enabled");
    const presenceSelect = root.getElementById("cfg-presence-detection");
    const personField = root.getElementById("person-entities-field");
    const _updatePersonFieldVisibility = () => {
      const mode = presenceSelect?.value || "both";
      const showPersons = mode !== "occupancy_sensors";
      personField?.classList.toggle("settings-field-disabled", !showPersons);
      root.querySelectorAll(".person-chk").forEach(c => { c.disabled = !showPersons; });
    };
    if (occChk) {
      occChk.addEventListener("change", () => {
        if (presenceSelect) {
          presenceSelect.disabled = !occChk.checked;
          presenceSelect.closest(".settings-field")?.classList.toggle("settings-field-disabled", !occChk.checked);
        }
      });
    }
    if (presenceSelect) {
      presenceSelect.addEventListener("change", _updatePersonFieldVisibility);
    }
    this._addClick("saveOccupancyBtn", async () => {
      const enabled = root.getElementById("cfg-occupancy-enabled")?.checked ?? false;
      const mode = root.getElementById("cfg-presence-detection")?.value || "both";
      const trackedPersons = [...root.querySelectorAll(".person-chk:checked")].map(c => c.dataset.entity);
      try {
        await this._hass.callWS({ type: "gttc/set_config",
          occupancy_enabled: enabled, presence_detection: mode, tracked_persons: trackedPersons });
        this._settingsData = { ...this._settingsData,
          occupancy_enabled: enabled, presence_detection: mode, tracked_persons: trackedPersons };
        this._showToast("Occupancy settings saved.");
      } catch (err) { this._showToast(err.message || "Failed to save.", "error"); }
    });

    // Energy section
    const touChk = root.getElementById("cfg-tou-enabled");
    if (touChk) {
      touChk.addEventListener("change", () => {
        const providerField = root.getElementById("cfg-tou-provider");
        if (providerField) {
          providerField.disabled = !touChk.checked;
          providerField.closest(".settings-field")?.classList.toggle("settings-field-disabled", !touChk.checked);
        }
      });
    }
    this._addClick("saveEnergyBtn", async () => {
      const precondition = root.getElementById("cfg-precondition-enabled")?.checked ?? true;
      const touEnabled = root.getElementById("cfg-tou-enabled")?.checked ?? false;
      const touProvider = root.getElementById("cfg-tou-provider")?.value || "none";
      const outdoorSensor = root.getElementById("cfg-outdoor-sensor")?.value.trim() || "";
      try {
        await this._hass.callWS({ type: "gttc/set_config",
          precondition_enabled: precondition, tou_enabled: touEnabled,
          tou_provider: touProvider, outdoor_temp_sensor: outdoorSensor });
        this._settingsData = { ...this._settingsData,
          precondition_enabled: precondition, tou_enabled: touEnabled,
          tou_provider: touProvider, outdoor_temp_sensor: outdoorSensor };
        this._showToast("Energy settings saved.");
      } catch (err) { this._showToast(err.message || "Failed to save.", "error"); }
    });

    // Windows section
    this._addClick("winAddBtn", async () => {
      const input = root.getElementById("winSensorInput");
      const entityId = input ? input.value.trim() : "";
      if (!entityId) return;
      try {
        await this._hass.callWS({ type: "gttc/add_window_sensor", entity_id: entityId });
        await this._loadSettingsData();
        this._showToast("Sensor added.");
      } catch (err) { this._showToast(err.message || "Failed to add sensor.", "error"); }
    });
    root.querySelectorAll(".win-remove-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const entityId = btn.dataset.sensor;
        if (!entityId) return;
        try {
          await this._hass.callWS({ type: "gttc/remove_window_sensor", entity_id: entityId });
          await this._loadSettingsData();
          this._showToast("Sensor removed.");
        } catch (err) { this._showToast(err.message || "Failed to remove sensor.", "error"); }
      });
    });
    const winChk = root.getElementById("winManualChk");
    if (winChk) {
      winChk.addEventListener("change", async () => {
        try {
          await this._hass.callService("switch", winChk.checked ? "turn_on" : "turn_off", {
            entity_id: "switch.gttc_windows_open",
          });
          if (this._settingsData) {
            this._settingsData = { ...this._settingsData, windows_open_override: winChk.checked };
          }
          this._showToast(winChk.checked ? "Thermostat suspended." : "Suspension lifted.");
        } catch (err) { this._showToast(err.message || "Failed.", "error"); }
      });
    }

    // ── Zones section ──────────────────────────────────────────────────────
    this._addClick("addZoneBtn", () => {
      this._editingZoneId = "new";
      this._zoneFormData = { name: "", sensor_entities: [], occupancy_sensor_entities: [], away_temp: "" };
      this._render();
    });

    this._addClick("discoverAreasBtn", async () => {
      try {
        const result = await this._hass.callWS({ type: "gttc/list_zones", include_areas: true });
        const areas = result.areas || [];
        if (areas.length === 0) {
          this._showToast("No HA areas found with temperature sensors.", "error");
          return;
        }
        const existingAreaIds = new Set((this._settingsData?.zones || []).map(z => z.area_id).filter(Boolean));
        let added = 0;
        for (const area of areas) {
          if (existingAreaIds.has(area.area_id)) continue;
          await this._hass.callWS({
            type: "gttc/save_zone",
            name: area.name,
            sensor_entities: area.temp_sensors,
            occupancy_sensor_entities: area.occupancy_sensors,
            area_id: area.area_id,
            floor_id: area.floor_id || null,
          });
          added++;
        }
        if (added > 0) {
          await this._loadSettingsData();
          this._showToast(`${added} zone${added !== 1 ? "s" : ""} discovered and added.`);
        } else {
          this._showToast("All discovered areas are already configured as zones.");
        }
      } catch (err) { this._showToast(err.message || "Failed to discover areas.", "error"); }
    });

    root.querySelectorAll("[data-zone-edit]").forEach(btn => {
      btn.addEventListener("click", () => {
        this._editingZoneId = btn.dataset.zoneEdit;
        this._zoneFormData = null;
        this._render();
      });
    });

    root.querySelectorAll("[data-zone-delete]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const zoneId = btn.dataset.zoneDelete;
        const zone = (this._settingsData?.zones || []).find(z => z.id === zoneId);
        if (!confirm(`Delete zone "${zone?.name || zoneId}"?`)) return;
        try {
          await this._hass.callWS({ type: "gttc/delete_zone", zone_id: zoneId });
          await this._loadSettingsData();
          this._showToast("Zone deleted.");
        } catch (err) { this._showToast(err.message || "Failed to delete zone.", "error"); }
      });
    });

    root.querySelectorAll("[data-zone-activate]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const zoneId = btn.dataset.zoneActivate;
        try {
          await this._hass.callWS({ type: "gttc/set_active_zone", zone_id: zoneId });
          if (this._settingsData?.zones) {
            this._settingsData = {
              ...this._settingsData,
              zones: this._settingsData.zones.map(z => ({ ...z, is_active: z.id === zoneId })),
            };
          }
          this._render();
          this._showToast("Active zone updated.");
        } catch (err) { this._showToast(err.message || "Failed.", "error"); }
      });
    });

    // Zone form interactions
    this._addClick("cancelZoneBtn", () => {
      this._editingZoneId = null;
      this._zoneFormData = null;
      this._render();
    });

    this._addClick("zone-add-temp-sensor", () => {
      const input = root.getElementById("zone-temp-sensor-input");
      const val = input?.value.trim();
      if (!val) return;
      this._syncZoneFormFromDOM();
      if (!this._zoneFormData.sensor_entities.includes(val)) {
        this._zoneFormData.sensor_entities = [...this._zoneFormData.sensor_entities, val];
      }
      this._render();
    });

    root.querySelectorAll(".zone-remove-temp-sensor").forEach(btn => {
      btn.addEventListener("click", () => {
        this._syncZoneFormFromDOM();
        this._zoneFormData.sensor_entities = this._zoneFormData.sensor_entities.filter(
          s => s !== btn.dataset.sensor
        );
        this._render();
      });
    });

    this._addClick("zone-add-occ-sensor", () => {
      const input = root.getElementById("zone-occ-sensor-input");
      const val = input?.value.trim();
      if (!val) return;
      this._syncZoneFormFromDOM();
      if (!this._zoneFormData.occupancy_sensor_entities.includes(val)) {
        this._zoneFormData.occupancy_sensor_entities = [...this._zoneFormData.occupancy_sensor_entities, val];
      }
      this._render();
    });

    root.querySelectorAll(".zone-remove-occ-sensor").forEach(btn => {
      btn.addEventListener("click", () => {
        this._syncZoneFormFromDOM();
        this._zoneFormData.occupancy_sensor_entities = this._zoneFormData.occupancy_sensor_entities.filter(
          s => s !== btn.dataset.sensor
        );
        this._render();
      });
    });

    this._addClick("saveZoneBtn", async () => {
      this._syncZoneFormFromDOM();
      const name = this._zoneFormData?.name?.trim();
      if (!name) { this._showToast("Zone name is required.", "error"); return; }
      const awayTempStr = this._zoneFormData?.away_temp;
      const awayTemp = awayTempStr !== "" && awayTempStr != null ? parseFloat(awayTempStr) : null;
      const payload = {
        type: "gttc/save_zone",
        name,
        sensor_entities: this._zoneFormData?.sensor_entities || [],
        occupancy_sensor_entities: this._zoneFormData?.occupancy_sensor_entities || [],
        away_temp: (awayTemp != null && !isNaN(awayTemp)) ? awayTemp : null,
      };
      if (this._editingZoneId !== "new") {
        payload.zone_id = this._editingZoneId;
      }
      try {
        await this._hass.callWS(payload);
        this._editingZoneId = null;
        this._zoneFormData = null;
        await this._loadSettingsData();
        this._showToast("Zone saved.");
      } catch (err) { this._showToast(err.message || "Failed to save zone.", "error"); }
    });
  }

  _syncZoneFormFromDOM() {
    const root = this.shadowRoot;
    const zones = this._settingsData?.zones || [];
    const existing = this._editingZoneId === "new" ? null : zones.find(z => z.id === this._editingZoneId);
    if (!this._zoneFormData) {
      this._zoneFormData = {
        sensor_entities: [...(existing?.sensor_entities || [])],
        occupancy_sensor_entities: [...(existing?.occupancy_sensor_entities || [])],
      };
    }
    const nameEl = root.getElementById("zone-form-name");
    if (nameEl) this._zoneFormData.name = nameEl.value;
    const awayEl = root.getElementById("zone-form-away-temp");
    if (awayEl) this._zoneFormData.away_temp = awayEl.value;
  }

  _renderWindowCard(d) {
    const win = (d && d.windows) || { open: false, sensors: [], open_sensors: [], manual_override: false };
    const isOpen = win.open;
    const statusLabel = win.manual_override
      ? "Paused (manual)"
      : isOpen
        ? `Paused — ${win.open_sensors.length} window${win.open_sensors.length !== 1 ? "s" : ""} open`
        : win.sensors.length > 0
          ? `All closed (${win.sensors.length} sensor${win.sensors.length !== 1 ? "s" : ""})`
          : "No sensors configured";
    const statusClass = isOpen ? "win-open" : "win-closed";
    const statusIcon = isOpen ? "mdi:window-open-variant" : "mdi:window-closed-variant";

    return `
      <div class="status-card win-card">
        <div class="status-card-title"><ha-icon icon="mdi:window-open-variant"></ha-icon> Windows</div>
        <div class="win-status ${statusClass}">
          <ha-icon icon="${statusIcon}"></ha-icon>
          <span>${statusLabel}</span>
          ${isOpen ? '<span class="win-badge">HVAC suspended</span>' : ""}
        </div>
        ${win.sensors.length > 0 ? `
          <div class="win-sensor-list" style="margin-top:8px">
            ${win.sensors.map(entityId => {
              const isThisOpen = win.open_sensors.includes(entityId);
              return `
                <div class="win-sensor-row ${isThisOpen ? "win-sensor-open" : ""}">
                  <ha-icon icon="${isThisOpen ? "mdi:window-open" : "mdi:window-closed"}"></ha-icon>
                  <span class="win-sensor-id">${entityId}</span>
                  <span class="win-sensor-state">${isThisOpen ? "open" : "closed"}</span>
                </div>
              `;
            }).join("")}
          </div>
        ` : ""}
        <div style="margin-top:10px">
          <button class="btn btn-outline btn-sm" id="goToWindowSettings">
            <ha-icon icon="mdi:cog"></ha-icon> Manage in Settings
          </button>
        </div>
      </div>
    `;
  }

  _fmt12(timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }

  async _loadStatusData() {
    if (this._statusLoading) return;
    this._statusLoading = true;
    this._render();
    try {
      this._statusError = null;
      this._diagData = await this._hass.callWS({ type: "gttc/get_diagnostics" });
      // Fetch temperature history if we have the entity ID
      const entityId = this._diagData.entity_ids && this._diagData.entity_ids.active_zone_temp;
      if (entityId) {
        try {
          const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const histResult = await this._hass.callApi(
            "GET",
            `history/period/${start}?filter_entity_id=${entityId}&minimal_response=true&no_attributes=true`
          );
          this._historyData = (histResult && histResult[0]) ? histResult[0] : [];
        } catch (histErr) {
          console.warn("GTTC: Could not fetch history", histErr);
          this._historyData = [];
        }
      } else {
        this._historyData = [];
      }
    } catch (err) {
      console.error("GTTC: Failed to load diagnostics", err);
      this._diagData = null;
      this._historyData = [];
      this._statusError = err.message || err.code || String(err);
    } finally {
      this._statusLoading = false;
      this._render();
    }
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

      /* On-peak overlay band */
      .on-peak-band {
        position: absolute; top: 0; bottom: 0;
        background: rgba(219,68,55,0.10);
        border-left: 1px dashed rgba(219,68,55,0.35);
        border-right: 1px dashed rgba(219,68,55,0.35);
        pointer-events: none; z-index: 0;
      }

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

      /* Main tab bar */
      .main-tab-bar {
        display: flex; gap: 4px; margin-bottom: 16px;
        border-bottom: 2px solid var(--divider);
        padding-bottom: 0;
      }
      .main-tab {
        padding: 8px 20px; border: none; border-radius: 8px 8px 0 0;
        background: transparent; color: var(--secondary-text); cursor: pointer;
        font-size: 14px; font-weight: 500; transition: all 0.15s;
        display: flex; align-items: center; gap: 6px;
        margin-bottom: -2px; border-bottom: 2px solid transparent;
      }
      .main-tab ha-icon { --mdc-icon-size: 16px; }
      .main-tab:hover { color: var(--primary); background: rgba(3,169,244,0.06); }
      .main-tab.active { color: var(--primary); border-bottom-color: var(--primary); background: transparent; }

      /* Status tab */
      .status-tab { display: flex; flex-direction: column; gap: 16px; }
      .status-loading { padding: 40px; text-align: center; color: var(--secondary-text); font-size: 15px; }
      .status-error-box { padding: 24px; background: var(--card-bg); border-radius: 12px; border: 1px solid var(--error-color,#db4437); display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
      .status-error-msg { color: var(--error-color,#db4437); font-size: 14px; line-height: 1.6; }
      .status-error-msg code { font-family: monospace; background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px; }
      .status-error-msg small { color: var(--secondary-text); display: block; margin-top: 4px; }

      /* Stat cards */
      .stat-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
      @media (max-width: 700px) { .stat-cards { grid-template-columns: repeat(2, 1fr); } }
      .stat-card {
        background: var(--card-bg); border-radius: 12px; border: 1px solid var(--divider);
        padding: 14px 16px; display: flex; align-items: center; gap: 12px;
      }
      .stat-icon { color: var(--primary); flex-shrink: 0; }
      .stat-icon ha-icon { --mdc-icon-size: 28px; }
      .stat-icon.heating { color: #f57c00; }
      .stat-icon.cooling { color: #0288d1; }
      .stat-body { min-width: 0; }
      .stat-label { font-size: 11px; color: var(--secondary-text); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
      .stat-value { font-size: 22px; font-weight: 600; line-height: 1.1; }
      .stat-value.heating { color: #f57c00; }
      .stat-value.cooling { color: #0288d1; }
      .stat-value-md { font-size: 18px; }
      .stat-value-sm { font-size: 13px; font-weight: 500; }
      .stat-sub { font-size: 11px; color: var(--secondary-text); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      /* Chart */
      .chart-card {
        background: var(--card-bg); border-radius: 12px; border: 1px solid var(--divider);
        padding: 16px;
      }
      .chart-title {
        font-size: 14px; font-weight: 500; margin-bottom: 12px;
        display: flex; align-items: center; gap: 12px; color: var(--primary-text);
      }
      .chart-legend { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--secondary-text); font-weight: 400; }
      .legend-dot { width: 12px; height: 2px; display: inline-block; border-radius: 1px; }
      .legend-dot.actual { background: var(--primary-color, #03a9f4); }
      .legend-dot.goal { background: var(--success-color, #43a047); }
      .legend-dot.on-peak { background: rgba(219,68,55,0.55); width: 10px; height: 10px; border-radius: 2px; }
      .legend-dot.hvac-heat { background: rgba(245,124,0,0.7); width: 10px; height: 10px; border-radius: 2px; }
      .legend-dot.hvac-cool { background: rgba(2,136,209,0.7); width: 10px; height: 10px; border-radius: 2px; }
      .chart-legend-zone {
        display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--secondary-text); font-weight: 400;
      }
      .chart-legend-zone::before {
        content: ""; display: inline-block; width: 10px; height: 10px;
        border-radius: 2px; background: var(--zone-color, #888); opacity: 0.5; flex-shrink: 0;
      }
      .chart-empty { padding: 40px 0; text-align: center; color: var(--secondary-text); font-size: 13px; }
      .temp-chart { width: 100%; height: auto; display: block; overflow: visible; }

      /* Status row 2 (zones + system side by side) */
      .status-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 700px) { .status-row-2 { grid-template-columns: 1fr; } }

      /* Status cards (zones / system) */
      .status-card {
        background: var(--card-bg); border-radius: 12px; border: 1px solid var(--divider);
        padding: 14px 16px;
      }
      .status-card-title {
        font-size: 13px; font-weight: 600; color: var(--secondary-text); text-transform: uppercase;
        letter-spacing: 0.5px; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;
      }
      .status-card-title ha-icon { --mdc-icon-size: 16px; }

      /* Zone rows */
      .zone-row {
        display: flex; align-items: center; gap: 8px; padding: 6px 0;
        border-bottom: 1px solid var(--divider); font-size: 14px;
      }
      .zone-row:last-child { border-bottom: none; }
      .zone-row.zone-active .zone-name { font-weight: 600; }
      .zone-indicator { font-size: 12px; color: var(--secondary-text); flex-shrink: 0; }
      .zone-row.zone-active .zone-indicator { color: var(--primary); }
      .zone-name { flex: 1; }
      .zone-temp { font-weight: 600; font-size: 15px; }
      .zone-occ { font-size: 11px; color: var(--secondary-text); background: var(--bg); padding: 1px 6px; border-radius: 8px; border: 1px solid var(--divider); }

      /* System table */
      .sys-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .sys-table tr { border-bottom: 1px solid var(--divider); }
      .sys-table tr:last-child { border-bottom: none; }
      .sys-label { padding: 5px 0; color: var(--secondary-text); width: 45%; }
      .sys-val { padding: 5px 0; font-weight: 500; text-align: right; }

      /* Debug card */
      .debug-card {
        background: var(--card-bg); border-radius: 12px; border: 1px solid var(--divider);
        overflow: hidden;
      }
      .debug-toggle {
        width: 100%; padding: 12px 16px; background: none; border: none; cursor: pointer;
        color: var(--secondary-text); font-size: 13px; font-weight: 500; text-align: left;
        display: flex; align-items: center; gap: 8px;
      }
      .debug-toggle:hover { background: var(--bg); color: var(--primary-text); }
      .debug-toggle ha-icon { --mdc-icon-size: 18px; }
      .debug-body { padding: 0 16px 16px; }
      .debug-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 12px; }
      @media (max-width: 700px) { .debug-grid { grid-template-columns: 1fr; } }
      .debug-section { }
      .debug-section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--secondary-text); margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--divider); }
      .debug-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 3px 0; gap: 8px; }
      .debug-row span:first-child { color: var(--secondary-text); flex-shrink: 0; }
      .debug-val { font-weight: 500; text-align: right; word-break: break-all; }
      .debug-entities { border-top: 1px solid var(--divider); padding-top: 12px; }
      .mono { font-family: monospace; font-size: 11px; }

      /* Status footer */
      .status-footer { display: flex; align-items: center; gap: 12px; padding-top: 4px; }
      .status-updated { font-size: 12px; color: var(--secondary-text); }

      /* Windows open badge in header */
      .status-item.windows-open {
        background: #e3f2fd; border-color: #1976d2; color: #0d47a1;
      }
      .status-item.windows-open ha-icon { --mdc-icon-size: 16px; }

      /* Window card */
      .win-card { display: flex; flex-direction: column; gap: 12px; }
      .win-status {
        display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        border-radius: 8px; font-size: 14px; font-weight: 500;
      }
      .win-status ha-icon { --mdc-icon-size: 20px; }
      .win-status.win-open { background: #fff8e1; color: #e65100; }
      .win-status.win-closed { background: #e8f5e9; color: #2e7d32; }
      .win-badge {
        margin-left: auto; font-size: 11px; font-weight: 600; letter-spacing: 0.5px;
        background: #ff6f00; color: #fff; padding: 2px 8px; border-radius: 10px;
        text-transform: uppercase;
      }
      .win-sensor-list { display: flex; flex-direction: column; gap: 4px; }
      .win-empty { font-size: 13px; color: var(--secondary-text); padding: 4px 0; }
      .win-sensor-row {
        display: flex; align-items: center; gap: 8px; font-size: 13px;
        padding: 6px 8px; border-radius: 6px; background: var(--bg);
      }
      .win-sensor-row ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text); flex-shrink: 0; }
      .win-sensor-row.win-sensor-open ha-icon { color: #e65100; }
      .win-sensor-id { flex: 1; font-family: monospace; font-size: 12px; word-break: break-all; }
      .win-sensor-state {
        font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 8px;
        background: var(--divider); color: var(--secondary-text); flex-shrink: 0;
      }
      .win-sensor-row.win-sensor-open .win-sensor-state { background: #ffe0b2; color: #bf360c; }
      .win-remove-btn {
        background: none; border: none; cursor: pointer; padding: 2px;
        color: var(--secondary-text); border-radius: 4px; display: flex; align-items: center;
        flex-shrink: 0;
      }
      .win-remove-btn:hover { color: var(--error); background: rgba(0,0,0,0.06); }
      .win-remove-btn ha-icon { --mdc-icon-size: 16px; }
      .win-add-row { display: flex; gap: 8px; align-items: center; }
      .win-input {
        flex: 1; padding: 7px 10px; border: 1px solid var(--divider); border-radius: 6px;
        font-size: 13px; font-family: monospace; background: var(--bg);
        color: var(--primary-text); min-width: 0;
      }
      .win-input:focus { outline: none; border-color: var(--primary); }
      .win-manual-row { padding-top: 4px; }
      .win-manual-label {
        display: flex; align-items: center; gap: 8px; font-size: 13px;
        color: var(--secondary-text); cursor: pointer;
      }
      .win-manual-label input[type=checkbox] { width: 16px; height: 16px; cursor: pointer; }

      /* Settings tab */
      .settings-tab { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }
      .settings-sections { display: flex; flex-direction: column; gap: 16px; }
      .settings-card {
        background: var(--card-bg); border-radius: 12px; border: 1px solid var(--divider); overflow: hidden;
      }
      .settings-card-title {
        display: flex; align-items: center; gap: 8px;
        padding: 14px 16px; font-size: 15px; font-weight: 600;
        border-bottom: 1px solid var(--divider); background: var(--bg);
      }
      .settings-card-title ha-icon { --mdc-icon-size: 20px; color: var(--primary); }
      .settings-card-body { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
      .settings-card-footer {
        padding: 12px 16px; border-top: 1px solid var(--divider);
        display: flex; justify-content: flex-end; background: var(--bg);
      }
      .settings-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
      @media (max-width: 700px) { .settings-row { grid-template-columns: 1fr; } }

      .settings-field { display: flex; flex-direction: column; gap: 6px; }
      .settings-field label { font-size: 13px; font-weight: 500; color: var(--primary-text); }
      .settings-hint { font-size: 12px; color: var(--secondary-text); }
      .settings-field-toggle {
        flex-direction: row; align-items: flex-start; justify-content: space-between; gap: 16px;
      }
      .settings-field-toggle > div { flex: 1; }
      .settings-field-toggle label:not(.toggle-switch) { font-size: 14px; }
      .settings-field-disabled { opacity: 0.45; pointer-events: none; }

      .settings-field input[type="number"],
      .settings-field input[type="text"],
      .settings-field select {
        padding: 8px 12px; border-radius: 8px; border: 1px solid var(--divider);
        background: var(--card-bg); color: var(--primary-text); font-size: 14px; width: 100%;
        box-sizing: border-box;
      }
      .settings-field input[type="number"]:focus,
      .settings-field input[type="text"]:focus,
      .settings-field select:focus { outline: none; border-color: var(--primary); }
      .settings-field input[type="range"] {
        width: 100%; max-width: 300px; accent-color: var(--primary);
      }

      /* Toggle switch */
      .toggle-switch { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; margin-top: 2px; }
      .toggle-switch input { opacity: 0; width: 0; height: 0; }
      .toggle-slider {
        position: absolute; cursor: pointer; inset: 0; background: var(--divider);
        border-radius: 24px; transition: 0.2s;
      }
      .toggle-slider::before {
        content: ""; position: absolute; width: 18px; height: 18px; left: 3px; bottom: 3px;
        background: #fff; border-radius: 50%; transition: 0.2s;
      }
      .toggle-switch input:checked + .toggle-slider { background: var(--primary); }
      .toggle-switch input:checked + .toggle-slider::before { transform: translateX(20px); }

      /* Primary save button */
      .btn-primary {
        background: var(--primary); color: #fff; border: none;
        padding: 8px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer;
      }
      .btn-primary:hover { filter: brightness(1.1); }

      /* Toast */
      .toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 500;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25); z-index: 9999; white-space: nowrap;
        animation: toast-in 0.2s ease;
      }
      .toast-success { background: var(--success-color, #43a047); color: #fff; }
      .toast-error { background: var(--error-color, #db4437); color: #fff; }
      @keyframes toast-in {
        from { opacity: 0; transform: translateX(-50%) translateY(8px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0); }
      }

      /* Person entity selector */
      .person-list { display: flex; flex-direction: column; gap: 6px; }
      .person-empty { font-size: 13px; color: var(--secondary-text); padding: 4px 0; }
      .person-row {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 10px; border-radius: 8px; background: var(--bg);
        border: 1px solid var(--divider); cursor: pointer; transition: background 0.15s;
      }
      .person-row:hover { background: var(--card-bg); }
      .person-row.person-home { border-color: var(--success-color, #43a047); }
      .person-row input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; flex-shrink: 0; accent-color: var(--primary); }
      .person-info { flex: 1; min-width: 0; }
      .person-name { display: block; font-size: 14px; font-weight: 500; color: var(--primary-text); }
      .person-entity { display: block; font-size: 11px; font-family: monospace; color: var(--secondary-text); }
      .person-badge {
        font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 8px;
        text-transform: lowercase; flex-shrink: 0;
      }
      .person-badge-home { background: #e8f5e9; color: #2e7d32; }
      .person-badge-away { background: var(--bg); color: var(--secondary-text); border: 1px solid var(--divider); }

      /* Zone list */
      .zone-list { display: flex; flex-direction: column; gap: 8px; }
      .zone-row {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 12px; border-radius: 8px;
        background: var(--bg); border: 1px solid var(--divider);
      }
      .zone-row.zone-active { border-color: var(--primary); background: rgba(var(--primary-rgb, 3,169,244), 0.06); }
      .zone-info { flex: 1; min-width: 0; }
      .zone-name {
        display: flex; align-items: center; gap: 6px;
        font-size: 14px; font-weight: 500; color: var(--primary-text);
      }
      .zone-active-icon { --mdc-icon-size: 14px; color: var(--primary); }
      .zone-meta { font-size: 12px; color: var(--secondary-text); margin-top: 2px; }
      .zone-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .zone-card-footer { justify-content: space-between; }
      .settings-hint-inline { font-size: 12px; color: var(--secondary-text); font-weight: 400; }
      .btn-danger { color: var(--error-color, #db4437) !important; }
      .btn-danger:hover { background: rgba(219,68,55,0.08) !important; }

      /* Responsive */
      @media (max-width: 600px) {
        .header { flex-direction: column; align-items: flex-start; }
        .entry-info { flex-direction: column; gap: 4px; }
        .day-tabs { flex-wrap: wrap; }
        .day-tab { min-width: 42px; }
        .day-actions { flex-direction: column; gap: 4px; }
        .entry-actions { flex-direction: column; gap: 4px; }
      }

      /* ── Command Center ─────────────────────────────────────────────── */
      .command-center { display: flex; flex-direction: column; gap: 16px; }

      .cc-main-row {
        display: grid; grid-template-columns: 1fr 270px; gap: 16px; align-items: start;
      }
      @media (max-width: 900px) { .cc-main-row { grid-template-columns: 1fr; } }

      /* Automation panel */
      .automation-panel {
        background: var(--card-bg); border-radius: 12px; border: 1px solid var(--divider); overflow: hidden;
      }
      .panel-title {
        display: flex; align-items: center; gap: 8px; padding: 12px 16px;
        font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;
        color: var(--secondary-text); border-bottom: 1px solid var(--divider); background: var(--bg);
      }
      .panel-title ha-icon { --mdc-icon-size: 15px; }

      .toggle-grid {
        display: grid; grid-template-columns: repeat(2, 1fr);
        gap: 1px; background: var(--divider);
      }
      @media (max-width: 700px) { .toggle-grid { grid-template-columns: 1fr; } }

      .toggle-card {
        display: flex; align-items: center; gap: 12px; padding: 14px 16px;
        background: var(--card-bg); transition: background 0.15s; cursor: default;
      }
      .toggle-card:hover { background: rgba(0,0,0,0.02); }
      .toggle-icon-wrap { flex-shrink: 0; transition: color 0.2s; }
      .toggle-icon-wrap ha-icon { --mdc-icon-size: 22px; }
      .toggle-card-on .toggle-icon-wrap { color: var(--primary); }
      .toggle-card-off .toggle-icon-wrap { color: var(--secondary-text); }
      .icon-active { opacity: 1; }
      .icon-idle { opacity: 0.45; }

      .toggle-card-body { flex: 1; min-width: 0; }
      .toggle-card-label { font-size: 14px; font-weight: 500; color: var(--primary-text); line-height: 1.2; }
      .toggle-card-desc { font-size: 11px; color: var(--secondary-text); margin-top: 2px; }
      .toggle-badge {
        display: inline-block; margin-top: 5px;
        font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 8px;
      }
      .badge-success { background: #e8f5e9; color: #2e7d32; }
      .badge-warn    { background: #fff8e1; color: #e65100; }
      .badge-danger  { background: #fce4ec; color: #c62828; }
      .badge-info    { background: #e3f2fd; color: #0d47a1; }
      .badge-neutral { background: var(--bg); color: var(--secondary-text); border: 1px solid var(--divider); }

      /* Quick panel */
      .quick-panel {
        display: flex; flex-direction: column; gap: 14px;
        background: var(--card-bg); border-radius: 12px; border: 1px solid var(--divider);
        padding: 14px 16px;
      }
      .qp-section { display: flex; flex-direction: column; gap: 6px; }
      .qp-label {
        font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;
        color: var(--secondary-text);
      }
      .qp-select {
        padding: 7px 10px; border-radius: 8px; border: 1px solid var(--divider);
        background: var(--bg); color: var(--primary-text); font-size: 14px; cursor: pointer; width: 100%;
      }
      .qp-select:focus { outline: none; border-color: var(--primary); }

      /* Override banner */
      .override-banner {
        display: flex; align-items: center; gap: 10px; padding: 10px 12px;
        background: #fff3e0; border: 1px solid #ff9800; border-radius: 8px; color: #e65100;
      }
      .override-banner ha-icon { --mdc-icon-size: 20px; flex-shrink: 0; }
      .override-info { flex: 1; }
      .override-label { display: block; font-size: 13px; font-weight: 600; }
      .override-sub { display: block; font-size: 11px; opacity: 0.85; }

      /* Mini zones */
      .mini-zones { display: flex; flex-direction: column; gap: 4px; }
      .mini-zone {
        display: flex; align-items: center; gap: 7px; padding: 5px 8px;
        border-radius: 6px; background: var(--bg); font-size: 13px;
      }
      .mini-zone-active {
        background: rgba(3,169,244,0.08); font-weight: 500;
        border: 1px solid rgba(3,169,244,0.2);
      }
      .mz-dot { font-size: 9px; color: var(--secondary-text); flex-shrink: 0; }
      .mini-zone-active .mz-dot { color: var(--primary); }
      .mz-name { flex: 1; }
      .mz-temp { font-weight: 600; font-size: 14px; }
      .mz-occ { font-size: 10px; padding: 1px 5px; border-radius: 6px; background: var(--divider); color: var(--secondary-text); }
      .occ-yes { background: #e8f5e9; color: #2e7d32; }

      /* TOU rate */
      .tou-rate-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .tou-rate-badge { font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 8px; }
      .tou-note { font-size: 11px; color: var(--secondary-text); }

      /* Schedule section card */
      .schedule-section {
        background: var(--card-bg); border-radius: 12px; border: 1px solid var(--divider); overflow: hidden;
      }
      .schedule-section-header {
        display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
        gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--divider); background: var(--bg);
      }
      .section-label {
        display: flex; align-items: center; gap: 6px;
        font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;
        color: var(--secondary-text);
      }
      .section-label ha-icon { --mdc-icon-size: 15px; }
      .schedule-controls-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .schedule-section-body { padding: 16px; }
      .schedule-section-body .day-tabs { margin-bottom: 16px; }
      .schedule-section-body .week-overview { margin-bottom: 20px; }

      /* Command center footer */
      .cc-footer { display: flex; align-items: center; gap: 12px; padding-top: 4px; }
    `;
  }
}

customElements.define("gttc-panel", GttcPanel);
