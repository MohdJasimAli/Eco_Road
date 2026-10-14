// ═══════════════════════════════════════════════
// Eco_Road — Full Turn-by-Turn GPS Navigation
// Google Maps Navigation HUD, Real GPS Following,
// Off-Route Rerouting, Voice Guidance & Arrival
// ═══════════════════════════════════════════════

const Navigation = (() => {

  const ANNOUNCE_DIST_M = 80;
  const ADVANCE_DIST_M  = 25;
  const OFF_ROUTE_DIST_M= 60;

  let _steps          = [];
  let _stepIndex      = 0;
  let _active         = false;
  let _muted          = false;
  let _route          = null;
  let _stepsOpen      = false;
  let _announcedSteps = new Set();
  let _userLat        = null;
  let _userLng        = null;
  let _currentHeading = 0;
  let _offRouteCount  = 0;
  let _isRerouting    = false;
  let _accumulatedDose= 0;
  let _lastHotspotId  = null;
  let _startTime      = 0;
  let _selectedRouteKey = 'eco';
  let _lastGpsTimestamp = 0;
  let _navAqiRequestId = 0;
  let _navCurrentAqi = null;
  let _navCurrentColor = null;
  let _navCurrentCat = null;
  let _navCurrentStation = null;
  let _navCurrentDataType = null;
  let _navCurrentGrid = null;
  let _navCurrentSource = null;
  let _navCurrentTimestamp = null;
  let _navIsUnavailable = false;
  let _navLastFetchLat = null;
  let _navLastFetchLng = null;
  let _navLastFetchTime = 0;

  // Walk simulator state (demo tool)
  let _simTimer       = null;
  let _simIndex       = 0;
  let _simCoords      = [];
  let _isSimulating   = false;
  let _simSpeed       = 1;

  // ── Ventilation Rate (m³/min) by Travel Mode & Sensitivity Profile ──
  function _getVentilationRate(mode, sensitivity) {
    const s = (sensitivity || 'standard').toLowerCase();
    const m = (mode || 'foot').toLowerCase();
    const rates = {
      athlete: { foot: 0.016, bike: 0.035, driving: 0.008 },
      child:   { foot: 0.008, bike: 0.015, driving: 0.008 },
      elderly: { foot: 0.010, bike: 0.018, driving: 0.008 },
      asthma:  { foot: 0.012, bike: 0.025, driving: 0.008 },
      standard:{ foot: 0.012, bike: 0.025, driving: 0.008 }
    };
    const prof = rates[s] || rates.standard;
    return prof[m] || (m === 'bike' ? 0.025 : (m === 'driving' ? 0.008 : 0.012));
  }

  // ── Find Active Segment along Route ──────────────────────────────────
  function _findActiveSegment(lat, lng) {
    if (!lat || !lng || !_route || !_route.colored_segments || _route.colored_segments.length === 0) {
      return null;
    }
    let bestSeg = null;
    let minDist = Infinity;
    for (const seg of _route.colored_segments) {
      const coords = seg.coordinates || seg.coords;
      if (!coords || coords.length < 2) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        const p1 = { lat: coords[i][0], lng: coords[i][1] };
        const p2 = { lat: coords[i+1][0], lng: coords[i+1][1] };
        const d = _distToSegment({ lat, lng }, p1, p2);
        if (d < minDist) {
          minDist = d;
          bestSeg = seg;
        }
      }
    }
    return bestSeg;
  }

  const _synth = window.speechSynthesis;

  // ── Calculate Bearing between two GPS points ─
  function _calculateBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const y  = Math.sin(Δλ) * Math.cos(φ2);
    const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ  = Math.atan2(y, x);
    return (θ * 180 / Math.PI + 360) % 360;
  }

  function _haversine(lat1, lng1, lat2, lng2) {
    if (!lat2 || !lng2) return Infinity;
    const R  = 6371000;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;
    const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Distance to Route Geometry ──────────────
  function _distanceToRoute(lat, lng, geomCoords) {
    if (!geomCoords || geomCoords.length < 2) return 0;
    let minD = Infinity;
    // geomCoords are [lng, lat]
    for (let i = 0; i < geomCoords.length - 1; i++) {
      const p1 = { lat: geomCoords[i][1], lng: geomCoords[i][0] };
      const p2 = { lat: geomCoords[i+1][1], lng: geomCoords[i+1][0] };
      const d = _distToSegment({ lat, lng }, p1, p2);
      if (d < minD) minD = d;
    }
    return minD;
  }

  function _distToSegment(p, v, w) {
    const l2 = (w.lat - v.lat)**2 + (w.lng - v.lng)**2;
    if (l2 === 0) return _haversine(p.lat, p.lng, v.lat, v.lng);
    let t = ((p.lat - v.lat) * (w.lat - v.lat) + (p.lng - v.lng) * (w.lng - v.lng)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projLat = v.lat + t * (w.lat - v.lat);
    const projLng = v.lng + t * (w.lng - v.lng);
    return _haversine(p.lat, p.lng, projLat, projLng);
  }

  // ── Start Live Navigation ───────────────────
  function start() {
    _startNavigation(false, 1);
  }

  // ── Start Walk Simulator (Demo Tool) ────────
  function startSimulation(speedMultiplier = 1) {
    _startNavigation(true, speedMultiplier);
  }

  function _startNavigation(isSim, speed) {
    _selectedRouteKey = Routing.getActiveKey() || 'eco';
    _route          = Routing.getActiveRoute();

    if (!_route) {
      Utils.toast('⚠️ Please select origin and destination to calculate a route first.');
      const dInput = document.getElementById('dest-input');
      if (dInput) dInput.focus();
      return;
    }
    if (!_route.steps || _route.steps.length === 0) {
      Utils.toast('⚠️ No turn-by-turn maneuvers found for this route. Please check route endpoints.');
      return;
    }

    _steps          = _route.steps;
    _stepIndex      = 0;
    _active         = true;
    _stepsOpen      = false;
    _announcedSteps = new Set();
    _isSimulating   = isSim;
    _simSpeed       = speed;
    _accumulatedDose= 0;
    _lastHotspotId  = null;
    _offRouteCount  = 0;
    _isRerouting    = false;
    _startTime      = Date.now();
    _lastGpsTimestamp = 0;
    _navAqiRequestId++;
    _navCurrentAqi = null;
    _navCurrentColor = null;
    _navCurrentCat = null;
    _navCurrentStation = null;
    _navCurrentDataType = null;
    _navCurrentGrid = null;
    _navCurrentSource = null;
    _navCurrentTimestamp = null;
    _navIsUnavailable = false;
    _navLastFetchLat = null;
    _navLastFetchLng = null;
    _navLastFetchTime = 0;

    // Determine initial navigation coordinates based on mode (sim vs live GPS)
    const rawCoords = _route.geometry ? (_route.geometry.coordinates || []) : [];
    if (isSim) {
      if (rawCoords.length > 0) {
        _userLat = rawCoords[0][1];
        _userLng = rawCoords[0][0];
      }
    } else {
      const realCoord = (typeof MapManager !== 'undefined' && MapManager.getUserCoord) ? MapManager.getUserCoord() : null;
      if (realCoord && realCoord.lat && realCoord.lng) {
        _userLat = realCoord.lat;
        _userLng = realCoord.lng;
      } else if (rawCoords.length > 0) {
        _userLat = rawCoords[0][1];
        _userLng = rawCoords[0][0];
      }
    }

    // Show Google Maps navigation overlay
    const overlay = document.getElementById('nav-overlay');
    if (overlay) overlay.style.display = 'block';

    // Hide search sheet
    const sheet = document.getElementById('search-sheet');
    if (sheet) sheet.classList.add('sheet-hidden');

    const activeSeg = _findActiveSegment(_userLat, _userLng);
    if (activeSeg && activeSeg.aqi != null) {
      _navCurrentAqi = activeSeg.aqi;
      _navCurrentColor = activeSeg.color;
      _navCurrentCat = activeSeg.category || activeSeg.bucket || '';
      _navCurrentStation = activeSeg.station || null;
      _navCurrentDataType = activeSeg.data_type || 'modeled';
      _navCurrentGrid = activeSeg.grid_coordinates || null;
      _navCurrentSource = activeSeg.source || null;
      _navCurrentTimestamp = activeSeg.source_timestamp || null;
    }

    _updateHUD(activeSeg);
    _buildStepsList();
    _renderStep(0);

    // Initial position live AQI check
    if (_userLat != null && _userLng != null) {
      _triggerNavAqiFetch(_userLat, _userLng, isSim);
    }

    // Initial camera focus on start coordinate
    if (_route.geometry && _route.geometry.coordinates && _route.geometry.coordinates.length > 0) {
      const c0 = _route.geometry.coordinates[0];
      MapManager.panTo(c0[1], c0[0], 17);
    }

    const modeRaw = _route.travel_mode || Routing.getMode();
    const modeName = modeRaw === 'bike' ? 'cycling' : (modeRaw === 'driving' ? 'driving' : 'walking');
    _speak(`Starting ${modeName} navigation. ${_steps[0].instruction}`);

    if (typeof MapManager !== 'undefined' && MapManager.setFollowing) {
      MapManager.setFollowing(true);
    }

    if (_isSimulating) {
      _runSimulator();
      Utils.toast(`🎮 Simulation running (${_simSpeed}x speed)`);
    } else {
      if (!navigator.geolocation) {
        Utils.toast('⚠️ Real GPS not supported in this browser. Running Demo Walk instead…', 4000);
        _isSimulating = true;
        _runSimulator();
        return;
      }

      MapManager.startGPSWatch(_onGPS, (err) => {
        if (err.code === 1) { // PERMISSION_DENIED
          Utils.toast('⚠️ Location access denied. Please allow GPS permission or tap "Demo Walk" to simulate trip.', 6000);
        } else if (err.code === 2) { // POSITION_UNAVAILABLE
          Utils.toast('⚠️ GPS signal searching… Waiting for satellite lock.', 4000);
        } else if (err.code === 3) { // TIMEOUT
          Utils.toast('⚠️ GPS request timed out. Retrying…', 3000);
        }
      });
      Utils.toast('🧭 Live GPS Navigation active — map follows your movement');
    }
  }

  // ── Simulator Runner ────────────────────────
  function _runSimulator() {
    _clearSimulator();
    const rawCoords = _route.geometry.coordinates || [];
    if (rawCoords.length < 2) return;

    _simCoords = rawCoords.map(c => ({ lat: c[1], lng: c[0] }));
    _simIndex  = 0;

    const intervalMs = Math.max(120, Math.round(500 / _simSpeed));

    _simTimer = setInterval(() => {
      if (!_active || _simIndex >= _simCoords.length) {
        _advanceToEnd();
        return;
      }

      const curr = _simCoords[_simIndex];
      const next = _simCoords[Math.min(_simIndex + 1, _simCoords.length - 1)];
      const heading = _calculateBearing(curr.lat, curr.lng, next.lat, next.lng);

      _userLat = curr.lat;
      _userLng = curr.lng;
      _currentHeading = heading;
      MapManager.updateCompassHeading(heading);

      MapManager.updateUserDot(curr.lat, curr.lng, heading, 5);
      if (MapManager.isFollowing()) {
        MapManager.panTo(curr.lat, curr.lng, 17);
      }

      _onGPS({ lat: curr.lat, lng: curr.lng, heading: heading, accuracy: 5 });

      // Live Inhaled Mass increment using active segment PM2.5 and profile ventilation rate
      const activeSeg = _findActiveSegment(curr.lat, curr.lng);
      const pm25Val = (activeSeg && activeSeg.pm25 != null) ? activeSeg.pm25 : (_route.avg_pm25 || 25.0);
      const vE = _getVentilationRate(_route.travel_mode || Routing.getMode(), _route.sensitivity);
      const dtMin = (intervalMs / 1000 / 60) * _simSpeed;
      _accumulatedDose += (pm25Val * dtMin * vE);

      _triggerNavAqiFetch(curr.lat, curr.lng, true);
      _updateHUD(activeSeg);

      _simIndex++;
    }, intervalMs);
  }

  function _clearSimulator() {
    if (_simTimer) {
      clearInterval(_simTimer);
      _simTimer = null;
    }
  }

  // ── Stop Navigation ─────────────────────────
  function stop() {
    _active = false;
    _clearSimulator();
    _navAqiRequestId++;
    _navCurrentAqi = null;
    _navCurrentColor = null;
    _navCurrentCat = null;
    _navCurrentStation = null;
    _navCurrentDataType = null;
    _navCurrentGrid = null;
    _navCurrentSource = null;
    _navCurrentTimestamp = null;
    _navIsUnavailable = false;
    _navLastFetchLat = null;
    _navLastFetchLng = null;
    _navLastFetchTime = 0;
    if (typeof MapManager !== 'undefined') {
      if (MapManager.clearNavCallback) {
        MapManager.clearNavCallback();
      } else {
        MapManager.stopGPSWatch();
      }
      MapManager.clearTurnMarker();

      // If we were simulating, restore the user's real GPS position marker if available
      if (_isSimulating && MapManager.getUserCoord) {
        const realCoord = MapManager.getUserCoord();
        if (realCoord) {
          MapManager.updateUserDot(
            realCoord.lat,
            realCoord.lng,
            MapManager.getUserHeading ? MapManager.getUserHeading() : 0,
            MapManager.getUserAccuracy ? MapManager.getUserAccuracy() : 15
          );
        }
      }
    }
    _isSimulating = false;
    if (_synth) _synth.cancel();

    const overlay = document.getElementById('nav-overlay');
    if (overlay) overlay.style.display = 'none';

    const alertBanner = document.getElementById('nav-hotspot-alert');
    if (alertBanner) alertBanner.style.display = 'none';

    const sheet = document.getElementById('search-sheet');
    if (sheet) {
      sheet.classList.remove('sheet-hidden');
      if (typeof BottomSheet !== 'undefined') {
        BottomSheet.snapTo('half');
      }
    }

    const recentreBtn = document.getElementById('recentre-btn');
    if (recentreBtn) recentreBtn.classList.remove('visible');

    Utils.toast('Navigation ended');
  }

  // ── GPS / Position Tracking ─────────────────
  function _onGPS({ lat, lng, heading, accuracy }) {
    if (!_active) return;
    _userLat = lat;
    _userLng = lng;
    if (heading != null) _currentHeading = heading;

    const step = _steps[_stepIndex];
    if (!step) return;

    // Check distance to next maneuver step
    const distToTurn = _haversine(lat, lng, step.lat, step.lng);
    _setDistBadge(distToTurn);

    // Pulse marker at upcoming intersection
    if (step.lat && step.lng) {
      MapManager.setTurnMarker(step.lat, step.lng);
    }

    // Voice announcement when approaching turn
    if (distToTurn < ANNOUNCE_DIST_M && !_announcedSteps.has(_stepIndex)) {
      _announcedSteps.add(_stepIndex);
      const distLabel = distToTurn < 35 ? 'In a few metres' : `In ${Math.round(distToTurn / 10) * 10} metres`;
      if (typeof AudioEngine !== 'undefined') AudioEngine.playTurnChime();
      if (typeof Utils !== 'undefined') Utils.haptic('medium');
      _speak(`${distLabel}, ${step.instruction}`);
    }

    // Advance to next maneuver when past turn
    if (distToTurn < ADVANCE_DIST_M) {
      _advance();
    }

    // Off-route detection (ignore if low accuracy or currently rerouting)
    if (!_isRerouting && (!_isSimulating ? accuracy < 35 : true)) {
      const devDist = _distanceToRoute(lat, lng, _route.geometry.coordinates);
      if (devDist > OFF_ROUTE_DIST_M) {
        _offRouteCount++;
        if (_offRouteCount >= 2) {
          _triggerReroute(lat, lng);
        }
      } else {
        _offRouteCount = 0;
      }
    }

    // Check localized environmental hotspot proximity
    if (typeof CampusPresets !== 'undefined') {
      const prox = CampusPresets.checkProximityToHotspot(lat, lng);
      const alertBanner = document.getElementById('nav-hotspot-alert');
      const alertText   = document.getElementById('nav-hotspot-text');

      if (prox.inHotspot) {
        if (alertBanner) alertBanner.style.display = 'flex';
        if (alertText) alertText.textContent = `⚠️ Corridor Advisory: ${prox.spot.name} (Historical baseline)`;
        if (_lastHotspotId !== prox.spot.name) {
          _lastHotspotId = prox.spot.name;
          if (typeof AudioEngine !== 'undefined') AudioEngine.playWarningChime();
          _speak(`Caution: Entering known high-emission corridor near ${prox.spot.name}. Mask recommended.`);
        }
      } else {
        if (alertBanner) alertBanner.style.display = 'none';
      }
    }

    // Dynamic route segment detection
    const activeSeg = _findActiveSegment(lat, lng);

    // Inhaled particulate accumulation during real GPS movement
    const now = Date.now();
    if (_lastGpsTimestamp && !_isSimulating) {
      const dtMin = Math.min(2.0, (now - _lastGpsTimestamp) / 60000.0);
      const pm25Val = (activeSeg && activeSeg.pm25 != null) ? activeSeg.pm25 : (_route.avg_pm25 || 25.0);
      const vE = _getVentilationRate(_route.travel_mode || Routing.getMode(), _route.sensitivity);
      _accumulatedDose += (pm25Val * dtMin * vE);
      const doseEl = document.getElementById('hud-live-dose');
      if (doseEl) {
        doseEl.textContent = `Inhaled PM2.5: ${_accumulatedDose.toFixed(2)} µg`;
        doseEl.title = 'Estimated Inhaled PM2.5 Mass (not absorbed lung dose)';
      }
    }
    _lastGpsTimestamp = now;

    // During live GPS mode, trigger location-based AQI refresh and HUD update
    if (!_isSimulating) {
      _triggerNavAqiFetch(lat, lng, false);
      _updateHUD(activeSeg);
    }
  }

  // ── Automatic Off-Route Rerouting ───────────
  async function _triggerReroute(lat, lng) {
    if (_isRerouting) return;
    _isRerouting = true;
    _offRouteCount = 0;

    Utils.toast('🔄 Route deviation detected — calculating new route…');
    _speak('Off route. Recalculating path to destination.');

    const state = Geocoding.getState();
    const dest = state.dest.coords;
    if (!dest) {
      _isRerouting = false;
      return;
    }

    try {
      const mode = _route.travel_mode || 'foot';
      const sens = _route.sensitivity || 'standard';
      const res = await fetch(Config.ENDPOINTS.route(lat, lng, dest.lat, dest.lng, mode, sens));
      if (!res.ok) throw new Error('Reroute engine error');
      const data = await res.json();

      const targetKey = _selectedRouteKey || 'eco';
      _route = data[targetKey] || data.eco || data.shortest;
      _steps = _route.steps;
      _stepIndex = 0;
      _announcedSteps = new Set();

      MapManager.drawRoutes(data);
      MapManager.highlightRoute(targetKey);

      _updateHUD();
      _buildStepsList();
      _renderStep(0);

      _speak(`New route found. ${_steps[0].instruction}`);
      Utils.toast('✅ Reroute complete');
    } catch (e) {
      console.warn('Rerouting error:', e);
      Utils.toast('⚠️ Could not recalculate route. Please check connection.');
    } finally {
      _isRerouting = false;
    }
  }

  function _advance() {
    if (_stepIndex + 1 < _steps.length) {
      _stepIndex++;
      _renderStep(_stepIndex);
      _speak(_steps[_stepIndex].instruction);
    } else {
      _advanceToEnd();
    }
  }

  function _advanceToEnd() {
    if (typeof AudioEngine !== 'undefined') AudioEngine.playArrivalChime();
    if (typeof Utils !== 'undefined') Utils.haptic('success');
    _speak('You have arrived at your destination. Clean air journey complete.');
    MapManager.clearTurnMarker();
    Utils.toast('🏁 Destination Reached!');
    setTimeout(stop, 4500);
  }

  // ── Render Step in HUD ──────────────────────
  function _renderStep(idx) {
    const step = _steps[idx];
    const next = _steps[idx + 1];
    if (!step) return;

    const icon = Utils.maneuverIcon(step.type, step.modifier);

    const iconEl   = document.getElementById('nav-maneuver-icon');
    const instrEl  = document.getElementById('nav-instruction-text');
    const roadEl   = document.getElementById('nav-road-bar');
    const thenEl   = document.getElementById('nav-then-bar');
    const distEl   = document.getElementById('nav-dist-badge');

    if (iconEl)  iconEl.textContent  = icon;
    if (instrEl) instrEl.textContent = step.instruction;
    if (roadEl)  roadEl.textContent  = step.road ? `along ${step.road}` : 'Path';
    if (distEl)  distEl.textContent  = step.distance_str;

    if (thenEl) {
      if (next) {
        const nextIcon = Utils.maneuverIcon(next.type, next.modifier);
        thenEl.textContent = `Then  ${nextIcon}  ${next.instruction}`;
      } else {
        thenEl.textContent = 'Then arrive at destination';
      }
    }

    const fill = document.getElementById('nav-progress-fill');
    if (fill) fill.style.width = `${((idx + 1) / _steps.length) * 100}%`;

    const items = document.querySelectorAll('.nav-step-item');
    items.forEach((item, i) => {
      item.classList.toggle('active', i === idx);
      const iconBox = item.querySelector('.step-icon');
      if (iconBox) iconBox.classList.toggle('active-icon', i === idx);
    });
  }

  function _setDistBadge(m) {
    const el = document.getElementById('nav-dist-badge');
    if (!el) return;
    el.textContent = m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  }

  // ── Update HUD Indicators ───────────────────
  function _updateHUD(activeSeg) {
    if (!_route) return;
    const durBig   = document.getElementById('hud-duration-big');
    const distEl   = document.getElementById('hud-dist');
    const etaEl    = document.getElementById('hud-eta');
    const aqiEl    = document.getElementById('hud-aqi');
    const bucketEl = document.getElementById('hud-aqi-bucket');
    const modeEl   = document.getElementById('hud-mode-indicator');
    const doseEl   = document.getElementById('hud-live-dose');

    if (durBig) durBig.textContent = _route.duration_str;
    if (distEl) distEl.textContent = _route.distance_str;

    const eta = new Date(Date.now() + _route.duration * 1000);
    const etaStr = eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (etaEl) etaEl.textContent = etaStr;

    if (modeEl) {
      const mode = _route.travel_mode || Routing.getMode() || 'foot';
      const modeIcon = mode === 'bike' ? '🚲 Cycling' : (mode === 'driving' ? '🚗 Driving' : '🚶 Walking');
      const routeBadge = _route.route_type === 'eco' ? '🟢 Clean Air' : '🔵 Shortest';
      modeEl.textContent = `${modeIcon} · ${routeBadge}`;
    }

    // Determine instantaneous navigation AQI without overwriting route-level metrics
    let currentAqi = null;
    let currentColor = null;
    let currentCat = null;
    let currentStation = null;
    let currentDataType = null;

    if (_navCurrentAqi != null) {
      currentAqi = _navCurrentAqi;
      currentColor = _navCurrentColor;
      currentCat = _navCurrentCat;
      currentStation = _navCurrentStation;
      currentDataType = _navCurrentDataType;
    } else if (activeSeg && activeSeg.aqi != null && !_navIsUnavailable) {
      currentAqi = activeSeg.aqi;
      currentColor = activeSeg.color || _route.aqi_color;
      currentCat = activeSeg.category || activeSeg.bucket || _route.aqi_category || _route.aqi_bucket;
      currentStation = activeSeg.station || null;
      currentDataType = activeSeg.data_type || 'modeled';
    }

    if (aqiEl) {
      if (currentAqi != null) {
        aqiEl.textContent = `AQI ${Math.round(currentAqi)}`;
        aqiEl.style.color = currentColor || _route.aqi_color;
      } else {
        aqiEl.textContent = 'AQI —';
        aqiEl.style.color = '#94a3b8';
      }
    }

    if (bucketEl) {
      if (currentAqi != null) {
        if (currentDataType === 'observed' && currentStation) {
          bucketEl.textContent = `${currentCat} · ${currentStation} · Route Avg: ${Math.round(_route.avg_aqi)}`;
          bucketEl.title = `Physical ground station observation: ${currentStation}. Local AQI: ${Math.round(currentAqi)} · Whole route average: ${Math.round(_route.avg_aqi)}`;
        } else if (_route.is_uniform_grid) {
          bucketEl.textContent = `${currentCat} · Regional Avg: ${Math.round(_route.avg_aqi)}`;
          bucketEl.title = 'Regional atmospheric model estimate (~11 km grid resolution). Street-level microclimate variation cannot be distinguished from available coarse grid data.';
        } else {
          bucketEl.textContent = `${currentCat} · Route Avg: ${Math.round(_route.avg_aqi)}`;
          bucketEl.title = `Local segment AQI ${Math.round(currentAqi)} · Overall route average ${Math.round(_route.avg_aqi)}`;
        }
        bucketEl.style.color = currentColor || _route.aqi_color;
      } else {
        bucketEl.textContent = `Unavailable · Route Avg: ${Math.round(_route.avg_aqi)}`;
        bucketEl.title = `Air quality observation unavailable for current position. Route-level average is ${Math.round(_route.avg_aqi)}.`;
        bucketEl.style.color = '#94a3b8';
      }
    }

    if (doseEl) {
      doseEl.textContent = `Inhaled PM2.5: ${_accumulatedDose.toFixed(2)} µg`;
      doseEl.title = 'Estimated Inhaled PM2.5 Mass (not absorbed lung dose)';
    }
  }

  // ── Throttled Live AQI Fetch Pipeline for Navigation ─────────
  function _triggerNavAqiFetch(lat, lng, isSim) {
    if (!_active || lat == null || lng == null) return;
    const now = Date.now();
    const dist = (_navLastFetchLat != null && _navLastFetchLng != null)
      ? _haversine(lat, lng, _navLastFetchLat, _navLastFetchLng)
      : Infinity;
    const elapsedMs = now - _navLastFetchTime;

    let shouldFetch = false;
    if (_navLastFetchLat == null) {
      shouldFetch = true;
    } else if (isSim) {
      // In demo simulation: trigger if moved > 250m AND at least 1500ms elapsed since last request
      if (dist > 250 && elapsedMs >= 1500) {
        shouldFetch = true;
      } else if (elapsedMs > 60000) {
        shouldFetch = true;
      }
    } else {
      // In live GPS: trigger if moved > 250m OR elapsed > 60s
      if (dist > 250 || elapsedMs > 60000) {
        shouldFetch = true;
      }
    }

    if (!shouldFetch) return;

    _navLastFetchLat = lat;
    _navLastFetchLng = lng;
    _navLastFetchTime = now;
    const reqId = ++_navAqiRequestId;

    _fetchNavPositionAQI(lat, lng, reqId);
  }

  async function _fetchNavPositionAQI(lat, lng, reqId) {
    try {
      const res = await fetch(Config.ENDPOINTS.liveAqi(lat, lng));
      if (!_active || reqId !== _navAqiRequestId) return;
      if (!res.ok) {
        if (_navCurrentAqi == null) _navIsUnavailable = true;
        return;
      }
      const data = await res.json();
      if (!_active || reqId !== _navAqiRequestId) return;

      if (data && data.aqi != null) {
        _navCurrentAqi       = data.aqi;
        _navCurrentColor     = data.aqi_color || (typeof Utils !== 'undefined' && Utils.aqiColor ? Utils.aqiColor(data.aqi) : '#94a3b8');
        _navCurrentCat       = data.aqi_category || data.aqi_bucket || '';
        _navCurrentStation   = data.station || null;
        _navCurrentDataType  = data.data_type || 'modeled';
        _navCurrentGrid      = data.grid_coordinates || null;
        _navCurrentSource    = data.source || null;
        _navCurrentTimestamp = data.source_timestamp || data.timestamp || null;
        _navIsUnavailable    = false;

        const activeSeg = _findActiveSegment(lat, lng);
        if (activeSeg) {
          activeSeg.aqi = data.aqi;
          if (data.pm25 != null) activeSeg.pm25 = data.pm25;
          activeSeg.color = _navCurrentColor;
          activeSeg.category = _navCurrentCat;
          activeSeg.station = _navCurrentStation;
          activeSeg.data_type = _navCurrentDataType;
          activeSeg.grid_coordinates = _navCurrentGrid;
        }
      } else {
        if (_navCurrentAqi == null) {
          _navIsUnavailable = true;
        }
      }
    } catch (_) {
      if (!_active || reqId !== _navAqiRequestId) return;
      if (_navCurrentAqi == null) {
        _navIsUnavailable = true;
      }
    } finally {
      if (_active && reqId === _navAqiRequestId) {
        const seg = _findActiveSegment(_userLat, _userLng);
        _updateHUD(seg);
      }
    }
  }

  // ── Switch Route Live (Toggle between Shortest & Clean Air)
  function switchRouteLive() {
    const currentKey = Routing.getActiveKey();
    const newKey     = (currentKey === 'shortest') ? 'eco' : 'shortest';
    _selectedRouteKey = newKey;
    Routing.selectRoute(newKey);
    _route     = Routing.getActiveRoute();
    _steps     = _route.steps;
    _stepIndex = 0;
    _announcedSteps = new Set();

    _updateHUD();
    _buildStepsList();
    _renderStep(0);
    _speak(`Switched to ${_route.route_type === 'eco' ? 'Clean Air Eco' : 'Shortest'} path.`);
    Utils.toast(`Switched to ${_route.route_type === 'eco' ? '🟢 Eco Route' : '🔵 Shortest Route'}`);
  }

  // ── Build Steps List (Pull-up Sheet) ────────
  function _buildStepsList() {
    const list = document.getElementById('nav-steps-list');
    if (!list) return;
    list.innerHTML = '';

    _steps.forEach((step, i) => {
      const icon = Utils.maneuverIcon(step.type, step.modifier);
      const div  = document.createElement('div');
      div.className = 'nav-step-item' + (i === 0 ? ' active' : '');
      div.innerHTML = `
        <div class="step-icon${i === 0 ? ' active-icon' : ''}">${icon}</div>
        <div class="step-text">${step.instruction}</div>
        <div class="step-dist">${step.distance_str}</div>`;
      div.addEventListener('click', () => {
        _stepIndex = i;
        _renderStep(i);
        _speak(step.instruction);
        if (step.lat && step.lng) {
          MapManager.panTo(step.lat, step.lng, 17);
        }
      });
      list.appendChild(div);
    });
  }

  // ── Voice Guidance (Web Speech API) ─────────
  function _speak(text) {
    if (!_synth || _muted || !text) return;
    try {
      _synth.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang  = 'en-US';
      utt.rate  = 0.95;
      utt.pitch = 1.0;
      const btn = document.getElementById('nav-voice-btn');
      utt.onstart = () => btn?.classList.add('speaking');
      utt.onend   = () => btn?.classList.remove('speaking');
      _synth.speak(utt);
    } catch (_) {}
  }

  function toggleMute() {
    _muted = !_muted;
    if (typeof AudioEngine !== 'undefined') AudioEngine.setMuted(_muted);
    const btn = document.getElementById('nav-voice-btn');
    if (btn) {
      btn.textContent = _muted ? '🔇' : '🔊';
      btn.classList.toggle('muted', _muted);
    }
    if (_muted) {
      _synth?.cancel();
    } else if (_steps[_stepIndex]) {
      _speak(_steps[_stepIndex].instruction);
    }
    Utils.toast(_muted ? 'Voice guidance muted' : 'Voice guidance enabled');
  }

  function toggleSteps() {
    _stepsOpen = !_stepsOpen;
    const panel = document.getElementById('nav-steps-panel');
    if (panel) panel.classList.toggle('open', _stepsOpen);
  }

  function recentreOnUser() {
    MapManager.recentre();
  }

  // ── Apply Clean Detour around Hotspot ───────
  async function applyCleanDetour() {
    if (!_active || !_userLat || !_userLng) {
      Utils.toast('⚠️ Navigation is not active');
      return;
    }
    const state = Geocoding.getState();
    const dest = state.dest.coords || (_route.steps && _route.steps[_route.steps.length - 1]);
    if (!dest) return;

    Utils.toast('🌿 Computing clean detour around hotspot…');
    const alertBanner = document.getElementById('nav-hotspot-alert');
    if (alertBanner) alertBanner.style.display = 'none';

    try {
      const avoidLat = _userLat + 0.002;
      const avoidLng = _userLng + 0.002;
      const url = Config.ENDPOINTS.detour(
        _userLat, _userLng, dest.lat, dest.lng,
        avoidLat, avoidLng, Routing.getMode()
      );
      const res = await fetch(url);
      if (!res.ok) throw new Error('Detour request failed');
      const detourData = await res.json();

      _speak('Rerouting via clean corridor to bypass pollution hotspot.');
      Utils.toast('🌿 Clean detour active');

      if (detourData.steps && detourData.steps.length > 0) {
        _steps = detourData.steps;
        _stepIndex = 0;
        _announcedSteps = new Set();
        _route.steps = _steps;
      }
      if (detourData.geometry) {
        _route.geometry = detourData.geometry;
      }

      _updateHUD();
      _buildStepsList();
      _renderStep(0);

      if (_isSimulating && detourData.geometry && detourData.geometry.coordinates) {
        _simCoords = detourData.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
        _simIndex = 0;
      }
    } catch (e) {
      console.error('Detour error:', e);
      Utils.toast('Continuing on clean path');
    }
  }

  return {
    start,
    startSimulation,
    stop,
    toggleMute,
    toggleSteps,
    recentreOnUser,
    switchRouteLive,
    applyCleanDetour,
    isActive: () => _active,
    getCurrentNavAqi: () => _navCurrentAqi,
    getCurrentNavProvenance: () => ({
      station: _navCurrentStation,
      data_type: _navCurrentDataType,
      grid: _navCurrentGrid,
      source: _navCurrentSource,
      is_unavailable: _navIsUnavailable
    }),
    getNavAqiRequestId: () => _navAqiRequestId,
    getLastFetchCoord: () => (_navLastFetchLat != null ? { lat: _navLastFetchLat, lng: _navLastFetchLng } : null),
  };
})();
