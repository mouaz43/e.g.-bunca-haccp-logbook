// Shared API client for all pages
window.API = (() => {
  const state = {
    token: localStorage.getItem('btoken') || '',
    shopId: localStorage.getItem('bshopId') || '',
    shopName: localStorage.getItem('bshopName') || ''
  };

  function setToken(t){ state.token = t || ''; if(t) localStorage.setItem('btoken', t); else localStorage.removeItem('btoken'); }
  function setShop(id, name){ state.shopId = id||''; state.shopName = name||''; localStorage.setItem('bshopId', state.shopId); localStorage.setItem('bshopName', state.shopName); }

  async function req(path, opt={}){
    opt.headers = Object.assign({ 'Content-Type':'application/json' }, opt.headers||{});
    if (state.token) opt.headers.Authorization = `Bearer ${state.token}`;
    const r = await fetch(path, opt);
    if (!r.ok) {
      let msg = `${r.status}`;
      try { const j = await r.json(); msg = j.error || JSON.stringify(j); } catch {}
      throw new Error(msg);
    }
    if (r.status === 204) return null;
    return r.json();
  }

  return {
    token: () => state.token,
    setShop,
    getShop: () => ({ id: state.shopId, name: state.shopName }),

    login: async (email, password) => {
      const j = await req('/api/auth/login', { method:'POST', body: JSON.stringify({ email, password })});
      setToken(j.token);
      return j;
    },
    register: (payload) => req('/api/auth/register', { method:'POST', body: JSON.stringify(payload)}),
    logout: () => { setToken(''); },

    shops: () => req('/api/shops'),
    createShop: (shop) => req('/api/shops', { method:'POST', body: JSON.stringify(shop) }),
    updateShop: (id, patch) => req(`/api/shops/${id}`, { method:'PUT', body: JSON.stringify(patch) }),
    deleteShop: (id) => req(`/api/shops/${id}`, { method:'DELETE' }),

    today: (shopId, date) => req(`/api/today?shopId=${encodeURIComponent(shopId||'')}${date?`&date=${date}`:''}`),
    saveToday: (payload) => req('/api/today', { method:'POST', body: JSON.stringify(payload)}),

    history: (shopId, from, to) => {
      const p = new URLSearchParams({ shopId });
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      return req(`/api/history?${p.toString()}`);
    }
  };
})();
