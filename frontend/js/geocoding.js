// ═══════════════════════════════════════════════
// Eco_Road — Worldwide Geocoding & Location Manager
// Complete Google Maps Search, Autocomplete & Stops
// ═══════════════════════════════════════════════

const Geocoding = (() => {

  let _activeInputKey = null; // 'origin' | 'dest' | 'waypoint-0', etc.
  let _abortController = null;
  const _abortControllers = {};
  let _keyboardIndex = -1;

  const _state = {
    origin: { coords: null, name: '' },
    dest:   { coords: null, name: '' },
    waypoints: [] // array of { id, coords: {lat, lng}, name: '' }
  };

  // ── Storage Helpers ─────────────────────────
  function _getRecentSearches() {
    try {
      const data = localStorage.getItem(Config.STORAGE_KEYS.recentSearches);
      return data ? JSON.parse(data) : [];
    } catch (_) { return []; }
  }

  function _saveRecentSearch(place) {
    if (!place || !place.name || !place.lat || !place.lng) return;
    if (place.name === 'Current Location') return;
    try {
      let list = _getRecentSearches().filter(p => p.name !== place.name);
      list.unshift({ name: place.name, lat: place.lat, lng: place.lng, type: place.type || 'place' });
      if (list.length > 8) list = list.slice(0, 8);
      localStorage.setItem(Config.STORAGE_KEYS.recentSearches, JSON.stringify(list));
    } catch (_) {}
  }

  function _getSavedPlaces() {
    try {
      const data = localStorage.getItem(Config.STORAGE_KEYS.savedPlaces);
      return data ? JSON.parse(data) : [
        { label: 'Home', icon: '🏠', coords: null, name: 'Set Home address' },
        { label: 'Work / College', icon: '💼', coords: null, name: 'Set Work address' }
      ];
    } catch (_) {
      return [];
    }
  }

  // ── Worldwide Backend Geocoding ─────────────
  async function search(query, key = null) {
    if (!query || query.trim().length < Config.AUTOCOMPLETE.minChars) {
      return [];
    }

    if (key && _abortControllers[key]) {
      _abortControllers[key].abort();
    } else if (!key && _abortController) {
      _abortController.abort();
    }
    const ac = new AbortController();
    if (key) _abortControllers[key] = ac;
    else _abortController = ac;

    try {
      let centerLat = null, centerLng = null;
      if (typeof MapManager !== 'undefined' && MapManager.getCenter) {
        const c = MapManager.getCenter();
        if (c) { centerLat = c.lat; centerLng = c.lng; }
      }
      const res = await fetch(Config.ENDPOINTS.geocode(query.trim(), centerLat, centerLng), {
        signal: ac.signal,
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn('Geocoding request note:', e);
      }
      return [];
    }
  }

  async function reverseGeocode(lat, lng) {
    try {
      const res = await fetch(Config.ENDPOINTS.reverseGeocode(lat, lng));
      if (!res.ok) throw new Error('Reverse geocode failed');
      return await res.json();
    } catch (e) {
      return {
        display_name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        lat: lat,
        lng: lng,
        type: 'coordinate'
      };
    }
  }

  function iconForType(type, category) {
    const map = {
      city: '🏙️', town: '🏘️', village: '🌿', suburb: '🏠',
      amenity: '📍', road: '🛣️', street: '🛣️', highway: '🛣️',
      restaurant: '🍽️', hospital: '🏥', school: '🏫', university: '🎓',
      station: '🚉', airport: '✈️', park: '🌳', coordinate: '🎯',
      bus_stop: '🚏', railway: '🚆', shop: '🛍️'
    };
    return map[type] || map[category] || '📍';
  }

  function _formatResolvedLocationName(rev, lat, lng) {
    if (rev && rev.type !== 'coordinate') {
      const candidate = rev.display_name || rev.name || '';
      const coordStr = `${lat.toFixed(4)}`;
      if (candidate && !candidate.startsWith(coordStr)) {
        return candidate;
      }
    }
    return 'Current Location';
  }

  // ── Render Autocomplete / History Dropdown ──
  function renderList(results, targetKey, isHistory = false) {
    const panel = document.getElementById('autocomplete-panel');
    const list  = document.getElementById('autocomplete-list');
    if (!panel || !list) return;

    list.innerHTML = '';
    _keyboardIndex = -1;

    const isPermissionDenied = typeof MapManager !== 'undefined' &&
      MapManager.isGPSPermissionDenied &&
      MapManager.isGPSPermissionDenied();

    const hasGeoSupport = typeof navigator !== 'undefined' && 'geolocation' in navigator;
    const showCurrentLocation = (targetKey === 'origin') && hasGeoSupport && !isPermissionDenied;

    const hasResults = Array.isArray(results) && results.length > 0;

    // If neither Current Location nor any results exist
    if (!showCurrentLocation && !hasResults) {
      if (isHistory) {
        panel.style.display = 'none';
        return;
      }
      list.innerHTML = `
        <div class="ac-empty">
          <span>🔍 No exact places found.</span>
          <small>Try searching a landmark or tap on the map to set location.</small>
        </div>`;
      panel.style.display = 'block';
      return;
    }

    let itemIndex = 0;

    // 1. Dedicated "📍 Current Location" suggestion for Start Location
    if (showCurrentLocation) {
      const curLocDiv = document.createElement('div');
      curLocDiv.className = 'ac-item ac-current-location';
      curLocDiv.dataset.index = itemIndex++;
      curLocDiv.tabIndex = 0;

      const userCoord = (typeof MapManager !== 'undefined' && MapManager.getUserCoord) ? MapManager.getUserCoord() : null;
      const subText = userCoord ? 'Use live GPS location' : 'Acquire GPS location';

      curLocDiv.innerHTML = `
        <div class="ac-icon" style="background:rgba(59,130,246,0.15);color:#3b82f6;">📍</div>
        <div class="ac-text-col">
          <div class="ac-name" style="color:#60a5fa;font-weight:600;">Current Location</div>
          <div class="ac-sub">${subText}</div>
        </div>
      `;

      // Prevent input blur before click fires
      curLocDiv.addEventListener('mousedown', (e) => e.preventDefault());

      curLocDiv.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.style.display = 'none';
        useMyLocation();
      });

      list.appendChild(curLocDiv);
    }

    // 2. Section Header if history and results exist
    if (isHistory && hasResults) {
      const header = document.createElement('div');
      header.className = 'ac-section-header';
      header.textContent = '🕒 Recent Searches';
      list.appendChild(header);
    }

    // 3. Render results (either recent searches or search results)
    if (hasResults) {
      results.forEach((item) => {
        const displayName = item.display_name || item.name || '';
        const parts = displayName.split(',');
        const mainName = item.name || parts[0].trim();
        const subName = parts.slice(1, 4).join(',').trim();
        const icon = isHistory ? '🕒' : iconForType(item.type, item.category);

        const div = document.createElement('div');
        div.className = 'ac-item';
        div.dataset.index = itemIndex++;
        div.tabIndex = 0;
        div.innerHTML = `
          <div class="ac-icon">${icon}</div>
          <div class="ac-text-col">
            <div class="ac-name">${mainName}</div>
            ${subName ? `<div class="ac-sub">${subName}</div>` : ''}
          </div>
        `;

        div.addEventListener('mousedown', (e) => e.preventDefault());

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const selectedPlace = {
            lat: parseFloat(item.lat),
            lng: parseFloat(item.lon != null ? item.lon : item.lng),
            name: mainName + (subName ? `, ${subName}` : ''),
            type: item.type
          };
          selectPlace(targetKey, selectedPlace);
        });

        list.appendChild(div);
      });
    } else if (!isHistory) {
      // Query was typed, but 0 places returned from geocoder
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'ac-empty';
      emptyDiv.innerHTML = `
        <span>🔍 No exact places found.</span>
        <small>Try searching a landmark or tap on the map to set location.</small>
      `;
      list.appendChild(emptyDiv);
    }

    panel.style.display = 'block';
  }

  // ── Place Selection ─────────────────────────
  function selectPlace(key, place) {
    if (!place || isNaN(place.lat) || isNaN(place.lng)) return;

    _saveRecentSearch(place);

    const panel = document.getElementById('autocomplete-panel');
    if (panel) panel.style.display = 'none';

    // Clear any stale route polylines when updating an endpoint
    MapManager.clearRoutes();

    if (key === 'origin') {
      _state.origin = { coords: { lat: place.lat, lng: place.lng }, name: place.name };
      const input = document.getElementById('origin-input');
      if (input) input.value = place.name;
      MapManager.setOriginMarker(place.lat, place.lng, place.name);
      MapManager.panTo(place.lat, place.lng, 14);
      fetchAndUpdateHeaderAQI(place.lat, place.lng);

    } else if (key === 'dest') {
      _state.dest = { coords: { lat: place.lat, lng: place.lng }, name: place.name };
      const input = document.getElementById('dest-input');
      if (input) input.value = place.name;
      MapManager.setDestMarker(place.lat, place.lng, place.name);
      MapManager.panTo(place.lat, place.lng, 14);

    } else if (key.startsWith('waypoint-')) {
      const wpIdx = parseInt(key.replace('waypoint-', ''), 10);
      if (_state.waypoints[wpIdx]) {
        _state.waypoints[wpIdx].coords = { lat: place.lat, lng: place.lng };
        _state.waypoints[wpIdx].name = place.name;
        const input = document.getElementById(`waypoint-input-${wpIdx}`);
        if (input) input.value = place.name;
        MapManager.updateWaypointMarkers(_state.waypoints);
      }
    }

    _triggerRoutingIfReady();
  }

  function _triggerRoutingIfReady() {
    if (_state.origin.coords && _state.dest.coords) {
      const validWps = _state.waypoints
        .filter(w => w.coords && !isNaN(w.coords.lat) && !isNaN(w.coords.lng))
        .map(w => [w.coords.lat, w.coords.lng]);

      Routing.findRoutes(_state.origin.coords, _state.dest.coords, validWps);
    }
  }

  // ── Swap Origin and Destination ─────────────
  function swapOriginAndDest() {
    const tempCoords = _state.origin.coords;
    const tempName   = _state.origin.name;

    _state.origin.coords = _state.dest.coords;
    _state.origin.name   = _state.dest.name;

    _state.dest.coords = tempCoords;
    _state.dest.name   = tempName;

    const oInput = document.getElementById('origin-input');
    const dInput = document.getElementById('dest-input');
    if (oInput) oInput.value = _state.origin.name || '';
    if (dInput) dInput.value = _state.dest.name || '';

    // Update markers on map
    if (_state.origin.coords) {
      MapManager.setOriginMarker(_state.origin.coords.lat, _state.origin.coords.lng, _state.origin.name);
    } else {
      MapManager.clearOriginMarker();
    }

    if (_state.dest.coords) {
      MapManager.setDestMarker(_state.dest.coords.lat, _state.dest.coords.lng, _state.dest.name);
    } else {
      MapManager.clearDestMarker();
    }

    Utils.toast('⇅ Swapped Start and Destination');
    _triggerRoutingIfReady();
  }

  // ── Intermediate Waypoints Management ───────
  function addWaypoint(coords = null, name = '') {
    if (_state.waypoints.length >= 4) {
      Utils.toast('Maximum 4 stops supported');
      return;
    }

    const id = Date.now();
    const wpObj = { id, coords, name };
    _state.waypoints.push(wpObj);
    _renderWaypointRows();

    if (coords) {
      MapManager.updateWaypointMarkers(_state.waypoints);
      _triggerRoutingIfReady();
    }
  }

  function removeWaypoint(idx) {
    _state.waypoints.splice(idx, 1);
    _renderWaypointRows();
    MapManager.updateWaypointMarkers(_state.waypoints);
    _triggerRoutingIfReady();
  }

  function _renderWaypointRows() {
    const container = document.getElementById('waypoints-container');
    if (!container) return;
    container.innerHTML = '';

    _state.waypoints.forEach((wp, idx) => {
      const row = document.createElement('div');
      row.className = 'input-row waypoint-row';
      row.innerHTML = `
        <div class="route-dot orange"></div>
        <input type="text" id="waypoint-input-${idx}" class="waypoint-input" placeholder="Stop ${idx + 1}" value="${wp.name || ''}" autocomplete="off" />
        <button class="icon-btn remove-wp-btn" title="Remove stop" onclick="Geocoding.removeWaypoint(${idx})">✕</button>
      `;
      container.appendChild(row);

      const input = document.getElementById(`waypoint-input-${idx}`);
      _setupInputListener(input, `waypoint-${idx}`);
    });
  }

  // ── Setup Input Event Listeners ─────────────
  function _setupInputListener(input, key) {
    if (!input) return;

    const performSearch = async (val) => {
      const q = (val || '').trim();
      if (q.length < Config.AUTOCOMPLETE.minChars) {
        const recent = _getRecentSearches();
        renderList(recent, key, true);
        return;
      }
      _activeInputKey = key;
      const results = await search(q, key);
      if (_activeInputKey === key) {
        renderList(results, key, false);
      }
    };

    const debounced = Utils.debounce((val) => performSearch(val), Config.AUTOCOMPLETE.debounceMs);

    input.addEventListener('input', (e) => debounced(e.target.value));

    input.addEventListener('focus', () => {
      _activeInputKey = key;
      const val = input.value.trim();
      if (val.length >= Config.AUTOCOMPLETE.minChars) {
        debounced(val);
      } else {
        const recent = _getRecentSearches();
        if (key === 'origin' || recent.length > 0) {
          renderList(recent, key, true);
        } else {
          const panel = document.getElementById('autocomplete-panel');
          if (panel) panel.style.display = 'none';
          const list = document.getElementById('autocomplete-list');
          if (list) list.innerHTML = '';
        }
      }
    });

    // Keyboard navigation & direct Enter selection
    input.addEventListener('keydown', async (e) => {
      const panel = document.getElementById('autocomplete-panel');
      const isPanelOpen = panel && panel.style.display !== 'none';
      const items = isPanelOpen ? panel.querySelectorAll('.ac-item') : [];

      if (e.key === 'ArrowDown') {
        if (!items.length) return;
        e.preventDefault();
        _keyboardIndex = (_keyboardIndex + 1) % items.length;
        _highlightItem(items, _keyboardIndex);
      } else if (e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        _keyboardIndex = (_keyboardIndex - 1 + items.length) % items.length;
        _highlightItem(items, _keyboardIndex);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (isPanelOpen && items.length > 0) {
          if (_keyboardIndex >= 0 && _keyboardIndex < items.length) {
            items[_keyboardIndex].click();
          } else {
            // Direct Enter without arrow keys:
            // If user typed a query in origin field and multiple items exist (e.g. Current Location + search results),
            // prefer the top search result over Current Location; otherwise select items[0].
            const val = input.value.trim();
            const hasTypedQuery = val.length >= Config.AUTOCOMPLETE.minChars;
            if (hasTypedQuery && items[0].classList.contains('ac-current-location') && items.length > 1) {
              items[1].click();
            } else {
              items[0].click();
            }
          }
        } else {
          // Direct search fallback on Enter when dropdown is not open
          const val = input.value.trim();
          if (val.length >= Config.AUTOCOMPLETE.minChars) {
            const results = await search(val, key);
            if (results && results.length > 0) {
              const item = results[0];
              const displayName = item.display_name || item.name || '';
              const parts = displayName.split(',');
              const mainName = item.name || parts[0].trim();
              const subName = parts.slice(1, 4).join(',').trim();
              const selectedPlace = {
                lat: parseFloat(item.lat),
                lng: parseFloat(item.lon != null ? item.lon : item.lng),
                name: mainName + (subName ? `, ${subName}` : ''),
                type: item.type
              };
              selectPlace(key, selectedPlace);
            } else {
              Utils.toast('🔍 No place found for: ' + val);
            }
          }
        }
      } else if (e.key === 'Escape') {
        if (panel) panel.style.display = 'none';
      }
    });
  }

  function _highlightItem(items, index) {
    items.forEach((it, i) => {
      it.classList.toggle('ac-selected', i === index);
      if (i === index) it.scrollIntoView({ block: 'nearest' });
    });
  }

  // ── Geolocation (Current Location Origin) ────
  async function useMyLocation() {
    if (!navigator.geolocation) {
      Utils.toast('⚠️ Geolocation not supported by your browser');
      return;
    }

    const input = document.getElementById('origin-input');
    const panel = document.getElementById('autocomplete-panel');
    if (panel) panel.style.display = 'none';

    // Fast-path: If MapManager already acquired a valid GPS fix, use it immediately
    if (typeof MapManager !== 'undefined' && MapManager.getUserCoord && MapManager.getUserCoord()) {
      const coord = MapManager.getUserCoord();
      const lat = coord.lat;
      const lng = coord.lng;
      const heading = (MapManager.getUserHeading && MapManager.getUserHeading()) || 0;
      const accuracy = (MapManager.getUserAccuracy && MapManager.getUserAccuracy()) || 15;

      MapManager.setUserMarker(lat, lng, heading, accuracy);
      MapManager.panTo(lat, lng, 15);

      // Store origin coordinates immediately
      selectPlace('origin', { lat, lng, name: 'Current Location', type: 'coordinate' });
      fetchAndUpdateHeaderAQI(lat, lng);
      Utils.toast('📍 Position acquired');

      // Asynchronously resolve human-readable address
      reverseGeocode(lat, lng).then(rev => {
        const name = _formatResolvedLocationName(rev, lat, lng);
        if (input && _state.origin.coords && _state.origin.coords.lat === lat && _state.origin.coords.lng === lng) {
          input.value = name;
          _state.origin.name = name;
          if (MapManager.setOriginMarker) {
            MapManager.setOriginMarker(lat, lng, name);
          }
        }
      }).catch(() => {});
      return;
    }

    if (input) {
      input.value = 'Getting your location…';
      input.disabled = true;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        if (input) input.disabled = false;
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        const heading = pos.coords.heading || 0;

        if (typeof MapManager !== 'undefined') {
          MapManager.setUserMarker(lat, lng, heading, accuracy || 15);
          MapManager.panTo(lat, lng, 15);
        }

        // Store origin coordinates immediately
        selectPlace('origin', { lat, lng, name: 'Current Location', type: 'coordinate' });
        fetchAndUpdateHeaderAQI(lat, lng);
        Utils.toast('📍 Position acquired');

        // Asynchronously resolve human-readable address
        reverseGeocode(lat, lng).then(rev => {
          const name = _formatResolvedLocationName(rev, lat, lng);
          if (input && _state.origin.coords && _state.origin.coords.lat === lat && _state.origin.coords.lng === lng) {
            input.value = name;
            _state.origin.name = name;
            if (MapManager.setOriginMarker) {
              MapManager.setOriginMarker(lat, lng, name);
            }
          }
        }).catch(() => {});
      },
      (err) => {
        if (input) {
          input.disabled = false;
          input.value = '';
        }
        if (err.code === 1 && typeof MapManager !== 'undefined' && MapManager.setGPSPermissionDenied) {
          MapManager.setGPSPermissionDenied(true);
        }
        const msgs = {
          1: 'Location permission denied. Please enable browser location.',
          2: 'GPS location unavailable. Please check device connectivity.',
          3: 'Location request timed out. Please retry.'
        };
        Utils.toast('⚠️ ' + (msgs[err.code] || 'Could not determine position'));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 }
    );
  }

  // ── Fetch + Update Header Live AQI Pill ──────
  async function fetchAndUpdateHeaderAQI(lat, lng) {
    try {
      const res = await fetch(Config.ENDPOINTS.liveAqi(lat, lng));
      if (!res.ok) return;
      const d = await res.json();
      if (d.aqi == null) return;

      const dot  = document.getElementById('header-aqi-dot');
      const text = document.getElementById('header-aqi-text');
      const pill = document.getElementById('header-aqi-pill');
      if (dot && text && pill) {
        dot.style.background = d.aqi_color;
        const cat = d.aqi_category || d.aqi_bucket || '';
        // Abbreviate long categories for clean header display
        const catMap = {
          'Unhealthy for Sensitive Groups': 'Sensitive',
          'Very Unhealthy': 'Very Poor',
          'Hazardous': 'Severe'
        };
        const displayCat = catMap[cat] || cat;
        text.textContent = `AQI ${Math.round(d.aqi)} · ${displayCat}`;
        text.style.color = d.aqi_color;
        pill.style.borderColor = d.aqi_color + '44';
        const typeNote = d.data_type === 'observed' ? 'Physical Station Observation' : 'Atmospheric Model (~11 km grid)';
        pill.title = `Air Quality: AQI ${Math.round(d.aqi)} (${cat})\nSource: ${d.station || d.source} (${typeNote})\nTimestamp: ${d.timestamp || 'Live'}`;
      }
    } catch (_) {}
  }

  // ── Clear Inputs ────────────────────────────
  function clearOrigin() {
    _state.origin = { coords: null, name: '' };
    const input = document.getElementById('origin-input');
    if (input) input.value = '';
    MapManager.clearOriginMarker();
    MapManager.clearRoutes();
    document.getElementById('route-cards').style.display = 'none';
  }

  function clearDest() {
    _state.dest = { coords: null, name: '' };
    const input = document.getElementById('dest-input');
    if (input) input.value = '';
    MapManager.clearDestMarker();
    MapManager.clearRoutes();
    document.getElementById('route-cards').style.display = 'none';
    const mini = document.getElementById('header-mini');
    if (mini) mini.style.display = 'none';
  }

  return {
    setup() {
      _setupInputListener(document.getElementById('origin-input'), 'origin');
      _setupInputListener(document.getElementById('dest-input'),   'dest');

      document.getElementById('use-location-btn')?.addEventListener('click', () => {
        if (typeof Utils !== 'undefined') Utils.haptic('medium');
        useMyLocation();
      });
      document.getElementById('clear-origin-btn')?.addEventListener('click', () => {
        if (typeof Utils !== 'undefined') Utils.haptic('light');
        clearOrigin();
      });
      document.getElementById('clear-dest-btn')?.addEventListener('click', () => {
        if (typeof Utils !== 'undefined') Utils.haptic('light');
        clearDest();
      });
      document.getElementById('swap-locations-btn')?.addEventListener('click', () => {
        if (typeof Utils !== 'undefined') Utils.haptic('medium');
        swapOriginAndDest();
      });
      document.getElementById('add-waypoint-btn')?.addEventListener('click', () => {
        if (typeof Utils !== 'undefined') Utils.haptic('light');
        addWaypoint();
      });

      // Close autocomplete on click outside
      document.addEventListener('click', (e) => {
        const panel = document.getElementById('autocomplete-panel');
        const sheet = document.getElementById('search-sheet');
        if (panel && sheet && !sheet.contains(e.target)) {
          panel.style.display = 'none';
        }
      });
    },
    getState: () => _state,
    reverseGeocode,
    selectPlace,
    useMyLocation,
    swapOriginAndDest,
    addWaypoint,
    removeWaypoint,
    clearOrigin,
    clearDest,
    fetchAndUpdateHeaderAQI,
    setOriginDirect(lat, lng, name) { selectPlace('origin', { lat, lng, name }); },
    setDestDirect(lat, lng, name) { selectPlace('dest', { lat, lng, name }); },
    addWaypointDirect(lat, lng, name) { addWaypoint({ lat, lng }, name); }
  };
})();
