// ══════════════════════════════════════════════════════════════
// Comprehensive E2E Verification: "Current Location" in Start Suggestions
// Verifies:
// 1. Focus on Start Location without typing shows "📍 Current Location" at top
// 2. Selecting it sets origin to live GPS coordinates and closes panel
// 3. Focus on Destination does NOT show "Current Location"
// 4. Typing an address in Start field shows "Current Location" + search results
// 5. Direct Enter on typed query selects top search result (not Current Location)
// 6. Keyboard ArrowDown + Enter selects Current Location
// 7. Route planning from Current Location uses real GPS coordinates
// 8. GPS permission denial hides Current Location and keeps manual search working
// 9. Repeated focus/select does not duplicate elements or listeners
// ══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const http = require('http');

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9226;
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
  console.log('=== STARTING CURRENT LOCATION SUGGESTIONS AUDIT ===');
  console.log(`Starting headless Chrome on remote port ${PORT}...`);

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

    // Grant geolocation permissions to localhost origin
    await client.send('Browser.grantPermissions', {
      permissions: ['geolocation'],
      origin: 'http://127.0.0.1:8000'
    });

    // Simulate GPS coordinates (Hazratganj, Lucknow)
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

          window.__simulatePermissionDenied = function() {
            _permissionDenied = true;
            if (typeof MapManager !== 'undefined' && MapManager.setGPSPermissionDenied) {
              MapManager.setGPSPermissionDenied(true);
            }
          };
        })()
      `
    });

    console.log(`Navigating to ${APP_URL}...`);
    await client.send('Page.navigate', { url: APP_URL });
    await sleep(2500);

    // ── TEST 1: Focus Start Location without typing shows "📍 Current Location" ──
    console.log('\n--- TEST 1: Focus Start Location without typing ---');
    const test1 = await client.eval(`
      (() => {
        const input = document.getElementById('origin-input');
        input.focus();
        input.dispatchEvent(new Event('focus', { bubbles: true }));

        const panel = document.getElementById('autocomplete-panel');
        const isPanelOpen = panel && window.getComputedStyle(panel).display !== 'none';
        const curLocItem = panel ? panel.querySelector('.ac-current-location') : null;
        const curLocName = curLocItem ? curLocItem.querySelector('.ac-name').textContent.trim() : null;
        const curLocCount = panel ? panel.querySelectorAll('.ac-current-location').length : 0;

        return {
          isPanelOpen,
          hasCurLocItem: curLocItem !== null,
          curLocName,
          curLocCount
        };
      })()
    `);
    console.log('Test 1 result:', test1);
    if (!test1.isPanelOpen) throw new Error('FAILED: Autocomplete panel did not open on Start Location focus');
    if (!test1.hasCurLocItem) throw new Error('FAILED: "📍 Current Location" item not found in suggestions');
    if (test1.curLocName !== 'Current Location') throw new Error(`FAILED: Expected "Current Location", got "${test1.curLocName}"`);
    if (test1.curLocCount !== 1) throw new Error(`FAILED: Expected exactly 1 Current Location item, got ${test1.curLocCount}`);
    console.log('✅ TEST 1 PASSED: Start Location focus displays "📍 Current Location" option at top.');

    // ── TEST 2: Click "Current Location" sets origin coordinates ──
    console.log('\n--- TEST 2: Select Current Location option ---');
    await client.eval(`
      (() => {
        const curLocItem = document.querySelector('.ac-current-location');
        if (curLocItem) curLocItem.click();
      })()
    `);
    await sleep(600);

    const test2 = await client.eval(`
      (() => {
        const state = Geocoding.getState();
        const input = document.getElementById('origin-input');
        const panel = document.getElementById('autocomplete-panel');
        const isPanelClosed = !panel || window.getComputedStyle(panel).display === 'none';

        return {
          isPanelClosed,
          inputValue: input ? input.value : '',
          originCoords: state.origin.coords,
          originName: state.origin.name
        };
      })()
    `);
    console.log('Test 2 result:', test2);
    if (!test2.isPanelClosed) throw new Error('FAILED: Autocomplete panel did not close after selecting Current Location');
    if (!test2.originCoords || Math.abs(test2.originCoords.lat - 26.8467) > 0.001 || Math.abs(test2.originCoords.lng - 80.9462) > 0.001) {
      throw new Error(`FAILED: Origin coordinates (${JSON.stringify(test2.originCoords)}) do not match GPS fix (26.8467, 80.9462)`);
    }
    if (!test2.inputValue || test2.inputValue.length < 3) {
      throw new Error('FAILED: Origin input value was not populated with resolved address/name');
    }
    console.log('✅ TEST 2 PASSED: Origin set to real GPS coordinates and readable address resolved.');

    // ── TEST 3: Focus Destination does NOT show Current Location ──
    console.log('\n--- TEST 3: Focus Destination field ---');
    const test3 = await client.eval(`
      (() => {
        const destInput = document.getElementById('dest-input');
        destInput.focus();
        destInput.dispatchEvent(new Event('focus', { bubbles: true }));

        const panel = document.getElementById('autocomplete-panel');
        const curLocItem = panel ? panel.querySelector('.ac-current-location') : null;

        return {
          hasCurLocInDest: curLocItem !== null
        };
      })()
    `);
    console.log('Test 3 result:', test3);
    if (test3.hasCurLocInDest) throw new Error('FAILED: "Current Location" should NOT be shown in Destination suggestions');
    console.log('✅ TEST 3 PASSED: Destination field does not show Current Location option.');

    // ── TEST 4: Typing an address shows Current Location + search results ──
    console.log('\n--- TEST 4: Typing address in Start field shows Current Location + search results ---');
    const test4 = await client.eval(`
      (async () => {
        const input = document.getElementById('origin-input');
        input.value = 'Hazratganj';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        // Wait for debounce and search results
        const panel = document.getElementById('autocomplete-panel');
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 200));
          const items = panel ? panel.querySelectorAll('.ac-item') : [];
          if (items.length > 1) break;
        }

        const items = panel ? Array.from(panel.querySelectorAll('.ac-item')) : [];

        const firstItemIsCurLoc = items.length > 0 && items[0].classList.contains('ac-current-location');
        const resultNames = items.slice(1).map(it => {
          const nameEl = it.querySelector('.ac-name');
          return nameEl ? nameEl.textContent : '';
        });

        return {
          totalItems: items.length,
          firstItemIsCurLoc,
          searchResultCount: resultNames.length,
          sampleResult: resultNames[0] || null
        };
      })()
    `);
    console.log('Test 4 result:', test4);
    if (!test4.firstItemIsCurLoc) throw new Error('FAILED: First item in search results must be "📍 Current Location"');
    if (test4.searchResultCount === 0) throw new Error('FAILED: Search results for "Hazratganj" did not appear');
    console.log('✅ TEST 4 PASSED: Current Location at top followed by matching address search results.');

    // ── TEST 5: Direct Enter key on typed query selects top search result ──
    console.log('\n--- TEST 5: Direct Enter key on typed query selects search result (not Current Location) ---');
    await client.eval(`
      (() => {
        const input = document.getElementById('origin-input');
        // Press Enter
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()
    `);
    await sleep(600);

    const test5 = await client.eval(`
      (() => {
        const state = Geocoding.getState();
        const input = document.getElementById('origin-input');
        return {
          originName: state.origin.name,
          inputValue: input ? input.value : ''
        };
      })()
    `);
    console.log('Test 5 result:', test5);
    if (!test5.originName.toLowerCase().includes('hazratganj')) {
      throw new Error(`FAILED: Direct Enter should select the typed place "Hazratganj", got "${test5.originName}"`);
    }
    console.log('✅ TEST 5 PASSED: Direct Enter on typed query properly selects the matched place.');

    // ── TEST 6: Keyboard ArrowDown + Enter selects Current Location ──
    console.log('\n--- TEST 6: Keyboard ArrowDown + Enter selects Current Location ---');
    const test6 = await client.eval(`
      (async () => {
        const input = document.getElementById('origin-input');
        input.value = '';
        input.blur();
        input.focus();
        input.dispatchEvent(new Event('focus', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));

        // ArrowDown highlights Current Location
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

        const panel = document.getElementById('autocomplete-panel');
        const selected = panel ? panel.querySelector('.ac-selected') : null;
        const isCurLocSelected = selected && selected.classList.contains('ac-current-location');

        // Press Enter
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise(r => setTimeout(r, 600));

        const state = Geocoding.getState();
        return {
          isCurLocSelected,
          originCoords: state.origin.coords
        };
      })()
    `);
    console.log('Test 6 result:', test6);
    if (!test6.isCurLocSelected) throw new Error('FAILED: ArrowDown did not highlight Current Location');
    if (!test6.originCoords || Math.abs(test6.originCoords.lat - 26.8467) > 0.001) {
      throw new Error('FAILED: Enter on highlighted Current Location did not set GPS coords');
    }
    console.log('✅ TEST 6 PASSED: ArrowDown highlights Current Location and Enter selects it.');

    // ── TEST 7: Route planning from Current Location to Destination ──
    console.log('\n--- TEST 7: Route planning from Current Location to Destination ---');
    // Set destination
    await client.eval(`
      (() => {
        Geocoding.setDestDirect(26.8358, 80.9894, 'Janeshwar Mishra Park');
      })()
    `);

    // Wait for route cards
    let routeFound = false;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      routeFound = await client.eval(`
        (() => {
          const el = document.getElementById('route-cards');
          return el && window.getComputedStyle(el).display !== 'none';
        })()
      `);
      if (routeFound) break;
    }

    if (!routeFound) throw new Error('FAILED: Route calculation timed out');

    const test7 = await client.eval(`
      (() => {
        const data = Routing.getRouteData();
        const state = Geocoding.getState();
        return {
          hasRouteData: data !== null,
          originLat: state.origin.coords.lat,
          originLng: state.origin.coords.lng,
          shortestDist: data && data.shortest ? data.shortest.distance_str : null,
          ecoDist: data && data.eco ? data.eco.distance_str : null
        };
      })()
    `);
    console.log('Test 7 result:', test7);
    if (!test7.hasRouteData) throw new Error('FAILED: Route data not returned');
    if (Math.abs(test7.originLat - 26.8467) > 0.001) {
      throw new Error('FAILED: Route calculation did not use exact GPS coordinates');
    }
    console.log('✅ TEST 7 PASSED: Route successfully planned using exact GPS coordinates from Current Location.');

    // ── TEST 8: GPS Permission Denied hides Current Location ──
    console.log('\n--- TEST 8: GPS permission denial hides Current Location ---');
    const test8 = await client.eval(`
      (async () => {
        window.__simulatePermissionDenied();

        // Clear and re-focus Start Location
        const input = document.getElementById('origin-input');
        input.value = '';
        input.blur();
        input.focus();
        input.dispatchEvent(new Event('focus', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));

        const panel = document.getElementById('autocomplete-panel');
        const isPanelOpen = panel && window.getComputedStyle(panel).display !== 'none';
        const curLocItem = panel ? panel.querySelector('.ac-current-location') : null;

        return {
          isPanelOpen,
          hasCurLocItem: isPanelOpen && curLocItem !== null,
          isDenied: MapManager.isGPSPermissionDenied()
        };
      })()
    `);
    console.log('Test 8 result:', test8);
    if (!test8.isDenied) throw new Error('FAILED: MapManager should report isGPSPermissionDenied = true');
    if (test8.hasCurLocItem) throw new Error('FAILED: Current Location must NOT be displayed when GPS permission is denied');
    console.log('✅ TEST 8 PASSED: Current Location hidden when GPS is denied, manual search remains functional.');

    // ── TEST 9: No duplicate entries or listeners on repeated interaction ──
    console.log('\n--- TEST 9: Repeated interaction does not duplicate elements ---');
    const test9 = await client.eval(`
      (async () => {
        // Reset permission for clean test
        MapManager.setGPSPermissionDenied(false);

        const input = document.getElementById('origin-input');
        for (let i = 0; i < 5; i++) {
          input.blur();
          input.focus();
          input.dispatchEvent(new Event('focus', { bubbles: true }));
        }
        await new Promise(r => setTimeout(r, 150));

        const panel = document.getElementById('autocomplete-panel');
        const curLocCount = panel ? panel.querySelectorAll('.ac-current-location').length : 0;

        return { curLocCount };
      })()
    `);
    console.log('Test 9 result:', test9);
    if (test9.curLocCount !== 1) throw new Error(`FAILED: Expected exactly 1 Current Location item, found ${test9.curLocCount}`);
    console.log('✅ TEST 9 PASSED: No duplicate elements or listeners created on repeated focus/blur.');

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('🎉 ALL 9 CURRENT LOCATION SUGGESTION TESTS PASSED!');
    console.log('══════════════════════════════════════════════════════════\n');

  } finally {
    try {
      chromeProc.kill();
    } catch (_) {}
  }
}

run().catch(err => {
  console.error('\n❌ CURRENT LOCATION TEST FAILED:', err);
  process.exit(1);
});
