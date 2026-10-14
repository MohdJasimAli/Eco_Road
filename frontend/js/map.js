// ═══════════════════════════════════════════════
// Eco_Road — Map Manager (Leaflet GIS Engine)
// Full-Screen Navigation Map, Live Blue GPS Marker,
// Map-Click Destinations & AQI Overlays
// ═══════════════════════════════════════════════

const MapManager = (() => {

  let _map            = null;
  let _currentTileKey = 'osm';
  let _tileLayer      = null;
  let _layers         = {};
  let _markers        = {};
  let _waypointMarkers= [];
  let _tempClickMarker= null;
  let _following          = true;
  let _hasInitialCentered = false;
  let _userInteracted     = false;
  let _watchId            = null;
  let _navGpsCallback     = null;
  let _navErrorCallback   = null;
  let _userLastCoord      = null;
  let _userLastHeading    = 0;
  let _userLastAccuracy   = 15;
  let _gpsPermissionDenied= false;
  let _aqiLayerVisible    = true;

  // ── Initialize Map ──────────────────────────
  function init() {
    _map = L.map('map', {
      center:             Config.MAP.defaultCenter,
      zoom:               Config.MAP.defaultZoom,
      zoomControl:        false,
      attributionControl: true,
      fadeAnimation:      true,
      markerZoomAnimation:true
    });

    // Custom pane for user marker so it's always above polylines and overlays
    if (!_map.getPane('userLocationPane')) {
      const userPane = _map.createPane('userLocationPane');
      userPane.style.zIndex = '650';
    }

    // Basemap tile layer
    const t = Config.MAP.tileLayers[_currentTileKey] || Config.MAP.tileLayers.osm;
    _tileLayer = L.tileLayer(t.url, {
      attribution: t.attrib,
      maxZoom: t.maxZoom || 19,
      crossOrigin: true
    }).addTo(_map);

    // Zoom controls at bottom-right
    L.control.zoom({ position: 'bottomright' }).addTo(_map);

    // Layer groups for z-index layering
    _layers.hotspots      = L.featureGroup().addTo(_map);
    _layers.altRoutes     = L.featureGroup().addTo(_map);
    _layers.activeRoute   = L.featureGroup().addTo(_map);
    _layers.segmentedLine = L.featureGroup().addTo(_map);
    _layers.aqiStations   = L.featureGroup().addTo(_map);
    _layers.navTurnMarker = L.featureGroup().addTo(_map);

    // Draw campus hotspots / green corridors if defined
    drawHotspots();

    // Map drag or zoom releases follow lock and shows recenter button
    _map.on('dragstart', () => {
      _following = false;
      _userInteracted = true;
      const btn = document.getElementById('recentre-btn');
      if (btn) btn.classList.add('visible');
    });

    _map.on('zoomstart', (e) => {
      if (e && e.originalEvent) {
        _following = false;
        _userInteracted = true;
        const btn = document.getElementById('recentre-btn');
        if (btn) btn.classList.add('visible');
      }
    });

    // Map Click / Long Press destination selection
    _map.on('click', _onMapClick);
    _map.on('contextmenu', (e) => {
      L.DomEvent.preventDefault(e);
      _onMapClick(e);
    });

    // Start background GPS location tracking independently of route planning
    _initLocationTracking();

    // Ensure map container size is accurately determined
    requestAnimationFrame(() => {
      if (_map) _map.invalidateSize({ pan: false });
    });

    return _map;
  }

  // ── Map Theme Toggling ──────────────────────
  function toggleMapTheme() {
    const keys = Object.keys(Config.MAP.tileLayers);
    if (keys.length <= 1) {
      Utils.toast('Using official OpenStreetMap standard basemap');
      return;
    }
    const nextIdx = (keys.indexOf(_currentTileKey) + 1) % keys.length;
    _currentTileKey = keys[nextIdx];

    if (_tileLayer) {
      _map.removeLayer(_tileLayer);
    }

    const t = Config.MAP.tileLayers[_currentTileKey];
    _tileLayer = L.tileLayer(t.url, {
      attribution: t.attrib,
      maxZoom: t.maxZoom || 19,
      crossOrigin: true
    }).addTo(_map);

    const themeBtn = document.getElementById('tile-toggle-btn');
    if (themeBtn) {
      themeBtn.textContent = '🗺️';
      themeBtn.title = `Basemap: ${t.name}`;
    }

    Utils.toast(`Map basemap: ${t.name}`);
  }

  // ── Toggle AQI Layer ────────────────────────
  function toggleAqiLayer() {
    _aqiLayerVisible = !_aqiLayerVisible;
    if (_aqiLayerVisible) {
      if (!_map.hasLayer(_layers.segmentedLine)) _map.addLayer(_layers.segmentedLine);
      if (!_map.hasLayer(_layers.hotspots)) _map.addLayer(_layers.hotspots);
      if (typeof Routing !== 'undefined' && Routing.getRouteData) {
        const data = Routing.getRouteData();
        const activeKey = (Routing.getActiveKey && Routing.getActiveKey()) || 'shortest';
        if (data && data[activeKey]) drawSegmentedLine(data[activeKey]);
      }
      Utils.toast('Air Quality overlays visible');
    } else {
      if (_map.hasLayer(_layers.segmentedLine)) _map.removeLayer(_layers.segmentedLine);
      if (_map.hasLayer(_layers.hotspots)) _map.removeLayer(_layers.hotspots);
      Utils.toast('Air Quality overlays hidden');
    }
    const btn = document.getElementById('aqi-layer-toggle-btn');
    if (btn) btn.classList.toggle('active', _aqiLayerVisible);
  }

  // ── Map Click / Destination Picker Popup ────
  async function _onMapClick(e) {
    // If navigation is actively in progress, don't drop selection pins on casual taps
    if (typeof Navigation !== 'undefined' && Navigation.isActive()) {
      return;
    }

    const lat = e.latlng.lat;
    const lng = e.latlng.lng;

    if (_tempClickMarker) {
      _map.removeLayer(_tempClickMarker);
      _tempClickMarker = null;
    }

    const tempIcon = L.divIcon({
      className: '',
      html: `<div class="temp-pin-bounce">📍</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 32]
    });

    _tempClickMarker = L.marker([lat, lng], { icon: tempIcon }).addTo(_map);

    // Initial popup with loading state
    const popupContent = document.createElement('div');
    popupContent.className = 'map-click-popup';
    popupContent.innerHTML = `
      <div class="mcp-title">Resolving address…</div>
      <div class="mcp-coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
      <div class="mcp-actions">
        <button class="mcp-btn start-btn" id="mcp-set-start">📍 Start here</button>
        <button class="mcp-btn dest-btn" id="mcp-set-dest">🏁 Navigate here</button>
        <button class="mcp-btn stop-btn" id="mcp-add-stop">➕ Add stop</button>
        <button class="mcp-btn cancel-btn" id="mcp-cancel">✕</button>
      </div>
    `;

    _tempClickMarker.bindPopup(popupContent, { maxWidth: 280, closeButton: false }).openPopup();

    // Reverse geocode asynchronously
    const rev = await Geocoding.reverseGeocode(lat, lng);
    const placeName = rev.name || rev.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const titleEl = popupContent.querySelector('.mcp-title');
    if (titleEl) titleEl.textContent = placeName;

    popupContent.querySelector('#mcp-set-start').onclick = () => {
      Geocoding.setOriginDirect(lat, lng, placeName);
      _clearTempClickMarker();
    };
    popupContent.querySelector('#mcp-set-dest').onclick = () => {
      Geocoding.setDestDirect(lat, lng, placeName);
      _clearTempClickMarker();
    };
    popupContent.querySelector('#mcp-add-stop').onclick = () => {
      Geocoding.addWaypointDirect(lat, lng, placeName);
      _clearTempClickMarker();
    };
    popupContent.querySelector('#mcp-cancel').onclick = () => {
      _clearTempClickMarker();
    };
  }

  function _clearTempClickMarker() {
    if (_tempClickMarker) {
      _map.removeLayer(_tempClickMarker);
      _tempClickMarker = null;
    }
  }

  // ── Draw Campus Hotspots ────────────────────
  function drawHotspots() {
    if (typeof CampusPresets === 'undefined') return;
    _layers.hotspots.clearLayers();

    CampusPresets.getHotspots().forEach(h => {
      const isClean = h.severity === 'clean';
      const color = isClean ? '#22c55e' : (h.severity === 'critical' ? '#ef4444' : '#f59e0b');

      const circle = L.circle([h.lat, h.lng], {
        radius: h.radius,
        color: color,
        weight: 1.5,
        opacity: 0.85,
        fillColor: color,
        fillOpacity: isClean ? 0.12 : 0.22,
        dashArray: isClean ? null : '6, 6'
      }).addTo(_layers.hotspots);

      circle.bindTooltip(`
        <div style="font-family:sans-serif;font-size:12px;color:#0f172a;line-height:1.35">
          <b>${isClean ? '🌿' : '⚠️'} ${h.name}</b><br/>
          <span style="color:${color};font-weight:700">Historical Ref: AQI ${h.aqi} · PM2.5: ${h.pm25} µg/m³</span><br/>
          <span style="font-size:10px;color:#64748b">${h.warning}</span><br/>
          <span style="font-size:9.5px;color:#94a3b8;font-style:italic">Curated corridor reference (Demonstration baseline · Not live sensor reading)</span>
        </div>
      `, { permanent: false, direction: 'top' });
    });
  }

  // ── Persistent Background GPS Watch & Marker Tracking ───────
  function _initLocationTracking() {
    if (!navigator.geolocation) {
      console.info('Geolocation not supported in this browser environment.');
      return;
    }
    if (_watchId !== null) return; // already active

    _watchId = navigator.geolocation.watchPosition(
      _handleGPSFix,
      _handleGPSError,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  function _handleGPSFix(pos) {
    if (!pos || !pos.coords) return;
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const acc = pos.coords.accuracy || 12;
    const hdg = (pos.coords.heading != null && !isNaN(pos.coords.heading)) ? pos.coords.heading : _userLastHeading;

    _userLastCoord = { lat, lng };
    _userLastHeading = hdg;
    _userLastAccuracy = acc;
    _gpsPermissionDenied = false;

    // 1. Create or update the blue current-location marker & accuracy circle
    updateUserDot(lat, lng, hdg, acc);

    // 2. Initial center on user's location ONLY on the initial fix,
    //    unless user manually moved the map or a route is actively displayed
    if (!_hasInitialCentered) {
      _hasInitialCentered = true;
      const isRouteActive = typeof Routing !== 'undefined' && Routing.hasActiveRoute && Routing.hasActiveRoute();
      if (_following && !_userInteracted && !isRouteActive) {
        panTo(lat, lng, _map.getZoom() < 16 ? 16 : _map.getZoom());
      }
      // Update header AQI for user's initial location if available
      if (typeof Geocoding !== 'undefined' && Geocoding.fetchAndUpdateHeaderAQI) {
        Geocoding.fetchAndUpdateHeaderAQI(lat, lng);
      }
    } else {
      // Subsequent fixes: ONLY pan if navigation is actively running AND following is enabled
      const isNavActive = typeof Navigation !== 'undefined' && Navigation.isActive && Navigation.isActive();
      if (isNavActive && _following) {
        panTo(lat, lng, _map.getZoom() < 16 ? 16 : _map.getZoom());
      }
    }

    // 3. Forward to active navigation callback if registered
    if (_navGpsCallback) {
      _navGpsCallback({ lat, lng, heading: hdg, accuracy: acc });
    }
  }

  function _handleGPSError(err) {
    if (!err) return;
    if (err.code === 1) { // PERMISSION_DENIED
      _gpsPermissionDenied = true;
      console.warn('Geolocation permission denied by user/browser.');
      stopGPSWatch(true);
    } else if (err.code === 2) { // POSITION_UNAVAILABLE
      console.warn('Geolocation position unavailable (searching for satellite/network fix).');
    } else if (err.code === 3) { // TIMEOUT
      console.warn('Geolocation request timed out (retrying automatically).');
    }

    if (_navErrorCallback) {
      _navErrorCallback(err);
    }
  }

  function startGPSWatch(callback = null, errorCallback = null) {
    _navGpsCallback = callback;
    _navErrorCallback = errorCallback;

    if (_watchId !== null) {
      // Watcher already running; immediately notify callback with last known coordinate
      if (_userLastCoord && callback) {
        callback({
          lat: _userLastCoord.lat,
          lng: _userLastCoord.lng,
          heading: _userLastHeading,
          accuracy: _userLastAccuracy
        });
      }
      return;
    }

    if (!navigator.geolocation) {
      Utils.toast('⚠️ Geolocation not available in this browser');
      if (errorCallback) errorCallback({ code: 0, message: 'Geolocation not supported' });
      return;
    }

    _initLocationTracking();
  }

  function stopGPSWatch(force = false) {
    _navGpsCallback = null;
    _navErrorCallback = null;
    if (force && _watchId !== null) {
      navigator.geolocation.clearWatch(_watchId);
      _watchId = null;
    }
  }

  function clearNavCallback() {
    _navGpsCallback = null;
    _navErrorCallback = null;
  }

  function recentre(lat, lng) {
    _following = true;
    _userInteracted = false;
    const btn = document.getElementById('recentre-btn');
    if (btn) btn.classList.remove('visible');

    const targetLat = lat != null ? lat : (_userLastCoord ? _userLastCoord.lat : null);
    const targetLng = lng != null ? lng : (_userLastCoord ? _userLastCoord.lng : null);

    if (targetLat != null && targetLng != null) {
      panTo(targetLat, targetLng, 17);
    } else {
      Utils.toast('📡 Waiting for GPS position fix…');
    }
  }

  // ── Blue GPS Marker with Heading Cone ───────
  function updateUserDot(lat, lng, heading = 0, accuracy = 15) {
    if (!_map || lat == null || lng == null || isNaN(lat) || isNaN(lng)) return;
    _userLastCoord = { lat, lng };
    _userLastHeading = heading;
    _userLastAccuracy = accuracy;

    // Accuracy Circle
    if (_markers.accCircle) {
      _markers.accCircle.setLatLng([lat, lng]).setRadius(Math.max(5, accuracy));
    } else {
      _markers.accCircle = L.circle([lat, lng], {
        radius: Math.max(5, accuracy),
        color: '#0284c7',
        weight: 1,
        opacity: 0.3,
        fillColor: '#0284c7',
        fillOpacity: 0.12,
        interactive: false
      }).addTo(_map);
    }

    const icon = L.divIcon({
      className: '',
      html: `
        <div class="user-dot-wrap">
          <div class="heading-cone" style="transform:translateX(-50%) rotate(${heading}deg)"></div>
          <div class="user-dot-inner"></div>
        </div>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24]
    });

    if (_markers.user) {
      _markers.user.setLatLng([lat, lng]).setIcon(icon);
    } else {
      const pane = _map.getPane('userLocationPane') ? 'userLocationPane' : 'markerPane';
      _markers.user = L.marker([lat, lng], {
        icon,
        pane: pane,
        zIndexOffset: 2500
      }).addTo(_map);
    }
  }

  function setUserMarker(lat, lng, heading = 0, accuracy = 15) {
    updateUserDot(lat, lng, heading, accuracy);
  }

  function updateCompassHeading(heading) {
    const needle = document.getElementById('compass-needle');
    if (needle) {
      needle.style.transform = `rotate(${-heading}deg)`;
    }
  }

  function resetNorth() {
    _userLastHeading = 0;
    updateCompassHeading(0);
    if (_userLastCoord) {
      panTo(_userLastCoord.lat, _userLastCoord.lng, _map.getZoom());
    }
    Utils.toast('Aligned to North');
  }

  // ── Route Visualizations ────────────────────
  function drawRoutes(routeData) {
    clearRoutes();

    if (!routeData) return;
    _hasInitialCentered = true;

    const shortest = routeData.shortest;
    const eco      = routeData.eco;

    // Fit map bounds synchronously first so projections are exact
    const fitGeom = (eco || shortest)?.geometry;
    if (fitGeom) {
      const bounds = L.latLngBounds(Utils.geoJsonToLatLng(fitGeom));
      _map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17, animate: false });
    }

    // Draw Shortest Route (Blue)
    if (shortest && shortest.geometry) {
      const latLngs = Utils.geoJsonToLatLng(shortest.geometry);
      const shortestLine = L.polyline(latLngs, {
        color: '#3b82f6',
        weight: 6,
        opacity: 0.75,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(_layers.altRoutes);

      shortestLine.on('click', () => Routing.selectRoute('shortest'));
    }

    // Draw Eco Route (Green) if physically distinct from shortest
    if (eco && eco.geometry && !routeData.same_route && !routeData.is_shortest_cleanest) {
      const latLngs = Utils.geoJsonToLatLng(eco.geometry);
      const ecoLine = L.polyline(latLngs, {
        color: '#22c55e',
        weight: 6,
        opacity: 0.75,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(_layers.altRoutes);

      ecoLine.on('click', () => Routing.selectRoute('eco'));
    }

    // Draw Balanced Route (Cyan) if distinct from shortest and eco
    const balanced = routeData.balanced;
    if (balanced && balanced.geometry && !routeData.same_route) {
      const isSameAsShortest = shortest && shortest.route_index === balanced.route_index;
      const isSameAsEco = eco && eco.route_index === balanced.route_index;
      if (!isSameAsShortest && !isSameAsEco) {
        const latLngs = Utils.geoJsonToLatLng(balanced.geometry);
        const balancedLine = L.polyline(latLngs, {
          color: '#06b6d4',
          weight: 6,
          opacity: 0.75,
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(_layers.altRoutes);

        balancedLine.on('click', () => Routing.selectRoute('balanced'));
      }
    }

    // Draw Evaluated Alternative Corridor (Neutral Grey/Dashed) if available
    const alt = routeData.alternative_corridor;
    if (alt && alt.geometry) {
      const latLngs = Utils.geoJsonToLatLng(alt.geometry);
      const altLine = L.polyline(latLngs, {
        color: '#94a3b8',
        weight: 5,
        opacity: 0.75,
        dashArray: '6, 8',
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(_layers.altRoutes);

      altLine.bindTooltip(`
        <div style="font-family:sans-serif;font-size:11px;color:#0f172a">
          <b>Alternative Road Corridor</b> (Evaluated)<br/>
          <span>${alt.distance_str} · ${alt.duration_str} · Inhaled PM2.5: ${alt.pm25_inhaled_ug || 0} µg</span><br/>
          <span style="color:#ef4444;font-size:10px">Higher duration and particulate exposure</span>
        </div>
      `, { permanent: false });
    }

    // Draw Segmented Color Overlays on chosen path only if AQI layer is active
    if (_aqiLayerVisible) {
      drawSegmentedLine(routeData.selected_route || eco || shortest);
    }
  }

  function drawSegmentedLine(route) {
    _layers.segmentedLine.clearLayers();
    _layers.aqiStations.clearLayers();

    if (!route || !route.colored_segments) return;

    route.colored_segments.forEach((seg, idx) => {
      const poly = L.polyline(seg.coordinates, {
        color: seg.color || '#22c55e',
        weight: 5,
        opacity: 0.9,
        lineCap: 'round'
      }).addTo(_layers.segmentedLine);

      poly.bindTooltip(`
        <div style="font-family:sans-serif;font-size:11px;color:#0f172a">
          <b>AQI ${Math.round(seg.aqi)}</b> · PM2.5: ${Utils.aqiToPm25 ? Utils.aqiToPm25(seg.aqi) : ''} µg/m³
        </div>
      `, { permanent: false, sticky: true });
    });

    // AQI inspection markers along the route
    if (route.aqi_samples) {
      route.aqi_samples.forEach((sample, i) => {
        if (sample.aqi == null) return;
        const dot = L.circleMarker([sample.lat, sample.lng], {
          radius: 5,
          color: '#ffffff',
          weight: 1.5,
          fillColor: sample.color,
          fillOpacity: 1.0
        }).addTo(_layers.aqiStations);

        dot.bindPopup(`
          <div style="font-family:sans-serif;font-size:12px;color:#0f172a;line-height:1.4">
            <b>Air Quality Sample #${i + 1}</b><br/>
            <span style="color:${sample.color};font-weight:700">AQI ${sample.aqi} (${sample.bucket})</span><br/>
            <span>PM2.5: ${sample.pm25} µg/m³</span><br/>
            <span style="font-size:10px;color:#64748b">Station: ${sample.station || 'Atmospheric Grid'}</span><br/>
            <span style="font-size:9px;color:#94a3b8">Source: ${sample.source} (${sample.data_type})</span>
          </div>
        `, { maxWidth: 220 });
      });
    }
  }

  function highlightRoute(which) {
    const data = Routing.getRouteData();
    if (!data) return;

    _layers.activeRoute.clearLayers();
    const activeRouteObj = data[which] || data.eco || data.shortest;
    if (activeRouteObj && activeRouteObj.geometry) {
      const latLngs = Utils.geoJsonToLatLng(activeRouteObj.geometry);
      const color = activeRouteObj.color || (which === 'eco' || which === 'cleanest' ? '#22c55e' : (which === 'balanced' ? '#06b6d4' : '#3b82f6'));

      L.polyline(latLngs, {
        color: color,
        weight: 8,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(_layers.activeRoute);

      if (_aqiLayerVisible) {
        drawSegmentedLine(activeRouteObj);
      }
    }
  }

  function clearRoutes() {
    _layers.altRoutes.clearLayers();
    _layers.activeRoute.clearLayers();
    _layers.segmentedLine.clearLayers();
    _layers.aqiStations.clearLayers();
  }

  // ── Origin, Destination, Waypoint Markers ───
  function setOriginMarker(lat, lng, name = '') {
    clearOriginMarker();
    const icon = L.divIcon({
      className: '',
      html: `<div class="origin-pin-icon"><div class="origin-pin-inner"></div></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    _markers.origin = L.marker([lat, lng], { icon, zIndexOffset: 1500 }).addTo(_map);
    if (name) _markers.origin.bindTooltip(`<b>Start:</b> ${name.split(',')[0]}`, { direction: 'top' }).openTooltip();
  }

  function clearOriginMarker() {
    if (_markers.origin) {
      _map.removeLayer(_markers.origin);
      _markers.origin = null;
    }
  }

  function setDestMarker(lat, lng, name = '') {
    clearDestMarker();
    const icon = L.divIcon({
      className: '',
      html: `<div class="dest-pin-icon">🏁</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 28]
    });
    _markers.dest = L.marker([lat, lng], { icon, zIndexOffset: 1500 }).addTo(_map);
    if (name) _markers.dest.bindTooltip(`<b>Destination:</b> ${name.split(',')[0]}`, { direction: 'top' }).openTooltip();
  }

  function clearDestMarker() {
    if (_markers.dest) {
      _map.removeLayer(_markers.dest);
      _markers.dest = null;
    }
  }

  function updateWaypointMarkers(waypoints) {
    _waypointMarkers.forEach(m => _map.removeLayer(m));
    _waypointMarkers = [];

    (waypoints || []).forEach((wp, idx) => {
      if (!wp.coords) return;
      const icon = L.divIcon({
        className: '',
        html: `<div class="waypoint-pin-icon">${idx + 1}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      const m = L.marker([wp.coords.lat, wp.coords.lng], { icon, zIndexOffset: 1400 }).addTo(_map);
      if (wp.name) m.bindTooltip(`<b>Stop ${idx + 1}:</b> ${wp.name.split(',')[0]}`, { direction: 'top' });
      _waypointMarkers.push(m);
    });
  }

  // ── Navigation Turn Marker ──────────────────
  function setTurnMarker(lat, lng) {
    clearTurnMarker();
    const icon = L.divIcon({
      className: '',
      html: `<div class="turn-pulsing-marker"></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
    _markers.turn = L.marker([lat, lng], { icon, zIndexOffset: 1800 }).addTo(_layers.navTurnMarker);
  }

  function clearTurnMarker() {
    _layers.navTurnMarker.clearLayers();
    _markers.turn = null;
  }

  // ── Pan and Zoom Helper ─────────────────────
  function panTo(lat, lng, zoom = 15) {
    if (!_map) return;
    _map.setView([lat, lng], zoom, { animate: true, duration: 0.5 });
  }

  return {
    init,
    toggleMapTheme,
    toggleAqiLayer,
    panTo,
    setUserMarker,
    updateUserDot,
    updateCompassHeading,
    resetNorth,
    startGPSWatch,
    stopGPSWatch,
    clearNavCallback,
    recentre,
    drawRoutes,
    highlightRoute,
    clearRoutes,
    setOriginMarker,
    clearOriginMarker,
    setDestMarker,
    clearDestMarker,
    updateWaypointMarkers,
    setTurnMarker,
    clearTurnMarker,
    getCenter: () => (_map ? _map.getCenter() : null),
    getMap: () => _map,
    getLayers: () => _layers,
    getTileLayer: () => _tileLayer,
    isFollowing: () => _following,
    setFollowing: (val) => { _following = val; },
    getUserCoord: () => _userLastCoord,
    getUserHeading: () => _userLastHeading,
    getUserAccuracy: () => _userLastAccuracy,
    hasLocationFix: () => _userLastCoord !== null,
    isGPSWatching: () => _watchId !== null,
    isGPSPermissionDenied: () => _gpsPermissionDenied,
    setGPSPermissionDenied: (val) => { _gpsPermissionDenied = val; }
  };
})();
