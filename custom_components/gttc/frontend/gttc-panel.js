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
    this._activeMainTab = "now";
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
    // Runtime / analytics
    this._runtimeData = null;
    this._runtimeRange = 30; // days: 7 | 30 | 90
    this._actionLog = null;
    // Settings: one draft across every section, one save bar
    this._draft = {};
    this._settingsSection = "season";
    // Vacation modal
    this._showVacationModal = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._schedule) {
      if (!this._loading) this._loadData();
      return;
    }
    // HA hands us a new hass object on every state change in the house. Only
    // the GTTC entities matter; when one of them moves, re-fetch and repaint.
    const sig = this._liveSignature(hass);
    if (sig !== this._liveSig) {
      this._liveSig = sig;
      this._queueLiveRefresh();
    }
  }

  // ── Live refresh ──────────────────────────────────────────────────────────

  _liveSignature(hass) {
    const ids = [
      this._diagData?.entity_ids?.climate || "climate.gttc",
      "select.gttc_season_mode",
      "switch.gttc_schedule",
      "binary_sensor.gttc_windows_open",
    ];
    return ids.map(id => hass.states[id]?.last_updated || "").join("|");
  }

  _queueLiveRefresh() {
    if (this._liveTimer) return;
    // Debounce, and never more than one refresh every 10s — climate.gttc's
    // attributes move every coordinator cycle.
    const wait = Math.max(1500, 10000 - (Date.now() - (this._lastFetchAt || 0)));
    this._liveTimer = setTimeout(() => {
      this._liveTimer = null;
      this._refreshLive();
    }, wait);
  }

  async _refreshLive() {
    if (!this._hass || this._loading) return;
    try {
      const [schedule, status, diagData] = await Promise.all([
        this._hass.callWS({ type: "gttc/get_schedule" }),
        this._hass.callWS({ type: "gttc/get_status" }),
        this._hass.callWS({ type: "gttc/get_diagnostics" }).catch(() => this._diagData),
      ]);
      this._schedule = schedule;
      this._status = status;
      this._diagData = diagData;
      this._activePreset = schedule.active_preset;
      this._lastFetchAt = Date.now();
      this._repaint();
    } catch (err) {
      console.warn("GTTC: live refresh failed", err);
    }
  }

  // True while the user is in the middle of something a repaint would destroy:
  // an open modal, a drag, or focus in a form field.
  _isBusy() {
    if (this._editingEntry || this._showCopyModal || this._showCopyDayModal || this._showPresetModal
        || this._showExportModal || this._showImportModal || this._showVacationModal) return true;
    if (this._dragActive) return true;
    if (this._activeMainTab === "settings") return true;
    const el = this.shadowRoot && this.shadowRoot.activeElement;
    return !!(el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
  }

  _repaint() {
    if (this._isBusy()) { this._repaintPending = true; return; }
    this._repaintPending = false;
    this._render();
  }

  disconnectedCallback() {
    if (this._liveTimer) { clearTimeout(this._liveTimer); this._liveTimer = null; }
  }

  set panel(panel) {
    this._config = panel.config || {};
  }

  async _loadData() {
    if (!this._hass) return;
    this._loading = true;
    try {
      const [schedule, status, diagData, configData, runtimeData] = await Promise.all([
        this._hass.callWS({ type: "gttc/get_schedule" }),
        this._hass.callWS({ type: "gttc/get_status" }),
        this._hass.callWS({ type: "gttc/get_diagnostics" }).catch(() => null),
        this._hass.callWS({ type: "gttc/get_config" }).catch(() => null),
        this._hass.callWS({ type: "gttc/get_runtime_history", days: 90 }).catch(() => null),
      ]);
      this._schedule = schedule;
      this._status = status;
      this._diagData = diagData;
      this._configData = configData;
      this._runtimeData = runtimeData;
      this._activePreset = schedule.active_preset;
      this._lastFetchAt = Date.now();
      this._liveSig = this._liveSignature(this._hass);
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
        const end = encodeURIComponent(new Date().toISOString());
        Promise.all([
          this._hass.callApi("GET",
            `history/period/${start}?end_time=${end}&filter_entity_id=${entityId}&minimal_response=true&no_attributes=true`
          ),
          climateId
            ? this._hass.callApi("GET", `history/period/${start}?end_time=${end}&filter_entity_id=${climateId}`)
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
    } finally {
      this._loading = false;
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
    const tab = this._activeMainTab;
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
        ${this._renderSeasonStrip()}

        <div class="content">
          ${tab === "now" ? this._renderNowTab()
            : tab === "schedule" ? this._renderScheduleTab()
            : tab === "history" ? this._renderHistoryTab()
            : this._renderSettingsTab()}
        </div>

        ${this._editingEntry ? this._renderEditModal() : ""}
        ${this._showCopyModal ? this._renderCopyModal() : ""}
        ${this._showCopyDayModal ? this._renderCopyDayModal() : ""}
        ${this._showPresetModal ? this._renderPresetModal() : ""}
        ${this._showExportModal ? this._renderExportModal() : ""}
        ${this._showImportModal ? this._renderImportModal() : ""}
        ${this._showVacationModal ? this._renderVacationModal() : ""}
        ${this._toast ? this._renderToast() : ""}
      </div>
    `;
    this._attachListeners();
  }

  // ── Status bar ────────────────────────────────────────────────────────────

  _renderStatus() {
    const st = this._status;
    const parts = [];
    if (st && st.override_active && this._activeMainTab !== "now") {
      const label = st.override_source === "physical" ? "Thermostat hold" : "Override";
      parts.push(`<span class="status-item override">${label} · ${st.override_remaining}m
        <button class="btn-cancel-override js-cancel-override" title="Resume schedule">✕</button>
      </span>`);
    }
    if (this._lastFetchAt) {
      const t = new Date(this._lastFetchAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      parts.push(`<button class="status-item status-live" id="statusRefreshBtn" title="Fetch now"><span class="live-dot"></span>Live · ${t}</button>`);
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
    const presetData = s.presets || {};
    const custom = s.active_preset && presetData[s.active_preset] && !presetData[s.active_preset].is_builtin;
    return `
      <div class="preset-group">
        <button class="btn btn-outline btn-small" id="createPresetBtn" title="Create a preset">+ New preset</button>
        ${custom ? `
          <button class="btn btn-icon btn-small" id="renamePresetBtn" title="Rename this preset">
            <ha-icon icon="mdi:pencil"></ha-icon>
          </button>
          <button class="btn btn-icon btn-small btn-danger" id="deletePresetBtn" title="Delete this preset">✕</button>
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

  _getDayGroups() {
    const s = this._schedule;
    if (!s) return DAYS_ORDERED.map(d => ({ days: [d], label: DAY_LABELS[d], representative: d }));

    // In weekday_weekend mode the days already share two templates — no need to compare
    if (s.mode === "weekday_weekend" && !s.active_preset) {
      const wdStr = JSON.stringify(s.weekday || []);
      const weStr = JSON.stringify(s.weekend || []);
      if (wdStr === weStr) {
        return [{ days: DAYS_ORDERED, label: "All Days", representative: "monday" }];
      }
      return [
        { days: ["monday","tuesday","wednesday","thursday","friday"], label: "Mon–Fri", representative: "monday" },
        { days: ["saturday","sunday"], label: "Sat–Sun", representative: "saturday" },
      ];
    }

    // per_day mode (or active preset): detect identical day groups
    const groups = [];
    const used = new Set();
    for (const day of DAYS_ORDERED) {
      if (used.has(day)) continue;
      const sig = JSON.stringify(this._getEntriesForDay(day));
      const matching = DAYS_ORDERED.filter(d => !used.has(d) && JSON.stringify(this._getEntriesForDay(d)) === sig);
      groups.push({ days: matching, label: this._groupLabel(matching), representative: day });
      matching.forEach(d => used.add(d));
    }
    return groups;
  }

  _groupLabel(days) {
    if (days.length === 7) return "All Days";
    if (days.length === 1) return DAY_LABELS[days[0]];
    const joined = days.join(",");
    if (joined === "monday,tuesday,wednesday,thursday,friday") return "Mon–Fri";
    if (joined === "saturday,sunday") return "Sat–Sun";
    return days.map(d => DAY_LABELS[d]).join(", ");
  }

  _renderWeekOverview() {
    const groups = this._getDayGroups();
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
        ${groups.map(group => {
          const rep = group.representative;
          const entries = this._getEntriesForDay(rep);
          const isSelected = group.days.includes(this._selectedDay);
          return `
            <div class="week-row ${isSelected ? "selected" : ""}" data-day="${rep}"
                 title="${group.days.map(d => DAY_LABELS_FULL[d]).join(', ')}">
              <div class="week-row-label">${group.label}</div>
              <div class="week-row-timeline">
                ${this._renderOnPeakOverlay(rep)}
                ${this._renderTimelineBlocks(entries, rep, true)}
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
    const groups = this._getDayGroups();
    const group = groups.find(g => g.days.includes(day)) || { label: DAY_LABELS_FULL[day], days: [day] };
    const titleStr = group.days.length > 1 ? `${group.label} Schedule` : `${DAY_LABELS_FULL[day]} Schedule`;
    const subtitleStr = group.days.length > 1
      ? `<span class="day-group-subtitle">${group.days.map(d => DAY_LABELS_FULL[d]).join(' · ')}</span>`
      : "";
    return `
      <div class="day-detail">
        <div class="day-detail-header">
          <div class="day-detail-title">
            <h2>${titleStr}</h2>
            ${subtitleStr}
          </div>
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
      const cooling = this._isCooling();
      const temp = this._seasonTemp(entry);
      const other = this._otherSeasonTemp(entry);
      const clamp = this._clampNote(entry);
      const color = temp != null ? tempColor(temp, s.temp_min, s.temp_max) : "var(--divider)";
      const textColor = "rgba(255,255,255,0.95)";
      const zoneLabel = entry.zone_id ? ` [${this._getZoneName(entry.zone_id)}]` : "";
      const extraBadges = [
        clamp ? `<span class="block-badge clamp-badge" title="${clamp.text}">⚠</span>` : "",
        other != null ? `<span class="block-badge ${cooling ? "heat-badge" : "cool-badge"}">${cooling ? "▲" : "▼"}${other}°</span>` : "",
        entry.away_temp != null && !cooling ? `<span class="block-badge away-badge">away ${entry.away_temp}°</span>` : "",
      ].filter(Boolean).join("");
      const tempText = `${this._fmtTemp(temp)}${this._seasonTempIsFallback(entry) ? "*" : ""}`;
      return `
        <div class="timeline-block ${compact ? "compact" : ""}"
             style="left:${leftPct}%;width:${widthPct}%;background:${color};color:${textColor}"
             data-day="${day}" data-index="${i}"
             title="${formatTime12(entry.time_start)} - ${formatTime12(entry.time_end)}: heat ${entry.target_temp}°F / cool ${entry.cooling_temp != null ? entry.cooling_temp + "°F" : "default"}${entry.away_temp != null ? ` / away ${entry.away_temp}°F` : ""}${zoneLabel}${clamp ? ` — ${clamp.text}` : ""}">
          ${compact
            ? `<span class="block-temp">${tempText}${extraBadges}</span>`
            : `<span class="block-temp">${tempText}${extraBadges}</span>
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
    const cooling = this._isCooling();
    const temp = this._seasonTemp(entry);
    const other = this._otherSeasonTemp(entry);
    const clamp = this._clampNote(entry);
    const color = temp != null ? tempColor(temp, s.temp_min, s.temp_max) : "var(--divider)";
    const zoneLabel = entry.zone_id ? this._getZoneName(entry.zone_id) : "";
    return `
      <div class="entry-card" data-day="${day}" data-index="${index}">
        <div class="entry-color" style="background:${color}"></div>
        <div class="entry-info">
          <span class="entry-time">${formatTime12(entry.time_start)} — ${formatTime12(entry.time_end)}</span>
          <span class="entry-temp">${this._fmtTemp(temp)}<span class="entry-temp-kind">${cooling ? "cool" : "heat"}${this._seasonTempIsFallback(entry) ? " · default" : ""}</span></span>
          <span class="entry-other">${cooling ? "heat" : "cool"} ${other != null ? other + "°" : "default"}${entry.away_temp != null ? ` · away ${entry.away_temp}°` : ""}</span>
          ${zoneLabel ? `<span class="entry-zone">${zoneLabel}</span>` : ""}
          ${clamp ? `<span class="entry-clamp">⚠ ${clamp.text}</span>` : ""}
        </div>
        <div class="entry-actions">
          <button class="btn btn-sm btn-copy" data-action="copy" data-day="${day}" data-index="${index}" title="Copy to other days">Copy</button>
          <button class="btn btn-sm btn-edit" data-action="edit" data-day="${day}" data-index="${index}">Edit</button>
          <button class="btn btn-sm btn-delete" data-action="delete" data-day="${day}" data-index="${index}">Delete</button>
        </div>
      </div>
    `;
  }

  // ── Season ────────────────────────────────────────────────────────────────
  // Every schedule entry carries two numbers: target_temp (heating) and
  // cooling_temp. Which one is in force depends on the season, so everything
  // that shows "the" temperature of a block must go through _seasonTemp.

  _season() {
    return this._diagData?.season || this._settingsData?.season || "heating";
  }

  _isCooling() {
    return this._season() === "cooling";
  }

  // Mirrors _calculate_desired_temp: cooling uses the entry's cooling_temp,
  // falling back to the global cooling comfort when the entry has none.
  _seasonTemp(entry) {
    if (!entry) return null;
    if (this._isCooling()) {
      if (entry.cooling_temp != null) return entry.cooling_temp;
      return this._diagData?.cooling_comfort ?? this._settingsData?.cooling_comfort ?? null;
    }
    return entry.target_temp;
  }

  // True when a cooling-season number is the global fallback, not the entry's own.
  _seasonTempIsFallback(entry) {
    return this._isCooling() && entry && entry.cooling_temp == null;
  }

  _otherSeasonTemp(entry) {
    if (!entry) return null;
    return this._isCooling() ? entry.target_temp : entry.cooling_temp;
  }

  _fmtTemp(v) {
    return v == null ? "—" : `${v}°`;
  }

  // A block whose goal plus the wall/zone offset lands past temp_min/temp_max
  // is clamped at the wall, so the zone settles short of the goal. Only the
  // active zone's offset is known, so only its blocks (or zoneless ones) warn.
  _clampNote(entry) {
    const d = this._diagData;
    const s = this._schedule;
    if (!d || !s || d.zone_offset == null) return null;
    if (entry.zone_id && d.active_zone_id && entry.zone_id !== d.active_zone_id) return null;
    const goal = this._seasonTemp(entry);
    if (goal == null) return null;
    const wall = goal + d.zone_offset;
    const cap = wall > s.temp_max ? s.temp_max : wall < s.temp_min ? s.temp_min : null;
    if (cap == null || Math.abs(wall - cap) < 0.25) return null;
    const settles = Math.round((cap - d.zone_offset) * 10) / 10;
    return {
      goal, cap, settles,
      text: `Wall capped at ${cap}° (${cap === s.temp_max ? "max" : "min"}); with the ${d.zone_offset > 0 ? "+" : ""}${d.zone_offset}° offset this zone settles near ${settles}°, not ${goal}°.`,
    };
  }

  _renderSeasonStrip() {
    const d = this._diagData;
    if (!d) return "";
    const s = this._schedule;
    const cooling = this._isCooling();
    const other = cooling ? "heating" : "cooling";
    const otherLabel = cooling ? "Heating" : "Cooling";
    const hours = d.season_conditions_hours || 0;
    const need = d.seasonal_recommend_hours || 0;
    const pct = need > 0 ? Math.min(100, (hours / need) * 100) : 0;
    const outdoor = d.features?.outdoor_temp;
    let meta;
    if (d.suggest_season_switch) {
      meta = `<b>${otherLabel} conditions for ${hours.toFixed(1)}h</b> — switch recommended`;
    } else if (hours > 0) {
      meta = `<b>${otherLabel} conditions ${hours.toFixed(1)}h of ${need}h</b>`;
    } else {
      meta = `<b>No switch recommended</b>${outdoor != null ? ` · outside ${outdoor.toFixed(1)}°` : ""}`;
    }
    const labels = s.preset_labels || {};
    return `
      <div class="season-strip ${d.suggest_season_switch ? "season-strip-suggest" : ""}">
        <div class="season-seg" role="group" aria-label="Season">
          <button class="season-seg-btn seg-heat" id="seasonHeatBtn" aria-pressed="${!cooling}">
            <ha-icon icon="mdi:fire"></ha-icon> Heat
          </button>
          <button class="season-seg-btn seg-cool" id="seasonCoolBtn" aria-pressed="${cooling}">
            <ha-icon icon="mdi:snowflake"></ha-icon> Cool
          </button>
        </div>
        <div class="season-meta">
          <span>${meta} · auto-switch ${d.auto_season_switch ? "on" : "off"}</span>
          ${need > 0 && hours > 0 ? `<span class="season-meter" aria-hidden="true"><i style="width:${pct.toFixed(0)}%"></i></span>` : ""}
        </div>
        ${d.suggest_season_switch ? `
          <button class="btn btn-primary season-cta" data-season-switch="${other}">Switch to ${otherLabel}</button>
        ` : ""}
        <label class="strip-preset">
          <span>Preset</span>
          <select class="preset-select" id="presetSelect">
            ${Object.entries(labels).map(([key, label]) =>
              `<option value="${key}" ${s.active_preset === key ? "selected" : ""}>${label}</option>`
            ).join("")}
            <option value="" ${!s.active_preset ? "selected" : ""}>No preset (base fallback)</option>
          </select>
        </label>
      </div>
    `;
  }

  async _setSeason(season) {
    if (season === this._season()) return;
    try {
      await this._hass.callWS({ type: "gttc/set_season", season });
      if (this._settingsData) this._settingsData = { ...this._settingsData, season };
      await this._loadData();
      this._showToast(season === "cooling"
        ? "Cooling season — thermostat set to Cool."
        : "Heating season — thermostat set to Heat.");
    } catch (err) {
      this._showToast(`Season not changed: ${err.message || err}`, "error");
    }
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
            ${this._isCooling() ? this._renderCoolingField(entry, s) : ""}
            <div class="form-row">
              <label>Heating target (°F)${this._isCooling() ? "" : ` <span class="form-label-now">in use now</span>`}</label>
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
            ${this._isCooling() ? "" : this._renderCoolingField(entry, s)}
            <div class="form-row">
              <label>Away Temp (\u00b0F) <span class="form-label-hint">setback when nobody home — leave blank to use global away</span></label>
              <div class="temp-input-row">
                <input type="number" id="editAwayTemp" min="${s.temp_min}" max="${s.temp_max}" step="0.5"
                       placeholder="global away"
                       value="${entry.away_temp != null ? entry.away_temp : ""}">
                <span class="temp-unit">\u00b0F</span>
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

  _renderCoolingField(entry, s) {
    const fallback = this._diagData?.cooling_comfort ?? this._settingsData?.cooling_comfort;
    return `
            <div class="form-row">
              <label>Cooling target (°F)${this._isCooling() ? ` <span class="form-label-now">in use now</span>` : ""}
                <span class="form-label-hint">blank = cooling comfort${fallback != null ? ` (${fallback}°)` : ""}</span></label>
              <div class="temp-input-row">
                <input type="range" id="editCoolingTempRange" min="${s.temp_min}" max="${s.temp_max}" step="1"
                       value="${entry.cooling_temp != null ? entry.cooling_temp : (fallback ?? 74)}">
                <input type="number" id="editCoolingTemp" min="${s.temp_min}" max="${s.temp_max}" step="0.5"
                       placeholder="${fallback != null ? fallback : "default"}"
                       value="${entry.cooling_temp != null ? entry.cooling_temp : ""}">
                <span class="temp-unit">°F</span>
              </div>
            </div>`;
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
            ${formatTime12(entry.entry.time_start)} — ${formatTime12(entry.entry.time_end)} at ${this._fmtTemp(this._seasonTemp(entry.entry))}F
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

    // Season strip
    this._addClick("seasonHeatBtn", () => this._setSeason("heating"));
    this._addClick("seasonCoolBtn", () => this._setSeason("cooling"));
    root.querySelectorAll("[data-season-switch]").forEach(btn => {
      btn.addEventListener("click", () => this._setSeason(btn.dataset.seasonSwitch));
    });

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
          if (tab === "history") this._loadActionLog();
        }
      });
    });

    // Now tab
    this._addClick("goScheduleBtn", () => { this._activeMainTab = "schedule"; this._render(); });
    root.querySelectorAll("[data-auto-toggle]").forEach(chip => {
      chip.addEventListener("click", () => {
        chip.disabled = true;
        this._handleAutomationToggle(chip.dataset.autoToggle, chip.dataset.on !== "1");
      });
    });
    root.querySelectorAll("[data-now-zone]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await this._hass.callWS({ type: "gttc/set_active_zone", zone_id: btn.dataset.nowZone });
          await this._loadData();
        } catch (err) { this._showToast(`Zone not changed: ${err.message || err}`, "error"); }
      });
    });

    // Command center refresh
    this._addClick("statusRefreshBtn", () => {
      this._historyData = null;
      this._hvacHistory = null;
      this._loadData();
    });


    // "Manage in Settings" link
    root.querySelectorAll(".js-window-settings").forEach(btn => btn.addEventListener("click", () => {
      this._activeMainTab = "settings";
      this._loadSettingsData();
    }));

    // Boost buttons
    root.querySelectorAll(".boost-btn").forEach(btn => {
      btn.addEventListener("click", () => this._activateBoost(btn.dataset.boostType));
    });

    // Vacation mode
    this._addClick("setVacationBtn", () => {
      this._showVacationModal = true;
      this._render();
    });
    this._addClick("clearVacationBtn", () => this._clearVacation());
    this._addClick("cancelVacation", () => { this._showVacationModal = false; this._render(); });
    this._addClick("confirmVacation", () => this._saveVacation());
    const vacModalOverlay = root.getElementById("vacationModalOverlay");
    if (vacModalOverlay) {
      vacModalOverlay.addEventListener("click", (e) => {
        if (e.target === vacModalOverlay) { this._showVacationModal = false; this._render(); }
      });
    }

    // Runtime range selector
    root.querySelectorAll(".range-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this._runtimeRange = parseInt(btn.dataset.range);
        this._render();
      });
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
      presetSelect.addEventListener("change", () => {
        const value = presetSelect.value;
        if (!value && this._schedule.active_preset) {
          const summary = this._baseScheduleSummary();
          if (!confirm(`Turn off the "${this._schedule.preset_labels?.[this._schedule.active_preset] || this._schedule.active_preset}" preset?\n\nThe house will fall back to the base schedule${summary ? ` (${summary})` : ""}.`)) {
            presetSelect.value = this._schedule.active_preset;
            return;
          }
        }
        this._setPreset(value);
      });
    }

    // Schedule mode selector
    const modeSelect = root.getElementById("modeSelect");
    if (modeSelect) {
      modeSelect.addEventListener("change", () => this._setScheduleMode(modeSelect.value));
    }

    // Cancel override — the header and the banner both carry one, so bind by class
    root.querySelectorAll(".js-cancel-override").forEach(btn => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); this._cancelOverride(); });
    });

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

    // Cooling temp slider/input sync
    const coolingRange = root.getElementById("editCoolingTempRange");
    const coolingInput = root.getElementById("editCoolingTemp");
    if (coolingRange && coolingInput) {
      coolingRange.addEventListener("input", () => {
        coolingInput.value = coolingRange.value;
      });
      coolingInput.addEventListener("input", () => {
        if (coolingInput.value !== "") coolingRange.value = coolingInput.value;
      });
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
    this._repaintPending = false;
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

    this._dragActive = true;
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
      this._dragActive = false;

      if (!this._wasDragging) return;

      const block = handle.closest(".timeline-block");
      const newStart = block ? block.dataset.dragStart || origStart : origStart;
      const newEnd = block ? block.dataset.dragEnd || origEnd : origEnd;

      if (newStart !== origStart || newEnd !== origEnd) {
        this._resizeEntry(day, entry, newStart, newEnd);
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // update_entry REPLACES the entry, so every field must be sent back —
  // omitting cooling_temp / away_temp here used to wipe them on every drag.
  async _resizeEntry(day, entry, newStart, newEnd) {
    const msg = {
      type: "gttc/update_entry",
      day, time_start: newStart, time_end: newEnd, target_temp: entry.target_temp,
      old_time_start: entry.time_start, old_time_end: entry.time_end,
    };
    if (entry.cooling_temp != null) msg.cooling_temp = entry.cooling_temp;
    if (entry.away_temp != null) msg.away_temp = entry.away_temp;
    if (entry.zone_id) msg.zone_id = entry.zone_id;
    const s = this._schedule;
    if (s.active_preset) msg.preset = s.active_preset;

    try {
      await this._hass.callWS(msg);
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to resize entry", err);
      this._showToast(`Resize failed: ${err.message || err}`, "error");
      await this._loadData();
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
    const coolingTempVal = root.getElementById("editCoolingTemp")?.value.trim();
    const coolingTemp = coolingTempVal !== "" ? parseFloat(coolingTempVal) : undefined;
    const zoneSelect = root.getElementById("editZone");
    const zoneId = zoneSelect ? zoneSelect.value || undefined : undefined;
    const e = this._editingEntry;

    const awayTempVal = root.getElementById("editAwayTemp")?.value.trim();
    const awayTemp = awayTempVal !== "" ? parseFloat(awayTempVal) : undefined;

    const msg = { type: "gttc/update_entry", day: e.day, time_start: start, time_end: end, target_temp: temp };
    if (coolingTemp !== undefined && !isNaN(coolingTemp)) msg.cooling_temp = coolingTemp;
    if (awayTemp !== undefined && !isNaN(awayTemp)) msg.away_temp = awayTemp;
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
    const coolingTempVal = root.getElementById("editCoolingTemp")?.value.trim();
    const coolingTemp = coolingTempVal !== "" ? parseFloat(coolingTempVal) : undefined;
    const zoneSelect = root.getElementById("editZone");
    const zoneId = zoneSelect ? zoneSelect.value || undefined : undefined;

    const container = root.getElementById("bulkDayCheckboxes");
    const days = [];
    if (container) {
      container.querySelectorAll("input[type='checkbox']:checked").forEach(cb => days.push(cb.value));
    }
    if (days.length === 0) { alert("Please select at least one day."); return; }

    const awayTempVal = root.getElementById("editAwayTemp")?.value.trim();
    const awayTemp = awayTempVal ? parseFloat(awayTempVal) : undefined;
    const msg = { type: "gttc/bulk_add_entry", days, time_start: start, time_end: end, target_temp: temp };
    if (coolingTemp !== undefined && !isNaN(coolingTemp)) msg.cooling_temp = coolingTemp;
    if (awayTemp !== undefined && !isNaN(awayTemp)) msg.away_temp = awayTemp;
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
    if (!confirm(`Delete ${formatTime12(entry.time_start)} - ${formatTime12(entry.time_end)} (${this._fmtTemp(this._seasonTemp(entry))}F)?`)) return;
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

  // One-line description of the dormant base lists, for the "no preset" warning.
  _baseScheduleSummary() {
    const s = this._schedule;
    if (!s) return "";
    const list = s.mode === "per_day" ? (s.per_day?.monday || []) : (s.weekday || []);
    if (list.length === 0) return "empty";
    if (list.length === 1) {
      const e = list[0];
      const allDay = e.time_start === "00:00" && e.time_end >= "23:59";
      return allDay ? `${e.target_temp}\u00b0 all day` : `${e.target_temp}\u00b0 ${formatTime12(e.time_start)}\u2013${formatTime12(e.time_end)}`;
    }
    return `${list.length} blocks`;
  }

  async _setPreset(presetName) {
    try {
      if (presetName) {
        await this._hass.callService("gttc", "set_preset", { preset: presetName });
      } else {
        await this._hass.callWS({ type: "gttc/deactivate_preset" });
      }
      await new Promise(r => setTimeout(r, 500));
      await this._loadData();
      const label = presetName ? (this._schedule?.preset_labels?.[presetName] || presetName) : "Base fallback";
      this._showToast(`Schedule: ${label}`);
    } catch (err) {
      console.error("GTTC: Failed to set preset", err);
      this._showToast(`Preset not changed: ${err.message || err}`, "error");
      await this._loadData();
    }
  }

  async _setScheduleMode(mode) {
    try {
      await this._hass.callWS({ type: "gttc/set_schedule_mode", mode });
      await new Promise(r => setTimeout(r, 300));
      await this._loadData();
    } catch (err) {
      console.error("GTTC: Failed to set schedule mode", err);
      this._showToast(`Mode not changed: ${err.message || err}`, "error");
      await this._loadData();
    }
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

  // ── Boost / Timed presets ─────────────────────────────────────────────────

  async _activateBoost(boostType) {
    try {
      const result = await this._hass.callWS({ type: "gttc/activate_timed_preset", boost_type: boostType });
      const label = result.label || boostType;
      const temp = result.target_temp;
      const dur = result.duration_minutes;
      this._showToast(`${label}: ${temp}° for ${dur} min`);
      await this._loadData();
    } catch (err) {
      this._showToast("Boost failed: " + (err.message || err), "error");
    }
  }

  // ── Vacation mode actions ─────────────────────────────────────────────────

  async _saveVacation() {
    const root = this.shadowRoot;
    const temp = parseFloat(root.getElementById("vacationTemp")?.value);
    const start = root.getElementById("vacationStart")?.value;
    const end = root.getElementById("vacationEnd")?.value;
    const label = root.getElementById("vacationLabel")?.value.trim() || "Vacation";
    if (!start || !end || isNaN(temp)) { this._showToast("Please fill in all fields.", "error"); return; }
    if (new Date(end) <= new Date(start)) { this._showToast("Return date must be after departure.", "error"); return; }
    try {
      await this._hass.callWS({
        type: "gttc/set_vacation",
        setback_temp: temp,
        start_dt: new Date(start + "T00:00:00").toISOString(),
        end_dt: new Date(end + "T23:59:59").toISOString(),
        label,
      });
      this._showVacationModal = false;
      this._showToast(`Vacation mode set — returns ${new Date(end).toLocaleDateString()}`);
      await this._loadData();
    } catch (err) {
      this._showToast("Failed to set vacation: " + (err.message || err), "error");
    }
  }

  async _clearVacation() {
    try {
      await this._hass.callWS({ type: "gttc/clear_vacation" });
      this._showToast("Vacation mode cancelled");
      await this._loadData();
    } catch (err) {
      this._showToast("Failed to clear vacation: " + (err.message || err), "error");
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

  _actionReasonLabel(d) {
    if (!d) return "—";
    const reason = d.hvac_action_reason;
    const map = {
      manual_override: `Override · ${d.override_remaining_minutes || 0}m left`,
      physical_override: `Thermostat override · ${d.override_remaining_minutes || 0}m left`,
      vacation: "Vacation mode",
      occupancy_away: "Nobody home",
      schedule: "Schedule",
      precondition: "Pre-conditioning",
      tou_adjustment: "TOU optimization",
      heat_pump_step: "Heat pump step",
      fan_precool: "Fan pre-cool",
      window_open: "Windows open",
      fallback: "Fallback",
    };
    return map[reason] || (d.schedule_enabled ? "Schedule" : "Manual");
  }

  // ── Command Center ────────────────────────────────────────────────────────

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

  _renderRuntimeChart() {
    const rd = this._runtimeData;
    if (!rd || !rd.history || rd.history.length === 0) return "";
    const days = this._runtimeRange;
    const today = rd.today;
    const daily = (today && today.date
      ? [...rd.history.filter(x => x.date !== today.date), today]
      : [...rd.history]).slice(-days);

    let bars;
    if (days <= 7) {
      bars = daily.map(x => ({
        label: new Date(x.date + "T12:00:00").toLocaleDateString([], { weekday: "short" }),
        title: new Date(x.date + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" }),
        heat: x.heating_min || 0, cool: x.cooling_min || 0, outdoor: x.avg_outdoor,
      }));
    } else {
      const weeks = new Map();
      for (const x of daily) {
        const dt = new Date(x.date + "T12:00:00");
        const monday = new Date(dt);
        monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
        const key = monday.toISOString().slice(0, 10);
        if (!weeks.has(key)) weeks.set(key, { start: monday, heat: 0, cool: 0, out: [], n: 0 });
        const w = weeks.get(key);
        w.heat += x.heating_min || 0;
        w.cool += x.cooling_min || 0;
        w.n += 1;
        if (x.avg_outdoor != null) w.out.push(x.avg_outdoor);
      }
      bars = [...weeks.values()].map(w => ({
        label: w.start.toLocaleDateString([], { month: "short", day: "numeric" }),
        title: `Week of ${w.start.toLocaleDateString([], { month: "short", day: "numeric" })}${w.n < 7 ? ` (${w.n} days)` : ""}`,
        heat: w.heat, cool: w.cool,
        outdoor: w.out.length ? w.out.reduce((a, b) => a + b, 0) / w.out.length : null,
      }));
    }
    const max = Math.max(1, ...bars.map(b => b.heat + b.cool));
    const hours = (m) => m >= 60 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m)}m`;
    const totalHeat = bars.reduce((a, b) => a + b.heat, 0);
    const totalCool = bars.reduce((a, b) => a + b.cool, 0);
    return `
      <div class="chart-card runtime-chart">
        <div class="chart-title">
          HVAC runtime · ${days <= 7 ? "daily" : "weekly"}
          <span class="chart-legend"><span class="legend-dot hvac-heat"></span> Heating ${hours(totalHeat)}</span>
          <span class="chart-legend"><span class="legend-dot hvac-cool"></span> Cooling ${hours(totalCool)}</span>
          <div class="range-selector">
            ${[7, 30, 90].map(r => `
              <button class="range-btn ${days === r ? "active" : ""}" data-range="${r}">${r}d</button>
            `).join("")}
          </div>
        </div>
        <div class="rt-bars">
          ${bars.map(b => `
            <div class="rt-col" title="${b.title}: heating ${hours(b.heat)}, cooling ${hours(b.cool)}${b.outdoor != null ? `, outside avg ${b.outdoor.toFixed(0)}°` : ""}">
              <div class="rt-stack">
                ${b.cool > 0 ? `<div class="rt-bar cool-bar" style="height:${(b.cool / max * 100).toFixed(1)}%"></div>` : ""}
                ${b.heat > 0 ? `<div class="rt-bar heat-bar" style="height:${(b.heat / max * 100).toFixed(1)}%"></div>` : ""}
              </div>
              <div class="rt-label">${b.label}</div>
              <div class="rt-out">${b.outdoor != null ? b.outdoor.toFixed(0) + "°" : ""}</div>
            </div>
          `).join("")}
        </div>
        <div class="runtime-note">Bottom row: average outside temperature${rd.learned_ramp_minutes ? ` · adaptive lead time ${rd.learned_ramp_minutes.toFixed(0)} min` : ""}</div>
      </div>
    `;
  }

  _renderVacationModal() {
    const today = new Date().toISOString().slice(0, 10);
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    return `
      <div class="modal-overlay" id="vacationModalOverlay">
        <div class="modal">
          <h3>Set Vacation Mode</h3>
          <p class="modal-hint">GTTC will hold a setback temperature until your return date, then resume normal scheduling.</p>
          <div class="form-row">
            <label>Setback Temperature (°F)</label>
            <input type="number" id="vacationTemp" min="50" max="80" step="1" value="62">
          </div>
          <div class="form-row">
            <label>Departure Date</label>
            <input type="date" id="vacationStart" value="${today}">
          </div>
          <div class="form-row">
            <label>Return Date</label>
            <input type="date" id="vacationEnd" value="${nextWeek}">
          </div>
          <div class="form-row">
            <label>Label (optional)</label>
            <input type="text" id="vacationLabel" value="Vacation" maxlength="40">
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-cancel" id="cancelVacation">Cancel</button>
            <button type="button" class="btn btn-save" id="confirmVacation">Set Vacation</button>
          </div>
        </div>
      </div>
    `;
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
    const dirty = Object.keys(this._draft || {}).length > 0;
    const tabs = [
      { id: "now", icon: "mdi:home-thermometer", label: "Now" },
      { id: "schedule", icon: "mdi:calendar-clock", label: "Schedule" },
      { id: "history", icon: "mdi:chart-line", label: "History" },
      { id: "settings", icon: "mdi:cog", label: dirty ? "Settings •" : "Settings" },
    ];
    return `
      <nav class="main-tab-bar">
        ${tabs.map(t => `
          <button class="main-tab ${this._activeMainTab === t.id ? "active" : ""}" data-main-tab="${t.id}">
            <ha-icon icon="${t.icon}"></ha-icon> ${t.label}
          </button>
        `).join("")}
      </nav>
    `;
  }

  // ── Status tab ────────────────────────────────────────────────────────────

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

    const goalTemps = goalSteps.map(s => s.temp).filter(v => v != null);
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
    const COLOR_IDLE = "#9e9e9e";
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
            temp: this._seasonTemp(entry),
            zone_id: entry.zone_id || null,
          });
        }
      }
    }

    return steps.sort((a, b) => a.tStart - b.tStart);
  }

  _renderDebugCard(d) {
    const row = (k, v, mono) => `<div class="debug-row"><span>${k}</span><span class="debug-val ${mono ? "mono" : ""}">${v}</span></div>`;
    const e = d.current_entry;
    return `
      <details class="debug-card">
        <summary class="debug-toggle">Diagnostics</summary>
        <div class="debug-body">
          <div class="debug-grid">
            <div class="debug-section">
              <div class="debug-section-title">Thermostat</div>
              ${row("Entity", d.thermostat_entity, true)}
              ${row("Wall reads", d.thermostat_temp != null ? d.thermostat_temp + "°" : "—")}
              ${row("Setpoint sent", d.thermostat_setpoint != null ? d.thermostat_setpoint + "°" : "—")}
              ${row("Wall − zone offset", d.zone_offset != null ? (d.zone_offset > 0 ? "+" : "") + d.zone_offset + "°" : "—")}
              ${row("Wall action", d.thermostat_action || "—")}
            </div>
            <div class="debug-section">
              <div class="debug-section-title">Schedule</div>
              ${row("Enabled", d.schedule_enabled ? "Yes" : "No")}
              ${row("Block", e ? `${e.time_start}–${e.time_end}` : "None")}
              ${row("Block goal", e ? `heat ${e.target_temp}° · cool ${e.cooling_temp != null ? e.cooling_temp + "°" : "default"}` : "—")}
              ${row("Decision", this._reasonLabel(d.hvac_action_reason || "—"))}
            </div>
            <div class="debug-section">
              <div class="debug-section-title">Config</div>
              ${row("Temp range", `${d.config.temp_min}° – ${d.config.temp_max}°`)}
              ${row("Away temp", `${d.config.away_temp}°`)}
              ${row("Override length", `${d.config.override_minutes} min`)}
            </div>
            <div class="debug-section">
              <div class="debug-section-title">Entities</div>
              ${row("Climate", d.entity_ids?.climate || "—", true)}
              ${row("Zone temp", d.entity_ids?.active_zone_temp || "—", true)}
            </div>
          </div>
        </div>
      </details>
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
    if (this._settingsLoading && !this._settingsData) {
      return `<div class="status-loading"><ha-icon icon="mdi:loading"></ha-icon> Loading…</div>`;
    }
    if (!this._settingsData) {
      return `
        <div class="status-error-box">
          <div class="status-error-msg">
            <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
            ${this._settingsError ? `Failed to load: <code>${this._settingsError}</code>` : "No config data available."}
          </div>
          <button class="btn btn-outline" id="settingsRetryBtn">Retry</button>
        </div>`;
    }
    const sections = this._settingsSections();
    const cur = sections.find(x => x.id === this._settingsSection) || sections[0];
    const n = Object.keys(this._draft).length;
    return `
      <div class="settings-layout">
        <nav class="set-nav">
          ${sections.map(x => {
            const dirty = x.keys.some(k => this._isDirty(k));
            return `<button class="set-nav-item ${x.id === cur.id ? "active" : ""}" data-set-section="${x.id}">
              <ha-icon icon="${x.icon}"></ha-icon><span>${x.label}</span>
              <span class="set-nav-dot" data-dirty-for="${x.id}" ${dirty ? "" : "hidden"}></span>
            </button>`;
          }).join("")}
        </nav>
        <div class="set-pane">
          <h2 class="set-title">${cur.label}</h2>
          ${this[`_renderSettings_${cur.id}`]()}
        </div>
      </div>
      ${this._renderEntityDatalists()}
      <div class="save-bar" id="saveBar" ${n ? "" : "hidden"}>
        <span id="saveBarText">${this._saveBarText()}</span>
        <span class="save-bar-sp"></span>
        <button class="btn btn-outline" id="discardAllBtn">Discard</button>
        <button class="btn btn-primary" id="saveAllBtn">Save</button>
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
              <input type="text" id="zone-temp-sensor-input" class="win-input" list="dl-temp-sensors"
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
              <input type="text" id="zone-occ-sensor-input" class="win-input" list="dl-occ-sensors"
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

    root.querySelectorAll("[data-set-section]").forEach(btn => btn.addEventListener("click", () => {
      this._settingsSection = btn.dataset.setSection;
      this._editingZoneId = null;
      this._zoneFormData = null;
      this._render();
    }));

    root.querySelectorAll("[data-cfg]").forEach(el => {
      el.addEventListener(el.dataset.kind === "bool" ? "change" : "input", () => this._onCfgInput(el));
      if (el.tagName === "SELECT") el.addEventListener("change", () => this._onCfgInput(el));
    });
    root.querySelectorAll("[data-cfg-person]").forEach(el => el.addEventListener("change", () => this._onPersonToggle()));

    this._addClick("saveAllBtn", () => this._saveSettings());
    this._addClick("discardAllBtn", () => { this._draft = {}; this._render(); });

    // ── Windows (immediate) ────────────────────────────────────────────────
    this._addClick("winAddBtn", async () => {
      const input = root.getElementById("winSensorInput");
      const entityId = input ? input.value.trim() : "";
      if (!entityId) return;
      if (!this._hass.states[entityId]) { this._showToast(`${entityId} does not exist in Home Assistant.`, "error"); return; }
      try {
        await this._hass.callWS({ type: "gttc/add_window_sensor", entity_id: entityId });
        await this._loadSettingsData();
        this._showToast("Sensor added.");
      } catch (err) { this._showToast(err.message || "Failed to add sensor.", "error"); }
    });
    root.querySelectorAll("[data-window-sensor]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const entityId = btn.dataset.windowSensor;
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
          this._settingsData = { ...this._settingsData, windows_open_override: winChk.checked };
          this._showToast(winChk.checked ? "HVAC paused." : "HVAC resumed.");
        } catch (err) { this._showToast(err.message || "Failed.", "error"); }
      });
    }

    this._attachZoneListeners();
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

  _fmt12(timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  _renderNowTab() {
    const d = this._diagData;
    if (!d) {
      return `<div class="status-loading"><ha-icon icon="mdi:loading"></ha-icon> Loading…</div>`;
    }
    return `
      <div class="now-grid">
        ${this._renderNowHero(d)}
        ${this._renderNowActions(d)}
        ${this._renderTodayStrip()}
      </div>
    `;
  }

  _goalWhy(d) {
    const e = d.current_entry;
    switch (d.hvac_action_reason) {
      case "schedule":
        return e ? `Schedule · ${this._fmt12(e.time_start)}–${this._fmt12(e.time_end)} block` : "Schedule";
      case "precondition": return "Pre-conditioning for the next block";
      case "occupancy_away": return "Nobody home — away setback";
      case "tou_adjustment": return "Peak-rate adjustment";
      case "heat_pump_step": return "Heat pump stepping up";
      case "fan_precool": return "Fan pre-cooling before the AC";
      case "fallback": return "No schedule block — fallback";
      default: return d.schedule_enabled ? "Schedule" : "Schedule off";
    }
  }

  _renderNowBanners(d) {
    const banners = [];
    if (d.override_active) {
      const physical = d.override_source === "physical";
      const resume = d.schedule_enabled && d.current_entry ? this._seasonTemp(d.current_entry) : null;
      banners.push(`
        <div class="now-banner banner-hold">
          <ha-icon icon="${physical ? "mdi:hand-back-right" : "mdi:clock-edit"}"></ha-icon>
          <span><b>${physical ? "Held at the thermostat" : `Override ${d.override_target_temp}°`}</b>
            · ${d.override_remaining_minutes} min left${resume != null ? `, then back to ${resume}°` : ""}</span>
          <button class="btn btn-sm js-cancel-override">Resume schedule</button>
        </div>`);
    }
    if (d.vacation_mode) {
      const vm = d.vacation_mode;
      const until = new Date(vm.end_dt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      banners.push(`
        <div class="now-banner banner-vacation">
          <ha-icon icon="mdi:airplane"></ha-icon>
          <span><b>${vm.label || "Vacation"}</b> · holding ${vm.setback_temp}° until ${until}</span>
          <button class="btn btn-sm" id="clearVacationBtn">End vacation</button>
        </div>`);
    }
    const w = d.windows || {};
    if (w.open || w.manual_override) {
      banners.push(`
        <div class="now-banner banner-windows">
          <ha-icon icon="mdi:window-open-variant"></ha-icon>
          <span><b>HVAC paused</b> · ${w.manual_override && !w.open
            ? "suspended by hand"
            : `${w.open_sensors.length} window${w.open_sensors.length !== 1 ? "s" : ""} open`}</span>
          <button class="btn btn-sm js-window-settings">Manage</button>
        </div>`);
    }
    return banners.join("");
  }

  _renderNowHero(d) {
    const action = d.hvac_action;
    const actionLabel = action ? action.charAt(0).toUpperCase() + action.slice(1) : "—";
    const banners = this._renderNowBanners(d);
    const zones = d.zones || [];
    const outdoor = d.features?.outdoor_temp;
    return `
      <section class="now-card now-hero">
        <div class="eyebrow">${d.active_zone_name || "Active zone"} · active zone</div>
        <div class="hero-row">
          <div class="hero-temp">${d.current_temp != null ? d.current_temp.toFixed(1) : "—"}<small>°</small></div>
          <div class="hero-goal">
            <span class="hero-goal-num">→ ${d.target_temp != null ? d.target_temp.toFixed(1) + "°" : "—"}</span>
            ${banners ? "" : `<span class="hero-why">${this._goalWhy(d)}</span>`}
            <span class="hero-action ${action === "heating" ? "is-heat" : action === "cooling" ? "is-cool" : ""}">${actionLabel}</span>
          </div>
        </div>
        ${banners}
        <div class="rooms">
          ${zones.map(z => `
            <button class="room ${z.is_active ? "room-active" : ""}" data-now-zone="${z.id}" ${z.is_active ? "disabled" : ""}
                    title="${z.is_active ? "Active zone" : "Make this the active zone"}">
              <span class="room-name">${z.name}</span>
              <span class="room-temp">${z.current_temp != null ? z.current_temp.toFixed(1) + "°" : "—"}</span>
            </button>`).join("")}
          <div class="room room-outside">
            <span class="room-name">Outside</span>
            <span class="room-temp">${outdoor != null ? outdoor.toFixed(1) + "°" : "—"}</span>
          </div>
        </div>
      </section>
    `;
  }

  _renderNowActions(d) {
    const f = d.features || {};
    const w = d.windows || {};
    const boosts = this._isCooling()
      ? [
          { id: "max_cool", big: "−4°", sub: "Max cool · 90 min", cls: "tile-cool" },
          { id: "cool_down", big: "−3°", sub: "Cool down · 60 min", cls: "tile-cool" },
        ]
      : [
          { id: "boost", big: "+4°", sub: "Boost · 90 min", cls: "tile-heat" },
          { id: "warm_up", big: "+3°", sub: "Warm up · 60 min", cls: "tile-heat" },
        ];
    const chips = [
      { id: "schedule", label: "Schedule", on: !!d.schedule_enabled },
      { id: "learning", label: d.learning?.patterns_learned ? `Learning · ${d.learning.patterns_learned} patterns` : "Learning", on: !!d.learning?.enabled },
      { id: "occupancy", label: "Presence", on: !!f.occupancy_enabled },
      { id: "tou", label: "Peak rates", on: !!f.tou_enabled },
      { id: "precondition", label: f.precondition_active ? "Pre-condition · running" : "Pre-condition", on: !!f.precondition_enabled },
      { id: "windows", label: "Pause HVAC", on: !!w.manual_override },
    ];
    return `
      <section class="now-card now-actions">
        <div class="eyebrow">Quick actions</div>
        <div class="action-tiles">
          ${boosts.map(b => `
            <button class="action-tile ${b.cls} boost-btn" data-boost-type="${b.id}">
              <b>${b.big}</b><span>${b.sub}</span>
            </button>`).join("")}
          ${d.vacation_mode ? "" : `
            <button class="action-tile" id="setVacationBtn">
              <b><ha-icon icon="mdi:airplane"></ha-icon></b><span>Vacation…</span>
            </button>`}
        </div>
        <div class="eyebrow">Automations · tap to switch</div>
        <div class="auto-chips">
          ${chips.map(c => `
            <button class="auto-chip ${c.on ? "chip-on" : "chip-off"}" data-auto-toggle="${c.id}" data-on="${c.on ? 1 : 0}"
                    aria-pressed="${c.on}">${c.label}</button>`).join("")}
        </div>
      </section>
    `;
  }

  _renderTodayStrip() {
    const today = DAYS_ORDERED[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
    const entries = this._getEntriesForDay(today);
    const s = this._schedule;
    const label = s.active_preset ? (s.preset_labels?.[s.active_preset] || s.active_preset) : "Base fallback";
    return `
      <section class="now-card now-today">
        <div class="today-head">
          <div class="eyebrow">Today · ${DAY_LABELS_FULL[today]} · ${label} · ${this._isCooling() ? "cooling" : "heating"} targets</div>
          <button class="btn btn-outline btn-sm" id="goScheduleBtn">Edit schedule</button>
        </div>
        <div class="week-row-timeline today-timeline">
          ${this._renderOnPeakOverlay(today)}
          ${this._renderTimelineBlocks(entries, today, true)}
          <div class="now-line" style="left:${this._nowPercent()}%"></div>
        </div>
        <div class="today-axis">
          <span style="left:0">12a</span><span style="left:25%">6a</span><span style="left:50%">12p</span>
          <span style="left:75%">6p</span><span style="left:100%">12a</span>
        </div>
      </section>
    `;
  }

  _renderScheduleTab() {
    const s = this._schedule;
    const label = s.active_preset ? (s.preset_labels?.[s.active_preset] || s.active_preset) : "Base fallback";
    return `
      <div class="schedule-section">
        <div class="schedule-section-header">
          <div class="section-label"><ha-icon icon="mdi:calendar-clock"></ha-icon> ${label} schedule</div>
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
    `;
  }

  _renderHistoryTab() {
    const d = this._diagData;
    return `
      <div class="history-tab">
        ${this._renderTempChart()}
        ${this._renderRuntimeChart()}
        <div class="history-row">
          ${this._renderActionLog()}
          ${d ? this._renderLearningCard(d) : ""}
        </div>
        ${d ? this._renderDebugCard(d) : ""}
      </div>
    `;
  }

  async _loadActionLog() {
    try {
      this._actionLog = await this._hass.callWS({ type: "gttc/get_action_log", limit: 200 });
    } catch (err) {
      this._actionLog = { error: err.message || String(err) };
    }
    if (this._activeMainTab === "history") this._repaint();
  }

  _reasonLabel(reason) {
    return ({
      schedule: "Schedule", manual_override: "Override", physical_override: "Thermostat hold",
      vacation: "Vacation", occupancy_away: "Nobody home", precondition: "Pre-conditioning",
      tou_adjustment: "Peak-rate adjustment", heat_pump_step: "Heat pump step",
      fan_precool: "Fan pre-cool", window_open: "Windows open", fallback: "Fallback",
    })[reason] || reason;
  }

  _renderActionLog() {
    const al = this._actionLog;
    let body;
    if (!al) {
      body = `<div class="chart-empty">Loading…</div>`;
    } else if (al.error) {
      body = `<div class="chart-empty">Could not load the log: ${al.error}</div>`;
    } else if (!al.log || al.log.length === 0) {
      body = `<div class="chart-empty">No decisions recorded since Home Assistant started.</div>`;
    } else {
      // Collapse consecutive identical decisions into runs, newest first.
      const runs = [];
      for (const e of al.log) {
        if (!e || isNaN(new Date(e.ts).getTime())) continue;
        const last = runs[runs.length - 1];
        if (last && last.reason === e.reason && last.target_temp === e.target_temp) continue;
        runs.push({ ts: e.ts, reason: e.reason, target_temp: e.target_temp });
      }
      const now = Date.now();
      const today = new Date().toDateString();
      body = `<ol class="log-list">${runs.map((r, i) => {
        const t = new Date(r.ts);
        const end = i < runs.length - 1 ? new Date(runs[i + 1].ts).getTime() : now;
        const mins = Math.max(0, Math.round((end - t.getTime()) / 60000));
        const dur = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
        const when = t.toDateString() === today
          ? t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : t.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
        return `<li class="log-row ${i === runs.length - 1 ? "log-current" : ""}">
          <span class="log-when">${when}</span>
          <span class="log-reason">${this._reasonLabel(r.reason)}</span>
          <span class="log-temp">${r.target_temp}°</span>
          <span class="log-dur">${i === runs.length - 1 ? `${dur} so far` : dur}</span>
        </li>`;
      }).reverse().slice(0, 40).join("")}</ol>`;
    }
    return `
      <div class="chart-card log-card">
        <div class="chart-title">Why the goal changed</div>
        ${body}
      </div>
    `;
  }

  _renderLearningCard(d) {
    const rd = this._runtimeData;
    const rows = [
      ["Learning", d.learning?.enabled ? "On" : "Off"],
      ["Patterns learned", d.learning?.patterns_learned ?? "—"],
      ["Changes recorded", d.learning?.events_recorded ?? "—"],
      ["Adaptive lead time", rd?.learned_ramp_minutes ? `${rd.learned_ramp_minutes.toFixed(0)} min` : "—"],
      ["Heat pump", d.features?.heat_pump_detected ? "Detected" : "Not detected"],
    ];
    return `
      <div class="chart-card learn-card">
        <div class="chart-title">What GTTC has learned</div>
        <table class="sys-table">
          ${rows.map(([k, v]) => `<tr><td class="sys-label">${k}</td><td class="sys-val">${v}</td></tr>`).join("")}
        </table>
      </div>
    `;
  }

  _settingsSections() {
    return [
      { id: "season", label: "Season rules", icon: "mdi:weather-partly-cloudy",
        keys: ["auto_season_switch", "seasonal_recommend_hours", "cooling_comfort", "cooling_away_temp"] },
      { id: "temps", label: "Temperatures", icon: "mdi:thermometer-lines",
        keys: ["temp_min", "temp_max", "away_temp", "manual_override_minutes"] },
      { id: "presence", label: "Presence", icon: "mdi:account-check",
        keys: ["occupancy_enabled", "presence_detection", "tracked_persons"] },
      { id: "energy", label: "Energy", icon: "mdi:lightning-bolt-circle",
        keys: ["precondition_enabled", "tou_enabled", "tou_provider", "outdoor_temp_sensor"] },
      { id: "learning", label: "Learning", icon: "mdi:brain",
        keys: ["learning_enabled", "learning_threshold"] },
      { id: "windows", label: "Windows", icon: "mdi:window-open-variant", keys: [] },
      { id: "zones", label: "Zones", icon: "mdi:map-marker-radius", keys: [] },
    ];
  }

  _cfg(key) {
    return Object.prototype.hasOwnProperty.call(this._draft, key) ? this._draft[key] : this._settingsData?.[key];
  }

  _isDirty(key) {
    return Object.prototype.hasOwnProperty.call(this._draft, key);
  }

  _row(key, label, hint, control, opts = {}) {
    const off = opts.depends && !this._cfg(opts.depends);
    return `
      <div class="set-row ${this._isDirty(key) ? "set-row-dirty" : ""} ${off ? "set-row-off" : ""}"
           data-row="${key}" ${opts.depends ? `data-depends="${opts.depends}"` : ""}>
        <div class="set-text">
          <label for="cfg-${key}">${label}</label>
          ${hint ? `<div class="settings-hint">${hint}</div>` : ""}
        </div>
        <div class="set-control">${control}</div>
      </div>`;
  }

  _numField(key, label, hint, { min, max, step = 0.5, unit = "°F", depends } = {}) {
    const v = this._cfg(key);
    const off = depends && !this._cfg(depends);
    return this._row(key, label, hint, `
      <input type="number" class="set-num" id="cfg-${key}" data-cfg="${key}" data-kind="num"
             value="${v ?? ""}" min="${min}" max="${max}" step="${step}" ${off ? "disabled" : ""}>
      <span class="set-unit">${unit}</span>`, { depends });
  }

  _rangeField(key, label, hint, { min, max, step = 1, suffix = "", depends } = {}) {
    const v = this._cfg(key);
    const off = depends && !this._cfg(depends);
    return this._row(key, label, hint, `
      <input type="range" class="set-range" id="cfg-${key}" data-cfg="${key}" data-kind="num" data-suffix="${suffix}"
             value="${v}" min="${min}" max="${max}" step="${step}" ${off ? "disabled" : ""}>
      <output class="set-out" id="cfg-${key}-out">${v}${suffix}</output>`, { depends });
  }

  _boolField(key, label, hint) {
    return this._row(key, label, hint, `
      <label class="toggle-switch">
        <input type="checkbox" id="cfg-${key}" data-cfg="${key}" data-kind="bool" ${this._cfg(key) ? "checked" : ""}>
        <span class="toggle-slider"></span>
      </label>`);
  }

  _selectField(key, label, hint, options, { depends } = {}) {
    const v = this._cfg(key);
    const off = depends && !this._cfg(depends);
    return this._row(key, label, hint, `
      <select class="set-select" id="cfg-${key}" data-cfg="${key}" data-kind="str" ${off ? "disabled" : ""}>
        ${options.map(([val, text]) => `<option value="${val}" ${v === val ? "selected" : ""}>${text}</option>`).join("")}
      </select>`, { depends });
  }

  _entityReading(entityId) {
    if (!entityId) return "";
    const st = this._hass?.states?.[entityId];
    if (!st) return `<span class="ent-missing">not found</span>`;
    const unit = st.attributes?.unit_of_measurement || "";
    return `${st.attributes?.friendly_name || entityId} · ${st.state}${unit}`;
  }

  _entityOptions(domain, deviceClasses) {
    const states = this._hass?.states || {};
    return Object.keys(states)
      .filter(id => id.startsWith(domain + ".") && (!deviceClasses || deviceClasses.includes(states[id].attributes?.device_class)))
      .sort()
      .map(id => `<option value="${id}">${states[id].attributes?.friendly_name || ""}</option>`)
      .join("");
  }

  _renderEntityDatalists() {
    return `
      <datalist id="dl-temp-sensors">${this._entityOptions("sensor", ["temperature"])}</datalist>
      <datalist id="dl-window-sensors">${this._entityOptions("binary_sensor", ["window", "door", "opening", "garage_door"])}</datalist>
      <datalist id="dl-occ-sensors">${this._entityOptions("binary_sensor", ["occupancy", "motion", "presence"])}</datalist>
    `;
  }

  _saveBarText() {
    const keys = Object.keys(this._draft);
    const where = this._settingsSections().filter(x => x.keys.some(k => keys.includes(k))).map(x => x.label);
    return `${keys.length} unsaved change${keys.length !== 1 ? "s" : ""}${where.length ? ` · ${where.join(", ")}` : ""}`;
  }

  _settingsClampWarning(key, label) {
    const off = this._diagData?.zone_offset;
    const v = this._cfg(key);
    const max = this._cfg("temp_max");
    const min = this._cfg("temp_min");
    if (off == null || v == null || isNaN(v)) return "";
    const wall = v + off;
    const cap = wall > max ? max : wall < min ? min : null;
    if (cap == null || Math.abs(wall - cap) < 0.25) return "";
    const settles = Math.round((cap - off) * 10) / 10;
    return `<div class="set-warn">⚠ ${label} ${v}° needs ${wall.toFixed(1)}° at the wall (offset ${off > 0 ? "+" : ""}${off}°),
      but the wall is capped at ${cap}°. ${this._diagData.active_zone_name || "The active zone"} will settle near ${settles}°.</div>`;
  }

  _renderSettings_season() {
    const d = this._settingsData;
    return `
      <p class="set-lede">Currently <b>${d.season === "cooling" ? "cooling" : "heating"}</b>. Switch season with the Heat / Cool control above — it applies immediately. These are the rules for when GTTC recommends or makes the switch itself.</p>
      ${this._boolField("auto_season_switch", "Switch automatically",
        "Switch to the other season once the threshold below is reached. Off: GTTC only recommends.")}
      ${this._rangeField("seasonal_recommend_hours", "Hours before recommending a switch",
        "Outdoor must stay past indoor (by the switch margin) this long. A reversal resets the count.",
        { min: 1, max: 48, step: 1, suffix: "h" })}
      ${this._numField("cooling_comfort", "Cooling comfort", "Used by schedule blocks that have no cooling target of their own.", { min: 60, max: 85 })}
      ${this._settingsClampWarning("cooling_comfort", "Cooling comfort")}
      ${this._numField("cooling_away_temp", "Cooling away", "Used when nobody is home in cooling season.", { min: 60, max: 90 })}
      ${this._settingsClampWarning("cooling_away_temp", "Cooling away")}
    `;
  }

  _renderSettings_temps() {
    return `
      ${this._numField("temp_min", "Minimum", "GTTC never sends the wall unit a setpoint below this.", { min: 32, max: 99 })}
      ${this._numField("temp_max", "Maximum", "…or above this. The cap applies after the zone offset is added.", { min: 33, max: 100 })}
      ${this._numField("away_temp", "Heating away", "Used when nobody is home in heating season. Must sit between min and max.", { min: 32, max: 100 })}
      ${this._rangeField("manual_override_minutes", "Hold length",
        "How long a change at the wall or a panel override holds before the schedule takes back over.",
        { min: 15, max: 480, step: 15, suffix: " min" })}
    `;
  }

  _renderSettings_presence() {
    const d = this._settingsData;
    const persons = d.all_persons || [];
    const tracked = new Set(this._cfg("tracked_persons") || []);
    const personsOff = !this._cfg("occupancy_enabled") || this._cfg("presence_detection") === "occupancy_sensors";
    return `
      ${this._boolField("occupancy_enabled", "Use presence", "Drop to the away temperature when nobody is home.")}
      ${this._selectField("presence_detection", "Detect presence with", "", [
        ["both", "People and occupancy sensors"],
        ["person_entities", "People only"],
        ["occupancy_sensors", "Occupancy sensors only"],
      ], { depends: "occupancy_enabled" })}
      <div class="set-row ${this._isDirty("tracked_persons") ? "set-row-dirty" : ""} ${personsOff ? "set-row-off" : ""}" data-row="tracked_persons" data-persons>
        <div class="set-text">
          <label>People to track</label>
          <div class="settings-hint">None ticked tracks everyone.</div>
        </div>
        <div class="set-control set-control-list">
          ${persons.length === 0 ? `<span class="settings-hint">No person entities in Home Assistant.</span>` : persons.map(p => `
            <label class="person-row">
              <input type="checkbox" data-cfg-person="${p.entity_id}" ${tracked.has(p.entity_id) ? "checked" : ""} ${personsOff ? "disabled" : ""}>
              <span class="person-name">${p.name}</span>
              <span class="person-badge ${p.is_home ? "person-badge-home" : "person-badge-away"}">${p.is_home ? "home" : p.state}</span>
            </label>`).join("")}
        </div>
      </div>
    `;
  }

  _renderSettings_energy() {
    const sensor = this._cfg("outdoor_temp_sensor") || "";
    return `
      ${this._boolField("precondition_enabled", "Pre-condition", "Start moving toward the next block early, using the learned lead time.")}
      ${this._boolField("tou_enabled", "Peak-rate optimisation", "Shift the setpoint during on-peak electricity hours.")}
      ${this._selectField("tou_provider", "Rate plan", "", [
        ["none", "None"],
        ["dominion_virginia", "Dominion Energy Virginia"],
      ], { depends: "tou_enabled" })}
      ${this._row("outdoor_temp_sensor", "Outdoor temperature sensor",
        "Drives the season recommendation, fan pre-cool and heat-pump setback. Blank disables them.", `
        <input type="text" class="set-entity" id="cfg-outdoor_temp_sensor" data-cfg="outdoor_temp_sensor" data-kind="entity"
               list="dl-temp-sensors" value="${sensor}" placeholder="sensor.outside_temperature" spellcheck="false" autocomplete="off">
        <span class="set-reading" id="cfg-outdoor_temp_sensor-state">${this._entityReading(sensor)}</span>`)}
    `;
  }

  _renderSettings_learning() {
    const v = this._cfg("learning_threshold");
    return `
      ${this._boolField("learning_enabled", "Learn from changes", "Rewrite a schedule block after the same change is made to it repeatedly.")}
      ${this._rangeField("learning_threshold", "Changes before a block adapts", `Currently ${v} repeats.`,
        { min: 2, max: 10, step: 1, suffix: "×", depends: "learning_enabled" })}
    `;
  }

  _renderSettings_windows() {
    const d = this._settingsData;
    const sensors = d.window_sensors || [];
    return `
      <p class="set-lede">Changes in this section apply immediately.</p>
      <div class="set-row">
        <div class="set-text">
          <label for="winManualChk">Pause HVAC by hand</label>
          <div class="settings-hint">Parks the thermostat as if a window were open, until you switch it back.</div>
        </div>
        <div class="set-control">
          <label class="toggle-switch">
            <input type="checkbox" id="winManualChk" ${d.windows_open_override ? "checked" : ""}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="set-row set-row-stack">
        <div class="set-text">
          <label for="winSensorInput">Window and door sensors</label>
          <div class="settings-hint">Any one open pauses heating and cooling.</div>
        </div>
        <div class="win-sensor-list">
          ${sensors.length === 0 ? `<div class="win-empty">No sensors added yet.</div>` : sensors.map(id => `
            <div class="win-sensor-row">
              <ha-icon icon="mdi:window-closed"></ha-icon>
              <span class="win-sensor-id">${id}</span>
              <span class="set-reading">${this._entityReading(id)}</span>
              <button class="win-remove-btn" data-window-sensor="${id}" title="Remove">
                <ha-icon icon="mdi:close"></ha-icon>
              </button>
            </div>`).join("")}
        </div>
        <div class="win-add-row">
          <input class="win-input" id="winSensorInput" type="text" list="dl-window-sensors"
                 placeholder="binary_sensor.bedroom_window" spellcheck="false" autocomplete="off">
          <button class="btn btn-sm" id="winAddBtn">Add sensor</button>
        </div>
      </div>
    `;
  }

  _renderSettings_zones() {
    return `
      <p class="set-lede">Zones save on their own — each has its own Save.</p>
      ${this._renderSettingsZonesCard(this._settingsData)}
    `;
  }

  _onCfgInput(el) {
    const key = el.dataset.cfg;
    const kind = el.dataset.kind;
    let v;
    if (kind === "bool") v = el.checked;
    else if (kind === "num") v = el.value === "" ? NaN : parseFloat(el.value);
    else v = el.value.trim();
    const orig = this._settingsData?.[key];
    const same = kind === "num" ? Number(orig) === v : orig === v || (orig == null && v === "");
    if (same) delete this._draft[key];
    else this._draft[key] = v;

    const root = this.shadowRoot;
    const out = root.getElementById(`cfg-${key}-out`);
    if (out) out.textContent = `${el.value}${el.dataset.suffix || ""}`;
    const row = root.querySelector(`[data-row="${key}"]`);
    if (row) row.classList.toggle("set-row-dirty", !same);
    if (kind === "bool") {
      root.querySelectorAll(`[data-depends="${key}"]`).forEach(r => {
        r.classList.toggle("set-row-off", !v);
        r.querySelectorAll("input, select").forEach(i => { i.disabled = !v; });
      });
    }
    if (key === "occupancy_enabled" || key === "presence_detection") {
      const off = !this._cfg("occupancy_enabled") || this._cfg("presence_detection") === "occupancy_sensors";
      const pr = root.querySelector("[data-persons]");
      if (pr) {
        pr.classList.toggle("set-row-off", off);
        pr.querySelectorAll("input").forEach(i => { i.disabled = off; });
      }
    }
    if (kind === "entity") {
      const r = root.getElementById(`cfg-${key}-state`);
      if (r) r.innerHTML = this._entityReading(v);
    }
    this._updateSaveBar();
  }

  _onPersonToggle() {
    const picked = [...this.shadowRoot.querySelectorAll("[data-cfg-person]:checked")].map(c => c.dataset.cfgPerson).sort();
    const orig = [...(this._settingsData?.tracked_persons || [])].sort();
    const same = JSON.stringify(picked) === JSON.stringify(orig);
    if (same) delete this._draft.tracked_persons;
    else this._draft.tracked_persons = picked;
    const row = this.shadowRoot.querySelector('[data-row="tracked_persons"]');
    if (row) row.classList.toggle("set-row-dirty", !same);
    this._updateSaveBar();
  }

  _updateSaveBar() {
    const root = this.shadowRoot;
    const n = Object.keys(this._draft).length;
    const bar = root.getElementById("saveBar");
    if (bar) bar.hidden = n === 0;
    const text = root.getElementById("saveBarText");
    if (text) text.textContent = this._saveBarText();
    for (const x of this._settingsSections()) {
      const dot = root.querySelector(`[data-dirty-for="${x.id}"]`);
      if (dot) dot.hidden = !x.keys.some(k => this._isDirty(k));
    }
    const tab = root.querySelector('[data-main-tab="settings"]');
    if (tab) tab.lastChild.textContent = n ? " Settings •" : " Settings";
  }

  async _saveSettings() {
    const draft = { ...this._draft };
    const bad = Object.entries(draft).filter(([, v]) => typeof v === "number" && isNaN(v)).map(([k]) => k);
    if (bad.length) { this._showToast(`Fill in: ${bad.join(", ").replace(/_/g, " ")}`, "error"); return; }
    const min = this._cfg("temp_min"), max = this._cfg("temp_max"), away = this._cfg("away_temp");
    if (min >= max) { this._showToast("Minimum must be below maximum.", "error"); return; }
    if (away < min || away > max) { this._showToast(`Heating away (${away}°) must sit between ${min}° and ${max}°.`, "error"); return; }
    try {
      await this._hass.callWS({ type: "gttc/set_config", ...draft });
      this._settingsData = { ...this._settingsData, ...draft };
      this._draft = {};
      await this._loadData();
      this._showToast(`Saved ${Object.keys(draft).length} setting${Object.keys(draft).length !== 1 ? "s" : ""}.`);
    } catch (err) {
      this._showToast(`Not saved: ${err.message || err}`, "error");
    }
  }

  _attachZoneListeners() {
    const root = this.shadowRoot;

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
      .time-axis { position: relative; height: 20px; margin-left: 72px; margin-bottom: 4px; font-size: 11px; color: var(--secondary-text); }
      .time-mark { position: absolute; transform: translateX(-50%); }
      .week-row {
        display: flex; align-items: center; height: 40px; margin-bottom: 2px;
        cursor: pointer; border-radius: 6px; transition: background 0.1s;
      }
      .week-row:hover { background: rgba(0,0,0,0.04); }
      .week-row.selected { background: rgba(3,169,244,0.08); }
      .week-row-label { width: 72px; font-size: 12px; font-weight: 600; color: var(--secondary-text); flex-shrink: 0; text-align: right; padding-right: 10px; white-space: nowrap; }
      .week-row.selected .week-row-label { color: var(--primary); }
      .week-row-timeline { flex: 1; position: relative; height: 32px; background: var(--bg); border-radius: 4px; overflow: hidden; }

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
      .block-cool { color: rgba(100,220,255,0.95); font-weight: 600; }

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
      .day-detail-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; gap: 12px; }
      .day-detail-title { display: flex; flex-direction: column; gap: 3px; }
      .day-detail h2 { margin: 0; font-size: 18px; font-weight: 500; }
      .day-group-subtitle { font-size: 12px; color: var(--secondary-text); letter-spacing: 0.2px; }
      .day-actions { display: flex; gap: 8px; flex-wrap: wrap; flex-shrink: 0; }
      .day-timeline-container { position: relative; margin-bottom: 20px; }
      .day-timeline-hours { position: relative; height: 20px; font-size: 11px; color: var(--secondary-text); }
      .hour-mark { position: absolute; transform: translateX(-50%); }
      .hour-label { white-space: nowrap; }
      .day-timeline { position: relative; height: 56px; background: var(--bg); border-radius: 8px; overflow: hidden; margin-top: 4px; }
      .day-timeline .timeline-block { top: 5px; bottom: 5px; }
      .day-timeline .block-temp { font-size: 14px; }
      .day-timeline .block-time { font-size: 11px; }
      .day-timeline .block-cool { font-size: 12px; }

      /* Entry cards */
      .entries-list { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
      .no-entries { color: var(--secondary-text); font-style: italic; text-align: center; padding: 20px; }
      .entry-card {
        display: flex; align-items: center; gap: 12px; padding: 10px 12px;
        border-radius: 8px; border: 1px solid var(--divider); background: var(--card-bg);
        transition: box-shadow 0.15s;
      }
      .entry-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
      .entry-color { width: 5px; align-self: stretch; border-radius: 3px; flex-shrink: 0; min-height: 32px; }
      .entry-info { flex: 1; display: flex; gap: 16px; align-items: center; min-width: 0; }
      .entry-time { font-size: 13px; font-weight: 500; white-space: nowrap; }
      .entry-temp { font-size: 16px; font-weight: 700; }
      .entry-zone { font-size: 12px; color: var(--secondary-text); background: var(--bg); padding: 2px 8px; border-radius: 10px; border: 1px solid var(--divider); }
      .entry-actions { display: flex; gap: 6px; flex-shrink: 0; }

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
      .legend-dot.actual { background: #9e9e9e; }
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
        box-sizing: border-box; width: 100%; padding: 12px 16px; background: none; border: none; cursor: pointer;
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
      .settings-hint-warn { color: var(--warning-color, #f59e0b); font-weight: 500; }
      .season-toggle-row { display: flex; gap: 8px; flex-wrap: wrap; }
      .season-mode-btn { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 20px; font-size: 14px; }
      .season-mode-btn-active { background: var(--primary); color: var(--text-primary-color, #fff); border-color: var(--primary); }
      .form-label-hint { font-size: 11px; color: var(--secondary-text); font-weight: 400; }
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

      /* ── Boost buttons ─────────────────────────────────────────────────── */
      .boost-row {
        display: flex; gap: 10px; padding: 12px 16px 4px; flex-wrap: wrap;
      }
      .boost-btn {
        display: flex; align-items: center; gap: 6px;
        padding: 8px 16px; border-radius: 20px; border: 2px solid var(--boost-color, #888);
        background: transparent; color: var(--boost-color, #888);
        font-size: 13px; font-weight: 600; cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      .boost-btn:hover { background: var(--boost-color, #888); color: #fff; }
      .boost-btn ha-icon { --mdc-icon-size: 18px; }

      /* ── Vacation banner ─────────────────────────────────────────────────── */
      .vacation-banner {
        display: flex; align-items: center; gap: 10px; padding: 10px 12px;
        background: #e3f2fd; border-left: 3px solid #1976d2; border-radius: 6px;
        margin: 4px 0;
      }
      .vacation-banner ha-icon { color: #1976d2; }
      .vacation-btn {
        width: 100%; justify-content: center; margin-top: 4px;
      }

      /* ── Block badges ────────────────────────────────────────────────────── */
      .block-badge {
        display: inline-block; font-size: 10px; padding: 1px 4px; border-radius: 3px;
        margin-left: 3px; opacity: 0.9; font-weight: 600;
      }
      .cool-badge { background: rgba(2,136,209,0.7); }
      .away-badge { background: rgba(100,100,100,0.6); }

      /* ── Runtime chart ───────────────────────────────────────────────────── */
      .runtime-chart { margin-top: 0; }
      .runtime-bars {
        display: flex; align-items: flex-end; gap: 3px;
        height: 180px; padding: 8px 8px 28px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        position: relative; overflow-x: auto;
      }
      .runtime-bar-col {
        display: flex; flex-direction: column; align-items: center; flex: 1;
        min-width: 18px; max-width: 36px; position: relative; height: 100%;
        justify-content: flex-end;
      }
      .runtime-bar-stack { display: flex; flex-direction: column-reverse; width: 100%; height: 100%; max-height: 100%; }
      .runtime-bar { width: 100%; border-radius: 3px 3px 0 0; min-height: 2px; }
      .heat-bar { background: #f57c00; }
      .cool-bar { background: #0288d1; }
      .runtime-outdoor {
        position: absolute; width: 6px; height: 6px; border-radius: 50%;
        background: #888; left: 50%; transform: translateX(-50%);
      }
      .runtime-date {
        position: absolute; bottom: -22px; font-size: 9px;
        color: var(--secondary-text-color, #727272); white-space: nowrap;
        transform: rotate(-30deg); transform-origin: top center;
      }
      .runtime-note {
        font-size: 11px; color: var(--secondary-text-color, #888); padding: 4px 8px;
      }
      .range-selector { display: flex; gap: 4px; margin-left: auto; }
      .range-btn {
        padding: 2px 8px; border-radius: 12px; border: 1px solid var(--divider-color, #ccc);
        background: transparent; font-size: 11px; cursor: pointer;
        color: var(--secondary-text-color, #555);
      }
      .range-btn.active {
        background: var(--primary-color, #03a9f4); color: #fff; border-color: var(--primary-color, #03a9f4);
      }

      /* ── Season strip ────────────────────────────────────────────────────── */
      .season-strip {
        display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
        padding: 10px 14px; margin-bottom: 16px; border-radius: 12px;
        background: var(--card-bg); border: 1px solid var(--divider);
      }
      .season-strip-suggest { border-color: #f9a825; background: color-mix(in srgb, #f9a825 10%, var(--card-bg)); }
      .season-seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--bg); border: 1px solid var(--divider); }
      .season-seg-btn {
        display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent;
        color: var(--secondary-text); font: inherit; font-size: 14px; font-weight: 600;
        padding: 7px 16px; border-radius: 999px; cursor: pointer;
      }
      .season-seg-btn ha-icon { --mdc-icon-size: 16px; }
      .season-seg-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
      .season-seg-btn.seg-heat[aria-pressed="true"] { background: #e65100; color: #fff; }
      .season-seg-btn.seg-cool[aria-pressed="true"] { background: #0277bd; color: #fff; }
      .season-meta { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--secondary-text); min-width: 0; }
      .season-meta b { color: var(--primary-text); font-weight: 600; }
      .season-meter { display: block; width: 140px; height: 4px; border-radius: 2px; background: var(--divider); overflow: hidden; }
      .season-meter i { display: block; height: 100%; background: #f9a825; }
      .season-cta { margin-left: auto; }
      .heat-badge { background: rgba(230,81,0,0.75); }
      .clamp-badge { background: rgba(0,0,0,0.45); }
      .entry-temp-kind { font-size: 11px; font-weight: 600; margin-left: 6px; color: var(--secondary-text); text-transform: uppercase; letter-spacing: .04em; }
      .entry-other { font-size: 12px; color: var(--secondary-text); }
      .entry-clamp { font-size: 12px; color: #b26a00; }
      .form-label-now { font-size: 11px; font-weight: 600; color: var(--primary); margin-left: 4px; }

      /* ── v2.3 shell ──────────────────────────────────────────────────────── */
      .main-tab { white-space: nowrap; }
      @media (max-width: 560px) {
        .main-tab-bar { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .main-tab { padding-left: 4px; padding-right: 4px; justify-content: center; font-size: 13px; }
        .main-tab ha-icon { display: none; }
        .strip-preset { margin-left: 0; width: 100%; }
        .strip-preset select { flex: 1; min-width: 0; }
        .hero-temp { font-size: 48px; }
        .today-timeline .block-badge { display: none; }
        .today-timeline .timeline-block { padding: 0 1px; }
        .today-timeline .timeline-block .block-temp { font-size: 12px; }
      }
      .status-live { cursor: pointer; font: inherit; font-size: 12px; color: var(--secondary-text); }
      .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); display: inline-block; }
      .strip-preset { display: flex; align-items: center; gap: 8px; margin-left: auto; font-size: 13px; color: var(--secondary-text); }
      .season-cta + .strip-preset { margin-left: 0; }
      .strip-preset select { font: inherit; font-size: 14px; font-weight: 600; padding: 6px 10px; border-radius: 8px;
        border: 1px solid var(--divider); background: var(--card-bg); color: var(--primary-text); }
      .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--secondary-text); }

      /* ── Now ─────────────────────────────────────────────────────────────── */
      .now-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 16px; }
      .now-today { grid-column: 1 / -1; }
      @media (max-width: 820px) { .now-grid { grid-template-columns: minmax(0, 1fr); } }
      .now-card { background: var(--card-bg); border: 1px solid var(--divider); border-radius: 12px; padding: 16px;
        display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .hero-row { display: flex; align-items: flex-end; gap: 20px; flex-wrap: wrap; }
      .hero-temp { font-size: 56px; font-weight: 600; line-height: 1; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
      .hero-temp small { font-size: 24px; color: var(--secondary-text); }
      .hero-goal { display: flex; flex-direction: column; gap: 3px; padding-bottom: 4px; }
      .hero-goal-num { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .hero-why { font-size: 13px; color: var(--secondary-text); }
      .hero-action { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--secondary-text); }
      .hero-action.is-heat { color: #e65100; }
      .hero-action.is-cool { color: #0277bd; }
      .now-banner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border-radius: 10px; font-size: 13px; }
      .now-banner ha-icon { --mdc-icon-size: 18px; flex-shrink: 0; }
      .now-banner span { flex: 1; min-width: 160px; }
      .now-banner .btn { margin-left: auto; }
      .banner-hold { background: color-mix(in srgb, #ff9800 14%, var(--card-bg)); }
      .banner-vacation { background: color-mix(in srgb, #1976d2 12%, var(--card-bg)); }
      .banner-windows { background: color-mix(in srgb, #fbc02d 16%, var(--card-bg)); }
      .rooms { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
      .room { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; border-radius: 10px;
        border: 1px solid var(--divider); background: transparent; color: var(--primary-text); font: inherit; text-align: left; cursor: pointer; }
      .room:disabled { cursor: default; }
      .room-active { border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); }
      .room-outside { cursor: default; }
      .room-name { font-size: 12px; color: var(--secondary-text); }
      .room-temp { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .action-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .action-tile { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 12px; border-radius: 10px;
        border: 1px solid var(--divider); background: transparent; color: var(--primary-text); font: inherit; cursor: pointer; text-align: left; }
      .action-tile:hover { border-color: var(--primary); }
      .action-tile b { font-size: 18px; font-variant-numeric: tabular-nums; }
      .action-tile span { font-size: 12px; color: var(--secondary-text); }
      .tile-heat b { color: #e65100; }
      .tile-cool b { color: #0277bd; }
      .auto-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .auto-chip { font: inherit; font-size: 12px; font-weight: 500; padding: 5px 11px; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--divider); background: transparent; color: var(--secondary-text); }
      .auto-chip::before { content: "○ "; }
      .auto-chip.chip-on { color: var(--primary-text); border-color: var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); }
      .auto-chip.chip-on::before { content: "● "; color: var(--success); }
      .auto-chip:disabled { opacity: .5; }
      .today-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .today-timeline { height: 48px; flex: none; }
      .today-timeline .timeline-block .block-temp { font-size: 13px; }
      .today-axis { position: relative; height: 14px; font-size: 11px; color: var(--secondary-text); }
      .today-axis span { position: absolute; transform: translateX(-50%); }
      .today-axis span:first-child { transform: none; }
      .today-axis span:last-child { transform: translateX(-100%); }

      /* ── History ─────────────────────────────────────────────────────────── */
      .history-tab { display: flex; flex-direction: column; gap: 16px; }
      .history-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 16px; align-items: start; }
      @media (max-width: 820px) { .history-row { grid-template-columns: minmax(0, 1fr); } }
      .log-list { list-style: none; margin: 0; padding: 0 8px 8px; max-height: 420px; overflow-y: auto; }
      .log-row { display: grid; grid-template-columns: 110px 1fr auto 80px; gap: 10px; padding: 7px 4px; font-size: 13px;
        border-top: 1px solid var(--divider); font-variant-numeric: tabular-nums; }
      .log-row:first-child { border-top: 0; }
      .log-current { font-weight: 600; }
      .log-when, .log-dur { color: var(--secondary-text); }
      .log-dur { text-align: right; }
      .log-temp { font-weight: 600; }
      .rt-bars { display: flex; align-items: stretch; gap: 4px; height: 210px; padding: 8px 8px 0; }
      .rt-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .rt-stack { flex: 1; display: flex; flex-direction: column-reverse; }
      .rt-bar { width: 100%; min-height: 2px; }
      .rt-stack .rt-bar:last-child { border-radius: 3px 3px 0 0; }
      .rt-label, .rt-out { font-size: 10px; text-align: center; color: var(--secondary-text); white-space: nowrap; overflow: hidden; }
      .rt-out { color: var(--secondary-text); opacity: .8; }
      details.debug-card > summary { cursor: pointer; list-style: revert; }

      /* ── Settings ────────────────────────────────────────────────────────── */
      .settings-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); background: var(--card-bg);
        border: 1px solid var(--divider); border-radius: 12px; overflow: hidden; }
      .set-nav { display: flex; flex-direction: column; gap: 2px; padding: 10px; border-right: 1px solid var(--divider); }
      .set-nav-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; border: 0;
        background: transparent; color: var(--secondary-text); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
      .set-nav-item ha-icon { --mdc-icon-size: 18px; }
      .set-nav-item.active { background: var(--bg); color: var(--primary-text); font-weight: 600; }
      .set-nav-dot { width: 7px; height: 7px; border-radius: 50%; background: #f9a825; margin-left: auto; }
      @media (max-width: 720px) {
        .settings-layout { grid-template-columns: minmax(0, 1fr); }
        .set-nav { flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--divider); }
      }
      .set-pane { padding: 18px 20px 24px; display: flex; flex-direction: column; gap: 0; min-width: 0; }
      .set-title { margin: 0 0 10px; font-size: 18px; font-weight: 600; }
      .set-lede { margin: 0 0 12px; font-size: 13px; color: var(--secondary-text); max-width: 64ch; }
      .set-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 20px; align-items: center;
        padding: 14px 0; border-top: 1px solid var(--divider); }
      .set-row-stack { grid-template-columns: minmax(0, 1fr); }
      .set-row label { font-size: 14px; font-weight: 600; }
      .set-row-off { opacity: .45; }
      .set-row-dirty .set-num, .set-row-dirty .set-select, .set-row-dirty .set-entity { border-color: #f9a825; background: color-mix(in srgb, #f9a825 10%, var(--card-bg)); }
      .set-row-dirty label::after { content: " •"; color: #f9a825; }
      .set-control { display: flex; align-items: center; gap: 8px; justify-self: end; flex-wrap: wrap; justify-content: flex-end; }
      .set-control-list { flex-direction: column; align-items: stretch; }
      .set-num { width: 84px; text-align: right; font: inherit; font-size: 16px; font-variant-numeric: tabular-nums; padding: 6px 8px;
        border: 1px solid var(--divider); border-radius: 8px; background: var(--card-bg); color: var(--primary-text); }
      .set-select, .set-entity { font: inherit; font-size: 16px; padding: 6px 8px; border: 1px solid var(--divider); border-radius: 8px;
        background: var(--card-bg); color: var(--primary-text); max-width: 100%; }
      .set-entity { width: 300px; font-family: var(--code-font-family, monospace); font-size: 14px; }
      .set-unit { font-size: 13px; color: var(--secondary-text); }
      .set-range { width: 200px; }
      .set-out { min-width: 64px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
      .set-reading { font-size: 12px; color: var(--secondary-text); flex-basis: 100%; text-align: right; }
      .win-sensor-row .set-reading { flex-basis: auto; margin-left: auto; }
      .ent-missing { color: var(--error); font-weight: 600; }
      .set-warn { margin: -4px 0 10px; padding: 10px 12px; border-radius: 9px; font-size: 13px;
        background: color-mix(in srgb, #f9a825 14%, var(--card-bg)); }
      .save-bar { position: sticky; bottom: 12px; z-index: 5; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        margin-top: 14px; padding: 10px 14px; border-radius: 12px; background: var(--primary-text); color: var(--card-bg);
        box-shadow: 0 8px 24px rgba(0,0,0,.25); font-size: 14px; }
      .save-bar[hidden] { display: none; }
      .save-bar-sp { flex: 1; }
      .save-bar .btn-outline { color: var(--card-bg); border-color: color-mix(in srgb, var(--card-bg) 45%, transparent); }
      @media (max-width: 560px) {
        .set-row { grid-template-columns: minmax(0, 1fr); }
        .set-control { justify-self: start; justify-content: flex-start; }
        .set-reading { text-align: left; }
        .set-entity { width: 100%; }
        .action-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .log-row { grid-template-columns: 80px 1fr auto; }
        .log-dur { display: none; }
      }
    `;
  }
}

customElements.define("gttc-panel", GttcPanel);
