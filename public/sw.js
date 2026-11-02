/* ShelfScout service worker - installable app shell + offline fallback.
 *
 * API calls are never cached: the library always comes from the live server.
 * App files are network-first on purpose - you edit styles.css or app.js and
 * the phone/desktop app shows the change on the next load. The cache is only
 * used when the computer is unreachable. */
const CACHE = "shelfscout-v2";
const CORE = [
  "/",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/favicon-32.png",
  "/icons/apple-touch-icon.png",
  "/vendor/qrcode.js",
  "/vendor/zxing.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Tolerate a missing optional asset rather than failing the whole install.
      await Promise.all(CORE.map((url) => cache.add(url).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/download/")) return;

  // Network first for everything the app renders: a changed file is picked up
  // on the next load, and the cached copy only matters when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => {
          if (hit) return hit;
          if (request.mode === "navigate") return caches.match("/");
          return new Response("Offline", { status: 504, headers: { "Content-Type": "text/plain" } });
        })
      )
  );
});
