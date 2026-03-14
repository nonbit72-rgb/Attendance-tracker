/* =============================================
   ATTEND TRACK - SERVICEWORKER.JS
   Handles offline caching via Cache API.
   - Caches app shell on install
   - Serves from cache; falls back to network
   - Deletes old cache versions on activate
   ============================================= */

'use strict';

/* Bump this version string whenever you change app files.
   The old cache will be deleted and a fresh cache created. */
const CACHE_VERSION = 'attend-track-v1';

/* Files that form the app shell – must be cached for offline use */
const CACHE_FILES = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* ---- INSTALL ----
   Pre-cache all app shell files. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(CACHE_FILES))
      .then(() => self.skipWaiting()) // activate immediately
  );
});

/* ---- ACTIVATE ----
   Remove any caches that are not the current version. */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => {
      const deletions = keys
        .filter(key => key !== CACHE_VERSION)
        .map(key => caches.delete(key));
      return Promise.all(deletions);
    }).then(() => self.clients.claim()) // take control of open pages
  );
});

/* ---- FETCH ----
   Cache-first strategy for app shell resources.
   Falls back to network if not cached (e.g. first visit before install). */
self.addEventListener('fetch', (event) => {
  /* Only handle GET requests for same-origin URLs */
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      /* Not in cache – fetch from network and cache for next time */
      return fetch(event.request).then(response => {
        /* Only cache valid responses */
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        /* Clone before caching (response body can only be consumed once) */
        const clone = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
