// GMRT 断层识别 · Service Worker
// 页面文件：联网时取最新、断网时用缓存；Pyodide（版本固定的 CDN 文件）：缓存优先，下载一次以后离线也能计算。
const VERSION = "1.1.0";
const SHELL_CACHE = `gfd-shell-${VERSION}`;
const PYODIDE_CACHE = "gfd-pyodide-314.0.7";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/app.css", "js/app.js", "js/params.js", "js/worker.js", "py/gmrt_fault_detect.py",
  "params/gmrt_fault_params_mar29n.json",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css", "vendor/leaflet/images/layers.png",
  "vendor/leaflet/images/layers-2x.png", "vendor/leaflet/images/marker-icon.png",
  "vendor/tifffile/tifffile-2026.10.15-py3-none-any.whl",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/favicon-32.png", "icons/favicon-64.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if ((key.startsWith("gfd-shell-") && key !== SHELL_CACHE) || (key.startsWith("gfd-pyodide-") && key !== PYODIDE_CACHE)) {
        await caches.delete(key);
      }
    }
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok && res.type === "basic") cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(request, { ignoreSearch: true }))
      || (request.mode === "navigate" ? await cache.match("index.html") : undefined);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && (res.type === "cors" || res.type === "basic")) cache.put(request.url, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/pyodide/v314.0.7/")) {
    event.respondWith(cacheFirst(request, PYODIDE_CACHE));
  }
  // 其余（地图瓦片、GMRT 服务）交给浏览器；GMRT 网格由计算线程自己缓存
});
