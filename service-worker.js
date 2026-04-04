/**
 * deep relay — service worker v2
 *
 * Strategy:
 *   - Shell assets (HTML, manifest, icons): cache-first, background update
 *   - Audio files (MP3): cache on first play, serve from cache thereafter
 *   - Fonts (Google Fonts CDN): stale-while-revalidate
 *   - Everything else: network-first
 *
 * Deploy policy: bump CACHE_VERSION on every audio/session deploy.
 *   v1 → v2: re-rendered all 7 Archive sessions (April 2026)
 */

const CACHE_VERSION = 'deep-relay-v2';

// Assets cached immediately on install (the app shell)
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ── Install: cache the shell ────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // Cache shell assets — ignore failures for optional assets (icons)
      return Promise.allSettled(
        SHELL_ASSETS.map(url =>
          cache.add(url).catch(() => {/* icon may not exist yet — that's ok */})
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ───────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests + Google Fonts
  const isLocal   = url.origin === self.location.origin;
  const isFonts   = url.hostname === 'fonts.googleapis.com' ||
                    url.hostname === 'fonts.gstatic.com';

  if (!isLocal && !isFonts) return; // let browser handle cross-origin

  // Audio: cache-first — applies to all MP3s (franchise + archive)
  if (isLocal && url.pathname.endsWith('.mp3')) {
    event.respondWith(cacheFirstAudio(request));
    return;
  }

  // Shell + manifest: cache-first with background revalidation
  if (isLocal && (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/icon-')
  )) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Fonts: stale-while-revalidate (avoids flash of unstyled text offline)
  if (isFonts) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Default: network-first
  event.respondWith(networkFirst(request));
});

// ── Cache strategies ─────────────────────────────────────────────────────────

async function cacheFirstAudio(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone()); // cache in background
    }
    return response;
  } catch {
    return new Response('Audio unavailable offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache    = await caches.open(CACHE_VERSION);
  const cached   = await cache.match(request);

  const networkFetch = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || await networkFetch || new Response('Offline', { status: 503 });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}
