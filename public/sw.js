// Jamboree service worker. Caches the static app shell so it boots offline,
// but never caches invite-bearing URLs or media. Per DESIGN.md §10:
//   - PWA-enhanced, not PWA-dependent.
//   - Do not act as an always-on seeder.
//   - Do not cache full media blobs (media is exchanged via the mesh protocol
//     using `blob:` URLs, which don't go through the SW fetch path anyway).
//   - Cache the SPA shell, manifest, icons, and built JS/CSS bundles only.

const SHELL_VERSION = 'v1';
const SHELL_CACHE = `jamboree-shell-${SHELL_VERSION}`;
const ASSET_CACHE = `jamboree-assets-${SHELL_VERSION}`;

// `registration.scope` is e.g. "https://host/Jamboree/". Derive the path so
// the SW works at any base path without recompiling.
const scopeUrl = new URL(self.registration.scope);
const BASE = scopeUrl.pathname;
const SHELL_URL = BASE;

const PRECACHE_URLS = [
  SHELL_URL,
  BASE + 'manifest.webmanifest',
  BASE + 'icon.svg',
  BASE + 'icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Tolerant precache: an individual 404 (e.g. icon not yet deployed)
    // shouldn't abort install. The shell URL is the one that really matters.
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res.ok) await cache.put(url, res);
      } catch {
        // ignore
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('jamboree-') && k !== SHELL_CACHE && k !== ASSET_CACHE)
        .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(BASE)) return;

  // SPA navigation: serve the canonical shell. The request path may include a
  // /r/<roomId> segment, but we never key the cache by it — the fragment that
  // carries the secret is never sent in the request anyway, and we only ever
  // cache the shell at SHELL_URL.
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate());
    return;
  }

  // Hashed JS/CSS bundles under /<base>/assets/<hash>.
  if (url.pathname.startsWith(BASE + 'assets/')) {
    event.respondWith(staleWhileRevalidate(req, ASSET_CACHE));
    return;
  }

  // Manifest + icons.
  if (
    url.pathname === BASE + 'manifest.webmanifest' ||
    url.pathname === BASE + 'icon.svg' ||
    url.pathname === BASE + 'icon-maskable.svg'
  ) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  // Everything else (tracker rendezvous, WebRTC signalling, etc.) goes
  // straight to the network. The SW is not in the media path.
});

async function handleNavigate() {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(SHELL_URL, { cache: 'no-cache' });
    if (fresh.ok) cache.put(SHELL_URL, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    return new Response(OFFLINE_FALLBACK_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  return cached || (await network) || new Response('', { status: 504 });
}

const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Jamboree — offline</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 32rem;
         margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { margin: 0 0 0.75rem; }
  p { opacity: 0.8; }
</style>
</head><body>
<h1>You're offline</h1>
<p>Jamboree rooms need active network peers. Reconnect to the internet to
share music with your friends, then reload this page.</p>
</body></html>`;
