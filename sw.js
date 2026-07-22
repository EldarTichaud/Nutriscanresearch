const CACHE = 'nsr-v090';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Ne jamais intercepter les requêtes cross-origin (Supabase, API tierces) :
  // tenter de cacher/cloner leur réponse pouvait planter ("Response body is
  // already used") et faisait retomber sur le cache au lieu de la vraie
  // réponse réseau — cassant silencieusement des appels Supabase (ex: le
  // chargement du projet du patient). Seuls les fichiers de l'app (même
  // origine) sont mis en cache.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
