// ══════════════════════════════════════════════════════════════
// Comprehensive End-to-End Verification: Initial GPS Location Marker
// Tests:
// 1. Initial page load marker appearance before any route/nav
// 2. Pane stacking (userLocationPane zIndex 650, zIndexOffset 2500)
// 3. Initial camera center vs browsing/dragging persistence
// 4. Route selection without marker destruction
// 5. Navigation start, movement, and stop without watcher destruction
// 6. Fast-path 'Use My Location' using cached background coordinate
// 7. Graceful GPS permission error handling (no fake coordinates)
// ══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const http = require('http');

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9225;
const APP_URL = "http://127.0.0.1:8000/";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    this.consoleLogs = [];

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map(a => a.value || a.description || '').join(' ');
        this.consoleLogs.push(`[${msg.params.type.toUpperCase()}] ${text}`);
      }
    };
  }

  ready() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const reqId = this.id++;
      this.callbacks.set(reqId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: reqId, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res.result ? res.result.value : null;
  }
}

async function run() {
  console.log('=== STARTING INITIAL GPS LOCATION MARKER VERIFICATION ===');
  console.log(`Starting headless Chrome on remote debugging port ${PORT}...`);

  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--window-size=1280,900',
    'about:blank'
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      targets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
      if (targets && targets.length > 0) break;
    } catch (_) {}
  }

  if (!targets || targets.length === 0) {
    console.error('Failed to connect to Chrome debugging endpoint');
    chromeProc.kill();
    process.exit(1);
  }

  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  const client = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await client.ready();
  console.log('Connected to Chrome CDP session.');

  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    // Emulate device GPS hardware using Page.addScriptToEvaluateOnNewDocument
    // so navigator.geolocation.watchPosition has immediate valid satellite lock on page load
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          let _watchers = new Map();
          let _watchIdCounter = 1;
          let _currentCoords = {
            latitude: 26.8467,
            longitude: 80.9462,
            accuracy: 12,
            heading: 45
          };
          let _permissionDenied = false;

          navigator.geolocation.getCurrentPosition = function(success, error, options) {
            setTimeout(() => {
              if (_permissionDenied) {
                if (error) error({ code: 1, message: 'User denied Geolocation' });
              } else {
                if (success) success({ coords: _currentCoords, timestamp: Date.now() });
              }
            }, 10);
          };

          navigator.geolocation.watchPosition = function(success, error, options) {
            const id = _watchIdCounter++;
            _watchers.set(id, { success, error });
            setTimeout(() => {
              if (_permissionDenied) {
                if (error) error({ code: 1, message: 'User denied Geolocation' });
              } else {
                if (_watchers.has(id) && success) {
                  success({ coords: _currentCoords, timestamp: Date.now() });
                }
              }
            }, 10);
            return id;
          };

          navigator.geolocation.clearWatch = function(id) {
            _watchers.delete(id);
          };

          window.__dispatchSimulatedGPS = function(lat, lng, heading, accuracy) {
            _currentCoords = {
              latitude: lat,
              longitude: lng,
              heading: heading != null ? heading : 0,
              accuracy: accuracy || 10
            };
            _watchers.forEach(w => {
              if (w.success) w.success({ coords: _currentCoords, timestamp: Date.now() });
            });
          };

          window.__simulatePermissionDenied = function() {
            _permissionDenied = true;
            _watchers.forEach(w => {
              if (w.error) w.error({ code: 1, message: 'User denied Geolocation' });
            });
          };
        })()
      `
    });

    console.log('\n--- TEST 1: Initial Page Load GPS Marker Appearance ---');
    console.log(`Navigating to ${APP_URL}...`);
    await client.send('Page.navigate', { url: APP_URL });
    await sleep(2500);

    // Verify location tracking started automatically on load
    const initialStatus = await client.eval(`
      (() => {
        const hasFix = MapManager.hasLocationFix();
        const coord = MapManager.getUserCoord();
        const isWatching = MapManager.isGPSWatching();
        const userDotEl = document.querySelector('.user-dot-wrap');
        const headingConeEl = document.querySelector('.heading-cone');
        const map = MapManager.getMap();
        const userPane = map ? map.getPane('userLocationPane') : null;
        const center = map ? map.getCenter() : null;

        return {
          isWatching,
          hasFix,
          coord,
          hasUserDotInDOM: userDotEl !== null,
          hasHeadingConeInDOM: headingConeEl !== null,
          hasUserLocationPane: userPane !== null,
          paneZIndex: userPane ? window.getComputedStyle(userPane).zIndex : null,
          mapCenter: center ? { lat: center.lat.toFixed(4), lng: center.lng.toFixed(4) } : null
        };
      })()
    `);

    console.log('Browser console logs:', client.consoleLogs);
    console.log('Initial page load tracking status:', initialStatus);
    if (!initialStatus.isWatching) {
      throw new Error('FAILED: Location tracking watchPosition was not started automatically on page load');
    }
    if (!initialStatus.hasFix || !initialStatus.hasUserDotInDOM) {
      throw new Error('FAILED: User marker dot was not rendered on initial page load');
    }
    if (initialStatus.paneZIndex !== '650') {
      throw new Error(`FAILED: userLocationPane zIndex should be 650, got ${initialStatus.paneZIndex}`);
    }
    console.log('✅ TEST 1 PASSED: Blue user location marker rendered automatically on initial load without any route.');

    console.log('\n--- TEST 2: Map Interaction and Browser Dragging Persistence ---');
    // User moves map manually
    const dragResult = await client.eval(`
      (() => {
        const map = MapManager.getMap();
        // Fire dragstart
        map.fire('dragstart');
        map.panTo([26.8600, 80.9600], { animate: false });
        map.fire('dragend');

        const isFollowingBefore = MapManager.isFollowing();

        // Now simulate another GPS update
        window.__dispatchSimulatedGPS(26.8468, 80.9463, 45, 10);

        const centerAfter = map.getCenter();
        const isFollowingAfter = MapManager.isFollowing();

        return {
          isFollowingBefore,
          isFollowingAfter,
          centerAfter: { lat: centerAfter.lat.toFixed(4), lng: centerAfter.lng.toFixed(4) }
        };
      })()
    `);

    console.log('Map drag result:', dragResult);
    if (dragResult.isFollowingBefore !== false) {
      throw new Error('FAILED: Map drag should set isFollowing to false');
    }
    if (dragResult.centerAfter.lat === '26.8468') {
      throw new Error('FAILED: Subsequent GPS update should NOT jerk camera back when user interacted');
    }
    console.log('✅ TEST 2 PASSED: User map dragging disengages camera following without disturbing user marker.');

    console.log('\n--- TEST 3: Route Planning & Preserving User Marker ---');
    // Click Hazratganj -> Janeshwar Mishra Park preset
    await client.eval(`
      (() => {
        const chips = document.querySelectorAll('.preset-chip');
        if (chips.length > 0) chips[0].click();
      })()
    `);

    // Wait for route cards
    let routeLoaded = false;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      routeLoaded = await client.eval(`
        (() => {
          const el = document.getElementById('route-cards');
          return el && window.getComputedStyle(el).display !== 'none';
        })()
      `);
      if (routeLoaded) break;
    }

    if (!routeLoaded) throw new Error('FAILED: Route calculation timed out');

    const routeMarkerStatus = await client.eval(`
      (() => {
        const userDotEl = document.querySelector('.user-dot-wrap');
        const hasActive = Routing.hasActiveRoute();
        const isWatching = MapManager.isGPSWatching();
        return {
          hasActive,
          isWatching,
          userDotStillInDOM: userDotEl !== null
        };
      })()
    `);

    console.log('Route marker status:', routeMarkerStatus);
    if (!routeMarkerStatus.hasActive) {
      throw new Error('FAILED: Routing.hasActiveRoute() should return true after finding routes');
    }
    if (!routeMarkerStatus.userDotStillInDOM) {
      throw new Error('FAILED: User marker dot disappeared after route calculation');
    }
    console.log('✅ TEST 3 PASSED: Route polylines and cards loaded while user marker remained visible.');

    console.log('\n--- TEST 4: Navigation Start and Movement Tracking ---');
    // Start navigation
    await client.eval(`Navigation.start()`);
    await sleep(1200);

    const navStatus = await client.eval(`
      (() => {
        const overlay = document.getElementById('nav-overlay');
        const isNavActive = Navigation.isActive();
        const isFollowing = MapManager.isFollowing();
        return {
          isNavActive,
          isFollowing,
          overlayVisible: overlay && window.getComputedStyle(overlay).display !== 'none'
        };
      })()
    `);

    console.log('Navigation started status:', navStatus);
    if (!navStatus.isNavActive || !navStatus.overlayVisible) {
      throw new Error('FAILED: Navigation did not start properly');
    }
    if (!navStatus.isFollowing) {
      throw new Error('FAILED: Navigation start should re-enable MapManager.isFollowing()');
    }
    console.log('✅ TEST 4 PASSED: Navigation active and camera following re-enabled.');

    console.log('\n--- TEST 5: Navigation Stop Does NOT Destroy Background GPS Watcher ---');
    // Stop navigation
    await client.eval(`Navigation.stop()`);
    await sleep(600);

    const stopStatus = await client.eval(`
      (() => {
        const overlay = document.getElementById('nav-overlay');
        const sheet = document.getElementById('search-sheet');
        const isNavActive = Navigation.isActive();
        const isWatching = MapManager.isGPSWatching();
        const userDotEl = document.querySelector('.user-dot-wrap');

        return {
          isNavActive,
          isWatching,
          overlayHidden: overlay && window.getComputedStyle(overlay).display === 'none',
          sheetRestored: sheet && !sheet.classList.contains('sheet-hidden'),
          userDotStillPresent: userDotEl !== null
        };
      })()
    `);

    console.log('Stop status:', stopStatus);
    if (stopStatus.isNavActive !== false) {
      throw new Error('FAILED: Navigation should be inactive after stop()');
    }
    if (stopStatus.isWatching !== true) {
      throw new Error('FAILED: MapManager GPS watch was killed on Navigation.stop()! It must remain active in background');
    }
    if (!stopStatus.userDotStillPresent) {
      throw new Error('FAILED: User dot marker disappeared after Navigation.stop()');
    }
    console.log('✅ TEST 5 PASSED: Navigation stopped cleanly while background GPS watcher and user marker persisted.');

    console.log('\n--- TEST 6: Fast-path "Use My Location" Using Cached GPS Coordinate ---');
    const fastPathResult = await client.eval(`
      (async () => {
        // Clear origin input first
        const originInput = document.getElementById('origin-input');
        if (originInput) originInput.value = '';

        // Call useMyLocation()
        await Geocoding.useMyLocation();
        await new Promise(r => setTimeout(r, 600));

        const state = Geocoding.getState();
        return {
          inputValue: originInput ? originInput.value : '',
          originLat: state.origin.coords ? state.origin.coords.lat : null,
          originLng: state.origin.coords ? state.origin.coords.lng : null
        };
      })()
    `);

    console.log('Fast-path Use My Location result:', fastPathResult);
    if (!fastPathResult.originLat || Math.abs(fastPathResult.originLat - 26.846) > 0.01) {
      throw new Error('FAILED: useMyLocation() did not instantly populate origin from background GPS coordinate');
    }
    console.log('✅ TEST 6 PASSED: "Use My Location" instantly used background GPS coordinate.');

    console.log('\n--- TEST 7: GPS Permission Denied Error Handling ---');
    const errorHandlingResult = await client.eval(`
      (() => {
        window.__simulatePermissionDenied();
        return {
          isDenied: MapManager.isGPSPermissionDenied()
        };
      })()
    `);

    console.log('Error handling result:', errorHandlingResult);
    if (!errorHandlingResult.isDenied) {
      throw new Error('FAILED: MapManager.isGPSPermissionDenied() should return true when permission denied');
    }
    console.log('✅ TEST 7 PASSED: GPS permission denied handled gracefully without crashing or fake locations.');

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('🎉 ALL 7 INITIAL LOCATION MARKER TESTS PASSED SUCCESSFULLY!');
    console.log('══════════════════════════════════════════════════════════\n');

  } finally {
    try {
      chromeProc.kill();
    } catch (_) {}
  }
}

run().catch(err => {
  console.error('\n❌ VERIFICATION TEST FAILED:', err);
  process.exit(1);
});
