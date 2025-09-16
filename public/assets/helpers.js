// Global helpers + nav + toasts + PWA bootstrap. Exposes window.Bunca
(function(){
  // ---------- CSRF / Auth ----------
  function csrf(){ return sessionStorage.getItem('csrf') || ''; }
  async function requireSession(role){
    const r = await fetch('/api/auth/session'); const d = await r.json();
    if(!d.session){ location.href='/login'; return null; }
    if(role && d.session.role !== role){ location.href='/login'; return null; }
    if(!sessionStorage.getItem('csrf')) sessionStorage.setItem('csrf', d.session.csrf);
    return d.session;
  }

  // ---------- Fetch wrapper (unchanged semantics) ----------
  async function api(url, method='GET', body){
    const opt = { method, headers:{} };
    if(['POST','PUT','PATCH','DELETE'].includes(method)){
      opt.headers['Content-Type'] = 'application/json';
      opt.headers['x-csrf-token'] = csrf();
      opt.body = JSON.stringify(body || {});
    }
    const res = await fetch(url, opt);
    return res.json();
  }

  // ---------- Toasts ----------
  function toast(msg, type){
    let root = document.getElementById('toast-root');
    if(!root){ root = document.createElement('div'); root.id='toast-root'; document.body.appendChild(root); }
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' '+type : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateY(5px)'; }, 2600);
    setTimeout(()=> root.removeChild(el), 3000);
  }

  // ---------- Minimal offline queue (foundation) ----------
  const QKEY = 'bunca.queue.v1';
  function loadQueue(){ try{ return JSON.parse(localStorage.getItem(QKEY)||'[]'); }catch{ return []; } }
  function saveQueue(arr){ localStorage.setItem(QKEY, JSON.stringify(arr)); }
  function addToQueue(entry){
    const q = loadQueue(); q.push({ ...entry, enqueued_at: Date.now() }); saveQueue(q);
    toast('Saved offline. Will sync when online.');
  }
  async function flushQueue(){
    if(!navigator.onLine) return;
    const q = loadQueue(); if(!q.length) return;
    const keep = [];
    for(const job of q){
      try{
        const res = await fetch(job.url, {
          method: job.method || 'POST',
          headers: job.headers || { 'Content-Type':'application/json', 'x-csrf-token': csrf() },
          body: job.body ? JSON.stringify(job.body) : undefined
        });
        if(!res.ok) throw new Error('HTTP '+res.status);
      }catch(e){
        // keep if still failing
        keep.push(job);
      }
    }
    saveQueue(keep);
    if(q.length !== keep.length){
      toast(`Synced ${q.length - keep.length} item(s).`);
    }
  }

  // Optional helper you can call from pages later:
  // if offline and this is a run submission, enqueue instead of failing outright.
  function enqueueIfOffline(url, method, body){
    if(navigator.onLine) return false; // no-op, go normal
    addToQueue({ url, method, body });
    return true;
  }

  // ---------- PWA: Service Worker + Manifest ----------
  async function registerSW(){
    if(!('serviceWorker' in navigator)) return;
    try{
      await navigator.serviceWorker.register('/sw.js');
      // Try to flush any queued work after SW is ready
      navigator.serviceWorker.ready.then(()=> flushQueue());
    }catch(e){ /* silent */ }
  }

  function ensureManifest(){
    if(document.querySelector('link[rel="manifest"]')) return;
    const link = document.createElement('link');
    link.rel = 'manifest'; link.href = '/manifest.webmanifest';
    document.head.appendChild(link);
  }

  function handleOnlineStatus(){
    const set = ()=> {
      document.documentElement.dataset.online = String(navigator.onLine);
      if(navigator.onLine){ toast('Back online'); flushQueue(); }
      else { toast('You are offline','warn'); }
    };
    window.addEventListener('online', set);
    window.addEventListener('offline', set);
    set();
  }

  // ---------- Navbar + mobile menu + FAB ----------
  function initNav(){
    const btn = document.querySelector('#menuToggle');
    const nav = document.querySelector('#mainNav');
    if(btn && nav){ btn.addEventListener('click', ()=> nav.classList.toggle('open')); }

    const links = document.querySelectorAll('#mainNav a');
    const path = location.pathname;
    links.forEach(a=>{ if(a.getAttribute('href') === path) a.classList.add('active'); });

    const fab = document.getElementById('fab');
    const fabMenu = document.getElementById('fabMenu');
    if(fab && fabMenu){
      fab.addEventListener('click', ()=> fabMenu.classList.toggle('open'));
      document.addEventListener('click', (e)=>{
        if(!fab.contains(e.target) && !fabMenu.contains(e.target)) fabMenu.classList.remove('open');
      });
    }
  }

  // ---------- Expose ----------
  window.Bunca = {
    csrf, requireSession, api, toast,
    // PWA helpers
    registerSW, ensureManifest, flushQueue,
    // Offline queue (to be used by pages we’ll upgrade)
    queue: { add: addToQueue, list: loadQueue, flush: flushQueue },
    enqueueIfOffline
  };

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', ()=>{
    initNav();
    ensureManifest();
    handleOnlineStatus();
    registerSW();
  });
})();
