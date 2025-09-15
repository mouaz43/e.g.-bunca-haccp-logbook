/* server.js — BUNCA HACCP API + static hosting (GitHub JSON storage)
   Works with Render + your existing /public HTML files.
*/
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');

// ======== CONFIG VIA ENV ========
const PORT = process.env.PORT || 10000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DEFAULT_SHOP = process.env.DEFAULT_SHOP || 'BUNCA · City';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // fine-grained PAT (repo contents read+write)
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // e.g. "mouaz43/e-g-bunca-haccp-logbook"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.warn('[WARN] Missing GITHUB_TOKEN or GITHUB_REPO — API writes will fail.');
}
const [GH_OWNER, GH_NAME] = GITHUB_REPO.split('/');

// ======== GITHUB HELPERS (no Octokit; uses fetch) ========
const API_BASE = `https://api.github.com/repos/${GH_OWNER}/${GH_NAME}/contents`;
const ghHeaders = () => ({
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json'
});

async function ghGet(pathInRepo) {
  const res = await fetch(`${API_BASE}/${encodeURI(pathInRepo)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
    headers: ghHeaders()
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ghPutJSON(pathInRepo, obj, message) {
  const contentB64 = Buffer.from(JSON.stringify(obj, null, 2)).toString('base64');

  // read to get sha (update) or create new
  let sha = undefined;
  const current = await ghGet(pathInRepo);
  if (current && current.sha) sha = current.sha;

  const res = await fetch(`${API_BASE}/${encodeURI(pathInRepo)}`, {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify({
      message,
      content: contentB64,
      branch: GITHUB_BRANCH,
      sha
    })
  });
  if (!res.ok) throw new Error(`GitHub PUT failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ghListDir(pathInRepo) {
  const res = await fetch(`${API_BASE}/${encodeURI(pathInRepo)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
    headers: ghHeaders()
  });
  if (res.status === 404) return []; // treat missing as empty
  if (!res.ok) throw new Error(`GitHub LIST failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function ghReadJSON(pathInRepo, fallback) {
  const file = await ghGet(pathInRepo);
  if (!file) return fallback;
  const decoded = Buffer.from(file.content || '', file.encoding || 'base64').toString('utf8');
  try { return JSON.parse(decoded); } catch { return fallback; }
}

// ======== DATA PATHS IN REPO ========
const P_SHOPS = 'data/shops.json';
const P_TPL = (shopId) => `data/templates/${shopId}.json`;
const P_ENTRY = (shopId, ymd) => `data/entries/${shopId}/${ymd}.json`;

// ======== DEFAULT DATA ========
function defaultTemplate() {
  return {
    items: [
      { id: 'fridge1', label: 'Kühlschrank 1', type: 'number', unit: '°C', rule: 'range', min: 0, max: 7 },
      { id: 'fridge2', label: 'Kühlschrank 2', type: 'number', unit: '°C', rule: 'range', min: 0, max: 7 },
      { id: 'freezer',  label: 'Tiefkühler',   type: 'number', unit: '°C', rule: 'max',   max: -18 },
      { id: 'oven',     label: 'Ofen/Backstation Betriebstemp', type: 'number', unit: '°C', rule: 'min', min: 180 }
    ],
    cleaning: [
      { id: 'task_surfaces', task: 'Arbeitsflächen desinfizieren', freq: 'täglich', area: 'Küche' },
      { id: 'task_fridge',   task: 'Kühlschrank Reinigung',        freq: 'wöchentlich', area: 'Küche' }
    ]
  };
}

function todayYMD(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
}

// ======== APP SETUP ========
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// serve your existing /public (so /info.html, /historie.html, /admin.html all work)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ======== AUTH ========
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function authRequired(req, res, next) {
  const token = req.cookies?.token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = signToken({ email });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 7*24*3600*1000 });
    return res.json({ ok: true, email });
  }
  return res.status(401).json({ error: 'bad_credentials' });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', authRequired, (req, res) => {
  res.json({ email: req.user.email || ADMIN_EMAIL });
});

// ======== INITIALIZATION ========
async function ensureDefaults() {
  // shops.json
  const shops = await ghReadJSON(P_SHOPS, null);
  if (!shops || !Array.isArray(shops.shops)) {
    const defaultId = 'shop_city';
    await ghPutJSON(P_SHOPS, {
      shops: [{ id: defaultId, name: DEFAULT_SHOP, city: '', address: '', active: true }]
    }, 'Init shops.json');
    // default template
    await ghPutJSON(P_TPL(defaultId), defaultTemplate(), `Init template for ${defaultId}`);
  }
}
ensureDefaults().catch(e => console.error('ensureDefaults failed:', e));

