// BUNCA HACCP — Service Worker (cache-first for assets, network-first for pages)
const CACHE = 'bunca-v1';
const CORE = [
  '/', '/index.html', '/admin.html', '/check.html', '/history.html', '/dashboard.html', '/shop.html', '/login.html',
  '/assets/styles.css', '/assets/helpers.js', '/manifest.webmanifest'
];

self.addEventListener('install', (e)=>{
  e.waitUntil((async()=>{
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE.map(u => new Request(u, { cache: 'reload' })));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e)=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e)=>{
  const req = e.request;
  const url = new URL(req.url);

  // Same-origin only
  if(url.origin !== location.origin) return;

  // Don’t interfere with non-GET (let app handle)
  if(req.method !== 'GET') return;

  // HTML navigations: network-first, fall back to cache
  if(req.mode === 'navigate' || (req.headers.get('accept')||'').includes('text/html')){
    e.respondWith(networkFirst(req));
    return;
  }

  // Static assets: stale-while-revalidate
  if(url.pathname.startsWith('/assets/') || url.pathname.endsWith('.webmanifest')){
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  // API GETs: network-first, cache fallback
  if(url.pathname.startsWith('/api/')){
    e.respondWith(networkFirst(req));
    return;
  }

  // Otherwise: try cache, then network
  e.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req){
  const cache = await caches.open(CACHE);
  try{
    const res = await fetch(req);
    if(res && res.ok) cache.put(req, res.clone());
    return res;
  }catch{
    const cached = await cache.match(req);
    if(cached) return cached;
    // Minimal offline fallback for navigations
    if(req.mode === 'navigate'){
      return new Response(`<html><body><h1>Offline</h1><p>You’re offline. Try again when you’re connected.</p></body></html>`, {
        headers:{'Content-Type':'text/html'}
      });
    }
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(req){
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(res=>{
    if(res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(()=> null);
  return cached || fetchPromise || new Response('Offline', { status: 503 });
}
