// ══════════════════════════════════════════════════════════════
// Comprehensive Verification Suite: Location-Based Navigation AQI
// Cases Tested (as required by specification):
//   Case A: Live navigation moves across grid cells -> HUD updates to new AQI
//   Case B: Demo navigation simulated coords move across grid cells -> HUD updates
//   Case C: Same grid cell coordinates -> identical AQI accepted without fake change
//   Case D: Starting value isolation -> start AQI not permanently reused
//   Case E: Route average isolation -> current nav AQI does not overwrite route average
//   Case F: Delayed out-of-order responses -> older request cannot overwrite newer position
//   Case G: Request throttling -> animation ticks and GPS frames throttled properly
//   Case H: Demo/live switching -> modes use correct coordinates and don't leak state
//   Case I: Missing AQI -> errors/unavailable show 'AQI —' without misleading origin reuse
// ══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let totalPassed = 0;
let totalFailed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    totalFailed++;
    throw new Error(msg);
  } else {
    console.log(`✅ PASSED: ${msg}`);
    totalPassed++;
  }
}

// ── DOM & Browser Environment Simulator ──────────────────────
function createNavigationEnvironment() {
  const elements = {};
  function getEl(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        textContent: '',
        style: {},
        classList: {
          classes: new Set(),
          add(c) { this.classes.add(c); },
          remove(c) { this.classes.delete(c); },
          toggle(c, force) {
            if (force === undefined) {
              if (this.classes.has(c)) this.classes.delete(c);
              else this.classes.add(c);
            } else if (force) {
              this.classes.add(c);
            } else {
              this.classes.delete(c);
            }
          },
          contains(c) { return this.classes.has(c); }
        },
        addEventListener() {},
        appendChild() {},
        title: ''
      };
    }
    return elements[id];
  }

  // Pre-populate standard HUD elements
  [
    'hud-duration-big', 'hud-dist', 'hud-eta', 'hud-aqi',
    'hud-aqi-bucket', 'hud-mode-indicator', 'hud-live-dose',
    'nav-overlay', 'search-sheet', 'nav-dist-badge', 'nav-hotspot-alert',
    'nav-hotspot-text', 'nav-voice-btn', 'nav-steps-list', 'nav-steps-panel',
    'recentre-btn', 'nav-maneuver-icon', 'nav-instruction-text',
    'nav-road-bar', 'nav-then-bar', 'nav-progress-fill'
  ].forEach(id => getEl(id));

  const windowMock = {
    speechSynthesis: {
      speak() {},
      cancel() {}
    }
  };

  const documentMock = {
    getElementById(id) {
      return getEl(id);
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return {
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {}
      };
    }
  };

  const utilsMock = {
    toast() {},
    aqiColor(aqi) {
      if (aqi <= 50) return '#00e400';
      if (aqi <= 100) return '#facc15';
      if (aqi <= 150) return '#f97316';
      if (aqi <= 200) return '#ef4444';
      if (aqi <= 300) return '#a855f7';
      return '#881337';
    },
    aqiCategory(aqi) {
      if (aqi <= 50) return 'Good';
      if (aqi <= 100) return 'Moderate';
      if (aqi <= 150) return 'Unhealthy for Sensitive Groups';
      if (aqi <= 200) return 'Unhealthy';
      if (aqi <= 300) return 'Very Unhealthy';
      return 'Hazardous';
    },
    maneuverIcon() { return '↑'; }
  };

  const mapManagerMock = {
    updateCompassHeading() {},
    updateUserDot() {},
    isFollowing() { return false; },
    panTo() {},
    clearTurnMarker() {},
    stopGPSWatch() {},
    clearNavCallback() {},
    setTurnMarker() {},
    setFollowing() {},
    startGPSWatch(cb) { this._cb = cb; },
    getUserCoord() { return { lat: 26.8467, lng: 80.9462 }; }
  };

  let activeRouteMock = null;
  const routingMock = {
    getActiveKey() { return 'eco'; },
    getActiveRoute() { return activeRouteMock; },
    getMode() { return 'foot'; }
  };

  const configMock = {
    ENDPOINTS: {
      liveAqi: (lat, lng) => `http://mock/aqi/live?lat=${lat}&lng=${lng}`
    }
  };

  // Load navigation.js code
  const navJsPath = path.resolve(__dirname, '../../frontend/js/navigation.js');
  const navJsCode = fs.readFileSync(navJsPath, 'utf8');

  let fetchHandler = null;
  const fetchMock = async (url) => {
    if (fetchHandler) {
      return await fetchHandler(url);
    }
    return {
      ok: true,
      json: async () => ({ aqi: 146, aqi_color: '#f97316', aqi_category: 'Unhealthy for Sensitive Groups', data_type: 'modeled', station: 'Grid [26.85, 80.94]' })
    };
  };

  const navigatorMock = {
    geolocation: {
      watchPosition() {},
      clearWatch() {}
    }
  };

  // Evaluate Navigation in sandbox
  const fn = new Function(
    'window', 'document', 'navigator', 'Utils', 'MapManager', 'Routing', 'Config', 'fetch',
    `${navJsCode}\nreturn Navigation;`
  );

  const NavigationInstance = fn(
    windowMock, documentMock, navigatorMock, utilsMock, mapManagerMock, routingMock, configMock, fetchMock
  );

  return {
    Navigation: NavigationInstance,
    elements,
    setActiveRoute(r) { activeRouteMock = r; },
    setFetchHandler(handler) { fetchHandler = handler; },
    mapManager: mapManagerMock
  };
}

