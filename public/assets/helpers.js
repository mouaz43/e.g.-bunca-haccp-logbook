// Global helpers + nav + toasts. Plain script (no modules). Exposes window.Bunca
(function(){
  function csrf(){ return sessionStorage.getItem('csrf') || ''; }
  async function requireSession(role){
    const r = await fetch('/api/auth/session'); const d = await r.json();
    if(!d.session){ location.href='/login'; return null; }
    if(role && d.session.role !== role){ location.href='/login'; return null; }
    if(!sessionStorage.getItem('csrf')) sessionStorage.setItem('csrf', d.session.csrf);
    return d.session;
  }
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

  // Expose
  window.Bunca = { csrf, requireSession, api, toast };

  // Navbar + mobile menu + FAB behaviors
  document.addEventListener('DOMContentLoaded', ()=>{
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
  });
})();