// ======== SHOPS ========
app.get('/api/shops', authRequired, async (req, res) => {
  try {
    const data = await ghReadJSON(P_SHOPS, { shops: [] });
    res.json(data.shops || []);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Create/Update shop (+ optional template)
app.post('/api/shops', authRequired, async (req, res) => {
  try {
    const body = req.body || {};
    const { id, name, city, address, active, items, cleaning } = body;

    const data = await ghReadJSON(P_SHOPS, { shops: [] });
    let shops = data.shops || [];

    let shopId = id || `shop_${Math.random().toString(36).slice(2, 8)}`;
    const idx = shops.findIndex(s => s.id === shopId);

    const newShop = { id: shopId, name: name || 'Neuer Shop', city: city || '', address: address || '', active: !!active };
    if (idx >= 0) shops[idx] = { ...shops[idx], ...newShop };
    else shops.push(newShop);

    await ghPutJSON(P_SHOPS, { shops }, `Save shop ${shopId}`);

    // If template provided, save it
    if (Array.isArray(items) || Array.isArray(cleaning)) {
      const tpl = {
        ...(await ghReadJSON(P_TPL(shopId), defaultTemplate())),
        ...(Array.isArray(items) ? { items } : {}),
        ...(Array.isArray(cleaning) ? { cleaning } : {})
      };
      await ghPutJSON(P_TPL(shopId), tpl, `Save template ${shopId}`);
    }

    res.json({ ok: true, shop: newShop });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/shops/:id', authRequired, async (req, res) => {
  try {
    const shopId = req.params.id;
    const data = await ghReadJSON(P_SHOPS, { shops: [] });
    const shops = (data.shops || []).filter(s => s.id !== shopId);
    await ghPutJSON(P_SHOPS, { shops }, `Delete shop ${shopId}`);
    // Note: keeping templates/history by design; remove manually if desired.
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ======== TEMPLATE (items + cleaning plan) ========
app.get('/api/template', authRequired, async (req, res) => {
  try {
    const shopId = String(req.query.shopId || 'shop_city');
    const tpl = await ghReadJSON(P_TPL(shopId), defaultTemplate());
    res.json(tpl);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/template', authRequired, async (req, res) => {
  try {
    const { shopId, items, cleaning } = req.body || {};
    if (!shopId) return res.status(400).json({ error: 'shopId required' });
    const current = await ghReadJSON(P_TPL(shopId), defaultTemplate());
    const next = {
      ...current,
      ...(Array.isArray(items) ? { items } : {}),
      ...(Array.isArray(cleaning) ? { cleaning } : {})
    };
    await ghPutJSON(P_TPL(shopId), next, `Update template ${shopId}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ======== CHECKLIST (daily entry) ========
app.get('/api/checklist', authRequired, async (req, res) => {
  try {
    const shopId = String(req.query.shopId || 'shop_city');
    const date = String(req.query.date || todayYMD());
    const entry = await ghReadJSON(P_ENTRY(shopId, date), { shopId, date, values: {}, notes: '', deviations: 0 });
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/checklist', authRequired, async (req, res) => {
  try {
    const { shopId, date, values, notes, deviations } = req.body || {};
    const sid = String(shopId || 'shop_city');
    const ymd = String(date || todayYMD());
    const payload = {
      shopId: sid,
      date: ymd,
      values: values || {},
      notes: notes || '',
      deviations: Number.isFinite(deviations) ? deviations : 0
    };
    await ghPutJSON(P_ENTRY(sid, ymd), payload, `Save entry ${sid}/${ymd}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ======== HISTORY ========
app.get('/api/history/list', authRequired, async (req, res) => {
  try {
    const shopId = String(req.query.shopId || 'shop_city');
    const dir = `data/entries/${shopId}`;
    const files = await ghListDir(dir);
    const dates = files
      .filter(f => f.type === 'file' && f.name.endsWith('.json'))
      .map(f => f.name.replace('.json', ''))
      .sort()
      .reverse();
    res.json(dates);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/history/entry', authRequired, async (req, res) => {
  try {
    const shopId = String(req.query.shopId || 'shop_city');
    const date = String(req.query.date || todayYMD());
    const entry = await ghReadJSON(P_ENTRY(shopId, date), null);
    if (!entry) return res.status(404).json({ error: 'not_found' });
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ======== FALLBACK (so /, /index.html, /info.html, etc. work) ========
app.get('*', (req, res, next) => {
  // Let static middleware handle existing files; otherwise send index
  if (req.path.includes('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ======== START ========
app.listen(PORT, () => {
  console.log(`BUNCA server running on :${PORT}`);
});