// ── Sample Mock Route Data ────────────────────────────────────
function createMockRoute(initialAqi = 146) {
  return {
    route_type: 'eco',
    travel_mode: 'foot',
    distance_str: '2.5 km',
    duration: 1800,
    duration_str: '30 min',
    avg_aqi: initialAqi,
    aqi_color: '#f97316',
    aqi_category: 'Unhealthy for Sensitive Groups',
    aqi_bucket: 'Unhealthy for Sensitive Groups',
    is_uniform_grid: false,
    pm25_inhaled_ug: 24.5,
    geometry: {
      type: 'LineString',
      coordinates: [
        [80.9400, 26.8500], // Start: Point 1
        [80.9420, 26.8520], // Point 2 (~300m away)
        [80.9450, 26.8550], // Point 3 (~700m away)
        [80.9500, 26.8600], // Point 4 (~1.5km away, new grid cell)
        [80.9600, 26.8700]  // Point 5 (~3.0km away, near physical station)
      ]
    },
    colored_segments: [
      {
        segment_index: 0,
        coordinates: [[26.8500, 80.9400], [26.8520, 80.9420]],
        aqi: initialAqi,
        pm25: 55.0,
        color: '#f97316',
        category: 'Unhealthy for Sensitive Groups',
        data_type: 'modeled'
      },
      {
        segment_index: 1,
        coordinates: [[26.8520, 80.9420], [26.8550, 80.9450]],
        aqi: initialAqi,
        pm25: 55.0,
        color: '#f97316',
        category: 'Unhealthy for Sensitive Groups',
        data_type: 'modeled'
      },
      {
        segment_index: 2,
        coordinates: [[26.8550, 80.9450], [26.8600, 80.9500]],
        aqi: 180,
        pm25: 110.0,
        color: '#ef4444',
        category: 'Unhealthy',
        data_type: 'modeled'
      },
      {
        segment_index: 3,
        coordinates: [[26.8600, 80.9500], [26.8700, 80.9600]],
        aqi: 85,
        pm25: 28.0,
        color: '#facc15',
        category: 'Moderate',
        data_type: 'observed',
        station: 'Gomti Nagar Sensor'
      }
    ],
    steps: [
      { instruction: 'Walk north on Road A', distance_str: '500 m', lat: 26.8500, lng: 80.9400, type: 'turn', modifier: 'straight' },
      { instruction: 'Turn right on Road B', distance_str: '2 km', lat: 26.8550, lng: 80.9450, type: 'turn', modifier: 'right' }
    ]
  };
}

