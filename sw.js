// Service worker de "Menú de la semana"
// - HTML (navegación): network-first → siempre ves la última versión si hay internet; offline usa la cache.
// - Resto del app shell e íconos: stale-while-revalidate.
// - Fuentes de Google: cache-first.
// - Supabase y cualquier otro origen: NUNCA se interceptan ni se cachean.
// Para publicar una versión nueva: sube CACHE_VERSION (ej. v3 → v4). La app mostrará "Actualizar".

const CACHE_VERSION = 'v8';
const CACHE_NAME = `menu-familiar-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './config.js',
  './cloud-sync.js',
  './vendor/supabase.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  // sin skipWaiting automático: la página pregunta al usuario y luego envía SKIP_WAITING
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('menu-familiar-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(request, response) {
  if (response && (response.status === 200 || response.type === 'opaque')) {
    const clone = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fuentes: cache-first
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(caches.match(req).then((c) => c || fetch(req).then((r) => putInCache(req, r))));
    return;
  }

  // Cualquier otro origen (Google Drive, accounts.google.com, etc.): directo a la red
  if (url.origin !== self.location.origin) return;

  // Navegación / HTML: network-first
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((r) => putInCache('./index.html', r))
        .catch(() => caches.match('./index.html').then((c) => c || caches.match('./')))
    );
    return;
  }

  // Resto del mismo origen: stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((r) => putInCache(req, r)).catch(() => cached);
      return cached || network;
    })
  );
});
