// ═══════════════════════════════════════════════
// Eco_Road — Routing & Clean-Air Analytics
// Multi-modal Routing (Walk, Cycle, Drive), Asthma Profile,
// Health Grades, Provenance Badges & Route Comparison
// ═══════════════════════════════════════════════

const Routing = (() => {

  let _routeData   = null;
  let _activeRoute = 'eco';
  let _loading     = false;
  let _mode        = 'foot';        // foot (walking), bike (cycling), driving
  let _sensitivity = 'standard';    // standard, asthma
  let _preference  = 'cleanest';    // cleanest, fastest, balanced
  let _abortController = null;
  let _reqSequence = 0;

  // ── Mode Switcher (Instant UI with AbortController) ─
  function setMode(newMode) {
    if (!['foot', 'bike', 'driving'].includes(newMode)) return;
    if (typeof Utils !== 'undefined') Utils.haptic('light');
    _mode = newMode;
    ['foot', 'bike', 'driving'].forEach(m => {
      const btn = document.getElementById(`mode-${m}`);
      if (btn) btn.classList.toggle('active', m === newMode);
    });
    const btnText = document.getElementById('go-btn-text');
    if (btnText) {
      const modeName = _mode === 'bike' ? 'Cycling' : (_mode === 'driving' ? 'Driving' : 'Walking');
      btnText.textContent = `Start ${modeName} Navigation`;
    }
    _retriggerIfReady();
  }

  function getMode() {
    return _mode;
  }

  // ── Health Sensitivity Toggle (Standard / Asthma) ─
  function toggleSensitivity() {
    if (typeof Utils !== 'undefined') Utils.haptic('medium');
    _sensitivity = (_sensitivity === 'standard') ? 'asthma' : 'standard';
    const pill = document.getElementById('health-mode-toggle');
    const icon = document.getElementById('health-mode-icon');
    const text = document.getElementById('health-mode-text');

    if (pill) {
      pill.classList.toggle('asthma-active', _sensitivity === 'asthma');
    }
    if (icon) icon.textContent = _sensitivity === 'asthma' ? '🫁' : '💚';
    if (text) text.textContent = _sensitivity === 'asthma' ? 'Asthma Mode' : 'Standard';

    Utils.toast(_sensitivity === 'asthma' 
      ? '🫁 Asthma Profile active: Prioritizing low-PM2.5 tree corridors' 
      : '💚 Standard Commuter Profile active'
    );

    _retriggerIfReady();
  }

  function _retriggerIfReady() {
    const state = Geocoding.getState();
    if (state.origin.coords && state.dest.coords) {
      const validWps = (state.waypoints || [])
        .filter(w => w.coords && !isNaN(w.coords.lat) && !isNaN(w.coords.lng))
        .map(w => [w.coords.lat, w.coords.lng]);

      findRoutes(state.origin.coords, state.dest.coords, validWps);
    }
  }

  // ── Find Routes (Backend API Call with Race-Free Cancellation) ──
  async function findRoutes(origin, dest, waypoints = [], preferredRouteType = null) {
    if (_abortController) {
      _abortController.abort();
    }
    _abortController = new AbortController();
    const currentSeq = ++_reqSequence;

    const modeLabel = _mode === 'bike' ? 'cycling' : (_mode === 'driving' ? 'driving' : 'pedestrian');
    Utils.toast(`🔍 Calculating real ${modeLabel} routes…`);

    const goBtn = document.getElementById('go-btn');
    if (goBtn) goBtn.disabled = true;

    // Visual loading skeleton pulse on cards
    const detailCard = document.getElementById('route-detail-card');
    if (detailCard) detailCard.classList.add('route-skeleton-pulse');

    try {
      const wpStr = waypoints.map(w => `${w[0]},${w[1]}`).join(';');
      const url = Config.ENDPOINTS.route(
        origin.lat, origin.lng, dest.lat, dest.lng, _mode, _sensitivity, wpStr, _preference
      );
      const res = await fetch(url, { signal: _abortController.signal });

      if (currentSeq !== _reqSequence) return; // Stale in-flight response, discard

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }

      _routeData = await res.json();
      if (currentSeq !== _reqSequence) return;

      _renderTabSubtitles(_routeData);
      _renderHealthSavings(_routeData);
      _showRouteCards();
      if (typeof MapManager !== 'undefined' && MapManager.getMap && MapManager.getMap()) {
        MapManager.getMap().invalidateSize({ pan: false });
      }
      MapManager.drawRoutes(_routeData);

      // Default highlight clean air route if distinct, or shortest
      const preferred = preferredRouteType || ((_routeData.same_route || !_routeData.eco) ? 'shortest' : 'eco');
      selectRoute(preferred);

      // Fetch 6-hour pollution forecast timeline
      _fetchHourlyTrend(origin, dest);

      if (_routeData.same_route) {
        Utils.toast('✅ Single direct route found on mapped road network');
      } else {
        Utils.toast('🌿 Alternative routes found — 🟢 Green = Clean Air Path · ⚖️ Cyan = Balanced');
      }

    } catch (e) {
      if (e.name === 'AbortError') {
        // Quietly ignored because a newer request was initiated
        return;
      }
      Utils.toast('❌ Route error: ' + e.message);
      console.error('Routing error:', e);
    } finally {
      if (currentSeq === _reqSequence) {
        _loading = false;
        if (goBtn) goBtn.disabled = false;
        if (detailCard) detailCard.classList.remove('route-skeleton-pulse');
      }
    }
  }

  // ── 6-Hour Hourly Trend Fetcher ──────────────
  async function _fetchHourlyTrend(origin, dest) {
    const card  = document.getElementById('route-trend-card');
    const badge = document.getElementById('trend-badge');
    const recEl = document.getElementById('trend-recommendation');
    const tlEl  = document.getElementById('trend-timeline');
    if (!card || !tlEl) return;

    try {
      const url = Config.ENDPOINTS.trend(origin.lat, origin.lng, dest.lat, dest.lng);
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      if (badge) badge.textContent = data.best_window ? `Cleanest: ${data.best_window}` : 'Forecast';
      if (recEl) recEl.textContent = data.recommendation || '';

      tlEl.innerHTML = '';
      (data.hourly_forecast || []).forEach(item => {
        const pill = document.createElement('div');
        pill.className = `trend-hour-pill ${item.is_rush_hour ? 'rush-hour' : ''}`;
        pill.innerHTML = `
          <span class="trend-pill-time">${item.label}</span>
          <span class="trend-pill-aqi" style="color:${item.color}">${Math.round(item.aqi)}</span>
          <span class="trend-pill-status" style="color:${item.color}">${item.bucket.split(' ')[0]}</span>
        `;
        tlEl.appendChild(pill);
      });

      card.style.display = 'flex';
    } catch (e) {
      console.warn('Hourly trend error:', e);
    }
  }

  // ── Select Active Route (Shortest, Clean Air, Balanced) ──
  function selectRoute(which) {
    if (!_routeData) return;
    _activeRoute = which;

    const chosen = _routeData[which] || _routeData.eco || _routeData.shortest;

    MapManager.highlightRoute(which);
    _updateDetailCard(chosen);

    // Route tab buttons
    const btnS = document.getElementById('btn-shortest');
    const btnE = document.getElementById('btn-eco');
    const btnB = document.getElementById('btn-balanced');
    if (btnS) btnS.className = 'route-btn' + (which === 'shortest' ? ' active blue-route'  : '');
    if (btnE) btnE.className = 'route-btn' + (which === 'eco' || which === 'cleanest' ? ' active green-route' : '');
    if (btnB) btnB.className = 'route-btn' + (which === 'balanced' ? ' active cyan-route'   : '');

    // Mini header preview
    const state = Geocoding.getState();
    const oEl   = document.getElementById('mini-origin');
    const dEl   = document.getElementById('mini-dest');
    const mini  = document.getElementById('header-mini');
    if (oEl) oEl.textContent = (state.origin.name || '').split(',')[0] || '—';
    if (dEl) dEl.textContent = (state.dest.name || '').split(',')[0] || '—';
    if (mini) mini.style.display = 'flex';
  }

  // ── Render Tab Subtitles (Shortest, Cleanest, Balanced) ──
  function _renderTabSubtitles(data) {
    const subS = document.getElementById('sub-shortest');
    const subE = document.getElementById('sub-eco');
    const subB = document.getElementById('sub-balanced');
    if (subS && data.shortest) {
      subS.textContent = `${data.shortest.distance_str} · ${data.shortest.duration_str}`;
    }
    if (subE && data.eco) {
      if (data.same_route) {
        subE.textContent = `${data.eco.distance_str} · (Single corridor)`;
      } else if (data.health_impact && data.health_impact.is_eco_cleaner && data.health_impact.saved_percent > 0) {
        subE.textContent = `${data.eco.duration_str} · ${data.health_impact.saved_percent}% cleaner`;
      } else {
        subE.textContent = `${data.eco.distance_str} · Cleanest`;
      }
    }
    if (subB && data.balanced) {
      if (data.same_route) {
        subB.textContent = `${data.balanced.distance_str} · Optimal`;
      } else {
        subB.textContent = `${data.balanced.duration_str} · Balanced`;
      }
    }
  }

  // ── Render Health Exposure Savings ────────────
  function _renderHealthSavings(data) {
    const savingsBody = document.getElementById('savings-body');
    if (!savingsBody) return;

    const h = data.health_impact || {};
    if (h.is_eco_cleaner && h.saved_pm25_ug > 0) {
      savingsBody.innerHTML = `
        <span class="savings-highlight">🌟 Save ${h.saved_pm25_ug} µg PM2.5 (${h.saved_percent}% cleaner)</span> 
        by choosing the Clean Air route. Eliminates the particulate intake of <b>${h.avoided_cigarettes} cigarettes</b> 
        for only <b>${h.extra_time_str}</b> extra travel time.
      `;
    } else if (data.same_route) {
      savingsBody.innerHTML = `
        Single corridor available on the mapped road network (${h.similarity_percent ? h.similarity_percent + '% overlap' : '100% overlap'}). Air quality is <b>AQI ${data.shortest.avg_aqi} (${data.shortest.aqi_bucket})</b> with Grade <b>${data.shortest.grade || 'A'}</b>.
      `;
    } else if (data.is_shortest_cleanest) {
      savingsBody.innerHTML = `
        <span class="savings-highlight">✨ Shortest route is also the cleanest route; no detour required.</span><br/>
        <span style="font-size:11.5px;color:#cbd5e1;line-height:1.4">${h.verdict || 'Both corridors evaluated on the road network; taking an alternative route increases travel duration and total particulate intake.'}</span>
      `;
    } else {
      savingsBody.innerHTML = `
        Air quality is uniform across alternative paths (AQI ${data.shortest.avg_aqi}). Both routes offer satisfactory conditions.
      `;
    }
  }

  // ── Detail Card Update with Route Rationale ───
  function _updateDetailCard(route) {
    if (!route) return;
    const dEl     = document.getElementById('stat-dist');
    const durEl   = document.getElementById('stat-dur');
    const aqiEl   = document.getElementById('stat-aqi');
    const pmEl    = document.getElementById('stat-pm25');
    const badge   = document.getElementById('route-aqi-badge');
    const tagEl   = document.getElementById('route-rationale-tag');
    const textEl  = document.getElementById('route-rationale-text');

    if (dEl)   dEl.textContent   = route.distance_str || '—';
    if (durEl) durEl.textContent = route.duration_str || '—';
    if (aqiEl) {
      aqiEl.textContent = route.avg_aqi != null ? route.avg_aqi : '—';
      aqiEl.style.color = route.aqi_color || '#94a3b8';
    }
    if (pmEl) {
      pmEl.textContent = route.pm25_inhaled_ug != null ? `${route.pm25_inhaled_ug} µg` : '—';
      pmEl.style.color = '#38bdf8';
    }

    if (tagEl && textEl) {
      const typeLabel = route.route_label || (route.route_type ? route.route_type.toUpperCase() : 'ROUTE');
      tagEl.textContent = typeLabel;
      tagEl.style.background = route.color || '#3b82f6';
      textEl.textContent = route.selection_rationale || 'Road path calculated via OpenStreetMap.';
    }

    if (badge) {
      const cov = route.coverage_info ? ` (${route.coverage_info.coverage_percent}% coverage)` : '';
      const cpcb = route.cpcb_category ? ` · CPCB: ${route.cpcb_category}` : '';
      const epa = route.aqi_category || route.aqi_bucket || 'Standard';
      const gridNote = route.is_uniform_grid ? ' · 11 km grid' : '';
      badge.textContent   = `● EPA: ${epa}${cpcb} · Grade ${route.grade || 'A'}${cov}${gridNote}`;
      if (route.resolution_note) {
        badge.title = route.resolution_note;
      }
      badge.style.cssText = `
        background:${route.aqi_color || '#3b82f6'}1a;
        color:${route.aqi_color || '#38bdf8'};
        border:1px solid ${route.aqi_color || '#3b82f6'}55;
        border-radius:20px;
        padding:3px 10px;
        font-size:12px;
        font-weight:600;
        display:inline-flex;
      `;
    }
  }

  // ── Show Route Cards ──────────────────────────
  function _showRouteCards() {
    const cards   = document.getElementById('route-cards');
    const acPanel = document.getElementById('autocomplete-panel');
    const presets = document.getElementById('presets-section');
    const goBtn   = document.getElementById('go-btn');
    const btnText = document.getElementById('go-btn-text');

    if (cards)   cards.style.display   = 'block';
    if (acPanel) acPanel.style.display = 'none';
    if (presets) presets.style.display = 'none';

    if (goBtn) {
      goBtn.disabled = false;
      const modeName = _mode === 'bike' ? 'Cycling' : (_mode === 'driving' ? 'Driving' : 'Walking');
      if (btnText) btnText.textContent = `Start ${modeName} Navigation`;
    }

    if (cards) {
      cards.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (typeof BottomSheet !== 'undefined') {
      BottomSheet.snapTo('half');
    }
  }

  function resetRouteUI() {
    const cards   = document.getElementById('route-cards');
    const presets = document.getElementById('presets-section');
    if (cards)   cards.style.display   = 'none';
    if (presets) presets.style.display = 'block';
    _routeData = null;
    if (typeof BottomSheet !== 'undefined') {
      BottomSheet.snapTo('half');
    }
  }

  // ── Initialize Presets ────────────────────────
  function initPresets() {
    const container = document.getElementById('presets-row');
    if (!container || typeof CampusPresets === 'undefined') return;

    container.innerHTML = '';
    CampusPresets.getPresets().forEach(p => {
      const chip = document.createElement('button');
      chip.className = 'preset-chip';
      chip.textContent = p.name;
      chip.title = p.desc;
      chip.onclick = () => {
        if (typeof Utils !== 'undefined') Utils.haptic('medium');
        Geocoding.setOriginDirect(p.origin.lat, p.origin.lng, p.origin.name);
        Geocoding.setDestDirect(p.dest.lat, p.dest.lng, p.dest.name);
        findRoutes(p.origin, p.dest);
      };
      container.appendChild(chip);
    });
  }

  // ── Comparison Modal ──────────────────────────
  function openComparisonModal() {
    if (typeof Utils !== 'undefined') Utils.haptic('light');
    if (!_routeData) {
      Utils.toast('⚠️ Calculate a route first to view health comparison');
      return;
    }
    const modal = document.getElementById('compare-modal');
    const body  = document.getElementById('modal-comparison-content');
    if (!modal || !body) return;

    const s = _routeData.shortest;
    const e = _routeData.eco || _routeData.cleanest;
    const b = _routeData.balanced || e;
    const h = _routeData.health_impact || {};

    const provS = s.coverage_info ? `Providers: ${s.coverage_info.providers.join(', ') || 'Atmospheric Grid'}` : '';

    const alt = _routeData.alternative_corridor;
    let altCardHtml = '';
    if (alt) {
      altCardHtml = `
        <div style="margin-top:10px;padding:10px 14px;background:#1e293b66;border:1px dashed #64748b66;border-radius:10px;font-size:12px;color:#cbd5e1">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span style="font-weight:700;color:#94a3b8">⚪ Evaluated Road Alternative (${alt.distance_str} · ${alt.duration_str})</span>
            <span style="color:#f87171;font-size:11px">Not Recommended (Higher Exposure)</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;font-size:11px">
            <div>Avg AQI: <b style="color:${alt.aqi_color}">${alt.avg_aqi}</b></div>
            <div>Ambient PM2.5: <b>${alt.avg_pm25 != null ? alt.avg_pm25 + ' µg/m³' : '—'}</b></div>
            <div>Inhaled PM2.5: <b style="color:#f87171">${alt.pm25_inhaled_ug || 0} µg</b></div>
          </div>
          <div style="margin-top:4px;font-size:10.5px;color:#94a3b8">
            ${alt.selection_rationale || 'Detour corridor evaluated; increases inhalation exposure time without clean-air benefit.'}
          </div>
        </div>
      `;
    }

    let verdictText = '';
    if (h.is_eco_cleaner && h.saved_pm25_ug > 0) {
      verdictText = `By taking the Clean Air Route, you avoid inhaling <b>${h.saved_pm25_ug} µg of PM2.5</b> (${h.saved_percent}% cleaner) and eliminate <b>${h.avoided_cigarettes} cigarettes equivalent</b> of particulate intake for only <b>${h.extra_time_str}</b> of extra travel time.`;
    } else if (_routeData.same_route) {
      verdictText = `Single corridor available on the mapped road network (${h.similarity_percent ? h.similarity_percent + '% geometry overlap' : '100% overlap'}). All preferences follow this path.`;
    } else if (_routeData.is_shortest_cleanest) {
      verdictText = h.verdict || `Shortest route is also the cleanest route; no detour required. Taking an alternative road corridor increases travel duration and total particulate intake.`;
    } else {
      verdictText = `All evaluated routes offer satisfactory breathing conditions along this corridor.`;
    }

    body.innerHTML = `
      <div class="compare-grid">
        <div class="compare-col">
          <div class="col-header">
            <span>🔵 Shortest</span>
            <span class="grade-badge" style="background:#3b82f6">${s.grade || 'B'}</span>
          </div>
          <div class="col-metric-row"><span class="metric-lbl">Distance</span><span class="metric-val">${s.distance_str}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Duration</span><span class="metric-val">${s.duration_str}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Avg AQI</span><span class="metric-val" style="color:${s.aqi_color}">${s.avg_aqi}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">EPA Category</span><span class="metric-val">${s.aqi_category || s.aqi_bucket}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">CPCB Scale</span><span class="metric-val">${s.cpcb_category || 'Satisfactory'}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Inhaled PM2.5</span><span class="metric-val" style="color:#38bdf8">${s.pm25_inhaled_ug || 0} µg</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Added Time</span><span class="metric-val">0 min (Baseline)</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Exposure Delta</span><span class="metric-val">0 µg (Baseline)</span></div>
          <div style="font-size:10.5px;color:#94a3b8;margin-top:4px;line-height:1.3">${s.selection_rationale}</div>
        </div>

        <div class="compare-col highlight-eco">
          <div class="col-header">
            <span>🟢 Clean Air</span>
            <span class="grade-badge" style="background:#22c55e">${e.grade || 'A+'}</span>
          </div>
          <div class="col-metric-row"><span class="metric-lbl">Distance</span><span class="metric-val">${e.distance_str}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Duration</span><span class="metric-val">${e.duration_str}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Avg AQI</span><span class="metric-val" style="color:${e.aqi_color}">${e.avg_aqi}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">EPA Category</span><span class="metric-val">${e.aqi_category || e.aqi_bucket}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">CPCB Scale</span><span class="metric-val">${e.cpcb_category || 'Satisfactory'}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Inhaled PM2.5</span><span class="metric-val" style="color:#4ade80">${e.pm25_inhaled_ug || 0} µg</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Added Time</span><span class="metric-val">+${e.extra_time_str || '0 min'}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Exposure Delta</span><span class="metric-val" style="color:#4ade80">-${e.saved_pm25_ug || 0} µg (${e.saved_percent || 0}%)</span></div>
          <div style="font-size:10.5px;color:#94a3b8;margin-top:4px;line-height:1.3">${e.selection_rationale}</div>
        </div>

        <div class="compare-col highlight-balanced">
          <div class="col-header">
            <span>⚖️ Balanced</span>
            <span class="grade-badge" style="background:#06b6d4">${b.grade || 'A'}</span>
          </div>
          <div class="col-metric-row"><span class="metric-lbl">Distance</span><span class="metric-val">${b.distance_str}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Duration</span><span class="metric-val">${b.duration_str}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Avg AQI</span><span class="metric-val" style="color:${b.aqi_color}">${b.avg_aqi}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">EPA Category</span><span class="metric-val">${b.aqi_category || b.aqi_bucket}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">CPCB Scale</span><span class="metric-val">${b.cpcb_category || 'Satisfactory'}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Inhaled PM2.5</span><span class="metric-val" style="color:#06b6d4">${b.pm25_inhaled_ug || 0} µg</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Added Time</span><span class="metric-val">+${b.extra_time_str || '0 min'}</span></div>
          <div class="col-metric-row"><span class="metric-lbl">Exposure Delta</span><span class="metric-val" style="color:#06b6d4">-${b.saved_pm25_ug || 0} µg (${b.saved_percent || 0}%)</span></div>
          <div style="font-size:10.5px;color:#94a3b8;margin-top:4px;line-height:1.3">${b.selection_rationale}</div>
        </div>
      </div>

      ${altCardHtml}

      <div class="diff-summary-card">
        <b>🫁 Respiratory Health Verdict:</b><br/>
        ${verdictText}
        <div style="margin-top:6px;font-size:11px;color:#94a3b8">
          ${provS}
        </div>
      </div>

      <div class="modal-actions-row">
        <button class="modal-action-btn" onclick="Routing.downloadGeoJson()">
          📥 Download GeoJSON (GPS/Strava)
        </button>
        <button class="modal-action-btn" onclick="window.print()">
          🖨️ Print Summary
        </button>
      </div>
    `;

    modal.style.display = 'flex';
  }

  function closeComparisonModal(e) {
    if (e && e.target && e.target.id !== 'compare-modal' && !e.target.classList.contains('modal-close-btn')) {
      return;
    }
    const modal = document.getElementById('compare-modal');
    if (modal) modal.style.display = 'none';
  }

  // ── Share Clean Route Link ────────────────────
  function shareRoute() {
    const state = Geocoding.getState();
    if (!state.origin.coords || !state.dest.coords) {
      Utils.toast('⚠️ Calculate a route first before sharing');
      return;
    }

    const params = new URLSearchParams({
      olat: state.origin.coords.lat,
      olng: state.origin.coords.lng,
      oname: state.origin.name || 'Origin',
      dlat: state.dest.coords.lat,
      dlng: state.dest.coords.lng,
      dname: state.dest.name || 'Destination',
      mode: _mode,
      sens: _sensitivity
    });

    if (state.waypoints && state.waypoints.length > 0) {
      const validWps = state.waypoints.filter(w => w.coords).map(w => `${w.coords.lat},${w.coords.lng}`).join(';');
      if (validWps) params.set('wps', validWps);
    }

    const shareUrl = `${window.location.origin}${window.location.pathname}?${params.toString()}`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareUrl).then(() => {
        Utils.toast('📋 Eco-Route link copied! Share with friends');
      }).catch(() => {
        prompt('Copy clean route link:', shareUrl);
      });
    } else {
      prompt('Copy clean route link:', shareUrl);
    }
  }

  // ── Download GeoJSON File ─────────────────────
  async function downloadGeoJson() {
    const state = Geocoding.getState();
    if (!state.origin.coords || !state.dest.coords) return;

    try {
      Utils.toast('⏳ Preparing GeoJSON file…');
      const url = Config.ENDPOINTS.exportGeoJson(
        state.origin.coords.lat, state.origin.coords.lng,
        state.dest.coords.lat, state.dest.coords.lng,
        _mode, _sensitivity
      );
      const res = await fetch(url);
      if (!res.ok) throw new Error('Export service error');
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'eco_road_clean_path.geojson';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      Utils.toast('✅ GeoJSON exported! Ready for GIS/GPS');
    } catch (e) {
      console.error('Download error:', e);
      Utils.toast('❌ Could not export GeoJSON file');
    }
  }

  // ── Auto-Load Route from URL Parameters ───────
  function initFromUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const olat = parseFloat(params.get('olat'));
    const olng = parseFloat(params.get('olng'));
    const dlat = parseFloat(params.get('dlat'));
    const dlng = parseFloat(params.get('dlng'));

    if (!isNaN(olat) && !isNaN(olng) && !isNaN(dlat) && !isNaN(dlng)) {
      const oname = params.get('oname') || `${olat.toFixed(4)}, ${olng.toFixed(4)}`;
      const dname = params.get('dname') || `${dlat.toFixed(4)}, ${dlng.toFixed(4)}`;
      const mode = params.get('mode') || 'foot';
      const sens = params.get('sens') || 'standard';

      setMode(mode);
      if (sens === 'asthma') toggleSensitivity();

      Geocoding.setOriginDirect(olat, olng, oname);
      Geocoding.setDestDirect(dlat, dlng, dname);

      const wpsParam = params.get('wps');
      const parsedWps = [];
      if (wpsParam) {
        wpsParam.split(';').forEach(p => {
          const parts = p.split(',');
          if (parts.length === 2) {
            const wLat = parseFloat(parts[0]);
            const wLng = parseFloat(parts[1]);
            if (!isNaN(wLat) && !isNaN(wLng)) {
              Geocoding.addWaypointDirect(wLat, wLng, `${wLat.toFixed(4)}, ${wLng.toFixed(4)}`);
              parsedWps.push([wLat, wLng]);
            }
          }
        });
      }

      findRoutes({ lat: olat, lng: olng, name: oname }, { lat: dlat, lng: dlng, name: dname }, parsedWps);
      Utils.toast('🔗 Loaded shared route!');
    }
  }

  return {
    findRoutes,
    selectRoute,
    getActiveRoute: () => (_routeData ? _routeData[_activeRoute] : null),
    getActiveKey: () => _activeRoute,
    getRouteData: () => _routeData,
    hasActiveRoute: () => _routeData !== null,
    setMode,
    getMode,
    toggleSensitivity,
    initPresets,
    openComparisonModal,
    closeComparisonModal,
    shareRoute,
    downloadGeoJson,
    initFromUrlParams,
    resetRouteUI
  };
})();