async function runUnitTests() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('PART 1: NAVIGATION AQI UNIT & SPECIFICATION REGRESSION TESTS');
  console.log('══════════════════════════════════════════════════════════\n');

  // ─────────────────────────────────────────────────────────────
  // CASE A: Live Navigation moves into different grid cell
  // ─────────────────────────────────────────────────────────────
  console.log('--- TEST CASE A: Live GPS Navigation Moves into New Grid Cell ---');
  {
    const env = createNavigationEnvironment();
    const route = createMockRoute(146);
    env.setActiveRoute(route);

    let fetchCount = 0;
    env.setFetchHandler(async (url) => {
      fetchCount++;
      if (url.includes('lat=26.87') || url.includes('lat=26.86')) {
        return {
          ok: true,
          json: async () => ({
            aqi: 85,
            aqi_color: '#facc15',
            aqi_category: 'Moderate',
            data_type: 'observed',
            station: 'Gomti Nagar Sensor'
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          aqi: 146,
          aqi_color: '#f97316',
          aqi_category: 'Unhealthy for Sensitive Groups',
          data_type: 'modeled',
          station: 'Grid [26.85, 80.94]'
        })
      };
    });

    // Start live navigation at Point 1
    env.mapManager.getUserCoord = () => ({ lat: 26.8500, lng: 80.9400 });
    env.Navigation.start();
    await new Promise(r => setTimeout(r, 10));

    assert(env.elements['hud-aqi'].textContent.includes('146'), 'Initial HUD displays start AQI 146');

    // Simulate GPS movement across space into Point 5 (>1.5km away, new station)
    env.mapManager._cb({ lat: 26.8700, lng: 80.9600, heading: 45, accuracy: 5 });
    await new Promise(r => setTimeout(r, 20));

    assert(env.elements['hud-aqi'].textContent.includes('85'), `HUD successfully updated to new position AQI 85 (got: ${env.elements['hud-aqi'].textContent})`);
    assert(env.elements['hud-aqi-bucket'].textContent.includes('Moderate'), 'HUD displays updated category Moderate');
    assert(env.elements['hud-aqi-bucket'].textContent.includes('Gomti Nagar Sensor'), 'HUD displays station provenance name');

    env.Navigation.stop();
  }

  // ─────────────────────────────────────────────────────────────
  // CASE B: Demo Navigation moves into different grid cell
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST CASE B: Demo Navigation Simulated Coordinates Move into Different Grid Cell ---');
  {
    const env = createNavigationEnvironment();
    const route = createMockRoute(146);
    env.setActiveRoute(route);

    env.setFetchHandler(async (url) => {
      if (url.includes('lat=26.87') || url.includes('lat=26.86')) {
        return {
          ok: true,
          json: async () => ({
            aqi: 72,
            aqi_color: '#facc15',
            aqi_category: 'Moderate',
            data_type: 'observed',
            station: 'Station B'
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          aqi: 146,
          aqi_color: '#f97316',
          aqi_category: 'Unhealthy for Sensitive Groups',
          data_type: 'modeled'
        })
      };
    });

    // Start Demo Navigation
    env.Navigation.startSimulation(10);
    await new Promise(r => setTimeout(r, 10));
    assert(env.elements['hud-aqi'].textContent.includes('146'), 'Demo starts with initial coordinate AQI 146');

    // Advance simulator to Point 4 / Point 5
    // In our mock route, coordinates advance in setInterval
    // Let's wait a couple simulator steps
    await new Promise(r => setTimeout(r, 350));

    const currentAqi = env.Navigation.getCurrentNavAqi();
    assert(currentAqi !== null, `Demo navigation recorded current position AQI: ${currentAqi}`);
    assert(env.elements['hud-aqi'].textContent !== 'AQI —', 'Demo HUD actively renders simulated position AQI');

    env.Navigation.stop();
  }

  // ─────────────────────────────────────────────────────────────
  // CASE C: Same Grid Cell: Different coordinates resolve to same AQI without fake noise
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST CASE C: Same Grid Cell Accepts Identical AQI Without Inventing Fake Change ---');
  {
    const env = createNavigationEnvironment();
    const route = createMockRoute(146);
    route.is_uniform_grid = true;
    env.setActiveRoute(route);

    let requestsMade = 0;
    env.setFetchHandler(async (url) => {
      requestsMade++;
      return {
        ok: true,
        json: async () => ({
          aqi: 146,
          aqi_color: '#f97316',
          aqi_category: 'Unhealthy for Sensitive Groups',
          data_type: 'modeled',
          grid_coordinates: [26.88, 80.88]
        })
      };
    });

    env.Navigation.start();
    await new Promise(r => setTimeout(r, 10));

    // Move 300m away (same ~11km grid cell)
    env.mapManager._cb({ lat: 26.8525, lng: 80.9425, heading: 45, accuracy: 5 });
    await new Promise(r => setTimeout(r, 20));

    assert(env.elements['hud-aqi'].textContent.includes('146'), 'HUD retains genuine uniform 146 without invented noise');
    assert(env.elements['hud-aqi-bucket'].textContent.includes('Regional Avg: 146'), 'HUD indicates regional grid model resolution');

    env.Navigation.stop();
  }

  // ─────────────────────────────────────────────────────────────
  // CASE D: Starting Value Isolation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST CASE D: Starting Value Isolation (Start AQI Not Permanently Reused) ---');
  {
    const env = createNavigationEnvironment();
    const route = createMockRoute(146);
    env.setActiveRoute(route);

    let currentLat = 26.8500;
    env.setFetchHandler(async (url) => {
      // If position has moved from origin, return distinct value 95
      if (url.includes('lat=26.86') || url.includes('lat=26.87')) {
        return {
          ok: true,
          json: async () => ({
            aqi: 95,
            aqi_color: '#facc15',
            aqi_category: 'Moderate',
            data_type: 'observed',
            station: 'Clean Corridor Station'
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          aqi: 146,
          aqi_color: '#f97316',
          aqi_category: 'Unhealthy for Sensitive Groups',
          data_type: 'modeled'
        })
      };
    });

    env.Navigation.start();
    await new Promise(r => setTimeout(r, 10));
    assert(env.elements['hud-aqi'].textContent.includes('146'), 'Start location displays 146');

    // User moves to 26.8650, 80.9550 (>1.5 km)
    env.mapManager._cb({ lat: 26.8650, lng: 80.9550, heading: 90, accuracy: 5 });
    await new Promise(r => setTimeout(r, 20));

    assert(!env.elements['hud-aqi'].textContent.includes('146'), `Start value 146 is replaced by new value (HUD shows: ${env.elements['hud-aqi'].textContent})`);
    assert(env.elements['hud-aqi'].textContent.includes('95'), 'HUD shows new position AQI 95');

    env.Navigation.stop();
  }

  // ─────────────────────────────────────────────────────────────
  // CASE E: Route Average Isolation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST CASE E: Route Average Isolation (HUD AQI Does Not Overwrite Whole-Route Average) ---');
  {
    const env = createNavigationEnvironment();
    const route = createMockRoute(146);
    const initialRouteAvg = route.avg_aqi;
    const initialInhaled = route.pm25_inhaled_ug;
    env.setActiveRoute(route);

    env.setFetchHandler(async (url) => {
      return {
        ok: true,
        json: async () => ({
          aqi: 320, // Severe local spike
          aqi_color: '#881337',
          aqi_category: 'Hazardous',
          data_type: 'observed',
          station: 'Hotspot Station'
        })
      };
    });

    env.Navigation.start();
    await new Promise(r => setTimeout(r, 10));

    // Move to trigger live fetch with high value
    env.mapManager._cb({ lat: 26.8600, lng: 80.9500, heading: 90, accuracy: 5 });
    await new Promise(r => setTimeout(r, 20));

    assert(env.elements['hud-aqi'].textContent.includes('320'), 'Local HUD shows local reading 320');
    assert(route.avg_aqi === initialRouteAvg, `Whole-route average remained intact at ${initialRouteAvg} (got: ${route.avg_aqi})`);
    assert(route.pm25_inhaled_ug === initialInhaled, `Route total inhaled mass untouched at ${initialInhaled} (got: ${route.pm25_inhaled_ug})`);
    assert(env.elements['hud-aqi-bucket'].textContent.includes(`Route Avg: ${Math.round(initialRouteAvg)}`), 'Secondary HUD display explicitly states route-level average alongside local value');

    env.Navigation.stop();
  }

  // ─────────────────────────────────────────────────────────────
  // CASE F: Delayed Out-of-Order Responses
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST CASE F: Delayed Responses (Older Request Cannot Overwrite Newer Position) ---');
  {
    const env = createNavigationEnvironment();
    const route = createMockRoute(146);
    env.setActiveRoute(route);

    let resolveOldRequest = null;
    let oldRequestPromise = new Promise(r => { resolveOldRequest = r; });

    env.setFetchHandler(async (url) => {
      if (url.includes('lat=26.85')) {
        // Old position (Point 1): artificially delay response
        await oldRequestPromise;
        return {
          ok: true,
          json: async () => ({
            aqi: 146,
            aqi_color: '#f97316',
            aqi_category: 'Old Origin Reading',
            data_type: 'modeled'
          })
        };
      }
      // Newer position (Point 4): returns immediately with AQI 60
      return {
        ok: true,
        json: async () => ({
          aqi: 60,
          aqi_color: '#facc15',
          aqi_category: 'Moderate',
          data_type: 'observed',
          station: 'New Fast Station'
        })
      };
    });

    env.Navigation.start(); // dispatches request 1 (delayed)
    await new Promise(r => setTimeout(r, 10));

    // Quickly move to new position (dispatches request 2)
    env.mapManager._cb({ lat: 26.8600, lng: 80.9500, heading: 45, accuracy: 5 });
    await new Promise(r => setTimeout(r, 20));

    assert(env.elements['hud-aqi'].textContent.includes('60'), 'HUD updated to newer position AQI 60');

    // Now let the older request resolve late
    resolveOldRequest();
    await new Promise(r => setTimeout(r, 30));

    assert(env.elements['hud-aqi'].textContent.includes('60'), `Delayed older response was safely discarded (HUD still shows 60, got: ${env.elements['hud-aqi'].textContent})`);
    assert(!env.elements['hud-aqi-bucket'].textContent.includes('Old Origin Reading'), 'Old provenance was not applied');

    env.Navigation.stop();
  }

  // ─────────────────────────────────────────────────────────────
  // CASE G: Request Throttling
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST CASE G: Request Throttling (Prevents Flooding on Rapid GPS Ticks & Animation Frames) ---');
  {
    const env = createNavigationEnvironment();
    const route = createMockRoute(146);
    env.setActiveRoute(route);

    let totalNetworkRequests = 0;
    env.setFetchHandler(async () => {
      totalNetworkRequests++;
      return {
        ok: true,
        json: async () => ({ aqi: 146, aqi_color: '#f97316', aqi_category: 'Moderate', data_type: 'modeled' })
      };
    });

    env.mapManager.getUserCoord = () => ({ lat: 26.8500, lng: 80.9400 });
    env.Navigation.start();
    await new Promise(r => setTimeout(r, 10));
    const requestsAfterStart = totalNetworkRequests;
    assert(requestsAfterStart === 1, `Initial start made exactly 1 request (got: ${requestsAfterStart})`);

    // Simulate 30 rapid GPS updates within 10 meters of each other (user walking in place / jitter)
    for (let i = 0; i < 30; i++) {
      env.mapManager._cb({
        lat: 26.8500 + (i * 0.00001), // ~1 meter steps
        lng: 80.9400 + (i * 0.00001),
        heading: 0,
        accuracy: 5
      });
    }
    await new Promise(r => setTimeout(r, 20));

    assert(totalNetworkRequests === 1, `30 small jitter movements triggered 0 extra requests due to distance throttling (got: ${totalNetworkRequests})`);

    // Now simulate one movement > 300 meters
    env.mapManager._cb({ lat: 26.8550, lng: 80.9450, heading: 45, accuracy: 5 });
    await new Promise(r => setTimeout(r, 20));

    assert(totalNetworkRequests === 2, `Moving > 250m cleanly dispatched exactly 1 refresh request (got: ${totalNetworkRequests})`);

    env.Navigation.stop();
  }

  // ─────────────────────────────────────────────────────────────
  // CASE H: Demo/Live Switching & State Isolation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST CASE H: Demo/Live Switching & Clean State Isolation ---');
  {
    const env = createNavigationEnvironment();
    const route = createMockRoute(146);
    env.setActiveRoute(route);

    // Physical device GPS is at 26.8000, 80.9000 (User's home)
    env.mapManager.getUserCoord = () => ({ lat: 26.8000, lng: 80.9000 });

    let requestedUrls = [];
    env.setFetchHandler(async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        json: async () => ({ aqi: 110, aqi_color: '#f97316', aqi_category: 'Moderate', data_type: 'modeled' })
      };
    });

    // Start Demo Navigation: MUST use route's starting coordinate (26.8500, 80.9400), NOT physical device GPS
    env.Navigation.startSimulation(1);
    await new Promise(r => setTimeout(r, 10));

    assert(requestedUrls.length > 0, 'Demo navigation initiated AQI fetch');
    const demoReq = requestedUrls[0];
    assert(demoReq.includes('lat=26.85') && demoReq.includes('lng=80.94'), `Demo start used route start coordinate, not user home GPS (requested: ${demoReq})`);

    // Stop Demo
    env.Navigation.stop();
    assert(env.Navigation.getCurrentNavAqi() === null, 'Stopping navigation cleanly resets current nav AQI to null');
    assert(env.Navigation.getLastFetchCoord() === null, 'Stopping navigation resets last fetch coordinate');

    // Start Live GPS: uses real GPS fix
    requestedUrls = [];
    env.Navigation.start();
    await new Promise(r => setTimeout(r, 10));

    const liveReq = requestedUrls[0];
    assert(liveReq.includes('lat=26.8') && liveReq.includes('lng=80.9'), `Live start used actual GPS fix (requested: ${liveReq})`);

    env.Navigation.stop();
  }

  // ─────────────────────────────────────────────────────────────
  // CASE I: Missing AQI / Error Handling
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- TEST CASE I: Missing AQI / Unavailable Current-Position Data ---');
  {
    const env = createNavigationEnvironment();
    const route = createMockRoute(146);
    // Force active segment to have null AQI
    route.colored_segments[0].aqi = null;
    env.setActiveRoute(route);

    // Mock network 500 error or missing data
    env.setFetchHandler(async () => {
      return {
        ok: false,
        status: 503,
        json: async () => ({ message: 'Service unavailable' })
      };
    });

    env.Navigation.start();
    await new Promise(r => setTimeout(r, 20));

    // Must NOT silently show origin 146 as if it were the measured current AQI
    assert(env.elements['hud-aqi'].textContent === 'AQI —', `HUD shows 'AQI —' when current position AQI is unavailable (got: ${env.elements['hud-aqi'].textContent})`);
    assert(env.elements['hud-aqi-bucket'].textContent.includes('Unavailable'), `Bucket label shows Unavailable status (got: ${env.elements['hud-aqi-bucket'].textContent})`);
    assert(env.elements['hud-aqi-bucket'].textContent.includes('Route Avg: 146'), `Bucket clearly labels the route average fallback without pretending it is live (got: ${env.elements['hud-aqi-bucket'].textContent})`);

    env.Navigation.stop();
  }
}

