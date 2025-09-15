/* public/js/api.js
   Unified API for BUNCA HACCP
   - Reads/writes shops from whichever backend exists (/store/* or /api/*)
   - Falls back to localStorage cache
*/
window.API = (function () {
  const LS_SHOPS = "bunca_shops";
  const LS_SEL = "bunca_shop";
  const HEADERS = { "Content-Type": "application/json" };

  // ---------- helpers ----------
  async function tryGet(path) {
    try {
      const r = await fetch(path, { credentials: "same-origin" });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) {
      return null;
    }
  }

  async function trySend(method, path, body) {
    try {
      const r = await fetch(path, {
        method,
        headers: HEADERS,
        body: JSON.stringify(body),
        credentials: "same-origin",
      });
      return r.ok;
    } catch (_) {
      return false;
    }
  }

  function normalizeShops(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.shops)) return payload.shops;
    if (Array.isArray(payload.data)) return payload.data;
    return [];
  }

  // pick the non-empty result if possible
  function pickBest(listA, listB) {
    if (listA.length && !listB.length) return listA;
    if (!listA.length && listB.length) return listB;
    // if both have data, prefer the longer one
    if (listA.length && listB.length) return listA.length >= listB.length ? listA : listB;
    // both empty
    return listA;
  }

  // ---------- shops ----------
  async function readShops() {
    // Try both server locations
    const s1 = normalizeShops(await tryGet("/store/shops"));
    const s2 = normalizeShops(await tryGet("/api/shops"));
    let shops = pickBest(s1, s2);

    // If server empty, try cache
    if (!shops.length) {
      const raw = localStorage.getItem(LS_SHOPS);
      if (raw) {
        try {
          const cached = JSON.parse(raw);
          if (Array.isArray(cached)) shops = cached;
        } catch {}
      }
    }

    // Normalize shape for consumers
    shops = shops.map((s, i) => ({
      id: s.id || `shop_${i}`,
      name: s.name || s.label || "Shop",
      active: s.active !== false,
      city: s.city || s.stadt || "",
      address: s.address || s.adresse || "",
      items: Array.isArray(s.items) ? s.items : (Array.isArray(s.checklist) ? s.checklist : []),
      cleaning: Array.isArray(s.cleaning) ? s.cleaning : [],
    }));

    // Cache what we have
    localStorage.setItem(LS_SHOPS, JSON.stringify(shops));
    return shops;
  }

  // Write whole list (Admin usually edits full shop object)
  async function saveShops(shops) {
    // keep cache in sync
    localStorage.setItem(LS_SHOPS, JSON.stringify(shops));

    // Try both endpoints; succeed if one accepts it
    const payload = { shops };
    const okStore = await trySend("PUT", "/store/shops", payload);
    const okApi = await trySend("PUT", "/api/shops", payload);
    return okStore || okApi;
  }

  // Convenience: update a single shop and persist
  async function upsertShop(shop) {
    const all = await readShops();
    const idx = all.findIndex((s) => s.id === shop.id);
    if (idx >= 0) all[idx] = shop;
    else all.push(shop);
    return saveShops(all);
  }

  // ---------- selection ----------
  function setShopId(id) {
    localStorage.setItem(LS_SEL, JSON.stringify({ id }));
  }

  function getShop() {
    const allRaw = localStorage.getItem(LS_SHOPS);
    const all = allRaw ? JSON.parse(allRaw) : [];
    const selRaw = localStorage.getItem(LS_SEL);
    const sel = selRaw ? JSON.parse(selRaw) : null;

    if (sel && all.length) {
      const s = all.find((x) => x.id === sel.id);
      if (s) return s;
    }
    return all[0] || null;
  }

  // ---------- auth stubs (kept for compatibility with pages that call them) ----------
  function token() {
    // If you later add JWT, store it under 'bunca_token'
    return localStorage.getItem("bunca_token") || null;
  }
  async function login(email, password) {
    // If you later wire a real login endpoint, put it here.
    // For now we just remember the email so prompts disappear.
    localStorage.setItem("bunca_user", email || "");
    return true;
  }
  function logout() {
    localStorage.removeItem("bunca_token");
    localStorage.removeItem("bunca_user");
  }

  // ---------- exports ----------
  return {
    // shops
    shops: readShops,
    saveShops,
    upsertShop,
    getShop,
    setShopId,

    // auth
    token,
    login,
    logout,
  };
})();
