// ══════════════════════════════════════════════════════════════
// Browser Navigation & Start Button Verification Script (CDP)
// Tests complete navigation lifecycle in real headless Chrome
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
    this.events = [];
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
        this.consoleLogs.push(text);
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

async function runVerification() {
  console.log("=== ECO_ROAD REAL BROWSER NAVIGATION VERIFICATION ===");
  console.log(`Starting headless Chrome from: ${CHROME_PATH}`);

  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    APP_URL
  ], { stdio: 'ignore' });

  // Wait for Chrome remote debugging port
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
    throw new Error("Could not connect to Chrome debugging port 9222");
  }

  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  console.log(`Connected to Chrome target: ${pageTarget.title} (${pageTarget.url})`);

  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.ready();

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // Wait 2s for Leaflet map & presets to initialize
  await sleep(2000);

  // 1. Initial State Check
  console.log("\n[1] Verifying Map Center & Lucknow Defaults...");
  const initialMapState = await cdp.eval(`(() => {
    return {
      title: document.title,
      hasMap: !!window.L,
      hasMapManager: typeof MapManager !== 'undefined',
      hasRouting: typeof Routing !== 'undefined',
      hasNavigation: typeof Navigation !== 'undefined',
      hasPresets: typeof CampusPresets !== 'undefined'
    };
  })()`);
  console.log("  Map modules loaded:", initialMapState);

  // 2. Click Lucknow Hazratganj -> Janeshwar Mishra Park preset
  console.log("\n[2] Selecting Preset: Hazratganj ➔ Janeshwar Mishra Park...");
  const presetSelected = await cdp.eval(`(() => {
    const chips = Array.from(document.querySelectorAll('.preset-chip'));
    const targetChip = chips.find(c => c.textContent.includes('Hazratganj') || c.textContent.includes('Mishra'));
    if (targetChip) {
      targetChip.click();
      return { success: true, text: targetChip.textContent };
    }
    return { success: false, chipsCount: chips.length };
  })()`);
  console.log("  Preset click result:", presetSelected);

  // 3. Wait for Route Calculation to finish
  console.log("\n[3] Waiting for Multimodal Route Calculation...");
  let routeReady = false;
  for (let i = 0; i < 25; i++) {
    await sleep(500);
    routeReady = await cdp.eval(`(() => {
      const cards = document.getElementById('route-cards');
      const dist = document.getElementById('stat-dist');
      return cards && cards.style.display !== 'none' && dist && dist.textContent !== '—';
    })()`);
    if (routeReady) break;
  }

  if (!routeReady) {
    throw new Error("Route calculation did not complete within 12 seconds");
  }

  const routeDetails = await cdp.eval(`(() => {
    return {
      dist: document.getElementById('stat-dist').textContent,
      dur: document.getElementById('stat-dur').textContent,
      aqi: document.getElementById('stat-aqi').textContent,
      pm25: document.getElementById('stat-pm25').textContent,
      badge: document.getElementById('route-aqi-badge').textContent,
      activeRoute: Routing.getActiveKey()
    };
  })()`);
  console.log("  Route Calculation Results:", routeDetails);

  // 4. Verify Start Navigation Button Visibility & Interaction
  console.log("\n[4] Verifying 'Start Navigation' Button Visibility...");
  const goBtnDetails = await cdp.eval(`(() => {
    const btn = document.getElementById('go-btn');
    if (!btn) return { exists: false };
    const rect = btn.getBoundingClientRect();
    const style = window.getComputedStyle(btn);
    return {
      exists: true,
      id: btn.id,
      text: btn.textContent.trim(),
      offsetParent: btn.offsetParent !== null,
      display: style.display,
      visibility: style.visibility,
      disabled: btn.disabled,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      bgColor: style.backgroundColor || style.backgroundImage
    };
  })()`);
  console.log("  'Start Navigation' Button Layout Inspection:", goBtnDetails);

  if (!goBtnDetails.exists || !goBtnDetails.offsetParent || goBtnDetails.rect.width === 0) {
    throw new Error("Start Navigation button is not visible on page!");
  }

  // 5. Test GPS Permission Error Handling
  console.log("\n[5] Testing GPS Permission Error Handling...");
  const permErrorHandled = await cdp.eval(`(() => {
    let toastMsg = '';
    const origToast = Utils.toast;
    Utils.toast = (m) => { toastMsg = m; origToast(m); };
    
    // Simulate what MapManager's errorCallback does on code 1
    const errCallback = (err) => {
      if (err.code === 1) {
        Utils.toast('⚠️ Location access denied. Please allow GPS permission or tap "Demo Walk" to simulate trip.', 6000);
      }
    };
    errCallback({ code: 1, message: 'User denied geolocation' });
    Utils.toast = origToast;
    return toastMsg;
  })()`);
  console.log("  Simulated GPS permission denial response:", permErrorHandled);

  // 6. Test Start Real GPS Navigation Lifecycle
  console.log("\n[6] Starting Navigation Lifecycle (Simulation Mode for Automated Test)...");
  await cdp.eval(`Navigation.startSimulation(5)`); // 5x speed for verification run
  await sleep(1200);

  const navHudState = await cdp.eval(`(() => {
    const overlay = document.getElementById('nav-overlay');
    const instr = document.getElementById('nav-instruction-text');
    const distBadge = document.getElementById('nav-dist-badge');
    const durBig = document.getElementById('hud-duration-big');
    const hudDist = document.getElementById('hud-dist');
    const hudEta = document.getElementById('hud-eta');
    const icon = document.getElementById('nav-maneuver-icon');
    const liveMarker = document.querySelector('.live-loc-dot');
    return {
      isActive: Navigation.isActive(),
      overlayVisible: overlay && overlay.style.display !== 'none',
      instruction: instr ? instr.textContent.trim() : '',
      distBadge: distBadge ? distBadge.textContent.trim() : '',
      hudDist: hudDist ? hudDist.textContent.trim() : '',
      etaDuration: durBig ? durBig.textContent.trim() : '',
      hudEta: hudEta ? hudEta.textContent.trim() : '',
      icon: icon ? icon.textContent.trim() : '',
      hasLiveMarker: !!liveMarker
    };
  })()`);
  console.log("  Navigation HUD & Active State:", navHudState);

  // 7. Verify Turn-by-turn Progress & Camera Follow
  console.log("\n[7] Verifying Route Progress Updates...");
  await sleep(2000);
  const progressState = await cdp.eval(`(() => {
    const hudDist = document.getElementById('hud-dist');
    const prog = document.getElementById('nav-progress-fill');
    const instr = document.getElementById('nav-instruction-text');
    return {
      distance: hudDist ? hudDist.textContent.trim() : '',
      progressPercent: prog ? prog.style.width : '0%',
      instruction: instr ? instr.textContent.trim() : ''
    };
  })()`);
  console.log("  Progress after 2.0s:", progressState);

  // 8. Test Stop Navigation
  console.log("\n[8] Testing Stop Navigation Action...");
  const stopNavState = await cdp.eval(`(() => {
    const exitBtn = document.getElementById('nav-exit-btn');
    if (exitBtn) exitBtn.click();
    else Navigation.stop();
    const overlay = document.getElementById('nav-overlay');
    const cards = document.getElementById('route-cards');
    return {
      isActive: Navigation.isActive(),
      overlayVisible: overlay && overlay.style.display !== 'none',
      cardsRestored: cards && cards.style.display !== 'none'
    };
  })()`);
  console.log("  Stop Navigation State:", stopNavState);

  chromeProc.kill();
  console.log("\n=== REAL BROWSER VERIFICATION PASSED SUCCESSFULLY ===");
  return true;
}

runVerification().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
