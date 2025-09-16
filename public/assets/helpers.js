// BUNCA – Helpers (DE)  | Theme + Page-ID + PWA + Queue + Nav
(function(){
  // ---------- THEME ----------
  const THEME_KEY = 'bunca.theme'; // 'roast' | 'espresso'
  function getTheme(){ return localStorage.getItem(THEME_KEY) || 'roast'; }
  function applyTheme(t){ document.documentElement.setAttribute('data-theme', t); }
  function setTheme(t){ localStorage.setItem(THEME_KEY, t); applyTheme(t); }
  function toggleTheme(){ setTheme(getTheme()==='roast' ? 'espresso' : 'roast'); }

  // ---------- PAGE ID (für seiten-spezifische Hintergründe) ----------
  function setPageId(){
    const p = location.pathname;
    let page = 'home';
    if (p.startsWith('/dashboard')) page = 'dashboard';
    else if (p.startsWith('/admin')) page = 'admin';
    else if (p.startsWith('/shop')) page = 'shop';
    else if (p.startsWith('/check')) page = 'check';
    else if (p.startsWith('/history')) page = 'history';
    else if (p.startsWith('/login')) page = 'login';
    document.documentElement.setAttribute('data-page', page);
  }

  // ---------- CSRF / Auth ----------
  function csrf(){ return sessionStorage.getItem('csrf') || ''; }
  async function requireSession(role){
    const r = await fetch('/api/auth/session'); const d = await r.json();
    if(!d.session){ location.href='/login'; return null; }
    if(role && d.session.role !== role){ location.href='/login'; return null; }
    if(!sessionStorage.getItem('csrf')) sessionStorage.setItem('csrf', d.session.csrf);
    return d.session;
  }

  // ---------- Fetch Wrapper ----------
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

  // ---------- Offline-Queue ----------
  const QKEY = 'bunca.queue.v1';
  function loadQueue(){ try{ return JSON.parse(localStorage.getItem(QKEY)||'[]'); }catch{ return []; } }
  function saveQueue(arr){ localStorage.setItem(QKEY, JSON.stringify(arr)); }
  function addToQueue(entry){
    const q = loadQueue(); q.push({ ...entry, enqueued_at: Date.now() }); saveQueue(q);
    toast('Offline gespeichert. Synchronisiert automatisch, sobald online.');
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
      }catch(e){ keep.push(job); }
    }
    saveQueue(keep);
    if(q.length !== keep.length){ toast(`${q.length - keep.length} Element(e) synchronisiert.`); }
  }
  function enqueueIfOffline(url, method, body){
    if(navigator.onLine) return false;
    addToQueue({ url, method, body }); return true;
  }

  // ---------- PWA ----------
  async function registerSW(){
    if(!('serviceWorker' in navigator)) return;
    try{ await navigator.serviceWorker.register('/sw.js'); navigator.serviceWorker.ready.then(()=> flushQueue()); }catch(e){}
  }
  function ensureManifest(){
    if(document.querySelector('link[rel="manifest"]')) return;
    const link = document.createElement('link'); link.rel='manifest'; link.href='/manifest.webmanifest'; document.head.appendChild(link);
  }
  function handleOnlineStatus(){
    const set = ()=> {
      document.documentElement.dataset.online = String(navigator.onLine);
      if(navigator.onLine){ toast('Wieder online'); flushQueue(); }
      else { toast('Du bist offline','warn'); }
    };
    window.addEventListener('online', set);
    window.addEventListener('offline', set);
    set();
  }

  // ---------- Navbar ----------
  function initNav(){
    const btn = document.querySelector('#menuToggle');
    const nav = document.querySelector('#mainNav');
    if(btn && nav){ btn.addEventListener('click', ()=> nav.classList.toggle('open')); }
    const links = document.querySelectorAll('#mainNav a');
    const path = location.pathname;
    links.forEach(a=>{ if(a.getAttribute('href') === path) a.classList.add('active'); });

    // Theme Toggle rechts in der Navi
    if(nav && !document.getElementById('themeToggle')){
      const tbtn = document.createElement('button');
      tbtn.id='themeToggle'; tbtn.type='button'; tbtn.className='btn small invert'; tbtn.title='Theme wechseln';
      tbtn.innerHTML = '<svg class="icon"><use href="/assets/icons.svg#settings"/></svg><span>Theme</span>';
      tbtn.addEventListener('click', ()=>{ toggleTheme(); toast(getTheme()==='roast'?'Helles Theme':'Dunkles Theme'); });
      nav.appendChild(tbtn);
    }
  }

  // ---------- Expose ----------
  window.Bunca = {
    csrf, requireSession, api, toast,
    registerSW, ensureManifest, flushQueue,
    queue: { add: addToQueue, list: loadQueue, flush: flushQueue },
    enqueueIfOffline
  };

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', ()=>{
    applyTheme(getTheme());
    setPageId();
    initNav();
    ensureManifest();
    handleOnlineStatus();
    registerSW();
  });
})();
