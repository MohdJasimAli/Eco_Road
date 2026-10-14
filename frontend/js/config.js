// ═══════════════════════════════════════════════
// Eco_Road — Frontend Configuration
// Complete Google Maps-Style Navigation & AQI
// ═══════════════════════════════════════════════

const Config = (() => {
  const isHttp = window.location.protocol.startsWith('http');
  const hostname = window.location.hostname || 'localhost';
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';

  // Dynamic API base resolution:
  // 1. Explicit override via window.__API_BASE__ or localStorage
  // 2. Same-origin if deployed on production (ports 80, 443, or default) or served directly on port 8000
  // 3. Fallback to ${protocol}//${hostname}:8000 for local dev frontend server (e.g. port 3000 or LAN IP)
  const envApiBase = (typeof window !== 'undefined' && window.__API_BASE__) || 
                     (typeof localStorage !== 'undefined' && localStorage.getItem('ecoroad_api_base'));
  const isStandardWebPort = !window.location.port || window.location.port === '80' || window.location.port === '443' || window.location.port === '8000';
  const defaultApiBase = isHttp
    ? (isStandardWebPort ? window.location.origin : `${protocol}//${hostname}:8000`)
    : 'http://localhost:8000';
  const apiBase = envApiBase || defaultApiBase;

  return {
    API_BASE: apiBase,

    ENDPOINTS: {
      health: () => `${Config.API_BASE}/health`,
      predict: () => `${Config.API_BASE}/predict`,
      geocode: (q, lat, lon) => {
        let url = `${Config.API_BASE}/geocode?q=${encodeURIComponent(q)}`;
        if (lat != null && lon != null) {
          url += `&lat=${lat}&lon=${lon}`;
        }
        return url;
      },
      reverseGeocode: (lat, lng) => `${Config.API_BASE}/geocode/reverse?lat=${lat}&lng=${lng}`,
      route: (oLat, oLng, dLat, dLng, mode = 'foot', sensitivity = 'standard', waypoints = '', preference = 'cleanest') => {
        let url = `${Config.API_BASE}/route?origin_lat=${oLat}&origin_lng=${oLng}&dest_lat=${dLat}&dest_lng=${dLng}&mode=${mode}&sensitivity=${sensitivity}&preference=${preference}`;
        if (waypoints) {
          url += `&waypoints=${encodeURIComponent(waypoints)}`;
        }
        return url;
      },
      detour: (cLat, cLng, dLat, dLng, aLat, aLng, mode = 'foot') =>
        `${Config.API_BASE}/route/detour?current_lat=${cLat}&current_lng=${cLng}&dest_lat=${dLat}&dest_lng=${dLng}&avoid_lat=${aLat}&avoid_lng=${aLng}&mode=${mode}`,
      compare: (oLat, oLng, dLat, dLng, mode = 'foot', sensitivity = 'standard') =>
        `${Config.API_BASE}/route/compare?origin_lat=${oLat}&origin_lng=${oLng}&dest_lat=${dLat}&dest_lng=${dLng}&mode=${mode}&sensitivity=${sensitivity}`,
      trend: (oLat, oLng, dLat, dLng) =>
        `${Config.API_BASE}/route/trend?origin_lat=${oLat}&origin_lng=${oLng}&dest_lat=${dLat}&dest_lng=${dLng}`,
      exportGeoJson: (oLat, oLng, dLat, dLng, mode = 'foot', sensitivity = 'standard') =>
        `${Config.API_BASE}/route/export?origin_lat=${oLat}&origin_lng=${oLng}&dest_lat=${dLat}&dest_lng=${dLng}&mode=${mode}&sensitivity=${sensitivity}`,
      liveAqi: (lat, lng) =>
        `${Config.API_BASE}/aqi/live?lat=${lat}&lng=${lng}`,
    },

    MAP: {
      defaultCenter: [26.8467, 80.9462],   // Lucknow, UP Rollout Center
      defaultZoom: 13,
      tileLayers: {
        osm: {
          name: 'OpenStreetMap Standard',
          url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          attrib: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · Eco_Road',
          maxZoom: 19
        }
      }
    },

    AUTOCOMPLETE: {
      debounceMs: 300,
      minChars: 2,
      maxResults: 8,
    },

    STORAGE_KEYS: {
      recentSearches: 'ecoroad_recent_searches_v2',
      savedPlaces: 'ecoroad_saved_places_v2',
      mapTheme: 'ecoroad_map_theme_v2',
      travelMode: 'ecoroad_travel_mode_v2',
      healthMode: 'ecoroad_health_mode_v2'
    }
  };
})();
