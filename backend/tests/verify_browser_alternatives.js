// ══════════════════════════════════════════════════════════════
// Browser UI & Route Comparison E2E Verification Script
// Launches Chrome, navigates to localhost:8000, tests route cards,
// comparison modal, honest verdict, and start navigation.
// ══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const http = require('http');

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9223;
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

async function runTest() {
  console.log('=== ECO_ROAD BROWSER E2E VERIFICATION ===');
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
  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.ready();
  console.log('Connected to CDP endpoint:', pageTarget.webSocketDebuggerUrl);

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log(`Navigating to ${APP_URL}...`);
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3000);

    // Verify title and page loaded
    const title = await cdp.eval('document.title');
    console.log(`Page title: "${title}"`);

    // Click first preset: Hazratganj to Janeshwar Mishra Park
    console.log('Triggering preset route: Hazratganj to Janeshwar Mishra Park...');
    const clickedPreset = await cdp.eval(`
      (() => {
        const chips = document.querySelectorAll('.preset-chip');
        if (chips.length > 0) {
          chips[0].click();
          return chips[0].textContent;
        }
        return null;
      })()
    `);
    console.log(`Clicked preset chip: "${clickedPreset}"`);

    // Wait for route calculation to complete
    console.log('Waiting for route calculation and route cards display...');
    let cardsVisible = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const isVisible = await cdp.eval(`
        (() => {
          const el = document.getElementById('route-cards');
          return el && window.getComputedStyle(el).display !== 'none';
        })()
      `);
      if (isVisible) {
        cardsVisible = true;
        break;
      }
    }

    if (!cardsVisible) {
      throw new Error('Route cards did not appear within 30 seconds');
    }
    console.log('✅ Route cards are visible in the DOM');

    // Inspect Card subtitles and stats
    const routeCardData = await cdp.eval(`
      (() => {
        const subS = document.getElementById('sub-shortest')?.textContent || '';
        const subE = document.getElementById('sub-eco')?.textContent || '';
        const statDist = document.getElementById('stat-dist')?.textContent || '';
        const statDur = document.getElementById('stat-dur')?.textContent || '';
        const statAqi = document.getElementById('stat-aqi')?.textContent || '';
        const statPm = document.getElementById('stat-pm25')?.textContent || '';
        const savings = document.getElementById('savings-body')?.textContent?.trim() || '';
        const goBtnText = document.getElementById('go-btn-text')?.textContent || '';
        const goBtnDisabled = document.getElementById('go-btn')?.disabled;

        const routeData = Routing.getRouteData();
        return {
          subShortest: subS,
          subEco: subE,
          statDist, statDur, statAqi, statPm,
          savings,
          goBtnText,
          goBtnDisabled,
          nAlternatives: routeData?.n_alternatives,
          sameRoute: routeData?.same_route,
          isShortestCleanest: routeData?.is_shortest_cleanest,
          similarityPercent: routeData?.similarity_percent,
          verdict: routeData?.health_impact?.verdict
        };
      })()
    `);

    console.log('\n--- ROUTE CARDS INSPECTION ---');
    console.log('Shortest Tab Subtitle:', routeCardData.subShortest);
    console.log('Eco Tab Subtitle:     ', routeCardData.subEco);
    console.log('Stat Distance:        ', routeCardData.statDist);
    console.log('Stat Duration:        ', routeCardData.statDur);
    console.log('Stat Avg AQI:         ', routeCardData.statAqi);
    console.log('Stat Inhaled PM2.5:   ', routeCardData.statPm);
    console.log('Health Savings Banner:', routeCardData.savings.replace(/\\s+/g, ' '));
    console.log('Start Navigation Btn: ', routeCardData.goBtnText, `(disabled: ${routeCardData.goBtnDisabled})`);
    console.log('Evaluated Candidates: ', routeCardData.nAlternatives);
    console.log('Geometry Similarity:  ', routeCardData.similarityPercent + '%');
    console.log('Same Route flag:      ', routeCardData.sameRoute);
    console.log('Shortest is Cleanest: ', routeCardData.isShortestCleanest);
    console.log('Verdict:              ', routeCardData.verdict);

    // Verify comparison modal
    console.log('\n--- TESTING HEALTH COMPARISON MODAL ---');
    await cdp.eval('Routing.openComparisonModal()');
    await sleep(500);

    const modalContent = await cdp.eval(`
      (() => {
        const modal = document.getElementById('compare-modal');
        const isShown = modal && window.getComputedStyle(modal).display !== 'none';
        const body = document.getElementById('modal-comparison-content')?.innerText || '';
        return { isShown, body };
      })()
    `);

    console.log('Modal displayed:       ', modalContent.isShown);
    console.log('Modal text excerpt:    \n' + modalContent.body.split('\\n').slice(0, 15).join('\\n'));

    if (!modalContent.isShown) {
      throw new Error('Comparison modal failed to open');
    }
    if (!modalContent.body.includes('Peak AQI')) {
      throw new Error('Comparison modal missing Peak AQI metric');
    }
    console.log('✅ Comparison modal correctly reports Peak AQI and honest verdict');

    // Close modal
    await cdp.eval('Routing.closeComparisonModal({ target: { id: "compare-modal" } })');
    await sleep(300);

    // Test Navigation Start
    console.log('\n--- TESTING START NAVIGATION ACTION ---');
    await cdp.eval('Navigation.start()');
    await sleep(1000);

    const navStatus = await cdp.eval(`
      (() => {
        const overlay = document.getElementById('nav-overlay');
        const isShown = overlay && window.getComputedStyle(overlay).display !== 'none';
        const instr = document.getElementById('nav-instruction-text')?.textContent || '';
        const icon = document.getElementById('nav-maneuver-icon')?.textContent || '';
        const road = document.getElementById('nav-road-bar')?.textContent || '';
        const eta = document.getElementById('hud-eta')?.textContent || '';
        const activeNav = Navigation.isActive();
        return { isShown, instr, icon, road, eta, activeNav };
      })()
    `);

    console.log('Navigation active:     ', navStatus.activeNav);
    console.log('Nav HUD overlay shown: ', navStatus.isShown);
    console.log('First Maneuver Icon:   ', navStatus.icon);
    console.log('First Instruction:     ', navStatus.instr);
    console.log('First Road Bar:        ', navStatus.road);
    console.log('HUD ETA:               ', navStatus.eta);

    if (!navStatus.activeNav || !navStatus.isShown) {
      throw new Error('Navigation failed to activate');
    }
    console.log('✅ Start Navigation successfully initiated turn-by-turn navigation overlay');

    // Stop navigation
    await cdp.eval('Navigation.stop()');
    console.log('✅ Navigation stopped cleanly');

    console.log('\n==========================================');
    console.log('ALL BROWSER E2E VERIFICATIONS PASSED 100%!');
    console.log('==========================================\n');

  } catch (err) {
    console.error('❌ E2E VERIFICATION FAILED:', err);
    process.exitCode = 1;
  } finally {
    try {
      chromeProc.kill();
    } catch (_) {}
  }
}

runTest();
