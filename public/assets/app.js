// Shared helpers (navbar + auth utils)
(function(){
  const btn = document.querySelector('#menuToggle');
  const nav = document.querySelector('#mainNav');
  if(btn && nav){
    btn.addEventListener('click', ()=> nav.classList.toggle('open'));
  }
})();

export function csrf(){
  return sessionStorage.getItem('csrf') || '';
}

export async function requireSession(role){ // role: 'admin' | 'user' | undefined
  const res = await fetch('/api/auth/session');
  const data = await res.json();
  if(!data.session){ location.href = '/login'; return null; }
  if(role && data.session.role !== role){ location.href='/login'; return null; }
  if(!sessionStorage.getItem('csrf')) sessionStorage.setItem('csrf', data.session.csrf);
  return data.session;
}

export async function api(url, method='GET', body){
  const opt = { method, headers: {} };
  if(['POST','PUT','PATCH','DELETE'].includes(method)){
    opt.headers['Content-Type'] = 'application/json';
    opt.headers['x-csrf-token'] = csrf();
    opt.body = JSON.stringify(body || {});
  }
  const res = await fetch(url, opt);
  return res.json();
}
