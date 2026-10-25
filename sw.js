/**
 * StudyPath • Progressive Web App Service Worker
 * 
 * Strict Privacy & Multi-User Security Guardrails:
 * - Caches ONLY static app shell files and UI assets.
 * - NEVER caches authenticated API endpoints (/api/*), credentials, or private planner content.
 * - Protects cross-user privacy on shared/family devices.
 * - Handles service worker lifecycle updates gracefully.
 */

const CACHE_NAME = 'studypath-shell-v1.1.0';

const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/logo-mark.png',
  '/icons/logo.png',
  '/icons/favicon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/icon.svg',
  '/icons/apple-touch-icon.png'
];

// Install: Pre-cache core app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(APP_SHELL_ASSETS);
      })
      .then(() => {
        return self.skipWaiting();
      })
      .catch((err) => {
        console.warn('[ServiceWorker] Pre-cache failed:', err);
      })
  );
});

// Activate: Clean up previous caches & claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME && name.startsWith('studypath-')) {
            console.log('[ServiceWorker] Removing outdated cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Listen for skipWaiting messages from client app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch: Strategy dispatcher
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. ABSOLUTE RULE: Never cache authenticated API requests or mutating methods.
  // Bypass service worker cache completely for all /api/ calls and non-GET requests.
  if (url.pathname.startsWith('/api/') || req.method !== 'GET') {
    event.respondWith(
      fetch(req).catch(() => {
        // Return structured offline JSON response when network is down
        return new Response(
          JSON.stringify({
            error: 'You are currently offline. A live network connection is required to load or modify your planner data.',
            offline: true
          }),
          {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'application/json' }
          }
        );
      })
    );
    return;
  }

  // 2. Navigation requests (HTML page): Network-first with app shell fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .catch(() => {
          return caches.match('/index.html')
            .then((cachedShell) => {
              return cachedShell || caches.match('/');
            });
        })
    );
    return;
  }

  // 3. Static assets: Stale-While-Revalidate
  // Serve cached version immediately for speed, refresh in background if online.
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(req, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // If network fetch fails, nothing to update; cached response (if any) was used.
          return cachedResponse;
        });

      return cachedResponse || fetchPromise;
    })
  );
});
