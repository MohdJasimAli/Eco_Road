// ══════════════════════════════════════════════════════════════
// Basemap Tile Network & Browser Rendering Verification Script
// ══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const http = require('http');

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9222;
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
    this.networkRequests = [];
    this.networkResponses = [];
    this.failedRequests = [];
    this.consoleErrors = [];

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      } else if (msg.method === 'Network.requestWillBeSent') {
        const req = msg.params.request;
        if (req.url.includes('.png') || req.url.includes('tile') || req.url.includes('basemap')) {
          this.networkRequests.push(req);
        }
      } else if (msg.method === 'Network.responseReceived') {
        const resp = msg.params.response;
        if (resp.url.includes('.png') || resp.url.includes('tile') || resp.url.includes('basemap')) {
          this.networkResponses.push(resp);
        }
      } else if (msg.method === 'Network.loadingFailed') {
        this.failedRequests.push(msg.params);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        if (msg.params.type === 'error' || msg.params.type === 'warning') {
          const text = msg.params.args.map(a => a.value || a.description || '').join(' ');
          this.consoleErrors.push(`[${msg.params.type.toUpperCase()}] ${text}`);
        }
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
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception ? res.exceptionDetails.exception.description : res.exceptionDetails.text;
      throw new Error(`CDP Eval Error: ${detail || JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result ? res.result.value : undefined;
  }
}

async function verifyBasemap() {
  console.log("=== BASEMAP TILE LAYER VERIFICATION ===");
  console.log(`Launching headless Chrome from: ${CHROME_PATH}`);

  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    APP_URL
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
    chromeProc.kill();
    throw new Error("Could not connect to Chrome debugging port");
  }

  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  console.log(`Connected to Chrome target: ${pageTarget.title} (${pageTarget.url})`);

  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.ready();

  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // Wait 3s for initial page load and map tile fetch
  await sleep(3000);

  // 1. Inspect Active Tile Layer in Leaflet DOM
  console.log("\n[1] Inspecting Leaflet Tile Layer DOM & Configuration...");
  const domInspection = await cdp.eval(`(() => {
    const tileImages = Array.from(document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile'));
    const tileSources = tileImages.slice(0, 5).map(img => ({
      src: img.src,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight
    }));

    const configTiles = Config.MAP.tileLayers;
    const attribution = document.querySelector('.leaflet-control-attribution');

    return {
      tileImagesCount: tileImages.length,
      sampleTiles: tileSources,
      configTileKeys: Object.keys(configTiles),
      configuredOsmUrl: configTiles.osm ? configTiles.osm.url : null,
      attributionHtml: attribution ? attribution.innerHTML : null
    };
  })()`);
  console.log("  DOM Inspection Results:", JSON.stringify(domInspection, null, 2));

  // 2. Inspect Network Requests
  console.log("\n[2] Inspecting Tile Network Requests...");
  console.log(`  Total tile-related requests: ${cdp.networkRequests.length}`);
  console.log(`  Total tile responses received: ${cdp.networkResponses.length}`);
  console.log(`  Failed requests count: ${cdp.failedRequests.length}`);

  const osmRequests = cdp.networkRequests.filter(r => r.url.includes('tile.openstreetmap.org'));
  const cartoRequests = cdp.networkRequests.filter(r => r.url.includes('cartocdn.com'));

  console.log(`  OpenStreetMap tile requests: ${osmRequests.length}`);
  console.log(`  Carto (watermarked) requests: ${cartoRequests.length}`);

  if (cartoRequests.length > 0) {
    throw new Error(`CRITICAL: Still found ${cartoRequests.length} requests to cartocdn.com!`);
  }
  if (osmRequests.length === 0) {
    throw new Error("CRITICAL: No requests to tile.openstreetmap.org observed!");
  }

  const sampleResponses = cdp.networkResponses.slice(0, 5).map(r => ({
    url: r.url,
    status: r.status,
    mimeType: r.mimeType,
    fromDiskCache: r.fromDiskCache
  }));
  console.log("  Sample Tile Responses:", sampleResponses);

  const non200Responses = cdp.networkResponses.filter(r => r.status !== 200 && r.status !== 304);
  if (non200Responses.length > 0) {
    console.warn(`  Warning: Found ${non200Responses.length} non-200 responses:`, non200Responses.map(r => `${r.status}: ${r.url}`));
  } else {
    console.log("  [PASS] All tile responses returned HTTP 200 OK!");
  }

  // 3. Test Zooming and Panning
  console.log("\n[3] Testing Map Zooming & Panning...");
  const zoomBefore = await cdp.eval(`MapManager.getMap().getZoom()`);
  await cdp.eval(`(() => { MapManager.getMap().setZoom(15); return true; })()`);
  await sleep(1500);
  const zoomAfter = await cdp.eval(`MapManager.getMap().getZoom()`);
  console.log(`  Zoom level updated from ${zoomBefore} to ${zoomAfter}`);

  // Test Panning to Hazratganj
  await cdp.eval(`(() => { MapManager.panTo(26.8467, 80.9462, 16); return true; })()`);
  await sleep(1500);
  const centerAfterPan = await cdp.eval(`(() => {
    const c = MapManager.getMap().getCenter();
    return { lat: Number(c.lat.toFixed(4)), lng: Number(c.lng.toFixed(4)) };
  })()`);
  console.log("  Center after pan:", centerAfterPan);

  // 4. Test Route Drawing on New Basemap
  console.log("\n[4] Testing Route Calculation & Polyline Overlay...");
  await cdp.eval(`(() => {
    const chips = Array.from(document.querySelectorAll('.preset-chip'));
    const chip = chips.find(c => c.textContent.includes('Hazratganj'));
    if (chip) chip.click();
  })()`);

  // Wait for route polyline
  let polylineDrawn = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    polylineDrawn = await cdp.eval(`(() => {
      const activeGroup = MapManager.getLayers().activeRoute;
      const segGroup = MapManager.getLayers().segmentedLine;
      const count1 = activeGroup ? activeGroup.getLayers().length : 0;
      const count2 = segGroup ? segGroup.getLayers().length : 0;
      return count1 > 0 || count2 > 0;
    })()`);
    if (polylineDrawn) break;
  }
  console.log(`  Route polyline drawn on map: ${polylineDrawn}`);

  // 5. Check Console Errors
  console.log("\n[5] Console Errors & Warnings Check:");
  if (cdp.consoleErrors.length === 0) {
    console.log("  [PASS] Zero console errors or warnings!");
  } else {
    console.log("  Console entries:", cdp.consoleErrors);
  }

  chromeProc.kill();
  console.log("\n=== BASEMAP VERIFICATION COMPLETED SUCCESSFULLY ===");
}

verifyBasemap().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
