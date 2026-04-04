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
 *   deep-relay-v8: fixed cacheFirstAudio — URL-only cache key, no Range header on fetch
 *   deep-relay-v7: fixed Phase 5 endings for silence, sol5111, arecibo (distinct seeds)
 *   deep-relay-v6: re-rendered 7 session(s), seed-base 20260408
 *   deep-relay-v5: re-rendered 7 session(s), seed-base 20260404
 *   deep-relay-v4: re-rendered 7 session(s), seed-base 20260201
 *   deep-relay-v3: re-rendered 7 session(s), seed-base 20260101
 *   v1 → v2: re-rendered all 7 Archive sessions (April 2026)
 */

const CACHE_VERSION = 'deep-relay-v8';

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
  // Normalise the cache key to URL-only — audio requests always carry a Range
  // header which varies per chunk.  Using the raw request as the key means every
  // new range value is a cache miss and Chrome rejects a full-200 response served
  // back against a specific Range request.  Stripping the header here ensures all
  // requests for the same file share one cache entry.
  const cacheKey = new Request(request.url);
  const cache    = await caches.open(CACHE_VERSION);
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    // Fetch without a Range header — mpeg.uk returns a full 200 for any request
    // anyway (no byte-range support), so normalising here is harmless and avoids
    // the browser rejecting a 200 served in response to a specific Range request.
    const fullRequest = new Request(request.url, { method: 'GET' });
    const response    = await fetch(fullRequest);
    if (response.ok) {
      cache.put(cacheKey, response.clone()); // cache full file; response stream
                                             // returned to browser simultaneously
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
