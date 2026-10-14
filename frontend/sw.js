// ═══════════════════════════════════════════════
// EcoNav — Offline Service Worker
// Member 1 (Hours 08–10 Hardening)
// ═══════════════════════════════════════════════

const CACHE_NAME = 'ecoroad-v3-nav-fix-20261014';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/pitch_deck.html',
  '/css/main.css',
  '/js/config.js',
  '/js/utils.js',
  '/js/audio.js',
  '/js/campus_presets.js',
  '/js/map.js',
  '/js/geocoding.js',
  '/js/routing.js',
  '/js/navigation.js',
  '/js/prediction.js',
  '/js/app.js',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // Network-only / Network-first for dynamic API calls
  if (url.includes('/route') || url.includes('/aqi') || url.includes('/health') || url.includes('/geocode') || url.includes('/predict')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Network-First with Cache Fallback for static assets (HTML, JS, CSS, JSON)
  // Ensures normal application launches and regular reloads always receive the latest basemap and code
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
