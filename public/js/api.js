// tiny helper for same-origin API
async function api(path, options={}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'include'
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function me() {
  try { const r = await api('/api/me'); return r.user; } catch { return null; }
}
async function login(email, password) { return api('/api/login', { method:'POST', body:{ email, password } }); }
async function logout(){ return api('/api/logout', { method:'POST' }); }

function option(text, val){ const o=document.createElement('option'); o.textContent=text; o.value=val; return o; }
function today(){ return new Date().toISOString().slice(0,10); }
function csvEscape(s){ return `"${String(s).replace(/"/g,'""')}"`; }
