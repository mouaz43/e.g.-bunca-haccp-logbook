// public/js/api.js
const API = (() => {
  const base = '';

  async function request(path, { method = 'GET', body } = {}) {
    const res = await fetch(base + path, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      // Try to show JSON error, else text
      let msg = '';
      try { msg = (await res.json()).error || ''; } catch { msg = await res.text(); }
      throw new Error(msg || `${method} ${path} failed (${res.status})`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // --- Auth ---
  const me     = () => request('/api/me');
  const login  = (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } });
  const logout = () => request('/api/auth/logout', { method: 'POST' });

  // --- Shops & Templates ---
  const listShops   = () => request('/api/shops');
  const saveShop    = (shop) => request('/api/shops', { method: 'POST', body: shop });
  const deleteShop  = (id) => request(`/api/shops/${encodeURIComponent(id)}`, { method: 'DELETE' });

  const getTemplate = (shopId) => request(`/api/template?shopId=${encodeURIComponent(shopId)}`);
  const saveTemplate = (shopId, { items, cleaning }) =>
    request('/api/template', { method: 'POST', body: { shopId, items, cleaning } });

  // --- Checklist / History ---
  const getChecklist = (shopId, date) =>
    request(`/api/checklist?shopId=${encodeURIComponent(shopId)}&date=${encodeURIComponent(date || '')}`);
  const saveChecklist = (payload) =>
    request('/api/checklist', { method: 'POST', body: payload });

  const listHistory = (shopId) =>
    request(`/api/history/list?shopId=${encodeURIComponent(shopId)}`);
  const getHistoryEntry = (shopId, date) =>
    request(`/api/history/entry?shopId=${encodeURIComponent(shopId)}&date=${encodeURIComponent(date)}`);

  // --- Utils ---
  const today = () => {
    const d = new Date();
    const z = (n) => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
  };

  return {
    me, login, logout,
    listShops, saveShop, deleteShop,
    getTemplate, saveTemplate,
    getChecklist, saveChecklist,
    listHistory, getHistoryEntry,
    today
  };
})();
