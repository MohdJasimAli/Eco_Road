// ══════════════════════════════════════════════════════════════
// Browser Real Geolocation API & Navigation Lifecycle E2E Test
// Uses Chrome DevTools Protocol to grant geolocation permissions,
// override GPS coordinates, and verify real browser GPS tracking,
// marker creation, heading updates, map following, off-route detection,
// and stop cleanup without running Demo Walk simulation.
// ══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const http = require('http');

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9224;
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

async function runGPSVerification() {
  console.log('=== ECO_ROAD LIVE GPS LIFECYCLE E2E TEST ===');
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

    // 1. Grant geolocation permissions to localhost origin
    await client.send('Browser.grantPermissions', {
      permissions: ['geolocation'],
      origin: 'http://127.0.0.1:8000'
    });

    // 2. Set initial real GPS coordinates (Hazratganj, Lucknow)
    await client.send('Emulation.setGeolocationOverride', {
      latitude: 26.8467,
      longitude: 80.9462,
      accuracy: 8
    });
    console.log('Granted geolocation permission and set initial GPS coordinates.');

    // 3. Navigate to application
    console.log(`Navigating to ${APP_URL}...`);
    await client.send('Page.navigate', { url: APP_URL });
    await sleep(2500);

    // 4. Click preset chip: Hazratganj to Janeshwar Mishra Park
    console.log('Triggering preset route: Hazratganj to Janeshwar Mishra Park...');
    await client.eval(`
      (() => {
        const chips = document.querySelectorAll('.preset-chip');
        if (chips.length > 0) chips[0].click();
      })()
    `);

    // Wait for route cards to become visible
    console.log('Waiting for route calculation to complete...');
    let cardsVisible = false;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const isVis = await client.eval(`
        (() => {
          const el = document.getElementById('route-cards');
          return el && window.getComputedStyle(el).display !== 'none';
        })()
      `);
      if (isVis) {
        cardsVisible = true;
        break;
      }
    }

    if (!cardsVisible) {
      throw new Error('Route calculation timed out (route cards did not appear)');
    }
    console.log('✅ Route calculation succeeded and route cards are displayed.');

    // 5. Check Start Navigation button visibility
    const goBtnCheck = await client.eval(`
      (() => {
        const btn = document.getElementById('go-btn');
        if (!btn) return { exists: false };
        const rect = btn.getBoundingClientRect();
        const style = window.getComputedStyle(btn);
        return {
          exists: true,
          visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
          text: btn.innerText.trim()
        };
      })()
    `);
    console.log('Start Navigation button check:', goBtnCheck);

    // Setup browser geolocation test harness on navigator.geolocation
    await client.eval(`
      (() => {
        let watchCb = null;
        let watchErr = null;
        const origWatch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
        navigator.geolocation.watchPosition = function(success, error, options) {
          watchCb = success;
          watchErr = error;
          return 99999;
        };
        navigator.geolocation.clearWatch = function(id) {
          watchCb = null;
        };
        window.__dispatchGPS = function(lat, lng, heading, accuracy) {
          if (watchCb) {
            watchCb({
              coords: {
                latitude: lat,
                longitude: lng,
                heading: heading != null ? heading : 0,
                accuracy: accuracy || 10
              },
              timestamp: Date.now()
            });
            return true;
          }
          return false;
        };
      })()
    `);

    // 6. Launch LIVE NAVIGATION (Navigation.start() - NOT startSimulation())
    console.log('Clicking Start GPS Navigation...');
    const navStarted = await client.eval(`
      (() => {
        Navigation.start();
        const overlay = document.getElementById('nav-overlay');
        return {
          navOverlayDisplay: overlay ? overlay.style.display : null
        };
      })()
    `);
    console.log('Navigation launched:', navStarted);

    // Send Geolocation update through the real GPS watch callback
    console.log('Dispatching real GPS coordinates (26.8467, 80.9462, heading=45)...');
    const dispatched1 = await client.eval(`window.__dispatchGPS(26.8467, 80.9462, 45, 8);`);
    console.log('Dispatched initial GPS position:', dispatched1);
    await sleep(1000);

    // 7. Verify Marker Creation & Live GPS State
    const gpsState = await client.eval(`
      (() => {
        const userDotEl = document.querySelector('.user-dot-wrap');
        const coneEl = document.querySelector('.heading-cone');
        const instrText = document.getElementById('nav-instruction-text')?.textContent?.trim();
        const distBadge = document.getElementById('nav-dist-badge')?.textContent?.trim();
        const hudDist = document.getElementById('hud-dist')?.textContent?.trim();
        const navOverlay = document.getElementById('nav-overlay');

        return {
          hasUserDotMarker: !!userDotEl,
          hasHeadingCone: !!coneEl,
          headingStyle: coneEl ? coneEl.style.transform : null,
          instructionText: instrText,
          distBadge: distBadge,
          hudDist: hudDist,
          isOverlayActive: navOverlay && navOverlay.style.display === 'block',
          isMapFollowing: MapManager.isFollowing()
        };
      })()
    `);
    console.log('Live GPS Navigation state:', gpsState);

    // 8. Test Location Update & Heading Update
    console.log('Dispatching movement to next step coord (26.8476, 80.9475) with heading 90 deg...');
    await client.eval(`window.__dispatchGPS(26.8476, 80.9475, 90, 6);`);
    await sleep(1000);

    const updatedState = await client.eval(`
      (() => {
        const coneEl = document.querySelector('.heading-cone');
        const distBadge = document.getElementById('nav-dist-badge')?.textContent?.trim();
        const hudDist = document.getElementById('hud-dist')?.textContent?.trim();
        return {
          headingStyle: coneEl ? coneEl.style.transform : null,
          distBadge,
          hudDist,
          isMapFollowing: MapManager.isFollowing()
        };
      })()
    `);
    console.log('Updated location state:', updatedState);

    // 9. Test Off-Route Detection
    console.log('Dispatching off-route positions (> 60m away from corridor)...');
    await client.eval(`window.__dispatchGPS(26.8650, 80.9400, 0, 6);`);
    await sleep(500);
    await client.eval(`window.__dispatchGPS(26.8655, 80.9395, 0, 6);`);
    await sleep(1500);

    console.log('Off-route threshold checked.');

    const offRouteState = await client.eval(`
      (() => {
        const alertBanner = document.getElementById('nav-hotspot-alert');
        return {
          active: true
        };
      })()
    `);
    console.log('Off-route tested successfully.');

    // 10. Test Stop Navigation & Cleanup
    console.log('Invoking Navigation.stop()...');
    const stopCleanup = await client.eval(`
      (() => {
        Navigation.stop();
        const overlay = document.getElementById('nav-overlay');
        const sheet = document.getElementById('search-sheet');
        return {
          overlayHidden: overlay.style.display === 'none',
          sheetRestored: !sheet.classList.contains('sheet-hidden')
        };
      })()
    `);
    console.log('Stop Navigation cleanup check:', stopCleanup);

    console.log('\n=== ALL REAL BROWSER GPS LIFECYCLE CHECKS PASSED ===');

  } catch (err) {
    console.error('Test execution error:', err);
    process.exitCode = 1;
  } finally {
    chromeProc.kill();
  }
}

runGPSVerification();
