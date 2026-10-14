// ═══════════════════════════════════════════════
// EcoNav v3 — App Entry Point
// ═══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {

  // 1. Map
  MapManager.init();

  // 2. Geocoding + autocomplete
  Geocoding.setup();

  // 2b. Initialize 1-Click Campus Presets
  Routing.initPresets();

  // 2c. Check for shared route in URL parameters
  Routing.initFromUrlParams();

  // 3. Prediction panel
  Prediction.init();

  // 4. Route tab buttons with haptic feedback
  document.getElementById('btn-shortest')?.addEventListener('click', () => {
    Utils.haptic('light');
    Routing.selectRoute('shortest');
  });
  document.getElementById('btn-eco')?.addEventListener('click', () => {
    Utils.haptic('light');
    Routing.selectRoute('eco');
  });
  document.getElementById('btn-balanced')?.addEventListener('click', () => {
    Utils.haptic('light');
    Routing.selectRoute('balanced');
  });

  // 4b. Native-Grade Multi-Snap Bottom Sheet Controller
  window.BottomSheet = (() => {
    const sheet = document.getElementById('search-sheet');
    const dragArea = document.getElementById('sheet-drag-area') || document.querySelector('.sheet-handle');
    if (!sheet) return { snapTo: () => {}, getSnap: () => 'half' };

    let currentSnap = 'half'; // 'peek', 'half', 'full'
    let startY = 0;
    let currentY = 0;
    let isDragging = false;
    let startTime = 0;

    function snapTo(snap, silent = false) {
      if (window.innerWidth > 768) return;
      currentSnap = snap;
      sheet.classList.remove('sheet-snap-peek', 'sheet-snap-half', 'sheet-snap-full', 'sheet-peek');
      sheet.classList.add(`sheet-snap-${snap}`);
      sheet.style.transform = '';
      if (!silent) Utils.haptic('light');
    }

    function getSnap() {
      return currentSnap;
    }

    // Touch Drag Handling for Mobile
    if (dragArea) {
      dragArea.addEventListener('touchstart', (e) => {
        if (window.innerWidth > 768) return;
        isDragging = true;
        startY = e.touches[0].clientY;
        currentY = startY;
        startTime = Date.now();
        sheet.style.transition = 'none';
      }, { passive: true });

      window.addEventListener('touchmove', (e) => {
        if (!isDragging || window.innerWidth > 768) return;
        currentY = e.touches[0].clientY;
        const deltaY = currentY - startY;

        const vh = window.innerHeight;
        let baseOffset = 0;
        if (currentSnap === 'half') baseOffset = vh * 0.52;
        else if (currentSnap === 'peek') baseOffset = vh - 76;
        else baseOffset = 0; // full

        const targetOffset = Math.max(0, Math.min(vh - 76, baseOffset + deltaY));
        sheet.style.transform = `translateY(${targetOffset}px)`;
      }, { passive: true });

      window.addEventListener('touchend', (e) => {
        if (!isDragging || window.innerWidth > 768) return;
        isDragging = false;
        sheet.style.transition = '';

        const deltaY = currentY - startY;
        const elapsed = Math.max(1, Date.now() - startTime);
        const velocity = deltaY / elapsed;

        // Velocity-based flick detection
        if (velocity > 0.35) {
          if (currentSnap === 'full') snapTo('half');
          else snapTo('peek');
        } else if (velocity < -0.35) {
          if (currentSnap === 'peek') snapTo('half');
          else snapTo('full');
        } else {
          // Position-based snap
          const vh = window.innerHeight;
          const rect = sheet.getBoundingClientRect();
          if (rect.top > vh * 0.70) {
            snapTo('peek');
          } else if (rect.top > vh * 0.28) {
            snapTo('half');
          } else {
            snapTo('full');
          }
        }
      });

      // Tap on drag handle toggles peek <-> half / full
      dragArea.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentSnap === 'peek') {
          snapTo('half');
        } else {
          snapTo('peek');
        }
      });
    }

    // Auto-expand sheet when tapping inside while peeked
    sheet.addEventListener('click', (e) => {
      if (currentSnap === 'peek') {
        snapTo('half');
      }
    });

    // When focusing inputs on mobile, elevate sheet to full so keyboard doesn't hide results
    const originInput = document.getElementById('origin-input');
    const destInput = document.getElementById('dest-input');
    originInput?.addEventListener('focus', () => {
      if (window.innerWidth <= 768) snapTo('full', true);
    });
    destInput?.addEventListener('focus', () => {
      if (window.innerWidth <= 768) snapTo('full', true);
    });

    // Default mobile snap on initial load
    if (window.innerWidth <= 768) {
      snapTo('half', true);
    }

    return { snapTo, getSnap };
  })();

  // 5. Start navigation with tactile haptic
  document.getElementById('go-btn')?.addEventListener('click', () => {
    Utils.haptic('success');
    Navigation.start();
  });

  // 6. Clear destination
  document.getElementById('clear-dest-btn').addEventListener('click', () => {
    document.getElementById('dest-input').value = '';
    Routing.resetRouteUI();
    document.getElementById('header-mini').style.display = 'none';
    MapManager.clearRoutes();
    const s = Geocoding.getState();
    s.dest = { coords: null, name: '' };
  });

  // 7. Route switch button inside nav overlay
  document.getElementById('nav-route-switch-btn')?.addEventListener('click', () => {
    const current = Routing.getActiveKey();
    const next    = current === 'shortest' ? 'eco' : 'shortest';
    Routing.selectRoute(next);
    // Re-draw the active route highlighted
    if (Navigation.isActive()) {
      // Restart navigation on the new route
      Navigation.stop();
      setTimeout(() => Navigation.start(), 300);
    }
    Utils.toast(`Switched to ${next === 'eco' ? '🟢 Clean Air' : '🔵 Shortest'} route`);
  });

  // 8. Model health check
  try {
    const res = await fetch(Config.ENDPOINTS.health());
    const d   = await res.json();
    const el  = document.getElementById('model-badge');
    if (d.model_loaded) {
      const m = d.model_meta || {};
      el.title       = `${m.model_type || 'Model'} · R²=${m.r2 || '?'} · MAE=${m.mae || '?'}`;
      el.textContent = '✅';
      el.classList.add('loaded');
    } else {
      el.title       = 'Model not loaded — run: python ml/train.py';
      el.textContent = '⚠';
    }
  } catch {
    const el = document.getElementById('model-badge');
    el.title       = 'API offline — start: uvicorn app:app --reload';
    el.textContent = '🔴';
  }

  // 9. Offline PWA Service Worker Registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.update();
    }).catch(err => {
      console.warn('Service worker registration note:', err);
    });
  }
});
