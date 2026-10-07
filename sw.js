// BookTrip service worker: offline shell + fast repeat visits.
//   navigations          → network first, offline fallback to the cached /index.html
//   /js, /css            → network first, cache fallback (offline). Not stale-while-revalidate: a stale
//                          ES module next to a fresh one (after a deploy) could break the import graph.
//   other statics        → stale-while-revalidate (/vendor, /data/books, /data/catalog.json, icons)
//   Google Fonts         → stale-while-revalidate (opaque responses allowed)
//   /api/*, Paddle, analytics and every other cross-origin request → never touched (network only)
// Bump VERSION to drop old caches after a deploy that changes cached files.

const VERSION = "bt-v2-1";
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const PRECACHE = [
  "/", "/index.html", "/css/base.css", "/css/home.css", "/css/book.css",
  "/js/app.js", "/js/account.js", "/js/api.js", "/js/i18n.js", "/js/util.js", "/js/enums.js", "/js/covers.js",
  "/js/ring.js", "/js/stars.js", "/js/book-view.js", "/js/strings-book.js", "/data/catalog.json",
  "/icon.svg", "/icon-192.png", "/manifest.webmanifest",
];
const STATIC_MAX = 160;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))))
      .catch(() => { /* offline install: the shell fills itself on the next visit */ })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("bt-") && !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch { /* not supported */ }
    }
    await self.clients.claim();
  })());
});

const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const CODE_RE = /^\/(css|js)\/[\w.-]+\.(css|js)$/;
const STATIC_RE = /^\/vendor\/|^\/data\/(books\/[a-z0-9-]+\.json|catalog\.json)$|^\/(icon\.svg|icon-192\.png|icon-512\.png|icon-maskable-512\.png|apple-touch-icon\.png|og\.png|manifest\.webmanifest)$/;

function isStatic(url) {
  if (url.origin === self.location.origin) return !url.pathname.startsWith("/api/") && STATIC_RE.test(url.pathname);
  return FONT_HOSTS.has(url.hostname);
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(STATIC);
  const cached = await cache.match(event.request);
  const network = fetch(event.request).then((res) => {
    if (res && (res.ok || res.type === "opaque")) {
      cache.put(event.request, res.clone()).then(() => trim(STATIC, STATIC_MAX)).catch(() => {});
    }
    return res;
  });
  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}

/** Network first with a cache fallback for code (/js, /css). */
async function codeFirst(event) {
  const cache = await caches.open(STATIC);
  try {
    const res = await fetch(event.request);
    if (res && res.ok) event.waitUntil(cache.put(event.request, res.clone()).catch(() => {}));
    return res;
  } catch (err) {
    const cached = await cache.match(event.request) || await (await caches.open(SHELL)).match(event.request);
    if (cached) return cached;
    throw err;
  }
}

async function networkFirst(event) {
  try {
    const preload = await event.preloadResponse;
    const res = preload || await fetch(event.request);
    if (res && res.ok && new URL(event.request.url).pathname === "/") {
      const copy = res.clone();
      event.waitUntil(caches.open(SHELL).then((c) => c.put("/index.html", copy)).catch(() => {}));
    }
    return res;
  } catch (err) {
    const cache = await caches.open(SHELL);
    return (await cache.match("/index.html")) || (await cache.match("/")) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_vercel/"))) return;
  if (req.mode === "navigate") {
    if (url.origin === self.location.origin) event.respondWith(networkFirst(event));
    return;
  }
  if (url.origin === self.location.origin && CODE_RE.test(url.pathname)) event.respondWith(codeFirst(event));
  else if (isStatic(url)) event.respondWith(staleWhileRevalidate(event));
});
