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
// Schedule blocks are shaded by what they ask for, on a fixed comfort scale:
// cold setpoints read blue, the high 60s cream, the 70s amber to orange. The
// old min..max hue wheel spent its whole range on 50-90°F, so 68° and 70°
// came out the same green.
const TEMP_STOPS = [
  [58, [47, 111, 219]], [62, [120, 166, 232]], [65, [196, 218, 244]], [67, [232, 236, 240]],
  [68, [251, 232, 204]], [69, [247, 215, 169]], [70, [242, 182, 120]], [72, [236, 147, 70]],
  [75, [222, 104, 40]], [80, [190, 60, 20]],
];
function _toF(temp, max) { return max != null && max < 45 ? temp * 9 / 5 + 32 : temp; }
function tempColor(temp, min, max) {
  const f = _toF(temp, max);
  if (f <= TEMP_STOPS[0][0]) return `rgb(${TEMP_STOPS[0][1].join(",")})`;
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [t1, c1] = TEMP_STOPS[i];
    if (f <= t1) {
      const [t0, c0] = TEMP_STOPS[i - 1];
      const k = (f - t0) / (t1 - t0);
      return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(",")})`;
    }
  }
  return `rgb(${TEMP_STOPS[TEMP_STOPS.length - 1][1].join(",")})`;
}
// Ink that reads on tempColor(temp): dark on the pale middle, white at the ends
function tempInk(temp, min, max) {
  const f = _toF(temp, max);
  return f < 63 || f > 72.5 ? "#ffffff" : "#2a1606";
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
    this.toggleAttribute("dark", !!hass?.themes?.darkMode);
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
    if (this._blk || this._editingEntry || this._showCopyModal || this._showCopyDayModal || this._showPresetModal
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
        this._hass.callWS({ type: "gttc/get_runtime_history", days: 400 }).catch(() => null),
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
          <h2>Climate</h2>
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
            <div class="hd-eyebrow">${this._headerEyebrow()}</div>
            <h1>Climate</h1>
          </div>
          <div class="header-right">
            ${this._liveChip()}
          </div>
        </header>

        ${this._renderMainTabBar()}

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

  _headerEyebrow() {
    const s = this._schedule;
    const plan = s.active_preset ? (s.preset_labels?.[s.active_preset] || s.active_preset) : "Base schedule";
    const LABEL = { heating: "Heat", cooling: "Cool", heat_cool: "Heat · Cool" };
    const season = this._diagData ? LABEL[this._season()] : null;
    return season ? `${plan} · ${season}` : plan;
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
      if (/:59$/.test(entry.time_end)) endMin += 1;
      // A block that runs past midnight is also the start of this day's list
      // (the list is read circularly), so draw its morning piece too.
      const morning = endMin > 0 && endMin < startMin ? endMin : 0;
      if (endMin <= startMin) endMin = 1440;
      const leftPct = (startMin / 1440) * 100;
      const widthPct = ((endMin - startMin) / 1440) * 100;
      const cooling = this._isCooling();
      const band = this._isHeatCool() ? this._seasonBand(entry) : null;
      const temp = this._seasonTemp(entry);
      const other = band ? null : this._otherSeasonTemp(entry);
      const clamp = this._clampNote(entry);
      const color = band
        ? `linear-gradient(90deg, ${tempColor(band.low, s.temp_min, s.temp_max)}, ${tempColor(band.high, s.temp_min, s.temp_max)})`
        : temp != null ? tempColor(temp, s.temp_min, s.temp_max) : "var(--divider)";
      const textColor = band ? tempInk((band.low + band.high) / 2, s.temp_min, s.temp_max)
        : temp != null ? tempInk(temp, s.temp_min, s.temp_max) : "var(--primary-text)";
      const zoneLabel = entry.zone_id ? ` [${this._getZoneName(entry.zone_id)}]` : "";
      const extraBadges = [
        clamp ? `<span class="block-badge clamp-badge" title="${clamp.text}">⚠</span>` : "",
        other != null ? `<span class="block-badge ${cooling ? "heat-badge" : "cool-badge"}">${cooling ? "▲" : "▼"}${other}°</span>` : "",
        entry.away_temp != null && !cooling && !band ? `<span class="block-badge away-badge">away ${entry.away_temp}°</span>` : "",
        band && band.moved != null ? `<span class="block-badge gap-badge" title="Heat lowered from ${band.moved}° to keep the thermostat's ${this._minGap()}° gap">gap</span>` : "",
      ].filter(Boolean).join("");
      const tempText = band
        ? `${this._fmtBand(band)}${this._seasonTempIsFallback(entry) ? "*" : ""}`
        : `${this._fmtTemp(temp)}${this._seasonTempIsFallback(entry) ? "*" : ""}`;
      return (morning ? `<div class="timeline-block ${compact ? "compact" : ""}" style="left:0;width:${(morning / 1440) * 100}%;background:${color}"
             data-day="${day}" data-index="${i}" title="${formatTime12(entry.time_start)} - ${formatTime12(entry.time_end)}"></div>` : "") + `
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
          ${this._isHeatCool() ? (() => {
            const band = this._seasonBand(entry);
            return `<span class="entry-temp">${this._fmtBand(band)}<span class="entry-temp-kind">heat·cool${this._seasonTempIsFallback(entry) ? " · default cool" : ""}</span></span>
              <span class="entry-other">${band && band.moved != null ? `heat ${band.moved}° lowered for the ${this._minGap()}° gap` : `heat ${entry.target_temp}° · cool ${band ? band.high + "°" : "default"}`}</span>`;
          })() : `<span class="entry-temp">${this._fmtTemp(temp)}<span class="entry-temp-kind">${cooling ? "cool" : "heat"}${this._seasonTempIsFallback(entry) ? " · default" : ""}</span></span>
          <span class="entry-other">${cooling ? "heat" : "cool"} ${other != null ? other + "°" : "default"}${entry.away_temp != null ? ` · away ${entry.away_temp}°` : ""}</span>`}
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

  _isHeatCool() {
    return this._season() === "heat_cool";
  }

  _minGap() {
    return this._diagData?.heat_cool?.min_gap ?? this._settingsData?.heat_cool_min_gap ?? 3;
  }

  // Mirrors _update_heat_cool: both numbers of a block, with the heat end
  // lowered when the block is narrower than the thermostat's minimum gap.
  _seasonBand(entry) {
    if (!entry) return null;
    const high = entry.cooling_temp != null
      ? entry.cooling_temp
      : this._diagData?.cooling_comfort ?? this._settingsData?.cooling_comfort ?? null;
    if (high == null || entry.target_temp == null) return null;
    const gap = this._minGap();
    const low = Math.min(entry.target_temp, Math.round((high - gap) * 10) / 10);
    return { low, high, moved: low < entry.target_temp ? entry.target_temp : null };
  }

  _fmtBand(b) {
    return b ? `${b.low}–${b.high}°` : "—";
  }

  // Mirrors _calculate_desired_temp: cooling uses the entry's cooling_temp,
  // falling back to the global cooling comfort when the entry has none.
  _seasonTemp(entry) {
    if (!entry) return null;
    if (this._isCooling() || this._isHeatCool()) {
      if (entry.cooling_temp != null) return entry.cooling_temp;
      return this._diagData?.cooling_comfort ?? this._settingsData?.cooling_comfort ?? null;
    }
    return entry.target_temp;
  }

  // True when a cooling-season number is the global fallback, not the entry's own.
  _seasonTempIsFallback(entry) {
    return (this._isCooling() || this._isHeatCool()) && entry && entry.cooling_temp == null;
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
    const season = this._season();
    const cooling = season === "cooling";
    const both = season === "heat_cool";
    const LABEL = { heating: "Heating", cooling: "Cooling", heat_cool: "Heat·Cool" };
    const other = d.recommended_season || (cooling ? "heating" : "cooling");
    const otherLabel = LABEL[other] || "Cooling";
    const hours = d.season_conditions_hours || 0;
    const need = d.seasonal_recommend_hours || 0;
    const pct = need > 0 ? Math.min(100, (hours / need) * 100) : 0;
    const outdoor = d.features?.outdoor_temp;
    const hc = d.heat_cool || {};
    const days = (h) => h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
    let meta;
    if (both) {
      // In heat/cool the question is which side is still doing any work
      const quiet = other === "heating" ? "cooling" : "heating";
      if (d.suggest_season_switch) {
        meta = `<b>No ${quiet} for ${days(hours)}</b> — ${otherLabel} recommended`;
      } else if (hours > 0) {
        meta = `<b>No ${quiet} for ${days(hours)} of ${days(need)}</b>`;
      } else {
        meta = `<b>Heat and cool both in use</b>${outdoor != null ? ` · outside ${outdoor.toFixed(1)}°` : ""}`;
      }
      if (hc.cool_locked_out) meta += ` · <b>AC off below ${hc.cool_lockout_temp}°</b>`;
    } else if (d.suggest_season_switch) {
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
          <button class="season-seg-btn seg-heat" id="seasonHeatBtn" aria-pressed="${season === "heating"}">
            <ha-icon icon="mdi:fire"></ha-icon> Heat
          </button>
          <button class="season-seg-btn seg-both" id="seasonBothBtn" aria-pressed="${both}">
            <ha-icon icon="mdi:sun-snowflake-variant"></ha-icon> Heat·Cool
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
        : season === "heat_cool"
          ? "Heat·Cool — the thermostat heats below the band and cools above it."
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
              <label>Cooling target (°F)${this._isCooling() || this._isHeatCool() ? ` <span class="form-label-now">in use now</span>` : ""}
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
    this._addClick("seasonBothBtn", () => this._setSeason("heat_cool"));
    root.querySelectorAll("[data-season-switch]").forEach(btn => {
      btn.addEventListener("click", () => this._setSeason(btn.dataset.seasonSwitch));
    });

    // Main tab bar
    root.querySelectorAll(".main-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.mainTab;
        if (tab === this._activeMainTab) return;
        this._activeMainTab = tab;
        this._setSheet = null;
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
      this._setSheet = "windows";
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
    this._attachNowListeners();
    if (this._activeMainTab === "settings") this._attachSettingsSheetListeners();
    if (this._activeMainTab === "schedule") this._attachScheduleTabListeners();
    root.querySelectorAll("[data-hview]").forEach(b => b.addEventListener("click", () => {
      this._histView = b.dataset.hview;
      this._render();
      if (this._histView === "week" && !this._actionLog) this._loadActionLog();
    }));

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
          // Today's strip opens the same editor as the Schedule tab, on the
          // block this entry belongs to (a night stored in two halves is one).
          this._activeMainTab = "schedule";
          this._planView = null; this._planModeSel = null; this._planPart = null; this._planDay = null;
          const plan = this._viewPlan();
          const blocks = this._blocksOf(this._planDayList(plan, this._planTarget(plan).rep));
          const bi = blocks.findIndex(b => b.parts.some(p => p.time_start === entries[idx].time_start && p.time_end === entries[idx].time_end));
          if (bi >= 0) this._openBlock(bi); else this._render();
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
      this._presetModalTarget = this._viewPlan() || this._schedule.active_preset;
      this._showPresetModal = true;
      this._render();
    });
    this._addClick("renamePresetBtn", () => {
      this._presetModalMode = "rename";
      this._presetModalTarget = this._viewPlan() || this._schedule.active_preset;
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
      cool_lockout: "AC locked out",
      warm_zone: "Warm zone",
      overheat: "Overheat — AC on",
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


  _goalWhy(d) {
    const e = d.current_entry;
    switch (d.hvac_action_reason) {
      // The lockout has its own note under the hero; the why names the block
      case "cool_lockout":
      case "schedule":
        return e ? `On schedule until ${this._fmt12(e.time_end)}.` : "On schedule.";
      case "precondition": return "Pre-conditioning for the next block";
      case "occupancy_away": return "Nobody home — away setback";
      case "tou_adjustment": return "Peak-rate adjustment";
      case "heat_pump_step": return "Heat pump stepping up";
      case "fan_precool": return "Fan pre-cooling before the AC";
      case "overheat": return "Too warm inside — AC on despite the cold";
      case "warm_zone": return d.warm_zone ? `Cooling ${d.warm_zone} — it ran warm` : "Cooling the warmest zone";
      case "fallback": return "No schedule block — fallback";
      default: return d.schedule_enabled ? "Schedule" : "Schedule off";
    }
  }

  _renderNowBanners(d) {
    const banners = [];
    if (d.override_active) {
      const physical = d.override_source === "physical";
      const resumeBand = this._isHeatCool() && d.schedule_enabled && d.current_entry ? this._seasonBand(d.current_entry) : null;
      const resume = resumeBand ? this._fmtBand(resumeBand).replace(/°$/, "")
        : d.schedule_enabled && d.current_entry ? this._seasonTemp(d.current_entry) : null;
      banners.push(`
        <div class="now-banner banner-hold">
          <ha-icon icon="${physical ? "mdi:hand-back-right" : "mdi:clock-edit"}"></ha-icon>
          <span><b>${physical ? "Held at the thermostat" : d.override_target_low != null
            ? `Override ${d.override_target_low}–${d.override_target_high}°` : `Override ${d.override_target_temp}°`}</b>
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

  // The two things heat/cool does on its own, said only while it is doing them
  _heatCoolNotes(d) {
    if (!this._isHeatCool()) return "";
    const hc = d.heat_cool || {};
    const notes = [];
    if (hc.cool_locked_out) {
      notes.push(`<ha-icon icon="mdi:snowflake-off"></ha-icon> AC off below ${hc.cool_lockout_temp}° outside — the fan circulates instead.`);
    }
    if (hc.gap_adjusted_from != null && hc.low != null) {
      notes.push(`<ha-icon icon="mdi:arrow-expand-horizontal"></ha-icon> Heat lowered ${hc.gap_adjusted_from}° → ${hc.low}° to keep the thermostat's ${hc.min_gap}° gap.`);
    }
    return notes.map(n => `<div class="hc-note">${n}</div>`).join("");
  }

  _renderNowHero(d) {
    const action = d.hvac_action;
    const banners = this._renderNowBanners(d) + this._renderSeasonSuggest(d);
    const band = this._isHeatCool() && d.heat_cool?.low != null;
    const goal = band ? `${d.heat_cool.low}–${d.heat_cool.high}°`
      : d.target_temp != null ? `${+d.target_temp.toFixed(1)}°` : null;
    const verb = action === "heating" ? "Heating to" : action === "cooling" ? "Cooling to"
      : action === "fan" ? "Fan only · holding" : action === "off" ? "Off · goal" : "Holding";
    const icon = action === "heating" ? "mdi:fire" : action === "cooling" ? "mdi:snowflake"
      : action === "fan" ? "mdi:fan" : "mdi:thermostat";
    const where = d.active_zone_name ? ` · ${d.active_zone_name}` : "";
    return `
      <section class="now-hero">
        <div class="hero-temp" aria-label="${d.active_zone_name || "Active zone"} temperature">${d.current_temp != null
          ? d.current_temp.toFixed(1) : "—"}<small>°</small></div>
        <div class="hero-line ${action === "heating" ? "is-heat" : action === "cooling" ? "is-cool" : ""}">
          <ha-icon icon="${icon}"></ha-icon>
          <span>${goal != null ? `${verb} ${goal}` : "No goal yet"}${where}</span>
        </div>
        ${banners ? "" : `<p class="hero-why">${this._goalWhy(d)}</p>`}
        ${banners}
        ${this._heatCoolNotes(d)}
      </section>
    `;
  }

  // A season change the house is asking for is the one setting worth
  // interrupting Now for; everything else about seasons lives in Settings.
  _renderSeasonSuggest(d) {
    if (!d.suggest_season_switch) return "";
    const LABEL = { heating: "Heat", cooling: "Cool", heat_cool: "Heat · Cool" };
    const other = d.recommended_season || (this._isCooling() ? "heating" : "cooling");
    return `
      <div class="now-banner banner-season">
        <ha-icon icon="mdi:sun-snowflake-variant"></ha-icon>
        <span><b>${LABEL[other] || other} weather</b> · switch recommended</span>
        <button class="btn btn-sm" data-season-switch="${other}">Switch to ${LABEL[other] || other}</button>
      </div>`;
  }

  _renderNowRooms(d) {
    const zones = d.zones || [];
    const outdoor = d.features?.outdoor_temp;
    const t = v => v != null ? `${v.toFixed(1)}°` : `<span class="dim">no reading</span>`;
    return `
      <section class="now-card now-rooms" aria-label="Rooms">
        ${zones.map(z => `
          <button class="room-row" data-now-zone="${z.id}" ${z.is_active ? "disabled" : ""}
                  title="${z.is_active ? "The schedule follows this room" : "Follow this room instead"}">
            <span class="room-name">${z.name}${z.is_active ? ` <i>· leading</i>` : ""}</span>
            <span class="room-temp">${t(z.current_temp)}</span>
          </button>`).join("")}
        <div class="room-row room-outside">
          <span class="room-name">Outside</span>
          <span class="room-temp">${t(outdoor)}</span>
        </div>
      </section>
    `;
  }


  // Set-and-forget switches: they used to sit on Now, above nothing you
  // would change twice a year. They live at the top of Settings instead.
  _renderAutomations(d) {
    const f = d.features || {};
    const w = d.windows || {};
    const chips = [
      { id: "schedule", label: "Schedule", on: !!d.schedule_enabled },
      { id: "learning", label: d.learning?.patterns_learned ? `Learning · ${d.learning.patterns_learned} patterns` : "Learning", on: !!d.learning?.enabled },
      { id: "occupancy", label: "Presence", on: !!f.occupancy_enabled },
      { id: "tou", label: "Peak rates", on: !!f.tou_enabled },
      { id: "precondition", label: f.precondition_active ? "Pre-condition · running" : "Pre-condition", on: !!f.precondition_enabled },
      { id: "windows", label: "Pause HVAC", on: !!w.manual_override },
    ];
    return `
      <section class="now-card set-autos">
        <h2 class="card-h">Automations</h2>
        <div class="auto-chips">
          ${chips.map(c => `
            <button class="auto-chip ${c.on ? "chip-on" : "chip-off"}" data-auto-toggle="${c.id}" data-on="${c.on ? 1 : 0}"
                    aria-pressed="${c.on}">${c.label}</button>`).join("")}
        </div>
      </section>`;
  }


  // ── Schedule tab ──────────────────────────────────────────────────────────
  // Plans as cards; the viewed plan's day drawn from 6 AM, so a night is one
  // block instead of two halves split at midnight; one number per block; and
  // an editor that writes a whole day group as ONE undo step
  // (gttc/set_day_entries). The list is per calendar day and read circularly,
  // which is how _find_entry_for_time reads it: "19:00 → 06:00" on Monday is
  // Monday's evening AND Monday's early morning.

  _planKeys() {
    const s = this._schedule;
    const keys = Object.keys(s.presets || {});
    // The base lists only run when no plan is picked, so they are a plan of
    // their own only then. Otherwise they are a decoy that never runs.
    return s.active_preset ? keys : [...keys, ""];
  }

  _planLabel(k) {
    const s = this._schedule;
    return k ? (s.preset_labels?.[k] || s.presets?.[k]?.label || k) : "Base schedule";
  }

  _viewPlan() {
    const keys = this._planKeys();
    if (this._planView != null && keys.includes(this._planView)) return this._planView;
    return this._schedule.active_preset || "";
  }

  _planDayList(plan, day) {
    const s = this._schedule;
    if (plan) return s.presets?.[plan]?.schedule?.[day] || [];
    if (s.mode === "per_day") return s.per_day?.[day] || [];
    return ["saturday", "sunday"].includes(day) ? (s.weekend || []) : (s.weekday || []);
  }

  _planSig(plan, day) {
    return JSON.stringify(this._planDayList(plan, day)
      .map(e => [e.time_start, e.time_end, e.target_temp, e.cooling_temp ?? null, e.away_temp ?? null, e.zone_id || null])
      .sort());
  }

  // How the plan's days actually group: identical all week, weekdays vs
  // weekends, or each day its own.
  _planShape(plan) {
    const sig = DAYS_ORDERED.map(d => this._planSig(plan, d));
    if (sig.every(x => x === sig[0])) return "all";
    const wd = sig.slice(0, 5), we = sig.slice(5);
    if (wd.every(x => x === wd[0]) && we.every(x => x === we[0])) return "split";
    return "each";
  }

  _todayKey() {
    const g = new Date().getDay();
    return DAYS_ORDERED[g === 0 ? 6 : g - 1];
  }

  _planMode(plan) {
    const canEach = !!plan || this._schedule.mode === "per_day";
    const m = this._planModeSel || this._planShape(plan);
    return m === "each" && !canEach ? "split" : m;
  }

  // The days an edit writes to, and the day whose list stands for them.
  _planTarget(plan) {
    const mode = this._planMode(plan);
    const today = this._todayKey();
    if (mode === "all") return { days: [...DAYS_ORDERED], rep: today };
    if (mode === "split") {
      const part = this._planPart || (["saturday", "sunday"].includes(today) ? "weekend" : "weekdays");
      const days = part === "weekend" ? ["saturday", "sunday"] : DAYS_ORDERED.slice(0, 5);
      return { days, rep: days.includes(today) ? today : days[0], part };
    }
    const day = this._planDay || today;
    return { days: [day], rep: day };
  }

  // "17:59" runs through the end of that minute (v2.5.0), so it ends at :00.
  _endMin(t) {
    const m = timeToMinutes(t);
    return /:59$/.test(t) ? m + 1 : m;
  }

  _span(e) {
    const a = timeToMinutes(e.time_start);
    const b = this._endMin(e.time_end);
    return { a, len: b > a ? b - a : b < a ? b + 1440 - a : 0 };
  }

  _entryKey(e) {
    return JSON.stringify([e.target_temp, e.cooling_temp ?? null, e.away_temp ?? null, e.zone_id || null]);
  }

  // Entries → blocks. Touching entries with the same settings merge, which is
  // what turns a night stored as 20:00–23:59 + 00:00–05:59 back into one.
  _blocksOf(list) {
    let blocks = list.map(e => ({ ...this._span(e), key: this._entryKey(e), parts: [e] }))
      .filter(b => b.len > 0);
    for (let guard = 0; guard < 8; guard++) {
      let merged = false;
      for (const x of blocks) {
        const y = blocks.find(o => o !== x && o.key === x.key && o.a === (x.a + x.len) % 1440);
        if (y && x.len + y.len <= 1440) {
          x.len += y.len; x.parts = [...x.parts, ...y.parts];
          blocks = blocks.filter(o => o !== y); merged = true; break;
        }
      }
      if (!merged) break;
    }
    const ax = m => (m - 360 + 1440) % 1440;
    return blocks.sort((p, q) => ax(p.a) - ax(q.a)).map(b => ({ ...b, e: b.parts[0], name: this._blockName(b) }));
  }

  _blockName(b) {
    if (b.len >= 1439) return "All day";
    const s = b.a, e = b.a + b.len;
    if (e > 1440 || s < 300) return "Overnight";
    if (s <= 720 && e > 720) return "Day";
    if (s < 720) return "Morning";
    if (s < 1020) return "Afternoon";
    return "Evening";
  }

  _gapsOf(list) {
    const cov = new Array(1440).fill(false);
    list.forEach(e => { const { a, len } = this._span(e); for (let k = 0; k < len; k++) cov[(a + k) % 1440] = true; });
    if (!cov.some(Boolean)) return [];
    const gaps = [];
    for (let k = 0; k < 1440;) {
      const m = (360 + k) % 1440;
      if (cov[m]) { k++; continue; }
      let n = 0;
      while (k + n < 1440 && !cov[(360 + k + n) % 1440]) n++;
      if (n > 1) gaps.push([m, (m + n) % 1440]);
      k += n;
    }
    return gaps;
  }

  _clock(m) {
    m = ((m % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60), mm = m % 60;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }

  _hhmm(m) {
    m = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }

  _blockRange(b) {
    if (b.len >= 1439) return "all day";
    return `${this._clock(b.a)} → ${this._clock(b.a + b.len)}`;
  }

  // Paint a day's minutes: the list minus `remove`, then `add` on top, read
  // back as entries. Overlaps resolve to the newest block, so moving a block
  // over its neighbour trims the neighbour instead of leaving two answers.
  _paintDay(list, remove, add) {
    const slot = new Array(1440).fill(null);
    const gone = e => remove.some(p => p.time_start === e.time_start && p.time_end === e.time_end);
    list.forEach(e => {
      if (gone(e)) return;
      const { a, len } = this._span(e);
      for (let k = 0; k < len; k++) slot[(a + k) % 1440] = e;
    });
    if (add) for (let k = 0; k < add.len; k++) slot[(add.a + k) % 1440] = add.e;
    let start = slot.findIndex((v, i) => v !== slot[(i + 1439) % 1440]);
    const out = [];
    const emit = (e, a, len) => {
      if (!e) return;
      const end = a + len;
      out.push({
        time_start: this._hhmm(a),
        time_end: len >= 1440 ? "23:59" : end === 1440 ? "23:59" : this._hhmm(end),
        target_temp: e.target_temp,
        cooling_temp: e.cooling_temp ?? null,
        away_temp: e.away_temp ?? null,
        zone_id: e.zone_id || null,
      });
    };
    if (start < 0) { emit(slot[0], 0, 1440); return out; }
    let runStart = start, cur = slot[start];
    for (let k = 1; k <= 1440; k++) {
      const m = (start + k) % 1440;
      if (k === 1440 || slot[m] !== cur) {
        emit(cur, runStart, (k + start - runStart + 1440) % 1440 || 1440);
        runStart = m; cur = slot[m];
      }
    }
    return out.sort((p, q) => p.time_start.localeCompare(q.time_start));
  }

  _zoneNow(zoneId) {
    const z = (this._diagData?.zones || []).find(x => x.id === zoneId);
    return z && z.current_temp != null ? z.current_temp : null;
  }

  _coolOf(e) {
    return e.cooling_temp != null ? e.cooling_temp : (this._diagData?.cooling_comfort ?? this._settingsData?.cooling_comfort ?? null);
  }

  // One number when heat and cool agree (or cool is unset); both otherwise.
  _asksFor(e) {
    const cool = this._coolOf(e);
    if (e.cooling_temp == null) return `Heat to <b>${e.target_temp}°</b> <span class="sx-dim">· cool uses the default${cool != null ? ` (${cool}°)` : ""}</span>`;
    if (e.cooling_temp === e.target_temp) return `Keep it at <b>${e.target_temp}°</b> <span class="sx-dim">· heat below, cool above</span>`;
    return `Heat to <b>${e.target_temp}°</b>, cool to <b>${e.cooling_temp}°</b>`;
  }

  // The number the block holds in the season the house is in.
  _blockTemp(e) {
    if (this._isHeatCool()) return this._fmtBand(this._seasonBand(e));
    return this._fmtTemp(this._seasonTemp(e));
  }

  _planIssues(plan) {
    const out = [];
    const label = this._planLabel(plan);
    const seen = new Set();
    DAYS_ORDERED.forEach(day => {
      const list = this._planDayList(plan, day);
      const sig = this._planSig(plan, day);
      if (seen.has(sig)) return;
      seen.add(sig);
      const days = DAYS_ORDERED.filter(d => this._planSig(plan, d) === sig);
      const when = days.length === 7 ? "" : ` on ${this._groupLabel(days)}`;
      if (!list.length) { out.push({ plan, text: `<b>${label} has nothing scheduled${when}.</b> GTTC keeps the last goal then.` }); return; }
      this._gapsOf(list).forEach(([a, b]) => out.push({ plan,
        text: `<b>${label} has nothing scheduled ${this._clock(a)}–${this._clock(b)}${when}.</b> GTTC keeps the last goal${this._isCooling() || this._isHeatCool() ? " (or the cool default)" : ""} until the next block.` }));
      if (list.some(e => !e.zone_id)) out.push({ plan,
        text: `<b>${label} has blocks that don't say which room counts${when}.</b> They keep measuring whichever room the last block picked.` });
    });
    return out;
  }


  _miniBar(blocks) {
    const s = this._schedule;
    const ax = m => ((m - 360 + 1440) % 1440) / 1440 * 100;
    return blocks.map(b => {
      const t = this._seasonTemp(b.e);
      const col = t != null ? tempColor(t, s.temp_min, s.temp_max) : "var(--divider)";
      const l = ax(b.a), w = b.len / 14.4;
      return l + w > 100.01
        ? `<i style="left:${l}%;width:${100 - l}%;background:${col}"></i><i style="left:0;width:${w - (100 - l)}%;background:${col}"></i>`
        : `<i style="left:${l}%;width:${w}%;background:${col}"></i>`;
    }).join("");
  }

  // ── Block editor ──────────────────────────────────────────────────────────

  _openBlock(idx) {
    const plan = this._viewPlan();
    const tgt = this._planTarget(plan);
    const list = this._planDayList(plan, tgt.rep);
    const blocks = this._blocksOf(list);
    const zones = this._schedule.zones || [];
    const activeZone = this._diagData?.zones?.find(z => z.is_active)?.id || zones[0]?.id || "";
    let parts = [], draft;
    if (idx == null) {
      // A new block fills the first gap if there is one, otherwise 6–10 PM.
      const g = this._gapsOf(list)[0];
      const a = g ? g[0] : 1080, b = g ? g[1] : 1320;
      const ref = blocks[0]?.e;
      draft = { start: this._hhmm(a), end: this._hhmm(b), temp: ref?.target_temp ?? 70, cool: ref?.cooling_temp ?? ref?.target_temp ?? 72,
        split: false, zone: ref?.zone_id || activeZone, away: null, name: "New block" };
    } else {
      const b = blocks[idx];
      if (!b) return;
      parts = b.parts;
      const split = b.e.cooling_temp != null && b.e.cooling_temp !== b.e.target_temp;
      draft = { start: this._hhmm(b.a), end: this._hhmm(b.a + b.len), temp: b.e.target_temp,
        cool: b.e.cooling_temp ?? b.e.target_temp, split, zone: b.e.zone_id || "", away: b.e.away_temp ?? null,
        name: b.name, coolWasDefault: b.e.cooling_temp == null };
    }
    this._blk = { plan, days: tgt.days, rep: tgt.rep, parts, draft, isNew: idx == null,
      pv: this._isHeatCool() ? "heat_cool" : this._isCooling() ? "cooling" : "heating", armDelete: false };
    this._render();
  }

  _blkSpan() {
    const d = this._blk.draft;
    const a = timeToMinutes(d.start), e = timeToMinutes(d.end);
    return { a, len: e > a ? e - a : e < a ? e + 1440 - a : 1440 };
  }

  _blkEntry() {
    const d = this._blk.draft;
    return { target_temp: d.temp, cooling_temp: d.split ? d.cool : d.temp, away_temp: d.away, zone_id: d.zone || null };
  }


  async _saveBlock(remove) {
    const B = this._blk;
    if (!B) return;
    const list = this._planDayList(B.plan, B.rep);
    const add = remove ? null : { ...this._blkSpan(), e: this._blkEntry() };
    const entries = this._paintDay(list, B.parts, add);
    const msg = { type: "gttc/set_day_entries", days: B.days, entries };
    if (B.plan) msg.preset = B.plan;
    try {
      await this._hass.callWS(msg);
      this._blk = null;
      await this._loadData();
      this._showToast(remove ? "Block deleted." : `Saved to ${this._planLabel(B.plan)}.`);
    } catch (err) {
      this._showToast(`Not saved: ${err.message || err}`, "error");
    }
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
      cool_lockout: "AC locked out", warm_zone: "Warm zone", overheat: "Overheat — AC on",
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
        if (last && last.reason === e.reason && last.target_temp === e.target_temp && last.target_high === e.target_high) continue;
        runs.push({ ts: e.ts, reason: e.reason, target_temp: e.target_temp, target_high: e.target_high });
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
          <span class="log-temp">${r.target_high != null ? `${r.target_temp}–${r.target_high}°` : `${r.target_temp}°`}</span>
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
      <p class="set-lede">Currently <b>${d.season === "cooling" ? "cooling" : d.season === "heat_cool" ? "heat·cool" : "heating"}</b>. Switch with the Heat · Heat·Cool · Cool control above — it applies immediately. These are the rules for when GTTC recommends or makes the switch itself.</p>
      ${this._boolField("heat_cool_ladder", "Heat·Cool in spring and fall",
        "Auto-switch goes Heat → Heat·Cool → Cool and back, never straight across. Off: straight between Heat and Cool.")}
      ${this._numField("cool_lockout_temp", "No AC below", "In Heat·Cool, outside temperature under which the AC stays off and the fan circulates instead. A hold or boost still cools, and so does a zone 3° over its goal (above 40° outside).", { min: 30, max: 70, step: 1 })}
      ${this._rangeField("heat_cool_settle_days", "Back to one mode after", "Days with only heat, or only cooling, before Heat·Cool hands over to that season.", { min: 1, max: 30, step: 1, suffix: " d" })}
      ${this._numField("heat_cool_min_gap", "Minimum gap", "Match the thermostat's own Auto Differential. Blocks narrower than this have their heat end lowered.", { min: 0, max: 10, step: 0.5 })}
      ${this._boolField("auto_season_switch", "Switch automatically",
        "Switch to the other season once the threshold below is reached. Off: GTTC only recommends.")}
      ${this._rangeField("seasonal_recommend_hours", "Hours before recommending a switch",
        "The house must sit 1° past the other season's goal this long, with this season's equipment idle. Heat also needs a cold outside. Any break, or an open window, resets the count.",
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
      this._setSheet = null;
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

  // ══ v2.8.0 — phone first ═════════════════════════════════════════════════
  // One graphic and one number per card. Words are kept to a phrase; colour
  // only ever means temperature (tempColor) or heat/cool.

  _ic(name, cls = "") { return `<ha-icon class="${cls}" icon="mdi:${name}"></ha-icon>`; }

  _liveChip() {
    const t = this._lastFetchAt ? new Date(this._lastFetchAt) : null;
    const txt = t ? t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "") : "—";
    return `<span class="live-chip" title="Updated ${txt}"><i></i>${txt}</span>`;
  }

  _renderMainTabBar() {
    const dirty = Object.keys(this._draft || {}).length > 0;
    const tabs = [["now", "thermometer", "Now"], ["schedule", "calendar-blank-outline", "Schedule"],
      ["history", "history", "History"], ["settings", "cog-outline", "Settings"]];
    return `
      <nav class="main-tab-bar" aria-label="Tabs">
        ${tabs.map(([id, ic, l]) => `
          <button class="main-tab ${this._activeMainTab === id ? "active" : ""}" data-main-tab="${id}"
                  aria-current="${this._activeMainTab === id ? "page" : "false"}">${this._ic(ic)}<span>${l}${id === "settings" && dirty ? " •" : ""}</span></button>`).join("")}
      </nav>`;
  }

  // "17:59" ends at 6 PM — short clock for pills and labels: 6p, 6:30a
  _short12(m) {
    m = ((m % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60), mm = m % 60;
    return `${h % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`;
  }

  // ── The dial ──────────────────────────────────────────────────────────────
  // A 270° horseshoe painted with the whole comfort scale. The stretch the
  // system is working across (room → goal, or the Heat·Cool band) is full
  // strength; the rest is a quiet wash. Cold and hot circles cap the ends
  // with the range's numbers; the goal is a handle carrying its number.
  _dialSVG(o) {
    const { lo, hi, cur, mode, act, room } = o;
    const MIN = o.min, MAX = o.max, SPAN = Math.max(1, MAX - MIN);
    const dark = this.hasAttribute("dark");
    const T = dark
      ? { ink: "#eceef2", ink2: "#9aa1ae", track: [42, 46, 54], surf: "#1a1d23", heat: "#ff8a50", cool: "#7fb0ff" }
      : { ink: "#15181d", ink2: "#5a6170", track: [236, 238, 241], surf: "#ffffff", heat: "#c2410c", cool: "#1d5fd1" };
    const tca = t => tempColor(t, MIN, MAX).match(/\d+/g).map(Number);
    const rgb = c => `rgb(${c.join(",")})`;
    const ink = t => tempInk(t, MIN, MAX);
    const off = mode === "off";
    const R = 116, W = 16;
    const clamp = t => Math.max(MIN, Math.min(MAX, t));
    const ang = t => (135 + (clamp(t) - MIN) / SPAN * 270) * Math.PI / 180;
    const pt = (r, t) => ({ x: +(150 + r * Math.cos(ang(t))).toFixed(2), y: +(150 + r * Math.sin(ang(t))).toFixed(2) });
    const arc = (t1, t2) => {
      const a = pt(R, t1), b = pt(R, t2), large = (t2 - t1) / SPAN * 270 > 180 ? 1 : 0;
      return `M${a.x} ${a.y} A${R} ${R} 0 ${large} 1 ${b.x} ${b.y}`;
    };
    const handleTs = off || lo == null ? [] : mode === "band" ? [lo, hi] : [lo];
    const live = off || lo == null ? null
      : mode === "band" ? [clamp(lo), clamp(hi)]
      : (act === "heating" || act === "cooling") && cur != null ? [clamp(Math.min(cur, lo)), clamp(Math.max(cur, lo))] : null;
    const wash = off ? 0 : dark ? 0.5 : 0.38;
    const mix = (c, k) => c.map((v, j) => Math.round(T.track[j] + (v - T.track[j]) * k));
    // A goal parked on an end becomes that end: the scale stops at the handle
    const nearEnd = e => handleTs.find(h => Math.abs(clamp(h) - e) < SPAN * 0.14);
    const A = nearEnd(MIN) !== undefined ? clamp(nearEnd(MIN)) : MIN;
    const B = nearEnd(MAX) !== undefined ? clamp(nearEnd(MAX)) : MAX;
    const STEP = SPAN / 120;
    let segs = "";
    for (let t = A; t < B - 1e-6; t += STEP) {
      const mid = t + STEP / 2, on = live && mid >= live[0] && mid <= live[1];
      const t2 = Math.min(B, t + STEP * 1.35), edge = t === A || t2 >= B;
      segs += `<path d="${arc(t, t2)}" style="fill:none;stroke:${rgb(on ? tca(mid) : mix(tca(mid), wash))};stroke-width:${W}px;stroke-linecap:${edge ? "round" : "butt"}"/>`;
    }
    const txt = (x, y, s, size, weight, col, extra = "") =>
      `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" style="font:${weight} ${size}px Inter,system-ui,sans-serif;fill:${col};${extra}">${s}</text>`;
    let ends = "";
    for (const e of [MIN, MAX]) {
      if (nearEnd(e) !== undefined) continue;
      const c = pt(R, e);
      ends += `<circle cx="${c.x}" cy="${c.y}" r="15" style="fill:${off ? rgb(T.track) : rgb(tca(e))};stroke:${T.surf};stroke-width:3px"/>`
        + txt(c.x, c.y, Math.round(e), 11, 800, off ? T.ink2 : ink(e));
    }
    const curDot = !off && cur != null && !handleTs.some(h => Math.abs(h - cur) < 0.9)
      ? (() => { const c = pt(R, cur); return `<circle cx="${c.x}" cy="${c.y}" r="6.5" style="fill:${T.ink};stroke:${T.surf};stroke-width:3px"/>`; })() : "";
    const handles = handleTs.map((t, i) => {
      const which = i ? "hi" : "lo", c = pt(R, t), selected = mode === "band" && (o.sel || "lo") === which;
      return `<g class="dial-h" ${mode === "band" ? `data-dial-sel="${which}" role="button" aria-label="${which === "lo" ? "Heat end" : "Cool end"} ${t}°"` : ""}>
        <circle cx="${c.x}" cy="${c.y}" r="27" style="fill:transparent;stroke:${selected ? T.ink : "transparent"};stroke-width:2.5px"/>
        <circle cx="${c.x}" cy="${c.y}" r="21" style="fill:${rgb(tca(t))};stroke:${T.surf};stroke-width:4px"/>
        ${txt(c.x, c.y, Math.round(t * 2) / 2, 16, 800, ink(t))}</g>`;
    }).join("");
    const goalCol = off ? T.ink2 : act === "heating" ? T.heat : act === "cooling" ? T.cool : T.ink2;
    const goalText = off ? "Off" : lo == null ? "—" : mode === "band" ? `${Math.round(lo)}–${Math.round(hi)}°` : `${Math.round(lo * 2) / 2}°`;
    const ICON = {
      heating: "M12 3c1 3 4.5 4.6 4.5 9a4.5 4.5 0 0 1-9 0c0-1.7.7-2.9 1.7-3.9.3 1.7 1.3 2.6 2.2 2.7-.6-2.7-.5-5 .6-7.8z",
      cooling: "M12 2v20M3.3 7l17.4 10M20.7 7L3.3 17M9 4l3 2 3-2M9 20l3-2 3 2",
      fan: "M12 12c0-3 1-6 4-6s3 3 0 5zM12 12c3 0 6 1 6 4s-3 3-5 0zM12 12c0 3-1 6-4 6s-3-3 0-5zM12 12c-3 0-6-1-6-4s3-3 5 0z",
    };
    const showAct = !off && ICON[act];
    const gw = String(goalText).length * 12.5, rowW = showAct ? 28 + gw : gw;
    const goalX = showAct ? 150 - rowW / 2 + 28 + gw / 2 : 150;
    const label = `${room || "Room"} ${cur != null ? cur.toFixed(1) : "unknown"} degrees, ${act || "idle"}, goal ${goalText}`;
    return `
      <svg class="dial" viewBox="0 0 300 300" role="img" aria-label="${label}">
        ${segs}${ends}${curDot}${handles}
        ${txt(150, 113, room || "", 14, 600, T.ink2)}
        ${txt(150, 156, cur != null ? cur.toFixed(1) + "°" : "—", 60, 800, T.ink, "letter-spacing:-2.5px")}
        ${showAct ? `<g transform="translate(${(150 - rowW / 2).toFixed(1)} 197) scale(0.92)"><path d="${ICON[act]}" style="fill:none;stroke:${goalCol};stroke-width:2.4px;stroke-linecap:round;stroke-linejoin:round"/></g>` : ""}
        ${txt(goalX, 208, goalText, 21, 800, goalCol)}
      </svg>`;
  }

  // ── Now ───────────────────────────────────────────────────────────────────

  _nowGoal(d) {
    const off = d.hvac_mode === "off";
    const band = !off && this._isHeatCool() && d.heat_cool?.low != null;
    let lo = d.target_temp, hi = null;
    if (band) {
      lo = d.override_active && d.override_target_low != null ? d.override_target_low : d.heat_cool.low;
      hi = d.override_active && d.override_target_high != null ? d.override_target_high : d.heat_cool.high;
    }
    const p = this._goalPending;
    if (p && Date.now() - p.at < 30000) { lo = p.lo; if (band && p.hi != null) hi = p.hi; }
    return { off, band, lo, hi, mode: off ? "off" : band ? "band" : this._isCooling() ? "cool" : "heat" };
  }

  _stepGoal(n) {
    const d = this._diagData;
    if (!d) return;
    const g = this._nowGoal(d);
    if (g.off || g.lo == null) return;
    const s = this._schedule;
    const clamp = v => Math.max(s.temp_min, Math.min(s.temp_max, v));
    const step = v => n > 0 ? Math.floor(v) + 1 : Math.ceil(v) - 1;
    let lo = g.lo, hi = g.hi;
    if (g.band) {
      const gap = this._minGap();
      if (this._dialSel === "hi") { hi = clamp(step(hi)); if (hi - lo < gap) lo = clamp(hi - gap); }
      else { lo = clamp(step(lo)); if (hi - lo < gap) hi = clamp(lo + gap); }
    } else lo = clamp(step(lo));
    this._goalPending = { lo, hi: g.band ? hi : null, at: Date.now() };
    this._render();
    clearTimeout(this._goalTimer);
    this._goalTimer = setTimeout(() => this._sendGoal(), 700);
  }

  async _sendGoal() {
    const p = this._goalPending;
    if (!p) return;
    const id = this._diagData?.entity_ids?.climate || "climate.gttc";
    try {
      await this._hass.callService("climate", "set_temperature", p.hi != null
        ? { entity_id: id, target_temp_low: p.lo, target_temp_high: p.hi }
        : { entity_id: id, temperature: p.lo });
      setTimeout(async () => {
        await this._refreshLive();
        if (this._goalPending === p) { this._goalPending = null; this._repaint(); }
      }, 1500);
    } catch (err) {
      this._goalPending = null;
      this._showToast(`Not changed: ${err.message || err}`, "error");
      this._render();
    }
  }

  async _setHvacMode(m) {
    const d = this._diagData || {};
    const id = d.entity_ids?.climate || "climate.gttc";
    const wasOff = d.hvac_mode === "off";
    const season = { heat: "heating", cool: "cooling", heat_cool: "heat_cool" }[m];
    try {
      if (m === "off") {
        await this._hass.callService("climate", "set_hvac_mode", { entity_id: id, hvac_mode: "off" });
      } else {
        if (season !== this._season()) await this._hass.callWS({ type: "gttc/set_season", season });
        // From Off, the season change alone leaves the thermostat off
        if (wasOff) await this._hass.callService("climate", "set_hvac_mode", { entity_id: id, hvac_mode: m === "heat_cool" ? "heat_cool" : m });
      }
      await this._loadData();
    } catch (err) {
      this._showToast(`Mode not changed: ${err.message || err}`, "error");
    }
  }

  _nowAlerts(d) {
    const out = [];
    const chip = (ic, txt, btn = "") => `<div class="nw-alert">${this._ic(ic)}<b>${txt}</b>${btn}</div>`;
    if (d.vacation_mode) {
      const until = new Date(d.vacation_mode.end_dt).toLocaleDateString([], { month: "short", day: "numeric" });
      out.push(chip("airplane", `Away · ${until}`, `<button class="nw-abtn" id="clearVacationBtn">End</button>`));
    }
    const w = d.windows || {};
    if (w.open) out.push(chip("window-open-variant", `${w.open_sensors.length} open`, `<button class="nw-abtn js-window-settings">Windows</button>`));
    else if (w.manual_override) out.push(chip("pause-circle-outline", "Paused", `<button class="nw-abtn" data-auto-toggle="windows" data-on="1">Resume</button>`));
    if (d.suggest_season_switch) {
      const LABEL = { heating: "Heat", cooling: "Cool", heat_cool: "Both" };
      const other = d.recommended_season || (this._isCooling() ? "heating" : "cooling");
      out.push(chip("sun-snowflake-variant", `${LABEL[other] || other} weather`, `<button class="nw-abtn" data-season-switch="${other}">Switch</button>`));
    }
    if (this._isHeatCool()) {
      const hc = d.heat_cool || {};
      if (hc.cool_locked_out) out.push(chip("snowflake-off", `AC off · under ${hc.cool_lockout_temp}°`));
      if (hc.gap_adjusted_from != null && hc.low != null) out.push(chip("arrow-expand-horizontal", `Heat ${hc.gap_adjusted_from}° → ${hc.low}°`));
    }
    return out.length ? `<div class="nw-alerts">${out.join("")}</div>` : "";
  }

  _nowPill(d) {
    if (d.override_active) {
      const m = Math.max(0, Math.round(d.override_remaining_minutes || 0));
      const t = `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
      return `<div class="nw-pill nw-pill-hold" title="${d.override_source === "physical" ? "Held at the thermostat" : "Your change"} · back to the plan in ${t}">
        ${this._ic(d.override_source === "physical" ? "hand-back-right-outline" : "timer-outline")}<b>${t}</b>
        <button class="nw-pill-x js-cancel-override" aria-label="Back to the plan">${this._ic("close")}</button></div>`;
    }
    const WHY = {
      schedule: "calendar-blank-outline", cool_lockout: "calendar-blank-outline", occupancy_away: "home-export-outline",
      vacation: "airplane", precondition: "weather-sunset-up", tou_adjustment: "lightning-bolt", heat_pump_step: "heat-pump-outline",
      fan_precool: "fan", window_open: "window-open-variant", overheat: "snowflake-alert", warm_zone: "thermometer-high",
    };
    const r = d.hvac_action_reason;
    const e = d.current_entry;
    const onPlan = r === "schedule" || r === "cool_lockout" || !r;
    const txt = onPlan ? (e ? this._short12(this._endMin(e.time_end)) : "Plan") : this._reasonLabel(r);
    return `<button class="nw-pill" data-goto="schedule" title="${this._goalWhy(d)}">${this._ic(WHY[r] || "calendar-blank-outline")}<b>${txt}</b></button>`;
  }

  _renderNowTab() {
    const d = this._diagData;
    if (!d) return `<div class="status-loading"><ha-icon icon="mdi:loading"></ha-icon> Loading…</div>`;
    const s = this._schedule;
    const g = this._nowGoal(d);
    const act = g.off ? "off" : d.hvac_action;
    const dial = this._dialSVG({ lo: g.lo, hi: g.hi, cur: d.current_temp, min: s.temp_min, max: s.temp_max,
      mode: g.mode, act, room: d.active_zone_name, sel: this._dialSel || "lo" });
    const mode = d.hvac_mode === "off" ? "off" : this._isHeatCool() ? "heat_cool" : this._isCooling() ? "cool" : "heat";
    const M = [["heat", "fire", "Heat"], ["heat_cool", "sun-snowflake-variant", "Both"], ["cool", "snowflake", "Cool"], ["off", "power", "Off"]];
    const zones = d.zones || [];
    const w = d.windows || {};
    const plan = s.active_preset ? this._planLabel(s.active_preset) : "Base";
    const dot = t => t != null ? `<i class="nw-dot" style="background:${tempColor(t, s.temp_min, s.temp_max)}"></i>` : "";
    const t1 = v => v != null ? `${v.toFixed(1)}°` : `<span class="dim">—</span>`;
    const outdoor = d.features?.outdoor_temp;
    return `
      <div class="nw">
        ${this._nowAlerts(d)}
        <div class="nw-cols">
          <section class="card nw-dialcard">
            ${dial}
            <div class="nw-ctl">
              <button class="nw-step" data-goal-step="-1" aria-label="Cooler" ${g.off ? "disabled" : ""}>${this._ic("minus")}</button>
              ${this._nowPill(d)}
              <button class="nw-step" data-goal-step="1" aria-label="Warmer" ${g.off ? "disabled" : ""}>${this._ic("plus")}</button>
            </div>
          </section>
          <div class="nw-side">
            <div class="card nw-modes" role="group" aria-label="Mode">
              ${M.map(([k, ic, l]) => `<button class="nw-mode nw-mode-${k} ${k === mode ? "on" : ""}" data-hvac-mode="${k}" aria-pressed="${k === mode}">${this._ic(ic)}<span>${l}</span></button>`).join("")}
            </div>
            <div class="nw-tiles">
              <button class="card nw-tile" data-goto="schedule">${this._ic("calendar-blank-outline")}<b>${plan}</b><span>Plan</span></button>
              <button class="card nw-tile" id="nwRoomBtn" ${zones.length < 2 ? "disabled" : ""}>${this._ic("map-marker-outline")}<b>${d.active_zone_name || "—"}</b><span>Room</span></button>
              <button class="card nw-tile" data-auto-toggle="windows" data-on="${w.manual_override ? 1 : 0}">${this._ic(w.manual_override ? "play-circle-outline" : "pause-circle-outline")}<b>${w.manual_override ? "Paused" : "Running"}</b><span>${w.manual_override ? "Resume" : "Pause"}</span></button>
            </div>
            <div class="nw-rooms">
              ${zones.map(z => `
                <button class="card nw-room ${z.is_active ? "on" : ""}" data-now-zone="${z.id}" ${z.is_active ? "disabled" : ""}
                        title="${z.is_active ? "The plan follows this room" : "Follow this room"}">
                  <span>${z.name}</span><b>${dot(z.current_temp)}${t1(z.current_temp)}</b></button>`).join("")}
              <div class="card nw-room nw-out"><span>Outside</span><b>${dot(outdoor)}${t1(outdoor)}</b></div>
            </div>
            ${this._renderTodayStrip()}
            ${this._renderNowActions(d)}
          </div>
        </div>
      </div>`;
  }

  _renderNowActions(d) {
    const boosts = this._isHeatCool()
      ? [{ id: "warm_up", big: "+3°", sub: "1h", cls: "tile-heat" }, { id: "cool_down", big: "−3°", sub: "1h", cls: "tile-cool" }]
      : this._isCooling()
      ? [{ id: "max_cool", big: "−4°", sub: "1½h", cls: "tile-cool" }, { id: "cool_down", big: "−3°", sub: "1h", cls: "tile-cool" }]
      : [{ id: "boost", big: "+4°", sub: "1½h", cls: "tile-heat" }, { id: "warm_up", big: "+3°", sub: "1h", cls: "tile-heat" }];
    return `
      <div class="nw-acts">
        ${boosts.map(b => `<button class="card nw-act ${b.cls} boost-btn" data-boost-type="${b.id}"><b>${b.big}</b><span>${b.sub}</span></button>`).join("")}
        ${d.vacation_mode ? "" : `<button class="card nw-act" id="setVacationBtn">${this._ic("airplane")}<span>Away</span></button>`}
      </div>`;
  }

  _renderTodayStrip() {
    const today = this._todayKey();
    const entries = this._getEntriesForDay(today);
    return `
      <section class="card now-today" aria-label="Today">
        <div class="week-row-timeline today-timeline">
          ${this._renderOnPeakOverlay(today)}
          ${this._renderTimelineBlocks(entries, today, true)}
          <div class="now-line" style="left:${this._nowPercent()}%"></div>
        </div>
        <div class="today-axis">
          <span style="left:0">12a</span><span style="left:25%">6a</span><span style="left:50%">12p</span>
          <span style="left:75%">6p</span><span style="left:100%">12a</span>
        </div>
      </section>`;
  }

  _attachNowListeners() {
    const root = this.shadowRoot;
    root.querySelectorAll("[data-goal-step]").forEach(b => b.addEventListener("click", () => this._stepGoal(Number(b.dataset.goalStep))));
    root.querySelectorAll("[data-dial-sel]").forEach(g => g.addEventListener("click", () => { this._dialSel = g.dataset.dialSel; this._render(); }));
    root.querySelectorAll("[data-hvac-mode]").forEach(b => b.addEventListener("click", () => {
      if (b.classList.contains("on")) return;
      b.disabled = true;
      this._setHvacMode(b.dataset.hvacMode);
    }));
    root.querySelectorAll("[data-goto]").forEach(b => b.addEventListener("click", () => { this._activeMainTab = b.dataset.goto; this._render(); }));
    this._addClick("nwRoomBtn", async () => {
      const zones = this._diagData?.zones || [];
      const i = zones.findIndex(z => z.is_active);
      const next = zones[(i + 1) % zones.length];
      if (!next || next.is_active) return;
      try {
        await this._hass.callWS({ type: "gttc/set_active_zone", zone_id: next.id });
        await this._loadData();
      } catch (err) { this._showToast(`Room not changed: ${err.message || err}`, "error"); }
    });
  }

  // ── Schedule ──────────────────────────────────────────────────────────────
  // Plans as buttons with a colour bar; the whole week as seven colour bars on
  // a 6 AM → 6 AM axis; tap a block to edit it in a sheet. Which days an edit
  // writes to is the plan's day grouping (Same / Weekdays·Weekends / Each).

  _sxViewSeason() {
    if (this._sxView) return this._sxView;
    return this._isCooling() ? "cooling" : "heating";
  }

  _sxTemp(e) {
    return this._sxViewSeason() === "cooling" ? this._coolOf(e) : e.target_temp;
  }

  _renderScheduleTab() {
    const s = this._schedule;
    const d = this._diagData || {};
    const plan = this._viewPlan();
    const running = s.active_preset || "";
    const isRunning = plan === running;
    const mode = this._planMode(plan);
    const tgt = this._planTarget(plan);
    const cur = d.current_entry || this._status?.current_entry;
    const canEach = !!plan || s.mode === "per_day";
    const custom = plan && s.presets?.[plan] && !s.presets[plan].is_builtin;
    const view = this._sxViewSeason();
    const today = this._todayKey();
    const ax = m => ((m - 360 + 1440) % 1440) / 1440 * 100;

    const cards = this._planKeys().map(k => {
      const kb = this._blocksOf(this._planDayList(k, today));
      const n = this._planIssues(k).length;
      return `
        <button class="sx-plan ${k === plan ? "sx-plan-on" : ""}" data-plan="${k}" aria-pressed="${k === plan}">
          <span class="sx-plan-top"><b>${this._planLabel(k)}</b>${k === running ? `<i class="sx-rundot" title="Running"></i>`
            : n ? `<i class="sx-chkdot" title="${n} to check"></i>` : ""}</span>
          <span class="sx-mini">${this._miniBar(kb)}</span>
        </button>`;
    }).join("");

    const now = new Date();
    const nowM = now.getHours() * 60 + now.getMinutes();
    const rows = DAYS_ORDERED.map(day => {
      const blocks = this._blocksOf(this._planDayList(plan, day));
      const inTgt = tgt.days.includes(day);
      const segs = blocks.map((b, bi) => {
        const t = this._sxTemp(b.e);
        const bg = t != null ? tempColor(t, s.temp_min, s.temp_max) : "var(--divider)";
        const fg = t != null ? tempInk(t, s.temp_min, s.temp_max) : "var(--primary-text)";
        const isLive = isRunning && day === today && cur && b.parts.some(p => p.time_start === cur.time_start && p.time_end === cur.time_end);
        const l = ax(b.a), w = b.len / 14.4;
        const pieces = l + w > 100.01 ? [[l, 100 - l], [0, w - (100 - l)]] : [[l, w]];
        return pieces.map(([pl, pw], i) => `
          <button class="sx-seg ${isLive ? "sx-seg-live" : ""}" data-day="${day}" data-block="${bi}"
                  style="left:${pl}%;width:${pw}%;background:${bg};color:${fg}"
                  aria-label="${DAY_LABELS[day]} ${b.name} ${this._blockRange(b)} ${t != null ? t + "°" : ""}">
            ${i === 0 && pw > 9 ? `<b>${t != null ? t + "°" : "—"}</b>${pw > 22 ? `<span>${this._short12(b.a)}</span>` : ""}` : ""}
          </button>`).join("");
      }).join("");
      const gaps = this._gapsOf(this._planDayList(plan, day));
      return `
        <span class="sx-dl ${day === today ? "on" : ""}">${DAY_LABELS[day].slice(0, 2)}</span>
        <div class="sx-track ${inTgt ? "sx-track-tgt" : ""} ${gaps.length ? "sx-track-gap" : ""}">
          ${segs || `<span class="sx-empty">—</span>`}
          ${day === today && blocks.length ? `<i class="sx-nowline" style="left:${ax(nowM)}%"></i>` : ""}
        </div>`;
    }).join("");

    const tabs = [["all", "Same"], ["split", "Wkdy · Wknd"], ...(canEach ? [["each", "Each"]] : [])]
      .map(([k, l]) => `<button class="sx-segbtn" data-pmode="${k}" aria-pressed="${mode === k}">${l}</button>`).join("");
    const issues = this._planIssues(plan);

    return `
      <div class="sx sx2">
        <div class="sx-plans" role="group" aria-label="Plans">
          ${cards}
          <button class="sx-plan sx-plan-add" id="createPresetBtn" aria-label="New plan">${this._ic("plus")}</button>
        </div>
        <section class="card sx-week">
          <div class="sx-bar">
            <div class="sx-segs sx-view" role="group" aria-label="Show">
              <button class="sx-segbtn sx-v-heat" data-sview="heating" aria-pressed="${view === "heating"}">${this._ic("fire")}Heat</button>
              <button class="sx-segbtn sx-v-cool" data-sview="cooling" aria-pressed="${view === "cooling"}">${this._ic("snowflake")}Cool</button>
            </div>
            <span class="sx-grow"></span>
            <button class="sx-round" id="undoBtn" aria-label="Undo" ${s.can_undo ? "" : "disabled"}>${this._ic("undo")}</button>
            <button class="sx-round sx-round-ink" id="sxAddBtn" aria-label="Add a block">${this._ic("plus")}</button>
          </div>
          <div class="sx-grid">
            ${rows}
            <span></span>
            <div class="sx-axis2"><span>6a</span><span>12p</span><span>6p</span><span>12a</span><span>6a</span></div>
          </div>
          <div class="sx-days">
            ${this._ic("calendar-sync-outline")}<div class="sx-segs" role="group" aria-label="Days edit together">${tabs}</div>
          </div>
          ${issues.length ? `<div class="sx-issues">${issues.map(x => `<div class="sx-issue">${this._ic("alert-outline")}<span>${x.text}</span></div>`).join("")}</div>` : ""}
        </section>
        <div class="sx-tools">
          ${isRunning ? "" : `<button class="sx-pill sx-pill-ink" data-run-plan="${plan}">${this._ic("play")}Run ${this._planLabel(plan)}</button>`}
          ${custom ? `<button class="sx-pill" id="renamePresetBtn">${this._ic("pencil-outline")}Rename</button>
            <button class="sx-pill" id="deletePresetBtn">${this._ic("delete-outline")}Delete</button>` : ""}
          <button class="sx-pill" id="redoBtn" ${s.can_redo ? "" : "disabled"}>${this._ic("redo")}Redo</button>
          <button class="sx-pill" id="exportBtn">${this._ic("export-variant")}Export</button>
          <button class="sx-pill" id="importBtn">${this._ic("import")}Import</button>
        </div>
        ${plan ? "" : `<div class="sx-basemode">${this._renderScheduleMode()}</div>`}
      </div>
      ${this._blk ? this._renderBlockDrawer() : ""}`;
  }

  // Tapping a block on a day that does not match the group being edited
  // switches to that day on its own, so the editor always opens on what was tapped.
  _openDayBlock(day, bi) {
    const plan = this._viewPlan();
    const mode = this._planMode(plan);
    const tgt = this._planTarget(plan);
    const canEach = !!plan || this._schedule.mode === "per_day";
    if (mode === "split") this._planPart = ["saturday", "sunday"].includes(day) ? "weekend" : "weekdays";
    else if (mode === "each") this._planDay = day;
    const t2 = this._planTarget(plan);
    if (this._planSig(plan, day) !== this._planSig(plan, t2.rep)) {
      if (canEach) { this._planModeSel = "each"; this._planDay = day; }
      else this._planPart = ["saturday", "sunday"].includes(day) ? "weekend" : "weekdays";
    }
    void tgt;
    const rep = this._planTarget(plan).rep;
    const want = this._blocksOf(this._planDayList(plan, day))[bi];
    const blocks = this._blocksOf(this._planDayList(plan, rep));
    const idx = want ? blocks.findIndex(b => b.a === want.a && b.len === want.len) : -1;
    this._openBlock(idx >= 0 ? idx : bi);
  }

  _renderBlockDrawer() {
    const B = this._blk;
    const d = B.draft;
    const s = this._schedule;
    const zones = s.zones || [];
    const { a, len } = this._blkSpan();
    const list = this._planDayList(B.plan, B.rep);
    const after = this._paintDay(list, B.parts, { a, len, e: this._blkEntry() });
    const others = this._blocksOf(list).filter(b => !b.parts.some(p => B.parts.includes(p)));
    const trimmed = others.filter(b => {
      for (let k = 0; k < b.len; k++) { const m = (b.a + k) % 1440; if (((m - a + 1440) % 1440) < len) return true; }
      return false;
    });
    const newGaps = this._gapsOf(after);
    const chip = (t, k) => `<span class="sx-chip" style="background:${tempColor(t, s.temp_min, s.temp_max)};color:${tempInk(t, s.temp_min, s.temp_max)}">${t}°</span>`;
    const stepper = (key, ic, cls, label) => `
      <div class="sx-stp ${cls}">
        ${this._ic(ic)}
        <button class="sx-step" data-sstep="${key}:-1" aria-label="${label} lower">−</button>
        ${chip(d[key], key)}
        <button class="sx-step" data-sstep="${key}:1" aria-label="${label} higher">+</button>
      </div>`;
    const dayChips = DAYS_ORDERED.map(x => `<span class="sx-dchip ${B.days.includes(x) ? "on" : ""}">${DAY_LABELS[x][0]}</span>`).join("");
    const hrs = len / 60;
    return `
      <div class="sx-scrim" id="sxScrim"></div>
      <aside class="sx-drawer" role="dialog" aria-label="${B.isNew ? "Add a block" : "Edit " + d.name}">
        <i class="sx-grab"></i>
        <div class="sx-drh">
          <b class="sx-title">${B.isNew ? "New block" : d.name}</b>
          ${B.isNew ? "" : `<button class="sx-round" id="sxDelete" aria-label="Delete block">${B.armDelete ? `<span class="sx-arm">Tap again to delete</span>` : this._ic("delete-outline")}</button>`}
          <button class="sx-round" id="sxClose" aria-label="Close">${this._ic("close")}</button>
        </div>
        <div class="sx-drb">
          <div class="sx-times">
            <label class="sx-time"><input type="time" id="sxStart" value="${d.start}" aria-label="Starts"></label>
            ${this._ic("arrow-right")}
            <label class="sx-time"><input type="time" id="sxEnd" value="${d.end}" aria-label="Ends"></label>
            <span class="sx-dur">${len >= 1440 ? "24h" : `${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)}h`}</span>
          </div>
          ${trimmed.length ? `<div class="sx-note">${this._ic("content-cut")}Trims ${trimmed.map(b => b.name).join(" · ")} to make room</div>` : ""}
          ${newGaps.length ? `<div class="sx-note sx-note-warn">${this._ic("alert-outline")}Gap ${newGaps.map(([x, y]) => `${this._short12(x)}–${this._short12(y)}`).join(", ")}</div>` : ""}
          ${d.split ? stepper("temp", "fire", "sx-stp-heat", "Heat") + stepper("cool", "snowflake", "sx-stp-cool", "Cool")
            : stepper("temp", "thermometer", "", "Goal")}
          <label class="sx-split"><input type="checkbox" id="sxSplit" ${d.split ? "checked" : ""}>${this._ic("fire")}${this._ic("snowflake")}<span>Separate heat and cool</span></label>
          <div class="sx-zones" role="group" aria-label="Room">
            ${zones.map(z => `<button class="sx-zone" data-szone="${z.id}" aria-pressed="${d.zone === z.id}">${z.name}</button>`).join("")}
          </div>
          <div class="sx-dchips" aria-label="Days this saves to">${dayChips}</div>
        </div>
        <div class="sx-drf">
          <button class="btn btn-add sx-big-btn" id="sxSave">Save</button>
          <button class="btn btn-cancel sx-big-btn" id="sxCancel">Cancel</button>
        </div>
      </aside>`;
  }

  _attachScheduleTabListeners() {
    const root = this.shadowRoot;
    const rerender = () => this._render();
    root.querySelectorAll("[data-plan]").forEach(b => b.addEventListener("click", () => {
      this._planView = b.dataset.plan; this._planModeSel = null; this._planPart = null; this._planDay = null; rerender();
    }));
    root.querySelectorAll("[data-run-plan]").forEach(b => b.addEventListener("click", () => this._setPreset(b.dataset.runPlan)));
    root.querySelectorAll("[data-pmode]").forEach(b => b.addEventListener("click", () => { this._planModeSel = b.dataset.pmode; rerender(); }));
    root.querySelectorAll("[data-sview]").forEach(b => b.addEventListener("click", () => { this._sxView = b.dataset.sview; rerender(); }));
    root.querySelectorAll(".sx-seg").forEach(b => b.addEventListener("click", () => this._openDayBlock(b.dataset.day, parseInt(b.dataset.block))));
    this._addClick("sxAddBtn", () => this._openBlock(null));
    if (!this._blk) return;
    const d = this._blk.draft;
    const close = () => { this._blk = null; rerender(); };
    this._addClick("sxClose", close);
    this._addClick("sxCancel", close);
    this._addClick("sxScrim", close);
    this._addClick("sxSave", () => this._saveBlock(false));
    this._addClick("sxDelete", () => {
      if (!this._blk.armDelete) {
        this._blk.armDelete = true; rerender();
        clearTimeout(this._armTimer);
        this._armTimer = setTimeout(() => { if (this._blk) { this._blk.armDelete = false; this._render(); } }, 5000);
        return;
      }
      this._saveBlock(true);
    });
    const time = (id, key) => {
      const el = root.getElementById(id);
      if (el) el.addEventListener("change", () => { if (/^\d\d:\d\d$/.test(el.value)) { d[key] = el.value; rerender(); } });
    };
    time("sxStart", "start");
    time("sxEnd", "end");
    root.querySelectorAll("[data-szone]").forEach(b => b.addEventListener("click", () => { d.zone = b.dataset.szone; rerender(); }));
    const split = root.getElementById("sxSplit");
    if (split) split.addEventListener("change", () => {
      d.split = split.checked;
      if (d.split && d.cool <= d.temp) d.cool = d.temp + this._minGap();
      rerender();
    });
    const s = this._schedule;
    root.querySelectorAll("[data-sstep]").forEach(b => b.addEventListener("click", () => {
      const [k, n] = b.dataset.sstep.split(":");
      d[k] = Math.max(s.temp_min, Math.min(s.temp_max, d[k] + Number(n)));
      if (!d.split) d.cool = d.temp;
      rerender();
    }));
  }

  // ── History ───────────────────────────────────────────────────────────────
  // Week: tiles, the last 24 hours (room, goal, why it changed, runs) and the
  // last seven days. Year: every day as a square, outside by month, hours by
  // month, and one dot per day against the outside temperature.

  _svgT(x, y, s, size, weight, col, anchor = "middle") {
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central" style="font:${weight} ${size}px Inter,system-ui,sans-serif;fill:${col}">${s}</text>`;
  }

  _histTile(ic, v, l, span = 2, col = "") {
    return `<div class="card hs-tile" style="grid-column:span ${span}">${this._ic(ic, col)}<b>${v}</b><span>${l}</span></div>`;
  }

  // Charts are drawn at the width they are shown at, so 12px text is 12px
  _chartW() {
    const w = (this.shadowRoot?.querySelector(".content")?.clientWidth || this.clientWidth || 390) - 32;
    return Math.max(300, Math.min(1000, w));
  }

  _fmtH(min) {
    if (min == null || isNaN(min)) return "—";
    return min >= 60 ? `${(min / 60).toFixed(1)}h` : `${Math.round(min)}m`;
  }

  // Runtime days as a map, one row per date (an old history can hold a date twice)
  _runtimeDays() {
    const rd = this._runtimeData;
    const out = {};
    for (const r of [...(rd?.history || []), ...(rd?.today ? [rd.today] : [])]) {
      if (!r?.date) continue;
      const a = out[r.date];
      out[r.date] = a
        ? { h: a.h + (r.heating_min || 0), c: a.c + (r.cooling_min || 0), o: a.o != null && r.avg_outdoor != null ? (a.o + r.avg_outdoor) / 2 : (a.o ?? r.avg_outdoor) }
        : { h: r.heating_min || 0, c: r.cooling_min || 0, o: r.avg_outdoor ?? null };
    }
    return out;
  }

  _renderHistoryTab() {
    const v = this._histView || "week";
    return `
      <div class="hs">
        <div class="hs-seg" role="group" aria-label="Range">
          <button data-hview="week" aria-pressed="${v === "week"}">Week</button>
          <button data-hview="year" aria-pressed="${v === "year"}">Year</button>
        </div>
        ${v === "year" ? this._renderHistoryYear() : this._renderHistoryWeek()}
      </div>`;
  }

  _renderHistoryWeek() {
    const d = this._diagData || {};
    const rd = this._runtimeData;
    const days = this._runtimeDays();
    const keys = Object.keys(days).sort();
    const last7 = keys.slice(-7);
    const cool = this._isCooling();
    const todayM = rd?.today ? (cool ? rd.today.cooling_min : rd.today.heating_min + (this._isHeatCool() ? rd.today.cooling_min : 0)) : null;
    const weekM = last7.length ? last7.reduce((a, k) => a + days[k].h + days[k].c, 0) : null;
    const outdoor = d.features?.outdoor_temp;
    const lead = rd?.learned_ramp_minutes;
    return `
      <div class="hs-tiles">
        ${this._histTile(cool ? "snowflake" : "fire", this._fmtH(todayM), "Today", 2, cool ? "c-cool" : "c-heat")}
        ${this._histTile("calendar-week", this._fmtH(weekM), "7 days")}
        ${this._histTile("thermometer", outdoor != null ? `${Math.round(outdoor)}°` : "—", "Outside")}
        ${this._histTile("timer-outline", lead ? `${Math.round(lead)}m` : "—", "Lead time", 3)}
        ${this._histTile("lightbulb-outline", d.learning?.enabled ? (d.learning.patterns_learned ?? "On") : "Off", d.learning?.enabled ? "Learned" : "Learning", 3)}
      </div>
      <section class="card hs-card"><b class="hs-h">24h</b>${this._hist24()}</section>
      <section class="card hs-card"><b class="hs-h">7 days</b>${this._hist7(days, keys)}</section>`;
  }

  _hist24() {
    const s = this._schedule;
    const pts = (this._historyData || []).map(p => ({ t: new Date(p.last_changed || p.lu * 1000).getTime(), v: parseFloat(p.state ?? p.s) }))
      .filter(p => !isNaN(p.v) && !isNaN(p.t));
    const now = Date.now(), t0 = now - 24 * 3600 * 1000;
    const log = (this._actionLog?.log || []).filter(e => e && !isNaN(new Date(e.ts).getTime()))
      .map(e => ({ ...e, t: new Date(e.ts).getTime() })).sort((a, b) => a.t - b.t);
    // Goal steps over the window: the decision in force at the start, then each change
    const inWin = log.filter(e => e.t >= t0);
    const before = log.filter(e => e.t < t0).pop();
    // Where the log does not reach (it starts at the first decision it kept),
    // the climate entity's own recorded goal fills in — drawn, but no icon.
    const logStart = before ? t0 : inWin.length ? inWin[0].t : now;
    const derived = [];
    for (const h of this._hvacHistory || []) {
      const t = new Date(h.last_changed || h.last_updated).getTime(), a = h.attributes || {};
      if (isNaN(t) || t >= logStart) continue;
      const lo = a.target_temp_low ?? a.temperature, hi = a.target_temp_low != null ? a.target_temp_high : undefined;
      if (lo == null) continue;
      derived.push({ t: Math.max(t, t0), reason: "_recorded", target_temp: lo, target_high: hi, derived: true });
    }
    const steps = [];
    for (const e of [...derived, ...(before ? [{ ...before, t: t0 }] : []), ...inWin]) {
      const last = steps[steps.length - 1];
      if (last && last.reason === e.reason && last.target_temp === e.target_temp && last.target_high === e.target_high) continue;
      steps.push(e);
    }
    // A window pause parks the thermostat at an extreme: draw a gap, never "32°"
    const parked = e => e.reason === "window_open" || e.target_temp == null || e.target_temp < s.temp_min - 5 || e.target_temp > s.temp_max + 5;
    const temps = [...pts.map(p => p.v), ...steps.filter(e => !parked(e)).flatMap(e => [e.target_temp, e.target_high].filter(x => x != null))];
    if (!pts.length && !steps.length) return `<div class="hs-empty">${this._ic("chart-line")}<span>No readings yet</span></div>`;
    let TMIN = Math.floor(Math.min(...temps) - 1), TMAX = Math.ceil(Math.max(...temps) + 1);
    if (TMAX - TMIN < 4) { TMIN -= 1; TMAX += 1; }
    const W = this._chartW(), H = 230, X0 = 30, X1 = W - 6, Y0 = 186, Y1 = 46;
    const hx = t => +(X0 + (t - t0) / (now - t0) * (X1 - X0)).toFixed(1);
    const ty = v => +(Y0 - (v - TMIN) / (TMAX - TMIN) * (Y0 - Y1)).toFixed(1);
    const step = (TMAX - TMIN) > 8 ? 4 : 2;
    let grid = "";
    for (let v = Math.ceil(TMIN / step) * step; v <= TMAX; v += step) {
      grid += `<line x1="${X0}" y1="${ty(v)}" x2="${X1}" y2="${ty(v)}" class="hs-grid"/>${this._svgT(X0 - 6, ty(v), v + "°", 11, 600, "var(--secondary-text)", "end")}`;
    }
    const goal = steps.map((e, i) => {
      if (parked(e)) return "";
      const x1 = hx(Math.max(t0, e.t)), x2 = hx(i < steps.length - 1 ? steps[i + 1].t : now);
      const one = v => `<line x1="${x1}" y1="${ty(v)}" x2="${Math.max(x1 + 1, x2)}" y2="${ty(v)}" style="stroke:${tempColor(v + 0.5, s.temp_min, s.temp_max)};stroke-width:6px;stroke-linecap:round;opacity:.9"/>`;
      return one(e.target_temp) + (e.target_high != null ? one(e.target_high) : "");
    }).join("");
    let curve = "";
    pts.filter(p => p.t >= t0).forEach((p, i) => { curve += `${i ? "L" : "M"}${hx(p.t)} ${ty(p.v)} `; });
    // Runs from the climate entity's hvac_action
    const runs = [];
    let open = null;
    for (const h of this._hvacHistory || []) {
      const a = h.attributes?.hvac_action, t = new Date(h.last_changed || h.last_updated).getTime();
      if (isNaN(t)) continue;
      if (open && a !== open.a) { runs.push({ ...open, e: t }); open = null; }
      if (!open && (a === "heating" || a === "cooling")) open = { a, s: t };
    }
    if (open) runs.push({ ...open, e: now });
    // A heat pump cycles every few minutes; one run is anything with gaps under 15 min
    for (let i = runs.length - 1; i > 0; i--) {
      if (runs[i].a === runs[i - 1].a && runs[i].s - runs[i - 1].e < 15 * 60000) { runs[i - 1].e = runs[i].e; runs.splice(i, 1); }
    }
    const runBars = runs.filter(r => r.e > t0).map(r => `<rect x="${hx(Math.max(t0, r.s))}" y="${Y0 + 8}" width="${Math.max(2, hx(r.e) - hx(Math.max(t0, r.s))).toFixed(1)}" height="6" rx="3" class="${r.a === "cooling" ? "f-cool" : "f-heat"}"/>`).join("");
    const ICON = {
      window_open: "M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 3v18M4 12h16",
      schedule: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4",
      physical_override: "M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 15.5a1.5 1.5 0 0 1 2.4-1.8L8 16",
      manual_override: "M12 5a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM12 9v4l2.5 2M9 2h6",
      heat_pump_step: "M13 2L4 14h7l-1 8 9-12h-7z", tou_adjustment: "M13 2L4 14h7l-1 8 9-12h-7z",
      precondition: "M12 3v5M5 10l2 2M19 10l-2 2M3 17h18M7 17a5 5 0 0 1 10 0",
      occupancy_away: "M3 11l9-7 9 7M5 10v10h14V10", vacation: "M2 16l20-7-4-3-6 3-5-3-2 1 4 4-4 2-2-1z",
    };
    const warm = r => /override|window/.test(r);
    let lastX = -99;
    const events = steps.filter(e => e.t >= t0 && !e.derived).map(e => {
      const lx = hx(e.t);
      let x = lx; if (x - lastX < 28 && lastX + 28 <= X1 - 6) x = +(lastX + 28).toFixed(1); lastX = x;
      const path = ICON[e.reason] || ICON.schedule;
      return `<g><title>${this._reasonLabel(e.reason)} · ${new Date(e.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</title>
        <line x1="${lx}" y1="30" x2="${lx}" y2="${Y0}" class="hs-evline"/>
        <circle cx="${x}" cy="15" r="13" class="${warm(e.reason) ? "hs-ev-warm" : "hs-ev"}"/>
        <g transform="translate(${(x - 8).toFixed(1)} 7) scale(0.67)"><path d="${path}" class="${warm(e.reason) ? "hs-evi-warm" : "hs-evi"}"/></g></g>`;
    }).join("");
    let axis = "";
    const d0 = new Date(t0); d0.setMinutes(0, 0, 0);
    for (let t = d0.getTime() + 3600e3; t < now; t += 3600e3) {
      const h = new Date(t).getHours();
      if (h % 6 === 0) axis += this._svgT(hx(t), H - 8, this._short12(h * 60), 11, 600, "var(--secondary-text)");
    }
    return `<svg class="hs-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Last 24 hours: room temperature, goal and why it changed">
      ${grid}${runBars}${goal}<path d="${curve}" class="hs-curve"/>${events}${axis}</svg>`;
  }

  _hist7(days, keys) {
    const ks = keys.slice(-8);
    if (!ks.length) return `<div class="hs-empty">${this._ic("chart-bar")}<span>No days recorded yet</span></div>`;
    const s = this._schedule;
    const W = this._chartW(), H = 244, BY = 198, BH = 104, step = W / ks.length, bw = Math.min(56, step * 0.62);
    const maxM = Math.max(240, ...ks.map(k => days[k].h + days[k].c));
    const os = ks.map(k => days[k].o).filter(o => o != null);
    const oMin = os.length ? Math.min(...os) - 2 : 0, oMax = os.length ? Math.max(...os) + 2 : 1;
    const oy = o => +(44 - (o - oMin) / Math.max(1, oMax - oMin) * 28).toFixed(1);
    let out = "", line = "";
    ks.forEach((k, i) => {
      const r = days[k], cx = +(step * i + step / 2).toFixed(1), isToday = i === ks.length - 1;
      const hh = r.h / maxM * BH, ch = r.c / maxM * BH;
      if (r.c > 0) out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(BY - ch).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(3, ch).toFixed(1)}" rx="8" class="f-cool" style="opacity:${isToday ? .5 : .9}"/>`;
      if (r.h > 0) out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(BY - ch - hh).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(3, hh).toFixed(1)}" rx="8" class="f-heat" style="opacity:${isToday ? .5 : .9}"/>`;
      if (r.h + r.c === 0) out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${BY - 3}" width="${bw.toFixed(1)}" height="3" rx="1.5" class="hs-zero"/>`;
      out += this._svgT(cx, BY - ch - hh - 12, this._fmtH(r.h + r.c), 13, 800, "var(--primary-text)");
      const dn = isToday ? "Now" : new Date(k + "T12:00").toLocaleDateString([], { weekday: "narrow" });
      out += this._svgT(cx, BY + 22, dn, 12, isToday ? 800 : 600, isToday ? "var(--primary-text)" : "var(--secondary-text)");
      if (r.o != null) {
        line += `${line ? "L" : "M"}${cx} ${oy(r.o)} `;
        out += `<circle cx="${cx}" cy="${oy(r.o)}" r="13" style="fill:${tempColor(r.o, s.temp_min, s.temp_max)};stroke:var(--card-bg);stroke-width:3px"/>`
          + this._svgT(cx, oy(r.o), Math.round(r.o), 11, 800, tempInk(r.o, s.temp_min, s.temp_max));
      }
    });
    return `<svg class="hs-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Running time per day, last week, with the outside temperature">
      <path d="${line}" class="hs-outline"/>${out}</svg>`;
  }

  async _loadYearStats() {
    if (this._yearStats || this._yearStatsLoading) return;
    const ids = this._diagData?.entity_ids || {};
    const stat = [ids.outdoor_temp, ...Object.values(ids.zone_temps || {})].filter(Boolean);
    this._yearStatsLoading = true;
    try {
      const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0); start.setMonth(start.getMonth() - 11);
      const [stats, rt] = await Promise.all([
        stat.length ? this._hass.callWS({ type: "recorder/statistics_during_period", start_time: start.toISOString(),
          statistic_ids: stat, period: "month", types: ["mean", "min", "max"] }).catch(() => ({})) : {},
        this._hass.callWS({ type: "gttc/get_runtime_history", days: 400 }).catch(() => null),
      ]);
      this._yearStats = stats || {};
      if (rt) this._runtimeData = rt;
    } finally {
      this._yearStatsLoading = false;
      if (this._activeMainTab === "history") this._repaint();
    }
  }

  _renderHistoryYear() {
    if (!this._yearStats) { this._loadYearStats(); return `<div class="status-loading"><ha-icon icon="mdi:loading"></ha-icon> Loading…</div>`; }
    const s = this._schedule;
    const days = this._runtimeDays();
    const keys = Object.keys(days).sort();
    const first = keys[0];
    const now = new Date();
    const todayK = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const months = [];
    for (let i = 11; i >= 0; i--) { const m = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push([m.getFullYear(), m.getMonth() + 1]); }
    const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const pad = n => String(n).padStart(2, "0");
    const mix = (hex, k) => {
      const c = hex === "heat" ? [194, 65, 12] : [29, 95, 209];
      const t = this.hasAttribute("dark") ? [26, 29, 35] : [244, 245, 247];
      return `rgb(${c.map((v, j) => Math.round(t[j] + (v - t[j]) * k)).join(",")})`;
    };
    // Every day: a square per day; no record and off are drawn differently
    const cal = months.map(([y, m]) => {
      const len = new Date(y, m, 0).getDate();
      let cells = "";
      for (let dd = 1; dd <= 31; dd++) {
        const k = `${y}-${pad(m)}-${pad(dd)}`;
        if (dd > len || k > todayK) { cells += `<i class="hs-c hs-c-none"></i>`; continue; }
        const r = days[k];
        if (!r) { cells += `<i class="hs-c hs-c-nr" title="${k} · no record"></i>`; continue; }
        const tot = r.h + r.c;
        if (tot < 1) { cells += `<i class="hs-c hs-c-off" title="${k} · off"></i>`; continue; }
        const heat = r.h >= r.c, k2 = Math.min(1, 0.25 + Math.max(r.h, r.c) / 600 * 0.75);
        cells += `<i class="hs-c ${k === todayK ? "hs-c-today" : ""}" style="background:${mix(heat ? "heat" : "cool", k2)}" title="${k} · ${this._fmtH(tot)} ${heat ? "heat" : "cool"}"></i>`;
      }
      const cur = y === now.getFullYear() && m === now.getMonth() + 1;
      return `<span class="hs-ml ${cur ? "on" : ""}">${MN[m - 1]}</span><div class="hs-crow">${cells}</div>`;
    }).join("");
    // Monthly outside (low · average · high) and the average inside
    const ids = this._diagData?.entity_ids || {};
    const st = this._yearStats;
    const byMonth = (id) => {
      const o = {};
      for (const r of st[id] || []) { const d0 = new Date(r.start); o[`${d0.getFullYear()}-${d0.getMonth() + 1}`] = r; }
      return o;
    };
    const OUT = byMonth(ids.outdoor_temp);
    const activeZoneId = (this._diagData?.zones || []).find(z => z.is_active)?.id;
    const IN = byMonth((ids.zone_temps || {})[activeZoneId] || Object.values(ids.zone_temps || {})[0]);
    const W = this._chartW(), cw = (W - 40) / 12, cx = i => +(40 + cw * i + cw / 2).toFixed(1);
    const all = Object.values(OUT).flatMap(r => [r.min, r.max]).filter(x => x != null);
    const TMIN = all.length ? Math.floor(Math.min(...all) / 10) * 10 : 30, TMAX = all.length ? Math.ceil(Math.max(...all) / 10) * 10 : 100;
    const ty = t => +(190 - (t - TMIN) / Math.max(1, TMAX - TMIN) * 170).toFixed(1);
    let tsvg = "";
    for (let t = TMIN; t <= TMAX; t += 20) tsvg += `<line x1="40" y1="${ty(t)}" x2="${W}" y2="${ty(t)}" class="hs-grid"/>${this._svgT(32, ty(t), t + "°", 11, 600, "var(--secondary-text)", "end")}`;
    let msvg = "";
    const MAXH = Math.max(50, ...months.map(([y, m]) => {
      const p = `${y}-${pad(m)}-`;
      return keys.filter(k => k.startsWith(p)).reduce((a, k) => a + days[k].h + days[k].c, 0) / 60;
    }));
    months.forEach(([y, m], i) => {
      const x = cx(i), o = OUT[`${y}-${m}`], inn = IN[`${y}-${m}`];
      const cur = y === now.getFullYear() && m === now.getMonth() + 1;
      const lab = (yy) => this._svgT(x, yy, MN[m - 1][0], 12, cur ? 800 : 600, cur ? "var(--primary-text)" : "var(--secondary-text)");
      tsvg += lab(212);
      if (o && o.mean != null) {
        tsvg += `<line x1="${x}" y1="${ty(o.max ?? o.mean)}" x2="${x}" y2="${ty(o.min ?? o.mean)}" class="hs-range"/>`;
        if (inn && inn.mean != null) tsvg += `<line x1="${x - 11}" y1="${ty(inn.mean)}" x2="${x + 11}" y2="${ty(inn.mean)}" class="hs-inside"/>`;
        tsvg += `<circle cx="${x}" cy="${ty(o.mean)}" r="14" style="fill:${tempColor(o.mean, s.temp_min, s.temp_max)};stroke:var(--card-bg);stroke-width:3px"/>`
          + this._svgT(x, ty(o.mean), Math.round(o.mean), 11, 800, tempInk(o.mean, s.temp_min, s.temp_max));
      } else tsvg += `<line x1="${x}" y1="${ty((TMIN + TMAX) / 2) - 5}" x2="${x}" y2="${ty((TMIN + TMAX) / 2) + 5}" class="hs-nr"/>`;
      // Hours by month
      const p = `${y}-${pad(m)}-`, mk = keys.filter(k => k.startsWith(p));
      msvg += this._svgT(x, 192, MN[m - 1][0], 12, cur ? 800 : 600, cur ? "var(--primary-text)" : "var(--secondary-text)");
      if (!mk.length) { msvg += `<rect x="${x - 13}" y="132" width="26" height="36" rx="6" class="hs-nrbar"/>`; return; }
      const h = mk.reduce((a, k) => a + days[k].h, 0) / 60, c = mk.reduce((a, k) => a + days[k].c, 0) / 60;
      const hh = h / MAXH * 130, ch = c / MAXH * 130;
      if (c > 0) msvg += `<rect x="${x - 13}" y="${(168 - ch).toFixed(1)}" width="26" height="${Math.max(3, ch).toFixed(1)}" rx="6" class="f-cool"/>`;
      if (h > 0) msvg += `<rect x="${x - 13}" y="${(168 - ch - hh).toFixed(1)}" width="26" height="${Math.max(3, hh).toFixed(1)}" rx="6" class="f-heat"/>`;
      msvg += this._svgT(x, 168 - ch - hh - 11, Math.round(h + c), 12, 800, "var(--primary-text)");
    });
    // Outside vs running: one dot per day
    const sx = o => +(36 + (o - 30) / 65 * (W - 46)).toFixed(1), sy = m => +(186 - Math.min(m, 900) / 900 * 170).toFixed(1);
    let ssvg = "";
    for (const m of [0, 450, 900]) ssvg += `<line x1="36" y1="${sy(m)}" x2="${W}" y2="${sy(m)}" class="hs-grid"/>${this._svgT(28, sy(m), m / 60 + "h", 11, 600, "var(--secondary-text)", "end")}`;
    for (let o = 40; o <= 90; o += 10) ssvg += this._svgT(sx(o), 206, o + "°", 11, 600, "var(--secondary-text)");
    for (const k of keys) {
      const r = days[k];
      if (r.o == null) continue;
      const cls = r.h + r.c < 1 ? "hs-dot-off" : r.h >= r.c ? "f-heat" : "f-cool";
      ssvg += `<circle cx="${sx(r.o)}" cy="${sy(Math.max(r.h, r.c))}" r="4.5" class="${cls}" style="opacity:.75"/>`;
    }
    const td = days[todayK];
    if (td?.o != null) ssvg += `<circle cx="${sx(td.o)}" cy="${sy(Math.max(td.h, td.c))}" r="10" class="hs-today"/>`;
    const H = keys.reduce((a, k) => a + days[k].h, 0), C = keys.reduce((a, k) => a + days[k].c, 0);
    const outs = Object.values(OUT);
    const hot = outs.reduce((a, r) => r.max != null && (!a || r.max > a.max) ? r : a, null);
    const cold = outs.reduce((a, r) => r.min != null && (!a || r.min < a.min) ? r : a, null);
    const mon = r => r ? MN[new Date(r.start).getMonth()] : "";
    const since = first ? new Date(first + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" }) : "";
    return `
      <div class="hs-tiles hs-tiles-2">
        ${this._histTile("fire", `${Math.round(H / 60)}h`, `Heat · since ${since}`, 1, "c-heat")}
        ${this._histTile("snowflake", `${Math.round(C / 60)}h`, `Cool · since ${since}`, 1, "c-cool")}
        ${this._histTile("thermometer-high", hot ? `${Math.round(hot.max)}°` : "—", `Hottest${hot ? " · " + mon(hot) : ""}`, 1)}
        ${this._histTile("thermometer-low", cold ? `${Math.round(cold.min)}°` : "—", `Coldest${cold ? " · " + mon(cold) : ""}`, 1)}
      </div>
      <section class="card hs-card">
        <div class="hs-hrow"><b class="hs-h">Every day</b>
          <span class="hs-key"><i class="f-heatbg"></i>Heat<i class="f-coolbg"></i>Cool<i class="hs-c-off"></i>Off<i class="hs-c-nr"></i>No record</span></div>
        <div class="hs-cal">${cal}</div>
      </section>
      <section class="card hs-card">
        <div class="hs-hrow"><b class="hs-h">Outside by month</b><span class="hs-key"><i class="hs-key-in"></i>Inside</span></div>
        <svg class="hs-svg" viewBox="0 0 ${W} 222" role="img" aria-label="Monthly outside low, average and high, with the average inside">${tsvg}</svg>
      </section>
      <section class="card hs-card">
        <b class="hs-h">Hours running</b>
        <svg class="hs-svg" viewBox="0 0 ${W} 200" role="img" aria-label="Heating and cooling hours per month">${msvg}</svg>
      </section>
      <section class="card hs-card">
        <b class="hs-h">Outside vs running</b>
        <svg class="hs-svg" viewBox="0 0 ${W} 216" role="img" aria-label="One dot per day: hours running against the outside average">${ssvg}</svg>
      </section>`;
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  // Cards grouped by what each setting decides. A card shows its value as a
  // picture; tapping it opens a sheet with the controls. Switches flip at once.

  _settingsSections() {
    return [
      { id: "goals", label: "Goals", keys: ["away_temp", "cooling_comfort", "cooling_away_temp"] },
      { id: "range", label: "Range", keys: ["temp_min", "temp_max"] },
      { id: "hold", label: "Changes", keys: ["manual_override_minutes"] },
      { id: "season", label: "Season switch", keys: ["auto_season_switch", "seasonal_recommend_hours", "heat_cool_ladder", "cool_lockout_temp", "heat_cool_min_gap", "heat_cool_settle_days"] },
      { id: "presence", label: "Away when empty", keys: ["occupancy_enabled", "presence_detection", "tracked_persons"] },
      { id: "early", label: "Start early", keys: ["precondition_enabled"] },
      { id: "learning", label: "Learn my changes", keys: ["learning_enabled", "learning_threshold"] },
      { id: "peak", label: "Peak rates", keys: ["tou_enabled", "tou_provider"] },
      { id: "outside", label: "Outside", keys: ["outdoor_temp_sensor"] },
      { id: "zones", label: "Rooms", keys: [] },
      { id: "windows", label: "Windows", keys: [] },
    ];
  }

  _toggle(on, attrs) {
    return `<button class="st-sw ${on ? "on" : ""}" role="switch" aria-checked="${on}" ${attrs}><i></i></button>`;
  }

  _renderSettingsTab() {
    if (this._settingsLoading && !this._settingsData) {
      return `<div class="status-loading"><ha-icon icon="mdi:loading"></ha-icon> Loading…</div>`;
    }
    if (!this._settingsData) {
      return `
        <div class="status-error-box">
          <div class="status-error-msg">${this._ic("alert-circle-outline")}
            ${this._settingsError ? `Failed to load: <code>${this._settingsError}</code>` : "No config data available."}</div>
          <button class="btn btn-outline" id="settingsRetryBtn">Retry</button>
        </div>`;
    }
    const c = k => this._settingsData[k];
    const s = this._schedule;
    const d = this._diagData || {};
    const col = t => `background:${tempColor(t, s.temp_min, s.temp_max)};color:${tempInk(t, s.temp_min, s.temp_max)}`;
    const off = d.zone_offset;
    const capped = k => off != null && c(k) != null && (c(k) + off > c("temp_max") + 0.25 || c(k) + off < c("temp_min") - 0.25);
    const goalCell = (k, t) => `<button class="st-goal" data-set-open="goals" style="${col(t)}">${t}°${capped(k) ? `<i class="st-flag" title="The wall cannot reach this"></i>` : ""}</button>`;
    const hold = c("manual_override_minutes");
    const holdTxt = hold >= 60 ? `${+(hold / 60).toFixed(1)}h` : `${hold}m`;
    const ladder = !!c("heat_cool_ladder");
    const row = (id, ic, t, sub, on, toggleAttrs) => `
      <div class="st-row">
        <button class="st-rowb" data-set-open="${id}"><span class="st-ri">${this._ic(ic)}</span>
          <span class="st-rt"><b>${t}</b><span>${sub}</span></span></button>
        ${this._toggle(on, toggleAttrs)}
      </div>`;
    const zones = c("zones") || [];
    const lead = this._runtimeData?.learned_ramp_minutes;
    const outdoor = d.features?.outdoor_temp;
    const persons = c("tracked_persons")?.length || (c("all_persons") || []).length;
    return `
      <div class="st">
        <section class="card st-card" aria-label="Goals">
          <div class="st-h">${this._ic("thermometer")}<b>Goals</b></div>
          <div class="st-goals">
            <span></span><span class="st-colh">${this._ic("home-outline")}Home</span><span class="st-colh">${this._ic("bag-suitcase-outline")}Away</span>
            <span class="st-rowh c-heat">${this._ic("fire")}Heat</span>
            <button class="st-goal st-goal-plan" data-goto="schedule">${this._ic("calendar-blank-outline")}Plan</button>
            ${goalCell("away_temp", c("away_temp"))}
            <span class="st-rowh c-cool">${this._ic("snowflake")}Cool</span>
            ${goalCell("cooling_comfort", c("cooling_comfort"))}
            ${goalCell("cooling_away_temp", c("cooling_away_temp"))}
          </div>
        </section>
        <div class="st-two">
          <button class="card st-card st-mini" data-set-open="range">
            <div class="st-h">${this._ic("thermometer-lines")}<b>Range</b></div>
            <div class="st-pic"><span class="st-end" style="${col(c("temp_min"))}">${c("temp_min")}</span>
              <i class="st-grad"></i><span class="st-end" style="${col(c("temp_max"))}">${c("temp_max")}</span></div>
            <span class="st-sub">Wall never goes past</span>
          </button>
          <button class="card st-card st-mini" data-set-open="hold">
            <div class="st-h">${this._ic("timer-outline")}<b>Changes</b></div>
            <div class="st-pic"><span class="st-end st-end-warm">${this._ic("hand-back-right-outline")}</span>
              <i class="st-dash"></i><b class="st-mid">${holdTxt}</b><i class="st-dash"></i>
              <span class="st-end st-end-plain">${this._ic("calendar-blank-outline")}</span></div>
            <span class="st-sub">Then back to plan</span>
          </button>
        </div>
        <section class="card st-card" aria-label="Season switch">
          <div class="st-h">${this._ic("swap-horizontal")}<b>Season switch</b><span class="st-grow"></span>
            <span class="st-sub">Auto</span>${this._toggle(!!c("auto_season_switch"), `data-cfg-now="auto_season_switch"`)}</div>
          <button class="st-path" data-set-open="season">
            <span class="st-pp st-pp-heat">${this._ic("fire")}Heat</span>
            ${ladder ? `<span class="st-arrow"><b>${c("seasonal_recommend_hours")}h</b><i></i></span><span class="st-pp st-pp-both">${this._ic("sun-snowflake-variant")}Both</span>` : ""}
            <span class="st-arrow">${ladder ? "" : this._ic("timer-outline")}<b>${c("seasonal_recommend_hours")}h</b><i></i></span>
            <span class="st-pp st-pp-cool">${this._ic("snowflake")}Cool</span>
          </button>
          <div class="st-inrow">${this._ic("sun-snowflake-variant")}<b>Stop at Both between</b>${this._toggle(ladder, `data-cfg-now="heat_cool_ladder"`)}</div>
          <span class="st-label">While in Both</span>
          <div class="st-three">
            <button class="st-mt" data-set-open="season">${this._ic("snowflake-off")}<b>${c("cool_lockout_temp")}°</b><span>AC off below</span></button>
            <button class="st-mt" data-set-open="season">${this._ic("arrow-expand-horizontal")}<b>${c("heat_cool_min_gap")}°</b><span>Kept apart</span></button>
            <button class="st-mt" data-set-open="season">${this._ic("calendar-check-outline")}<b>${c("heat_cool_settle_days")}d</b><span>Then one mode</span></button>
          </div>
        </section>
        <section class="card st-card st-rows" aria-label="Automatic">
          <div class="st-h">${this._ic("lightbulb-outline")}<b>Automatic</b></div>
          ${row("plan", "calendar-blank-outline", "Follow the plan", "Goals change on schedule", !!d.schedule_enabled, `data-auto-toggle="schedule" data-on="${d.schedule_enabled ? 1 : 0}"`)}
          ${row("presence", "account-outline", "Away when empty", "Uses Away goals", !!c("occupancy_enabled"), `data-cfg-now="occupancy_enabled"`)}
          ${row("early", "weather-sunset-up", "Start early", lead ? `${Math.round(lead)}m before each block` : "Before each block", !!c("precondition_enabled"), `data-cfg-now="precondition_enabled"`)}
          ${row("learning", "lightbulb-outline", "Learn my changes", `Plan adapts after ${c("learning_threshold") || 3} repeats`, !!c("learning_enabled"), `data-cfg-now="learning_enabled"`)}
          ${row("peak", "lightning-bolt-outline", "Peak rates", "Ease off when power costs more", !!c("tou_enabled"), `data-cfg-now="tou_enabled"`)}
        </section>
        <section class="card st-card" aria-label="House">
          <div class="st-h">${this._ic("home-outline")}<b>House</b></div>
          <div class="st-four">
            <button class="st-mt" data-set-open="zones">${this._ic("map-marker-outline")}<b>${zones.length}</b><span>Rooms</span></button>
            <button class="st-mt" data-set-open="windows">${this._ic("window-closed-variant")}<b>${(c("window_sensors") || []).length}</b><span>Windows</span></button>
            <button class="st-mt" data-set-open="presence">${this._ic("account-multiple-outline")}<b>${persons}</b><span>People</span></button>
            <button class="st-mt" data-set-open="outside">${this._ic("thermometer")}<b>${outdoor != null ? Math.round(outdoor) + "°" : "—"}</b><span>Outside</span></button>
          </div>
        </section>
      </div>
      ${this._renderEntityDatalists()}
      ${this._setSheet ? this._renderSettingsSheet() : ""}
      ${this._setSheet ? "" : this._saveBarMarkup()}`;
  }

  _saveBarMarkup() {
    const n = Object.keys(this._draft).length;
    return `
      <div class="save-bar" id="saveBar" ${n ? "" : "hidden"}>
        <span id="saveBarText">${this._saveBarText()}</span>
        <span class="save-bar-sp"></span>
        <button class="btn btn-outline" id="discardAllBtn">Discard</button>
        <button class="btn btn-primary" id="saveAllBtn">Save</button>
      </div>`;
  }

  _renderSettingsSheet() {
    const id = this._setSheet;
    const sec = this._settingsSections().find(x => x.id === id);
    let body = "", title = sec?.label || "", icon = "cog-outline";
    switch (id) {
      case "goals":
        icon = "thermometer"; title = "Goals";
        body = this._numField("away_temp", "Heat · Away", "", { min: 32, max: 100 })
          + this._numField("cooling_comfort", "Cool · Home", "Blocks with no cool number", { min: 60, max: 85 })
          + this._settingsClampWarning("cooling_comfort", "Cool · Home")
          + this._numField("cooling_away_temp", "Cool · Away", "", { min: 60, max: 90 })
          + this._settingsClampWarning("cooling_away_temp", "Cool · Away");
        break;
      case "range":
        icon = "thermometer-lines";
        body = this._numField("temp_min", "Never below", "", { min: 32, max: 99 }) + this._numField("temp_max", "Never above", "", { min: 33, max: 100 });
        break;
      case "hold":
        icon = "timer-outline"; title = "Your changes last";
        body = this._rangeField("manual_override_minutes", "Then back to plan", "", { min: 15, max: 480, step: 15, suffix: " min" });
        break;
      case "season":
        icon = "swap-horizontal";
        body = this._boolField("auto_season_switch", "Switch by itself", "")
          + this._rangeField("seasonal_recommend_hours", "Wait before switching", "", { min: 1, max: 48, step: 1, suffix: "h" })
          + this._boolField("heat_cool_ladder", "Stop at Both between", "")
          + this._numField("cool_lockout_temp", "Both · AC off below", "Outside", { min: 30, max: 70, step: 1 })
          + this._numField("heat_cool_min_gap", "Both · keep apart", "", { min: 0, max: 10, step: 0.5 })
          + this._rangeField("heat_cool_settle_days", "Both · then one mode after", "", { min: 1, max: 30, step: 1, suffix: " d" });
        break;
      case "presence": icon = "account-outline"; body = this._renderSettings_presence(); break;
      case "early":
        icon = "weather-sunset-up";
        body = this._boolField("precondition_enabled", "Start early", this._runtimeData?.learned_ramp_minutes ? `Learned lead ${Math.round(this._runtimeData.learned_ramp_minutes)} min` : "");
        break;
      case "learning": icon = "lightbulb-outline"; body = this._renderSettings_learning(); break;
      case "peak":
        icon = "lightning-bolt-outline";
        body = this._boolField("tou_enabled", "Peak rates", "")
          + this._selectField("tou_provider", "Rate plan", "", [["none", "None"], ["dominion_virginia", "Dominion Energy Virginia"]], { depends: "tou_enabled" });
        break;
      case "outside": {
        icon = "thermometer"; title = "Outside sensor";
        const sensor = this._cfg("outdoor_temp_sensor") || "";
        body = this._row("outdoor_temp_sensor", "Sensor", "", `
          <input type="text" class="set-entity" id="cfg-outdoor_temp_sensor" data-cfg="outdoor_temp_sensor" data-kind="entity"
                 list="dl-temp-sensors" value="${sensor}" placeholder="sensor.outside_temperature" spellcheck="false" autocomplete="off">
          <span class="set-reading" id="cfg-outdoor_temp_sensor-state">${this._entityReading(sensor)}</span>`);
        break;
      }
      case "zones": icon = "map-marker-outline"; body = this._renderSettingsZonesCard(this._settingsData); break;
      case "windows": icon = "window-closed-variant"; body = this._renderSettings_windows(); break;
      default: body = "";
    }
    return `
      <div class="sx-scrim" id="stScrim"></div>
      <aside class="sx-drawer st-sheet" role="dialog" aria-label="${title}">
        <i class="sx-grab"></i>
        <div class="sx-drh">${this._ic(icon)}<b class="sx-title">${title}</b>
          <button class="sx-round" id="stClose" aria-label="Close">${this._ic("close")}</button></div>
        <div class="sx-drb st-body">${body}</div>
        ${sec && sec.keys.length ? this._saveBarMarkup() : ""}
      </aside>`;
  }

  async _cfgNow(key, value) {
    try {
      await this._hass.callWS({ type: "gttc/set_config", [key]: value });
      this._settingsData = { ...this._settingsData, [key]: value };
      delete this._draft[key];
      await this._loadData();
    } catch (err) {
      this._showToast(`Not changed: ${err.message || err}`, "error");
      this._render();
    }
  }

  _attachSettingsSheetListeners() {
    const root = this.shadowRoot;
    root.querySelectorAll("[data-set-open]").forEach(b => b.addEventListener("click", () => {
      const id = b.dataset.setOpen;
      if (id === "plan") { this._activeMainTab = "schedule"; this._render(); return; }
      this._setSheet = id;
      this._editingZoneId = null;
      this._zoneFormData = null;
      this._render();
    }));
    root.querySelectorAll("[data-cfg-now]").forEach(b => b.addEventListener("click", () => {
      b.disabled = true;
      this._cfgNow(b.dataset.cfgNow, !this._settingsData?.[b.dataset.cfgNow]);
    }));
    const close = () => { this._setSheet = null; this._editingZoneId = null; this._zoneFormData = null; this._render(); };
    this._addClick("stClose", close);
    this._addClick("stScrim", close);
  }


  _styles() {
    return `
      :host {
        display: block;
        --gt-ground: #f4f5f7; --gt-surface: #ffffff; --gt-ink: #15181d; --gt-ink2: #5a6170;
        --gt-line: #e8eaee; --gt-accent: #2f6fdb; --gt-heat: #c2410c; --gt-cool: #1d5fd1;
        --primary: var(--gt-accent);
        --primary-text: var(--gt-ink);
        --secondary-text: var(--gt-ink2);
        --card-bg: var(--gt-surface);
        --divider: var(--gt-line);
        --bg: var(--gt-ground);
        --error: #b42318;
        --success: #16a34a;
        background: var(--gt-ground);
        min-height: 100%;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      :host([dark]) {
        --gt-ground: #0f1115; --gt-surface: #1a1d23; --gt-ink: #eceef2; --gt-ink2: #9aa1ae;
        --gt-line: #2a2e36; --gt-accent: #7fa8ff; --gt-heat: #ff8a50; --gt-cool: #7fb0ff;
        --primary: #3d6fe0;
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

      /* Schedule tab (v2.6) */
      .sx { display: flex; flex-direction: column; gap: 16px; font-variant-numeric: tabular-nums; }
      .sx-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
      .sx-head h2 { margin: 0; font-size: 18px; font-weight: 700; }
      .sx-dim { font-size: 13px; color: var(--secondary-text); line-height: 1.45; }
      .sx-ok-t { font-size: 13px; color: var(--success); font-weight: 600; }
      .sx-warn-t { font-size: 13px; color: var(--warning-color, #c26a00); font-weight: 600; line-height: 1.45; }
      .sx-lbl { font-size: 12px; font-weight: 700; color: var(--secondary-text); text-transform: uppercase; letter-spacing: .06em; }
      .sx-grow { flex: 1; }
      .sx-plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
      .sx-plan {
        text-align: left; background: var(--card-bg); color: var(--primary-text); border: 1px solid var(--divider);
        border-radius: 14px; padding: 13px 15px; display: flex; flex-direction: column; gap: 9px; cursor: pointer; font: inherit;
      }
      .sx-plan-on { border: 2px solid var(--primary-text); padding: 12px 14px; }
      .sx-plan-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 15px; }
      .sx-run { font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; background: var(--success); color: #fff; padding: 3px 8px; border-radius: 99px; }
      .sx-check { font-size: 12px; font-weight: 700; color: var(--warning-color, #c26a00); }
      .sx-mini { position: relative; display: block; height: 10px; border-radius: 5px; overflow: hidden; background: var(--bg); }
      .sx-mini i { position: absolute; top: 0; bottom: 0; }
      .sx-plan-sum { font-size: 13px; color: var(--secondary-text); }
      .sx-tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .sx-main { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
      .sx-card { background: var(--card-bg); border: 1px solid var(--divider); border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; }
      .sx-detail { flex: 999 1 600px; min-width: 0; gap: 16px; }
      .sx-side { flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
      .sx-dhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
      .sx-title { font-size: 21px; font-weight: 800; letter-spacing: -0.01em; }
      .sx-ctitle { font-size: 16px; font-weight: 800; }
      .sx-held { font-size: 15px; margin-top: 6px; }
      .sx-dbtns { display: flex; gap: 8px; flex-wrap: wrap; }
      .sx-dbtns .btn { min-height: 40px; }
      .sx-days { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .sx-segs { display: flex; flex-wrap: wrap; background: var(--bg); border: 1px solid var(--divider); border-radius: 10px; padding: 3px; gap: 2px; }
      .sx-segbtn { min-height: 34px; padding: 0 13px; border-radius: 8px; border: 0; background: transparent; color: var(--secondary-text); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
      .sx-segbtn[aria-pressed="true"] { background: var(--card-bg); color: var(--primary-text); font-weight: 700; box-shadow: 0 1px 2px rgba(0,0,0,.15); }
      .sx-modenote { margin-top: -8px; }
      .sx-shape { position: relative; height: 84px; border-radius: 12px; overflow: hidden; background: var(--bg); }
      .sx-seg {
        position: absolute; top: 0; bottom: 0; border: 0; border-right: 2px solid var(--card-bg); box-sizing: border-box;
        display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 2px; padding: 0 14px;
        color: #fff; font: inherit; cursor: pointer; overflow: hidden; text-shadow: 0 1px 2px rgba(0,0,0,.35);
      }
      .sx-seg-live { box-shadow: inset 0 -4px 0 rgba(255,255,255,.85); }
      .sx-seg-n { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; white-space: nowrap; }
      .sx-seg-t { font-size: 26px; font-weight: 800; white-space: nowrap; }
      .sx-nowline { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--primary-text); pointer-events: none; }
      .sx-nowline b { position: absolute; bottom: 5px; left: 6px; font-size: 10px; font-weight: 800; letter-spacing: .06em; color: var(--primary-text); background: var(--card-bg); padding: 1px 4px; border-radius: 4px; }
      .sx-axis { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)) 0; font-size: 12px; color: var(--secondary-text); font-weight: 600; margin-top: -8px; }
      .sx-axis span:last-child { display: none; }
      .sx-gap, .sx-chk { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; line-height: 1.45; }
      .sx-gap { background: rgba(255,152,0,.10); border-radius: 10px; padding: 10px 12px; }
      .sx-chk { padding: 10px 0; border-top: 1px solid var(--divider); }
      .sx-ico { flex: none; width: 18px; height: 18px; margin-top: 1px; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .sx-warn-c { stroke: var(--warning-color, #c26a00); }
      .sx-ok-c { stroke: var(--success); }
      .sx-link { background: none; border: 0; padding: 0; font: inherit; color: var(--primary); cursor: pointer; text-decoration: underline; }
      .sx-rows { display: flex; flex-direction: column; gap: 8px; }
      .sx-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) 140px 80px; gap: 14px; align-items: center; padding: 13px 14px; border: 1px solid var(--divider); border-radius: 12px; }
      .sx-row-h { border: 0; padding: 0 14px; font-size: 12px; font-weight: 700; color: var(--secondary-text); text-transform: uppercase; letter-spacing: .06em; }
      .sx-row-live { border: 2px solid var(--primary); padding: 12px 13px; }
      .sx-row-n { font-weight: 800; font-size: 15px; }
      .sx-row-ask { font-size: 15px; }
      .sx-row-ask b { font-size: 19px; }
      .sx-row-z { font-weight: 700; }
      .sx-now { font-size: 10px; font-weight: 800; color: #fff; background: var(--primary); padding: 2px 6px; border-radius: 99px; vertical-align: 2px; letter-spacing: .06em; text-transform: uppercase; }
      .sx-edit { min-height: 40px; }
      .sx-tbl { display: grid; border: 1px solid var(--divider); border-radius: 10px; overflow: hidden; font-size: 13px; }
      .sx-th { padding: 8px 10px; background: var(--bg); font-weight: 700; color: var(--secondary-text); font-size: 12px; }
      .sx-td { padding: 10px; border-top: 1px solid var(--divider); }
      .sx-td-h { font-weight: 700; color: var(--secondary-text); }
      .sx-td-on { background: rgba(3,169,244,.10); font-weight: 700; color: var(--primary-text); }
      .sx-foot { margin-top: -4px; }
      @media (max-width: 720px) {
        .sx-row { grid-template-columns: minmax(0, 1fr) auto; }
        .sx-row-h { display: none; }
        .sx-row > :nth-child(2), .sx-row > :nth-child(3) { grid-column: 1; }
        .sx-row > .sx-edit { grid-row: 1; grid-column: 2; }
      }
      /* Block editor drawer */
      .sx-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 1000; }
      .sx-drawer {
        position: fixed; top: 0; right: 0; bottom: 0; width: min(540px, 100vw); z-index: 1001;
        background: var(--card-bg); color: var(--primary-text); box-shadow: -12px 0 40px rgba(0,0,0,.3);
        display: flex; flex-direction: column;
      }
      .sx-drh { padding: 20px 24px 14px; border-bottom: 1px solid var(--divider); display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
      .sx-x { width: 40px; height: 40px; padding: 0; }
      .sx-drb { flex: 1; overflow-y: auto; padding: 18px 24px; display: flex; flex-direction: column; gap: 14px; }
      .sx-drf { padding: 14px 24px; border-top: 1px solid var(--divider); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .sx-big-btn { min-height: 44px; padding: 0 20px; font-size: 15px; font-weight: 600; }
      .sx-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .sx-f { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 700; color: var(--secondary-text); min-width: 0; }
      .sx-f input { box-sizing: border-box; width: 100%; height: 44px; border: 1px solid var(--divider); border-radius: 10px; padding: 0 12px; font: inherit; font-size: 16px; background: var(--card-bg); color: var(--primary-text); }
      .sx-zones { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: -6px; }
      .sx-zone { text-align: left; display: flex; flex-direction: column; gap: 3px; padding: 11px 13px; border-radius: 12px; border: 1px solid var(--divider); background: var(--card-bg); color: var(--primary-text); font: inherit; cursor: pointer; }
      .sx-zone[aria-pressed="true"] { border: 2px solid var(--primary-text); padding: 10px 12px; background: var(--bg); }
      .sx-zone-top { display: flex; justify-content: space-between; gap: 8px; font-size: 15px; }
      .sx-temph { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
      .sx-chkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--secondary-text); cursor: pointer; }
      .sx-chkbox input { width: 18px; height: 18px; }
      .sx-big { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
      .sx-big b { font-size: 52px; font-weight: 800; letter-spacing: -0.03em; min-width: 100px; text-align: center; }
      .sx-big .sx-dim { flex: 1 1 160px; }
      .sx-step { width: 40px; height: 40px; border-radius: 10px; border: 1px solid var(--divider); background: var(--card-bg); color: var(--primary-text); font: inherit; font-size: 22px; font-weight: 600; cursor: pointer; }
      .sx-step-l { width: 52px; height: 52px; border-radius: 14px; font-size: 26px; }
      .sx-pc { border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--divider); }
      .sx-pc > span { font-size: 13px; font-weight: 700; }
      .sx-pc-heat > span { color: #d9622b; }
      .sx-pc-cool > span { color: #2f6fd6; }
      .sx-stepper { display: flex; align-items: center; gap: 10px; }
      .sx-stepper b { font-size: 30px; font-weight: 800; min-width: 64px; text-align: center; }
      .sx-pv { border: 1px solid var(--divider); border-radius: 12px; overflow: hidden; }
      .sx-pvtabs { display: flex; gap: 4px; padding: 5px; background: var(--bg); }
      .sx-pvtabs .sx-segbtn { flex: 1; }
      .sx-pvb { padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
      .sx-pvmain { font-size: 17px; font-weight: 700; line-height: 1.35; }

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
      .season-seg-btn.seg-both[aria-pressed="true"] { background: linear-gradient(90deg, #e65100, #0277bd); color: #fff; }
      .hc-note { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--secondary-text);
        background: var(--secondary-background-color, rgba(0,0,0,.04)); border-radius: 8px; padding: 8px 12px; margin-top: 10px; }
      .hc-note ha-icon { --mdc-icon-size: 16px; flex: none; }
      .block-badge.gap-badge { background: rgba(0,0,0,.28); }
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

      /* ── v2.7 kit: one shell shared with First Words and Kitchen ───────── */
      .panel { max-width: 1080px; padding: 0 20px 32px; }
      .header { border-bottom: 0; margin-bottom: 8px; padding: 28px 0 8px; align-items: flex-end; flex-wrap: nowrap; }
      .header-left { flex-direction: column; align-items: flex-start; gap: 2px; }
      .hd-eyebrow { font-size: 13px; font-weight: 600; color: var(--secondary-text); }
      .header h1 { font-size: 34px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; }
      .status-item { border: 0; background: var(--card-bg); border-radius: 999px; padding: 6px 12px; }
      .eyebrow { font-size: 13px; letter-spacing: 0; text-transform: none; font-weight: 600; }
      .card-h { margin: 0; font-size: 17px; font-weight: 700; }
      .link-btn { border: 0; background: none; padding: 6px 2px; font: inherit; font-size: 15px; font-weight: 600; color: var(--gt-accent); cursor: pointer; }
      .dim { color: var(--secondary-text); font-weight: 500; }

      /* surfaces: fill, no outline; cards never nest */
:host { min-height: 100vh; }
      .now-card, .week-overview, .day-detail, .season-strip, .status-error-box, .sx-card, .stat-card, .chart-card,
      .status-card, .debug-card, .settings-card, .automation-panel, .quick-panel, .schedule-section, .settings-layout {
        border: 0; border-radius: 20px; }
      .sx-pv { border: 0; background: var(--bg); border-radius: 16px; }
      .sx-plan { border-color: transparent; border-radius: 20px; }
      .sx-plan-on { border-color: var(--primary-text); }
      .sx-lbl, .sx-row-h, .stat-label { text-transform: none; letter-spacing: 0; font-size: 13px; }
      .season-seg { border: 0; }
      .season-seg-btn.seg-heat[aria-pressed="true"] { background: var(--gt-heat); }
      .season-seg-btn.seg-cool[aria-pressed="true"] { background: var(--gt-cool); }
      .season-seg-btn.seg-both[aria-pressed="true"] { background: linear-gradient(90deg, var(--gt-heat), var(--gt-cool)); }
      .entry-card, .room, .action-tile, .sx-zone, .sx-pc { border-color: transparent; border-radius: 16px; background: var(--bg); }
      .btn { border-radius: 999px; }
      .btn-primary, .btn-add { background: var(--gt-ink); color: var(--gt-surface); border-color: var(--gt-ink); }
      .btn-outline { color: var(--primary-text); border-color: var(--divider); }
      .btn-outline:hover { background: var(--bg); color: var(--primary-text); }
      .preset-select, .mode-select, .strip-preset select { border-radius: 12px; }

      /* tabs: underline on a wide screen, a bottom bar on a phone */
      .main-tab-bar { border-bottom: 0; gap: 6px; margin-bottom: 20px; }
      .main-tab { border-radius: 999px; border-bottom: 0; margin-bottom: 0; padding: 8px 16px; font-weight: 600; }
      .main-tab:hover { background: var(--card-bg); color: var(--primary-text); }
      .main-tab.active { background: var(--gt-ink); color: var(--gt-surface); }
      @media (max-width: 700px) {
        .panel { padding-bottom: calc(100px + env(safe-area-inset-bottom)); }
        .header { padding-top: 20px; flex-direction: row; align-items: flex-end; justify-content: space-between; }
        .status-item { font-size: 12px; padding: 5px 10px; }
        .main-tab-bar {
          position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; margin: 0; gap: 0;
          display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
          padding: 8px 0 calc(10px + env(safe-area-inset-bottom));
          background: color-mix(in srgb, var(--card-bg) 94%, transparent);
          border-top: 1px solid var(--divider);
          -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
        }
        .main-tab { flex-direction: column; gap: 3px; padding: 4px 0; font-size: 11px; border-radius: 0; background: none; }
        .main-tab ha-icon { display: inline-block; --mdc-icon-size: 24px; }
        .main-tab.active, .main-tab:hover { background: none; color: var(--primary-text); font-weight: 700; }
        .main-tab:not(.active) { color: var(--secondary-text); }
        .save-bar { bottom: calc(96px + env(safe-area-inset-bottom)); }
      }

      /* Now: the number first */
      .now-grid { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 12px; align-items: start; }
      .now-hero { padding: 4px 4px 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .now-hero .hero-temp { font-size: 96px; font-weight: 800; letter-spacing: -0.05em; line-height: .9; }
      .now-hero .hero-temp small { font-size: 40px; font-weight: 700; vertical-align: top; margin-left: 2px; }
      .hero-line { display: flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 700; margin-top: 6px; }
      .hero-line ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text); }
      .hero-line.is-heat ha-icon { color: var(--gt-heat); }
      .hero-line.is-cool ha-icon { color: var(--gt-cool); }
      .now-hero .hero-why { margin: 0; font-size: 15px; color: var(--secondary-text); }
      .now-rooms { padding: 4px 16px; gap: 0; }
      .room-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 13px 0;
        border: 0; border-top: 1px solid var(--divider); background: none; color: var(--primary-text);
        font: inherit; font-size: 16px; text-align: left; cursor: pointer; width: 100%; }
      .room-row:first-child { border-top: 0; }
      .room-row:disabled { cursor: default; opacity: 1; }
      .room-row .room-name { font-size: 16px; font-weight: 600; color: var(--primary-text); }
      .room-row .room-name i { font-style: normal; font-size: 13px; font-weight: 500; color: var(--secondary-text); }
      .room-row .room-temp { font-size: 16px; font-weight: 700; }
      .now-today, .now-actions { grid-column: 1 / -1; }
      .today-head { display: flex; justify-content: space-between; align-items: baseline; }
      .today-timeline { height: 40px; border-radius: 12px; }
      .today-timeline .timeline-block { top: 0; bottom: 0; border-radius: 0; box-shadow: none; border-right: 2px solid var(--card-bg); box-sizing: border-box; }
      .timeline-block .block-temp, .timeline-block .block-time { text-shadow: none; }
      .now-line { background: var(--primary-text); width: 3px; border-radius: 2px; opacity: 1; }
      .now-actions { background: none; padding: 0; }
      .action-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .action-tile { background: var(--card-bg); padding: 14px; min-height: 76px; justify-content: center; }
      .action-tile b { font-size: 20px; font-weight: 800; }
      .action-tile.tile-heat b { color: var(--gt-heat); }
      .action-tile.tile-cool b { color: var(--gt-cool); }
      .action-tile span { font-size: 13px; font-weight: 600; color: var(--primary-text); }
      .now-banner { border-radius: 14px; }
      .banner-season { background: color-mix(in srgb, var(--gt-cool) 12%, var(--card-bg)); }
      @media (max-width: 820px) { .now-grid { grid-template-columns: minmax(0, 1fr); } }
      @media (max-width: 560px) { .action-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); } .action-tile { padding: 12px; } }

      /* Settings: season and automations first */
      .set-top { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
      .set-top .season-strip { margin: 0; }
      .set-autos { gap: 12px; }
      .auto-chip { border-radius: 999px; }

      /* Schedule segments carry their own ink now */
      .sx-seg { text-shadow: none; }
      .sx-seg-n { text-transform: none; letter-spacing: 0; font-size: 13px; }

      /* The block editor is a bottom sheet on a phone */
      @media (max-width: 700px) {
        .sx-drawer { top: auto; left: 0; width: 100vw; height: min(92vh, 100%); border-radius: 28px 28px 0 0;
          box-shadow: 0 -12px 40px rgba(0,0,0,.3); }
        .sx-drawer::before { content: ""; display: block; width: 40px; height: 5px; border-radius: 999px;
          background: var(--divider); margin: 8px auto 0; flex: none; }
        .sx-drf { padding-bottom: calc(14px + env(safe-area-inset-bottom)); }
      }
      /* ══ v2.8.0 — phone first ══════════════════════════════════════════ */
      .panel { max-width: 1100px; padding: 16px 16px 24px; }
      .header { border-bottom: 0; padding: 4px 4px 0; margin-bottom: 12px; align-items: flex-end; flex-wrap: nowrap; }
      .header h1 { font-size: 34px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; }
      .header-left { flex-direction: column; align-items: flex-start; gap: 2px; }
      .hd-eyebrow { font-size: 13px; font-weight: 600; color: var(--secondary-text); }
      .live-chip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 999px;
        background: var(--card-bg); font-size: 12px; font-weight: 600; color: var(--secondary-text); }
      .live-chip i { width: 8px; height: 8px; border-radius: 999px; background: var(--success); }
      .card { background: var(--card-bg); border-radius: 22px; border: 0; box-shadow: none; color: var(--primary-text); }
      button.card { font: inherit; cursor: pointer; text-align: left; }
      .c-heat { color: var(--gt-heat); } .c-cool { color: var(--gt-cool); }
      .f-heat { fill: var(--gt-heat); } .f-cool { fill: var(--gt-cool); }
      .dim { color: var(--secondary-text); }

      /* Tabs: pills on a wide screen, a bottom bar on a phone */
      .main-tab-bar { display: flex; gap: 6px; margin: 0 0 14px; border: 0; padding: 0; background: none; }
      .main-tab { border: 0; border-radius: 999px; padding: 8px 16px; font: 600 14px Inter, system-ui, sans-serif; background: none;
        color: var(--secondary-text); display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
      .main-tab ha-icon { --mdc-icon-size: 18px; }
      .main-tab.active { background: var(--primary-text); color: var(--card-bg); }
      @media (max-width: 760px) {
        .panel { padding-bottom: 100px; }
        .main-tab-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; margin: 0; display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr)); background: var(--card-bg); border-top: 1px solid var(--divider);
          padding: 6px 0 calc(8px + env(safe-area-inset-bottom)); }
        .main-tab { flex-direction: column; gap: 2px; font-size: 11px; padding: 6px 0; border-radius: 0; }
        .main-tab ha-icon { --mdc-icon-size: 24px; }
        .main-tab.active { background: none; color: var(--primary-text); font-weight: 800; }
      }

      /* Now */
      .nw { display: flex; flex-direction: column; gap: 12px; }
      .nw-alerts { display: flex; flex-direction: column; gap: 8px; }
      .nw-alert { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 6px 8px 6px 14px; border-radius: 16px;
        background: #fdf0e4; color: #9a3412; }
      :host([dark]) .nw-alert { background: #3a2417; color: #ffb48a; }
      .nw-alert ha-icon { --mdc-icon-size: 20px; flex: none; }
      .nw-alert b { flex: 1; font-size: 15px; font-weight: 800; }
      .nw-abtn { border: 0; border-radius: 999px; height: 36px; padding: 0 14px; font: 700 14px Inter, system-ui, sans-serif;
        background: var(--card-bg); color: var(--primary-text); cursor: pointer; }
      .nw-cols { display: grid; gap: 12px; }
      @media (min-width: 900px) { .nw-cols { grid-template-columns: minmax(0, 420px) minmax(0, 1fr); align-items: start; } }
      .nw-dialcard { padding: 14px 14px 18px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
      .dial { width: 100%; max-width: 340px; height: auto; display: block; }
      .dial .dial-h { cursor: pointer; }
      .nw-ctl { display: flex; align-items: center; justify-content: center; gap: 14px; width: 100%; }
      .nw-step { width: 64px; height: 64px; flex: none; border-radius: 999px; border: 0; background: var(--bg); color: var(--primary-text);
        display: flex; align-items: center; justify-content: center; cursor: pointer; }
      .nw-step ha-icon { --mdc-icon-size: 28px; }
      .nw-step:disabled { opacity: .35; cursor: default; }
      .nw-pill { height: 48px; min-width: 96px; padding: 0 16px; border-radius: 999px; border: 0; background: var(--bg); color: var(--primary-text);
        display: inline-flex; align-items: center; justify-content: center; gap: 8px; font: 800 18px Inter, system-ui, sans-serif; cursor: pointer; }
      .nw-pill ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text); }
      .nw-pill-hold { background: #fdf0e4; color: #9a3412; padding-right: 6px; cursor: default; }
      :host([dark]) .nw-pill-hold { background: #3a2417; color: #ffb48a; }
      .nw-pill-hold ha-icon { color: inherit; }
      .nw-pill-x { width: 36px; height: 36px; border-radius: 999px; border: 0; background: var(--card-bg); color: inherit;
        display: flex; align-items: center; justify-content: center; cursor: pointer; }
      .nw-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .nw-modes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding: 6px; }
      .nw-mode { border: 0; border-radius: 16px; height: 68px; background: none; color: var(--primary-text); cursor: pointer;
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; font: 700 14px Inter, system-ui, sans-serif; }
      .nw-mode ha-icon { --mdc-icon-size: 22px; }
      .nw-mode.on { background: var(--primary-text); color: var(--card-bg); }
      .nw-mode-heat.on { background: var(--gt-heat); color: #fff; }
      .nw-mode-cool.on { background: var(--gt-cool); color: #fff; }
      :host([dark]) .nw-mode-heat.on, :host([dark]) .nw-mode-cool.on, :host([dark]) .sx2 .sx-v-heat[aria-pressed="true"],
      :host([dark]) .sx2 .sx-v-cool[aria-pressed="true"], :host([dark]) .st-pp-heat, :host([dark]) .st-pp-cool { color: #0f1115; }
      .nw-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .nw-tile { border: 0; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .nw-tile ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text); }
      .nw-tile b { font-size: 16px; font-weight: 800; line-height: 1.15; overflow-wrap: anywhere; }
      .nw-tile span { font-size: 12px; font-weight: 600; color: var(--secondary-text); }
      .nw-tile:disabled { cursor: default; }
      .nw-rooms { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 8px; }
      .nw-room { border: 0; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .nw-room span { font-size: 13px; font-weight: 600; color: var(--secondary-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .nw-room b { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; display: flex; align-items: center; gap: 8px; }
      .nw-room.on { box-shadow: inset 0 0 0 2.5px var(--primary-text); cursor: default; }
      .nw-room:disabled { opacity: 1; }
      .nw-dot { width: 10px; height: 10px; border-radius: 999px; flex: none; }
      .now-today { padding: 14px; }
      .nw-acts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .nw-act { border: 0; height: 72px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
      .nw-act b { font-size: 22px; font-weight: 800; }
      .nw-act span { font-size: 12px; font-weight: 600; color: var(--secondary-text); }
      .nw-act ha-icon { --mdc-icon-size: 22px; }
      .nw-act.tile-heat b { color: var(--gt-heat); } .nw-act.tile-cool b { color: var(--gt-cool); }

      /* Schedule */
      .sx2 { display: flex; flex-direction: column; gap: 12px; }
      .sx2 .sx-plans { display: flex; gap: 8px; overflow-x: auto; margin: 0 -16px; padding: 2px 16px; scrollbar-width: none; grid-template-columns: none; }
      .sx2 .sx-plans::-webkit-scrollbar { display: none; }
      .sx2 .sx-plan { flex: none; width: auto; min-width: 104px; max-width: 190px; border: 0; border-radius: 18px; padding: 12px 14px; background: var(--card-bg);
        display: flex; flex-direction: column; gap: 9px; align-items: stretch; text-align: left; cursor: pointer; box-shadow: none; }
      .sx2 .sx-plan-on { box-shadow: inset 0 0 0 2.5px var(--primary-text); }
      .sx2 .sx-plan-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
      .sx2 .sx-plan-top b { font-size: 15px; font-weight: 800; white-space: nowrap; }
      .sx-rundot { width: 9px; height: 9px; border-radius: 999px; background: var(--success); flex: none; }
      .sx-chkdot { width: 9px; height: 9px; border-radius: 999px; background: #ea580c; flex: none; }
      .sx2 .sx-mini { position: relative; display: block; height: 8px; border-radius: 999px; overflow: hidden; background: var(--divider); }
      .sx2 .sx-mini i { position: absolute; top: 0; bottom: 0; }
      .sx2 .sx-plan-add { width: 52px; align-items: center; justify-content: center; }
      .sx-week { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
      .sx-bar { display: flex; align-items: center; gap: 6px; }
      .sx-grow { flex: 1; }
      .sx2 .sx-segs { display: flex; background: var(--bg); border-radius: 999px; padding: 4px; gap: 4px; flex-wrap: nowrap; }
      .sx2 .sx-segbtn { border: 0; border-radius: 999px; height: 36px; padding: 0 12px; display: inline-flex; align-items: center; gap: 6px;
        font: 700 13px Inter, system-ui, sans-serif; background: none; color: var(--primary-text); cursor: pointer; white-space: nowrap; }
      .sx2 .sx-segbtn ha-icon { --mdc-icon-size: 17px; }
      .sx2 .sx-segbtn[aria-pressed="true"] { background: var(--primary-text); color: var(--card-bg); }
      .sx2 .sx-v-heat[aria-pressed="true"] { background: var(--gt-heat); color: #fff; }
      .sx2 .sx-v-cool[aria-pressed="true"] { background: var(--gt-cool); color: #fff; }
      .sx-round { width: 40px; height: 40px; flex: none; border-radius: 999px; border: 0; background: var(--bg); color: var(--primary-text);
        display: flex; align-items: center; justify-content: center; cursor: pointer; }
      .sx-round:disabled { opacity: .35; cursor: default; }
      .sx-round-ink { background: var(--primary-text); color: var(--card-bg); }
      .sx-round:has(.sx-arm) { width: auto; padding: 0 12px; background: #fdecea; color: #b42318; font: 700 13px Inter, system-ui, sans-serif; }
      .sx-grid { display: grid; grid-template-columns: 30px minmax(0, 1fr); row-gap: 8px; column-gap: 8px; align-items: center; }
      .sx-dl { font-size: 13px; font-weight: 600; color: var(--secondary-text); }
      .sx-dl.on { font-weight: 800; color: var(--primary-text); }
      .sx-track { position: relative; height: 50px; border-radius: 12px; background: var(--bg); }
      .sx-track-tgt { box-shadow: 0 0 0 2px var(--divider); }
      .sx-track-gap { background: repeating-linear-gradient(135deg, var(--bg) 0 6px, var(--divider) 6px 8px); }
      .sx2 .sx-seg { position: absolute; top: 0; bottom: 0; border: 0; border-radius: 12px; padding: 0 8px; display: flex; align-items: center;
        gap: 6px; overflow: hidden; cursor: pointer; box-shadow: inset 0 0 0 1.5px var(--card-bg); font-family: inherit;
        flex-direction: row; justify-content: flex-start; text-align: left; min-width: 0; }
      .sx2 .sx-seg b { font-size: 17px; font-weight: 800; letter-spacing: -0.02em; }
      .sx2 .sx-seg span { margin-left: auto; font-size: 11px; font-weight: 700; opacity: .7; }
      .sx2 .sx-seg-live { box-shadow: inset 0 0 0 3px var(--primary-text); }
      .sx2 .sx-nowline { position: absolute; top: -4px; bottom: -4px; width: 3px; margin-left: -1.5px; border-radius: 2px; background: var(--primary-text); pointer-events: none; }
      .sx2 .sx-nowline b { display: none; }
      .sx-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--secondary-text); }
      .sx-axis2 { display: flex; justify-content: space-between; font-size: 11px; font-weight: 600; color: var(--secondary-text); }
      .sx2 .sx-days { display: flex; align-items: center; gap: 8px; color: var(--secondary-text); }
      .sx2 .sx-days ha-icon { --mdc-icon-size: 20px; }
      .sx-issues { display: flex; flex-direction: column; gap: 6px; }
      .sx-issue { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; font-weight: 600; color: #9a3412; }
      .sx-issue ha-icon { --mdc-icon-size: 18px; flex: none; }
      .sx-tools { display: flex; flex-wrap: wrap; gap: 8px; }
      .sx-pill { height: 40px; padding: 0 14px; border-radius: 999px; border: 0; background: var(--card-bg); color: var(--primary-text);
        display: inline-flex; align-items: center; gap: 6px; font: 700 13px Inter, system-ui, sans-serif; cursor: pointer; }
      .sx-pill ha-icon { --mdc-icon-size: 18px; }
      .sx-pill:disabled { opacity: .4; cursor: default; }
      .sx-pill-ink { background: var(--primary-text); color: var(--card-bg); }

      /* Sheets: from the bottom on a phone, from the side on a wide screen */
      .sx-scrim { position: fixed; inset: 0; background: rgba(21,24,29,.38); z-index: 1000; }
      .sx-drawer { position: fixed; z-index: 1001; background: var(--card-bg); color: var(--primary-text); display: flex; flex-direction: column;
        left: 0; right: 0; bottom: 0; top: auto; width: auto; height: auto; max-height: 88vh; border-radius: 28px 28px 0 0;
        padding: 10px 16px calc(16px + env(safe-area-inset-bottom)); box-shadow: 0 -12px 40px rgba(21,24,29,.18); }
      @media (min-width: 900px) {
        .sx-drawer { left: auto; top: 16px; right: 16px; bottom: 16px; width: 400px; max-height: none; border-radius: 24px; padding: 16px; }
        .sx-grab { display: none; }
      }
      .sx-grab { align-self: center; width: 40px; height: 5px; border-radius: 999px; background: var(--divider); margin-bottom: 8px; flex: none; }
      .sx-drawer .sx-drh { display: flex; align-items: center; gap: 8px; padding: 0 0 10px; border: 0; }
      .sx-drawer .sx-drh ha-icon { --mdc-icon-size: 22px; }
      .sx-drawer .sx-title { font-size: 22px; font-weight: 800; flex: 1; }
      .sx-drawer .sx-drb { overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 0; flex: 0 1 auto; }
      .sx-drawer .sx-drf { display: grid; grid-template-columns: 2fr 1fr; gap: 8px; padding: 12px 0 0; border: 0; }
      .sx-drawer .sx-big-btn { height: 54px; border-radius: 999px; font-size: 16px; font-weight: 700; }
      .sx-times { display: flex; align-items: center; gap: 8px; color: var(--secondary-text); }
      .sx-time { flex: 1; }
      .sx-time input { width: 100%; box-sizing: border-box; height: 60px; border-radius: 16px; border: 0; background: var(--bg); color: var(--primary-text);
        font: 800 20px Inter, system-ui, sans-serif; text-align: center; }
      .sx-dur { font-size: 13px; font-weight: 700; color: var(--secondary-text); min-width: 32px; text-align: right; }
      .sx-note { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--secondary-text); }
      .sx-note ha-icon { --mdc-icon-size: 18px; }
      .sx-note-warn { color: #9a3412; }
      .sx-stp { display: flex; align-items: center; gap: 10px; background: var(--bg); border-radius: 16px; padding: 8px 8px 8px 14px; }
      .sx-stp > ha-icon { --mdc-icon-size: 22px; color: var(--secondary-text); margin-right: auto; }
      .sx-stp-heat > ha-icon { color: var(--gt-heat); } .sx-stp-cool > ha-icon { color: var(--gt-cool); }
      .sx-drawer .sx-step { width: 48px; height: 48px; border-radius: 999px; border: 0; background: var(--card-bg); color: var(--primary-text);
        font: 700 24px Inter, system-ui, sans-serif; cursor: pointer; }
      .sx-chip { width: 72px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 800; }
      .sx-split { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; color: var(--secondary-text); cursor: pointer; }
      .sx-split ha-icon { --mdc-icon-size: 18px; }
      .sx-split input { width: 20px; height: 20px; margin: 0 4px 0 0; accent-color: var(--primary-text); }
      .sx-drawer .sx-zones { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
      .sx-drawer .sx-zone { border: 0; border-radius: 14px; height: 48px; background: var(--bg); color: var(--primary-text); font: 700 15px Inter, system-ui, sans-serif; cursor: pointer; display: block; padding: 0 10px; }
      .sx-drawer .sx-zone[aria-pressed="true"] { background: var(--primary-text); color: var(--card-bg); }
      .sx-dchips { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 5px; }
      .sx-dchip { height: 40px; border-radius: 12px; background: var(--bg); color: var(--secondary-text); display: flex; align-items: center;
        justify-content: center; font-size: 14px; font-weight: 800; }
      .sx-dchip.on { background: var(--primary-text); color: var(--card-bg); }

      /* History */
      .hs { display: flex; flex-direction: column; gap: 12px; }
      .hs-seg { display: flex; background: var(--card-bg); border-radius: 999px; padding: 4px; gap: 4px; }
      .hs-seg button { flex: 1; border: 0; border-radius: 999px; height: 38px; font: 700 14px Inter, system-ui, sans-serif; background: none;
        color: var(--secondary-text); cursor: pointer; }
      .hs-seg button[aria-pressed="true"] { background: var(--primary-text); color: var(--card-bg); }
      .hs-tiles { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
      .hs-tiles-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      @media (min-width: 900px) { .hs-tiles-2 { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
      .hs-tile { padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .hs-tile ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text); }
      .hs-tile ha-icon.c-heat { color: var(--gt-heat); } .hs-tile ha-icon.c-cool { color: var(--gt-cool); }
      .hs-tile b { font-size: 24px; font-weight: 800; letter-spacing: -0.02em; }
      .hs-tile span { font-size: 12px; font-weight: 600; color: var(--secondary-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .hs-card { padding: 14px 16px 10px; display: flex; flex-direction: column; gap: 6px; }
      .hs-h { font-size: 15px; font-weight: 800; }
      .hs-hrow { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
      .hs-svg { width: 100%; height: auto; display: block; overflow: visible; }
      .hs-grid { stroke: var(--divider); stroke-width: 1px; }
      .hs-curve { fill: none; stroke: var(--primary-text); stroke-width: 2.5px; stroke-linejoin: round; stroke-linecap: round; }
      .hs-evline { stroke: var(--divider); stroke-width: 1.2px; stroke-dasharray: 2 4; }
      .hs-ev { fill: var(--bg); } .hs-ev-warm { fill: #fdf0e4; }
      .hs-evi { fill: none; stroke: var(--primary-text); stroke-width: 2.4px; stroke-linecap: round; stroke-linejoin: round; }
      .hs-evi-warm { fill: none; stroke: #9a3412; stroke-width: 2.4px; stroke-linecap: round; stroke-linejoin: round; }
      .hs-outline { fill: none; stroke: var(--gt-accent); stroke-width: 1.5px; stroke-dasharray: 2 4; stroke-linecap: round; }
      .hs-zero { fill: var(--divider); }
      .hs-empty { display: flex; align-items: center; gap: 8px; padding: 30px 0; justify-content: center; color: var(--secondary-text); font-weight: 600; }
      .hs-key { display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--secondary-text); }
      .hs-key i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; margin-left: 6px; }
      .f-heatbg { background: var(--gt-heat); } .f-coolbg { background: var(--gt-cool); }
      .hs-key .hs-key-in { width: 14px; height: 3px; background: var(--primary-text); }
      .hs-cal { display: grid; grid-template-columns: 28px minmax(0, 1fr); row-gap: 3px; column-gap: 6px; align-items: center; }
      .hs-ml { font-size: 11px; font-weight: 600; color: var(--secondary-text); }
      .hs-ml.on { font-weight: 800; color: var(--primary-text); }
      .hs-crow { display: grid; grid-template-columns: repeat(31, minmax(0, 1fr)); gap: 1.5px; }
      .hs-c { display: block; aspect-ratio: 1; border-radius: 2px; }
      .hs-c-none { visibility: hidden; }
      .hs-c-nr { background: var(--bg); box-shadow: inset 0 0 0 1px var(--divider); }
      .hs-c-off { background: var(--divider); }
      .hs-c-today { box-shadow: 0 0 0 1.5px var(--primary-text); }
      .hs-range { stroke: var(--divider); stroke-width: 7px; stroke-linecap: round; }
      .hs-inside { stroke: var(--primary-text); stroke-width: 3px; stroke-linecap: round; }
      .hs-nr { stroke: var(--divider); stroke-width: 1.5px; stroke-dasharray: 2 3; }
      .hs-nrbar { fill: none; stroke: var(--divider); stroke-width: 1px; stroke-dasharray: 2 3; }
      .hs-dot-off { fill: var(--divider); }
      .hs-today { fill: none; stroke: var(--primary-text); stroke-width: 2.5px; }

      /* Settings */
      .st { display: flex; flex-direction: column; gap: 12px; }
      .st-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; border: 0; }
      .st-h { display: flex; align-items: center; gap: 8px; }
      .st-h > b { font-size: 17px; font-weight: 800; }
      .st-h ha-icon { --mdc-icon-size: 20px; }
      .st-grow { flex: 1; }
      .st-sub { font-size: 12px; font-weight: 600; color: var(--secondary-text); }
      .st-h .st-sub { font-size: 13px; font-weight: 700; }
      .st-goals { display: grid; grid-template-columns: 62px minmax(0, 1fr) minmax(0, 1fr); gap: 8px; align-items: center; }
      .st-colh, .st-rowh { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; color: var(--secondary-text); }
      .st-colh { justify-content: center; }
      .st-colh ha-icon, .st-rowh ha-icon { --mdc-icon-size: 16px; }
      .st-rowh.c-heat { color: var(--gt-heat); } .st-rowh.c-cool { color: var(--gt-cool); }
      .st-goal { position: relative; height: 50px; border-radius: 14px; border: 0; font: 800 21px Inter, system-ui, sans-serif; cursor: pointer;
        display: flex; align-items: center; justify-content: center; gap: 6px; }
      .st-goal-plan { background: var(--bg); color: var(--primary-text); font-size: 16px; }
      .st-goal-plan ha-icon { --mdc-icon-size: 18px; }
      .st-flag { position: absolute; top: 6px; right: 6px; width: 8px; height: 8px; border-radius: 999px; background: #fff; box-shadow: 0 0 0 2px #ea580c; }
      .st-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .st-mini { text-align: left; }
      .st-pic { display: flex; align-items: center; gap: 4px; }
      .st-end { width: 34px; height: 34px; flex: none; border-radius: 999px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; }
      .st-end ha-icon { --mdc-icon-size: 18px; }
      .st-end-warm { background: #fdf0e4; color: #9a3412; } .st-end-plain { background: var(--bg); color: var(--primary-text); }
      .st-grad { flex: 1; height: 8px; border-radius: 999px; background: linear-gradient(90deg, rgb(196,218,244), rgb(251,232,204), rgb(242,182,120), rgb(222,104,40)); }
      .st-dash { flex: 1; border-top: 2px dashed var(--divider); }
      .st-mid { font-size: 20px; font-weight: 800; }
      .st-path { display: flex; align-items: center; gap: 6px; border: 0; background: none; padding: 0; cursor: pointer; color: var(--primary-text); font: inherit; }
      .st-pp { height: 40px; padding: 0 12px; border-radius: 999px; display: inline-flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 800; color: #fff; flex: none; }
      .st-pp ha-icon { --mdc-icon-size: 16px; }
      .st-pp-heat { background: var(--gt-heat); } .st-pp-cool { background: var(--gt-cool); } .st-pp-both { background: var(--primary-text); color: var(--card-bg); }
      .st-arrow { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 28px; }
      .st-arrow b { font-size: 14px; font-weight: 800; }
      .st-arrow ha-icon { --mdc-icon-size: 14px; display: none; }
      .st-arrow i { width: 100%; height: 2px; background: var(--primary-text); position: relative; }
      .st-arrow i::before, .st-arrow i::after { content: ""; position: absolute; top: -4px; width: 8px; height: 8px; border: solid var(--primary-text); border-width: 2px 2px 0 0; }
      .st-arrow i::after { right: 0; transform: rotate(45deg); } .st-arrow i::before { left: 0; transform: rotate(-135deg); }
      .st-inrow { display: flex; align-items: center; gap: 10px; background: var(--bg); border-radius: 14px; padding: 10px 12px; }
      .st-inrow b { flex: 1; font-size: 14px; font-weight: 700; }
      .st-inrow ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text); }
      .st-label { font-size: 13px; font-weight: 800; color: var(--secondary-text); margin-bottom: -4px; }
      .st-three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .st-four { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .st-mt { border: 0; background: var(--bg); color: var(--primary-text); border-radius: 14px; padding: 10px; display: flex; flex-direction: column;
        align-items: flex-start; gap: 3px; text-align: left; min-width: 0; cursor: pointer; font: inherit; }
      .st-mt ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text); }
      .st-mt b { font-size: 20px; font-weight: 800; }
      .st-mt span { font-size: 12px; font-weight: 600; color: var(--secondary-text); line-height: 1.2; }
      .st-rows { gap: 0; }
      .st-rows .st-h { margin-bottom: 4px; }
      .st-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--divider); }
      .st-row:last-child { border-bottom: 0; }
      .st-rowb { flex: 1; display: flex; align-items: center; gap: 12px; border: 0; background: none; padding: 0; text-align: left; color: var(--primary-text); cursor: pointer; font: inherit; min-width: 0; }
      .st-ri { flex: none; width: 38px; height: 38px; border-radius: 12px; background: var(--bg); display: flex; align-items: center; justify-content: center; }
      .st-ri ha-icon { --mdc-icon-size: 18px; }
      .st-rt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .st-rt b { font-size: 15px; font-weight: 800; }
      .st-rt span { font-size: 12px; font-weight: 600; color: var(--secondary-text); }
      .st-sw { flex: none; width: 46px; height: 28px; border-radius: 999px; border: 0; padding: 3px; display: flex; align-items: center;
        background: var(--divider); cursor: pointer; justify-content: flex-start; }
      .st-sw.on { background: var(--primary-text); justify-content: flex-end; }
      .st-sw i { width: 22px; height: 22px; border-radius: 999px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
      .st-sw:disabled { opacity: .5; }
      .st-sheet .set-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0;
        border-bottom: 1px solid var(--divider); flex-wrap: wrap; }
      .st-sheet .set-row:last-child { border-bottom: 0; }
      .st-sheet .set-text { flex: 1 1 140px; min-width: 0; }
      .st-sheet .set-text label { font-size: 15px; font-weight: 800; color: var(--primary-text); }
      .st-sheet .settings-hint { font-size: 12px; font-weight: 600; color: var(--secondary-text); margin-top: 2px; }
      .st-sheet .set-control { display: flex; align-items: center; gap: 8px; flex: none; }
      .st-sheet .set-num { width: 84px; height: 44px; border-radius: 12px; border: 0; background: var(--bg); color: var(--primary-text);
        font: 800 18px Inter, system-ui, sans-serif; text-align: center; box-sizing: border-box; }
      .st-sheet .set-select, .st-sheet .set-entity { height: 44px; border-radius: 12px; border: 0; background: var(--bg); color: var(--primary-text);
        font: 600 16px Inter, system-ui, sans-serif; padding: 0 12px; max-width: 100%; }
      .st-sheet .set-unit { font-size: 13px; font-weight: 700; color: var(--secondary-text); }
      .st-sheet .set-range { accent-color: var(--primary-text); width: 150px; }
      .st-sheet .set-out { font-size: 16px; font-weight: 800; min-width: 48px; text-align: right; }
      .st-sheet .toggle-slider { background: var(--divider); }
      .st-sheet .toggle-switch input:checked + .toggle-slider { background: var(--primary-text); }
      .st-sheet input[type="checkbox"] { accent-color: var(--primary-text); }
      .st-sheet .set-warn { font-size: 13px; font-weight: 600; color: #9a3412; background: #fdf0e4; border-radius: 12px; padding: 10px 12px; }
      .st-sheet .set-row-dirty .set-text label::after { content: " •"; color: #ea580c; }
      .st-sheet .save-bar { position: static; margin: 12px 0 0; border-radius: 16px; }
    `;
  }
}

customElements.define("gttc-panel", GttcPanel);
