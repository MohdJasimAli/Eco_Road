// ═══════════════════════════════════════════════
// EcoNav — Shared Utilities
// ═══════════════════════════════════════════════

const Utils = {

  // ── AQI classification ─────────────────────
  aqiBucket(v, scale = 'US_EPA') {
    if (scale === 'IN_CPCB') {
      if (v <= 50)  return 'Good';
      if (v <= 100) return 'Satisfactory';
      if (v <= 200) return 'Moderate';
      if (v <= 300) return 'Poor';
      if (v <= 400) return 'Very Poor';
      return 'Severe';
    }
    // US EPA Standard Categories
    if (v <= 50)  return 'Good';
    if (v <= 100) return 'Moderate';
    if (v <= 150) return 'Unhealthy for Sensitive Groups';
    if (v <= 200) return 'Unhealthy';
    if (v <= 300) return 'Very Unhealthy';
    return 'Hazardous';
  },

  aqiColor(v, scale = 'US_EPA') {
    if (scale === 'IN_CPCB') {
      if (v <= 50)  return '#00e400';
      if (v <= 100) return '#a8e05f';
      if (v <= 200) return '#fdd74b';
      if (v <= 300) return '#fe9b57';
      if (v <= 400) return '#fe6a69';
      return '#a97abc';
    }
    // US EPA Standard Colors
    if (v <= 50)  return '#22c55e';
    if (v <= 100) return '#eab308';
    if (v <= 150) return '#f97316';
    if (v <= 200) return '#ef4444';
    if (v <= 300) return '#a855f7';
    return '#881337';
  },

  aqiCssClass(v) {
    if (v <= 50)  return 'aqi-good';
    if (v <= 100) return 'aqi-satisfactory';
    if (v <= 200) return 'aqi-moderate';
    if (v <= 300) return 'aqi-poor';
    if (v <= 400) return 'aqi-very-poor';
    return 'aqi-severe';
  },

  aqiToPm25(aqi) {
    if (aqi <= 50) return Math.round((aqi / 50.0) * 12.0 * 10) / 10;
    if (aqi <= 100) return Math.round((12.1 + ((aqi - 50) / 50.0) * (35.4 - 12.1)) * 10) / 10;
    if (aqi <= 150) return Math.round((35.5 + ((aqi - 100) / 50.0) * (55.4 - 35.5)) * 10) / 10;
    if (aqi <= 200) return Math.round((55.5 + ((aqi - 150) / 50.0) * (150.4 - 55.5)) * 10) / 10;
    if (aqi <= 300) return Math.round((150.5 + ((aqi - 200) / 100.0) * (250.4 - 150.5)) * 10) / 10;
    return Math.round((250.5 + ((Math.min(aqi, 500) - 300) / 200.0) * 249.5) * 10) / 10;
  },


  // ── Maneuver icon ──────────────────────────
  maneuverIcon(type, modifier) {
    const icons = {
      'depart':            '🟢',
      'arrive':            '🏁',
      'turn-left':         '←',
      'turn-right':        '→',
      'turn-slight left':  '↖',
      'turn-slight right': '↗',
      'turn-sharp left':   '⬅',
      'turn-sharp right':  '➡',
      'turn-uturn':        '↩',
      'turn-straight':     '↑',
      'merge':             '⇒',
      'fork-left':         '↰',
      'fork-right':        '↱',
      'roundabout':        '🔄',
      'continue':          '↑',
    };
    return icons[`${type}-${modifier}`] || icons[type] || '↑';
  },

  // ── Toast ──────────────────────────────────
  _toastTimer: null,
  toast(msg, duration = 3500) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  },

  // ── Debounce ───────────────────────────────
  debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },

  // ── ETA calculator ─────────────────────────
  calcETA(durationSeconds) {
    const now = new Date();
    now.setSeconds(now.getSeconds() + durationSeconds);
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },

  // ── GeoJSON coords → Leaflet LatLng ────────
  geoJsonToLatLng(geoJson) {
    return geoJson.coordinates.map(c => [c[1], c[0]]);
  },
};
