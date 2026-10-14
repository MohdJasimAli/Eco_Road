const { spawn } = require('child_process');
const http = require('http');

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9235;
const APP_URL = "http://127.0.0.1:8000/";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.requestedUrls = [];
    this.consoleLogs = [];

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      } else if (msg.method === 'Network.requestWillBeSent') {
        this.requestedUrls.push(msg.params.request.url);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map(a => a.value || a.description || '').join(' ');
        this.consoleLogs.push(`[${msg.params.type}] ${text}`);
      }
    };
  }

  ready() {
    return new Promise(r => {
      if (this.ws.readyState === WebSocket.OPEN) return r();
      this.ws.onopen = r;
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const reqId = this.id++;
      this.callbacks.set(reqId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: reqId, method, params }));
    });
  }

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result ? res.result.value : null;
  }
}

async function runAudit() {
  console.log('====================================================');
  console.log('   ECO_ROAD MASTER BUG AUDIT & VERIFICATION TEST    ');
  console.log('====================================================\n');

  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    'about:blank'
  ]);

  let passCount = 0;
  let failCount = 0;
  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passCount++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failCount++;
    }
  }

  try {
    await sleep(2000);
    const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) throw new Error('No page target found');
    const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.ready();

    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // ────────────────────────────────────────────────
    // TEST SECTION 1: Basemap & Service Worker (Bug 2)
    // ────────────────────────────────────────────────
    console.log('>>> [1/4] AUDITING BASEMAP & SERVICE WORKER LIFECYCLE (BUG 2)...');
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(2500);

    const tileInfo = await cdp.eval(`
      (() => {
        const tileLayer = MapManager.getTileLayer();
        const urlTemplate = tileLayer ? tileLayer._url : '';
        const tiles = Array.from(document.querySelectorAll('.leaflet-tile-pane img')).map(img => img.src);
        return {
          urlTemplate,
          tilesSample: tiles.slice(0, 3)
        };
      })()
    `);

    assert(tileInfo.urlTemplate.includes('openstreetmap.org'), 'Active Leaflet tile template uses OpenStreetMap');
    assert(!tileInfo.urlTemplate.includes('cartocdn.com'), 'Active Leaflet tile template does NOT contain obsolete CARTO URLs');
    const hasCartoNetwork = cdp.requestedUrls.some(u => u.includes('cartocdn.com'));
    assert(!hasCartoNetwork, 'Network log confirms 0 requests to obsolete CARTO tile servers');

    // Test Ordinary Reload (F5 equivalent)
    console.log('  Testing ordinary page reload (F5 navigation without cache bypass)...');
    cdp.requestedUrls = [];
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(2500);

    const reloadedTile = await cdp.eval(`
      (() => {
        const t = MapManager.getTileLayer();
        return t ? t._url : '';
      })()
    `);
    assert(reloadedTile.includes('openstreetmap.org'), 'After ordinary reload, basemap remains official OpenStreetMap');
    assert(!reloadedTile.includes('cartocdn.com'), 'After ordinary reload, no CARTO URL restored');

    // Check Service Worker registration and cache
    const swInfo = await cdp.eval(`
      (async () => {
        if (!('serviceWorker' in navigator)) return { supported: false };
        const reg = await navigator.serviceWorker.getRegistration();
        const keys = await caches.keys();
        return {
          supported: true,
          registered: !!reg,
          cacheKeys: keys
        };
      })()
    `);
    assert(swInfo.supported && swInfo.registered, 'PWA Service Worker is registered');
    assert(swInfo.cacheKeys.includes('ecoroad-v2-osm'), 'Service worker cache upgraded to ecoroad-v2-osm');
    assert(!swInfo.cacheKeys.includes('ecoroad-v1'), 'Obsolete ecoroad-v1 cache has been purged');

    // ────────────────────────────────────────────────
    // TEST SECTION 2: Search & Map Sync (Bug 1)
    // ────────────────────────────────────────────────
    console.log('\n>>> [2/4] AUDITING PLACE SEARCH & MAP SYNCHRONIZATION (BUG 1)...');

    // Step A: Search Origin with autocomplete
    await cdp.eval(`
      const input = document.getElementById('origin-input');
      input.focus();
      input.value = 'Hazratganj';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await sleep(1500);

    const acOrigin = await cdp.eval(`
      (() => {
        const panel = document.getElementById('autocomplete-panel');
        const items = panel ? panel.querySelectorAll('.ac-item') : [];
        return {
          display: panel ? window.getComputedStyle(panel).display : 'none',
          count: items.length,
          topName: items[0]?.querySelector('.ac-name')?.textContent || ''
        };
      })()
    `);
    assert(acOrigin.display === 'block' && acOrigin.count > 0, `Search dropdown displayed ${acOrigin.count} results for 'Hazratganj'`);

    // Click first item to select
    await cdp.eval(`
      const items = document.querySelectorAll('.ac-item');
      if (items.length > 0) items[0].click();
    `);
    await sleep(800);

    const originSync = await cdp.eval(`
      (() => {
        const state = Geocoding.getState();
        const map = MapManager.getMap();
        const center = map.getCenter();
        const marker = MapManager.getMap().hasLayer(MapManager.getLayers().activeRoute); // check map responsive
        return {
          originCoords: state.origin.coords,
          originName: state.origin.name,
          inputVal: document.getElementById('origin-input').value,
          centerDist: Math.hypot(center.lat - state.origin.coords.lat, center.lng - state.origin.coords.lng)
        };
      })()
    `);
    assert(originSync.originCoords && originSync.originCoords.lat > 26 && originSync.originCoords.lng > 80, `Origin coordinates resolved correctly: (${originSync.originCoords?.lat}, ${originSync.originCoords?.lng})`);
    assert(originSync.inputVal.toLowerCase().includes('hazratganj'), `Search input reflects resolved place: "${originSync.inputVal}"`);
    assert(originSync.centerDist < 0.05, 'Map smoothly centered/panned to selected origin location');

    // Step B: Search Destination with direct Enter key press
    console.log('  Testing destination search with direct Enter key...');
    await cdp.eval(`
      (() => {
        const input = document.getElementById('dest-input');
        input.focus();
        input.value = 'Janeshwar Mishra';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(600);

    // Press Enter directly to trigger selection
    await cdp.eval(`
      (() => {
        const input = document.getElementById('dest-input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()
    `);
    await sleep(3500);

    const destSync = await cdp.eval(`
      (() => {
        const state = Geocoding.getState();
        return {
          destCoords: state.dest.coords,
          destName: state.dest.name,
          inputVal: document.getElementById('dest-input').value
        };
      })()
    `);
    assert(destSync.destCoords && destSync.destCoords.lat > 26 && destSync.destCoords.lng > 80, `Destination resolved via Enter: (${destSync.destCoords?.lat}, ${destSync.destCoords?.lng})`);
    assert(destSync.inputVal.length > 0, `Destination input populated: "${destSync.inputVal}"`);

    // ────────────────────────────────────────────────
    // TEST SECTION 3: Route Rendering Without Toggle (Bug 3)
    // ────────────────────────────────────────────────
    console.log('\n>>> [3/4] AUDITING ROUTE RENDERING & OVERLAY INDEPENDENCE (BUG 3)...');

    // Wait up to 10s for route calculation to complete
    let hasRouteData = false;
    for (let i = 0; i < 20; i++) {
      hasRouteData = await cdp.eval(`!!Routing.getRouteData()`);
      if (hasRouteData) break;
      await sleep(500);
    }

    const routeRender = await cdp.eval(`
      (() => {
        const routeData = Routing.getRouteData();
        const cards = document.getElementById('route-cards');
        const layers = MapManager.getLayers();
        const svg = document.querySelector('.leaflet-overlay-pane svg');
        
        const paths = svg ? Array.from(svg.querySelectorAll('path')).map(p => ({
          d: p.getAttribute('d') || '',
          stroke: p.getAttribute('stroke') || '',
          strokeWidth: parseFloat(p.getAttribute('stroke-width') || '0'),
          strokeOpacity: p.getAttribute('stroke-opacity') || ''
        })) : [];

        // Filter route line polylines (weight >= 5)
        const routePaths = paths.filter(p => p.strokeWidth >= 5 && p.d.length > 50);

        return {
          hasRouteData: !!routeData,
          cardsVisible: cards && window.getComputedStyle(cards).display !== 'none',
          shortestDist: routeData?.shortest?.distance_str,
          ecoDist: routeData?.eco?.distance_str,
          totalPathsInSvg: paths.length,
          renderedRoutePolylinesCount: routePaths.length,
          routeStrokeColors: routePaths.map(p => p.stroke)
        };
      })()
    `);

    assert(routeRender.hasRouteData, 'Route API response received automatically after origin & destination set');
    assert(routeRender.cardsVisible, 'Route detail cards displayed');
    assert(routeRender.renderedRoutePolylinesCount >= 1, `Route polylines rendered immediately in SVG (${routeRender.renderedRoutePolylinesCount} paths found with stroke colors: ${routeRender.routeStrokeColors.join(', ')}) WITHOUT clicking AQI toggle`);

    // Step C: Verify AQI toggle on/off does NOT break or hide the route
    console.log('  Testing AQI overlay toggling on/off...');
    await cdp.eval(`document.getElementById('aqi-layer-toggle-btn').click();`); // Turn OFF
    await sleep(500);

    const offState = await cdp.eval(`
      (() => {
        const svg = document.querySelector('.leaflet-overlay-pane svg');
        const paths = svg ? Array.from(svg.querySelectorAll('path')).filter(p => parseFloat(p.getAttribute('stroke-width') || '0') >= 5 && (p.getAttribute('d') || '').length > 50) : [];
        return {
          routePolylinesCount: paths.length,
          mapHasSegmentedLine: MapManager.getMap().hasLayer(MapManager.getLayers().segmentedLine)
        };
      })()
    `);
    assert(offState.routePolylinesCount >= 1, `With AQI toggle OFF, route polyline remains visible (${offState.routePolylinesCount} paths)`);
    assert(!offState.mapHasSegmentedLine, 'Segmented line overlay successfully removed when toggled OFF');

    await cdp.eval(`document.getElementById('aqi-layer-toggle-btn').click();`); // Turn ON again
    await sleep(500);

    const onState = await cdp.eval(`
      (() => {
        const svg = document.querySelector('.leaflet-overlay-pane svg');
        const paths = svg ? Array.from(svg.querySelectorAll('path')).filter(p => parseFloat(p.getAttribute('stroke-width') || '0') >= 5 && (p.getAttribute('d') || '').length > 50) : [];
        return {
          routePolylinesCount: paths.length,
          mapHasSegmentedLine: MapManager.getMap().hasLayer(MapManager.getLayers().segmentedLine)
        };
      })()
    `);
    assert(onState.routePolylinesCount >= 1, `With AQI toggle ON again, route polylines remain visible (${onState.routePolylinesCount} paths)`);
    assert(onState.mapHasSegmentedLine, 'Segmented line overlay reattached cleanly');

    // ────────────────────────────────────────────────
    // TEST SECTION 4: Navigation & Route Switching
    // ────────────────────────────────────────────────
    console.log('\n>>> [4/4] AUDITING ROUTE SWITCHING, NAVIGATION & REGRESSIONS...');

    // Switch to Shortest route
    await cdp.eval(`Routing.selectRoute('shortest');`);
    await sleep(300);
    const activeRouteKey1 = await cdp.eval(`Routing.getActiveKey();`);
    assert(activeRouteKey1 === 'shortest', 'Active route switched to "shortest"');

    // Switch to Clean Air route
    await cdp.eval(`Routing.selectRoute('eco');`);
    await sleep(300);
    const activeRouteKey2 = await cdp.eval(`Routing.getActiveKey();`);
    assert(activeRouteKey2 === 'eco', 'Active route switched back to "eco" (Clean Air)');

    // Start Navigation
    console.log('  Testing Start Navigation along Clean Air route...');
    await cdp.eval(`Navigation.start();`);
    await sleep(500);

    const navStatus = await cdp.eval(`
      (() => {
        const active = Navigation.isActive();
        const overlay = document.getElementById('nav-overlay');
        const bottomBar = document.getElementById('nav-bottom-bar');
        const instrText = document.getElementById('nav-instruction-text');
        const chosen = Routing.getActiveRoute();
        return {
          isActive: active,
          overlayDisplay: overlay ? window.getComputedStyle(overlay).display : 'none',
          bottomBarDisplay: bottomBar ? window.getComputedStyle(bottomBar).display : 'none',
          instruction: instrText?.textContent || '',
          chosenDistance: chosen?.distance_str
        };
      })()
    `);
    assert(navStatus.isActive, 'Navigation mode activated successfully');
    assert(navStatus.overlayDisplay !== 'none', 'Navigation overlay is visible');
    assert(navStatus.instruction.length > 0, `First turn-by-turn guidance displayed: "${navStatus.instruction}"`);

    // Stop Navigation
    await cdp.eval(`Navigation.stop();`);
    await sleep(300);
    const stopped = await cdp.eval(`Navigation.isActive();`);
    assert(!stopped, 'Navigation stopped and HUD cleaned up');

    // Test map click still functional
    console.log('  Testing Map-click endpoint selection...');
    const clickSim = await cdp.eval(`
      (async () => {
        const map = MapManager.getMap();
        map.fire('click', { latlng: L.latLng(26.8500, 80.9500) });
        await new Promise(r => setTimeout(r, 400));
        const popup = document.querySelector('.map-click-popup');
        return { popupOpen: !!popup };
      })()
    `);
    assert(clickSim.popupOpen, 'Map click popup opens correctly with "Start here" and "Navigate here" actions');

    console.log('\n====================================================');
    console.log(` AUDIT COMPLETE: ${passCount} PASSED, ${failCount} FAILED `);
    console.log('====================================================');

    if (failCount > 0) process.exit(1);

  } catch (err) {
    console.error('Fatal error during test:', err);
    process.exit(1);
  } finally {
    chromeProc.kill();
  }
}

runAudit();