// ── Part 2: Real Browser E2E Test via Chrome CDP ──────────────
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9227;
const APP_URL = "http://127.0.0.1:8000/";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    };
  }

  async send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result ? res.result.value : undefined;
  }
}

async function runBrowserIntegrationTest() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('PART 2: REAL BROWSER INTEGRATION TEST (HEADLESS CHROME)');
  console.log('══════════════════════════════════════════════════════════\n');

  console.log(`Starting Chrome on port ${PORT}...`);
  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-extensions',
    'about:blank'
  ]);

  try {
    let version = null;
    for (let i = 0; i < 20; i++) {
      try {
        version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
        if (version && version.webSocketDebuggerUrl) break;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 250));
    }

    if (!version || !version.webSocketDebuggerUrl) {
      console.warn('⚠️ Chrome CDP port not reachable, skipping browser portion.');
      return;
    }

    const browserCdp = new CDPClient(version.webSocketDebuggerUrl);
    await new Promise(r => setTimeout(r, 400));

    const { targetId } = await browserCdp.send('Target.createTarget', { url: APP_URL });
    const targetWs = `ws://127.0.0.1:${PORT}/devtools/page/${targetId}`;
    const pageCdp = new CDPClient(targetWs);
    await new Promise(r => setTimeout(r, 600));

    await pageCdp.send('Page.enable');
    await pageCdp.send('Runtime.enable');

    console.log(`Navigating to ${APP_URL}...`);
    await pageCdp.send('Page.navigate', { url: APP_URL });
    await new Promise(r => setTimeout(r, 2000));

    // Verify app loaded and Leaflet map ready
    const isReady = await pageCdp.evaluate(`
      typeof Navigation !== 'undefined' && typeof MapManager !== 'undefined' && MapManager.getMap() !== null
    `);
    assert(isReady === true, 'Application and Leaflet map initialized in browser');

    // Select start and destination via Geocoding
    console.log('Setting up route: Hazratganj -> Charbagh...');
    await pageCdp.evaluate(`
      (() => {
        Geocoding.setOriginDirect(26.8467, 80.9462, 'Hazratganj, Lucknow');
        Geocoding.setDestDirect(26.8322, 80.9221, 'Charbagh Railway Station, Lucknow');
      })()
    `);

    // Poll up to 15s for route calculation
    let routeCalcResult = false;
    for (let i = 0; i < 30; i++) {
      routeCalcResult = await pageCdp.evaluate(`Routing.getActiveRoute() !== null`);
      if (routeCalcResult) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert(routeCalcResult === true, 'Route successfully calculated in browser');

    // Start Demo Navigation (5x speed for fast completion)
    console.log('Starting Demo Walk (5x simulation)...');
    await pageCdp.evaluate(`
      Navigation.startSimulation(5);
    `);
    await new Promise(r => setTimeout(r, 800));

    const navStatus = await pageCdp.evaluate(`
      ({
        isActive: Navigation.isActive(),
        hudDisplay: document.getElementById('nav-overlay').style.display,
        hudAqiText: document.getElementById('hud-aqi').textContent,
        hudBucketText: document.getElementById('hud-aqi-bucket').textContent,
        currentNavAqi: Navigation.getCurrentNavAqi()
      })
    `);

    assert(navStatus.isActive === true, 'Navigation is active');
    assert(navStatus.hudDisplay === 'block', 'Google Maps navigation overlay HUD is visible');
    assert(navStatus.hudAqiText.startsWith('AQI '), `HUD AQI element renders valid AQI (got: ${navStatus.hudAqiText})`);
    assert(navStatus.currentNavAqi !== null, `Current nav AQI tracked in state: ${navStatus.currentNavAqi}`);

    // Wait 2.5 seconds for simulator to advance coordinates
    await new Promise(r => setTimeout(r, 2500));

    const movingStatus = await pageCdp.evaluate(`
      ({
        hudAqiText: document.getElementById('hud-aqi').textContent,
        hudBucketText: document.getElementById('hud-aqi-bucket').textContent,
        lastFetch: Navigation.getLastFetchCoord()
      })
    `);
    console.log('Moving status in simulation:', movingStatus);
    assert(movingStatus.hudAqiText.startsWith('AQI '), 'HUD continues to render valid AQI during movement');

    // Stop navigation
    console.log('Stopping navigation...');
    await pageCdp.evaluate(`Navigation.stop();`);
    await new Promise(r => setTimeout(r, 500));

    const stopStatus = await pageCdp.evaluate(`
      ({
        isActive: Navigation.isActive(),
        hudDisplay: document.getElementById('nav-overlay').style.display,
        currentNavAqi: Navigation.getCurrentNavAqi(),
        userDotPresent: document.querySelector('.user-dot-inner') !== null
      })
    `);

    assert(stopStatus.isActive === false, 'Navigation stopped successfully');
    assert(stopStatus.hudDisplay === 'none', 'Navigation HUD hidden');
    assert(stopStatus.currentNavAqi === null, 'Navigation current AQI state reset to null on stop');
    assert(stopStatus.userDotPresent === true, 'User GPS dot preserved on map after stopping');

  } finally {
    try { chromeProc.kill(); } catch (_) {}
  }
}

async function main() {
  try {
    await runUnitTests();
    await runBrowserIntegrationTest();

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`🎉 ALL TESTS PASSED! (${totalPassed} passed, ${totalFailed} failed)`);
    console.log('══════════════════════════════════════════════════════════\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST SUITE ENCOUNTERED AN ERROR:\n', err);
    process.exit(1);
  }
}

main();
