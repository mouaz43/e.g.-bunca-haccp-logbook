/**
 * BUNCA HACCP minimal backend
 * - Serves /public as static site
 * - JSON API that stores data in your GitHub repo (data/*.json)
 * - CommonJS only (no ESM), uses Node >= 18 global fetch
 */
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const { randomBytes } = require('crypto');
const { nanoid } = require('nanoid');

// ---- env
const PORT = process.env.PORT || 10000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // "owner/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const DEFAULT_SHOP = process.env.DEFAULT_SHOP || 'BUNCA Â· City';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');
const REGISTRATION_CODE = process.env.REGISTRATION_CODE || 'BUNCA-2025';

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.error('Missing GITHUB_TOKEN or GITHUB_REPO env. Please configure Render environment variables.');
}

const [GH_OWNER, GH_REPO] = (GITHUB_REPO || 'owner/repo').split('/');

// ---- app
const app = express();
app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static('public', { extensions: ['html'] }));

// ---- helpers
const GH_API = 'https://api.github.com';
const GH_HEADERS = {
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json'
};

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

async function ghGetFile(path) {
  const url = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: GH_HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text());
  const j = await res.json();
  if (Array.isArray(j)) return j; // directory listing
  const content = Buffer.from(j.content, j.encoding).toString('utf8');
  return { sha: j.sha, content };
}

async function ghPutFile(path, contentStr, message) {
  const existing = await ghGetFile(path);
  const body = {
    message: message || `Update ${path}`,
    content: Buffer.from(contentStr, 'utf8').toString('base64'),
    branch: GITHUB_BRANCH
  };
  if (existing && existing.sha) body.sha = existing.sha;
  const res = await fetch(`${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: GH_HEADERS,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t);
  }
  return await res.json();
}

async function ghEnsureJson(path, fallbackObj) {
  const f = await ghGetFile(path);
  if (!f) {
    await ghPutFile(path, JSON.stringify(fallbackObj, null, 2), `Create ${path}`);
    return fallbackObj;
  }
  try {
    return JSON.parse(f.content);
  } catch (e) {
    // corrupt file, reset
    await ghPutFile(path, JSON.stringify(fallbackObj, null, 2), `Reset ${path}`);
    return fallbackObj;
  }
}

// ---- data layout in repo
// data/shops.json                -> [{id,name,city,address,active}]
// data/templates/<shopId>.json   -> { items: [...], cleaning: [...] }
// data/entries/<shopId>/<date>.json -> { values: {itemId:value}, notes, createdAt, updatedAt }

async function getAllShops() {
  const shops = await ghEnsureJson('data/shops.json', []);
  if (!shops.length) {
    const defaultShop = { id: nanoid(8), name: DEFAULT_SHOP, city: '', address: '', active: true };
    shops.push(defaultShop);
    await ghPutFile('data/shops.json', JSON.stringify(shops, null, 2), 'Init shops.json');
    await ghPutFile(`data/templates/${defaultShop.id}.json`, JSON.stringify({
      items: [
        { id: 'fridge1', label: 'KÃ¼hlschrank 1', type: 'number', unit: 'Â°C', rule: 'range', min: 0, max: 7 },
        { id: 'fridge2', label: 'KÃ¼hlschrank 2', type: 'number', unit: 'Â°C', rule: 'range', min: 0, max: 7 },
        { id: 'freezer',  label: 'TiefkÃ¼hler',  type: 'number', unit: 'Â°C', rule: 'max', max: -18 },
        { id: 'oven',     label: 'Ofen/Backstation Betriebstemp', type: 'number', unit: 'Â°C', rule: 'min', min: 180 }
      ],
      cleaning: [
        { id: 'task_surfaces', task: 'ArbeitsflÃ¤chen desinfizieren', freq: 'tÃ¤glich', area: 'KÃ¼che' },
        { id: 'task_sink', task: 'SpÃ¼lbecken & Armaturen reinigen', freq: 'tÃ¤glich', area: 'SpÃ¼le' }
      ]
    }, null, 2), 'Init default template');
  }
  return shops;
}

async function getTemplate(shopId) {
  return await ghEnsureJson(`data/templates/${shopId}.json`, { items: [], cleaning: [] });
}

async function saveTemplate(shopId, template) {
  await ghPutFile(`data/templates/${shopId}.json`, JSON.stringify(template, null, 2), `Update template ${shopId}`);
}

async function getEntry(shopId, dateStr) {
  const p = `data/entries/${shopId}/${dateStr}.json`;
  const f = await ghGetFile(p);
  if (!f) return null;
  return JSON.parse(f.content);
}

async function saveEntry(shopId, dateStr, entry) {
  const p = `data/entries/${shopId}/${dateStr}.json`;
  await ghPutFile(p, JSON.stringify(entry, null, 2), `Save entry ${shopId}/${dateStr}`);
}

async function listEntryDates(shopId) {
  const dir = await ghGetFile(`data/entries/${shopId}`);
  if (!dir || Array.isArray(dir) === false) return [];
  return dir.filter(x => x.type === 'file' && x.name.endsWith('.json')).map(x => x.name.replace('.json','')).sort().reverse();
}

// ---- auth (very light)
function makeToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}
function authRequired(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'auth' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    req.user = d;
    next();
  } catch {
    return res.status(401).json({ error: 'auth' });
  }
}

// ---- API
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = makeToken({ role: 'admin', email });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30*24*3600*1000 });
    return res.json({ ok: true, role: 'admin' });
  }
  return res.status(401).json({ error: 'invalid' });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// Shops
app.get('/api/shops', async (req, res) => {
  try {
    const shops = await getAllShops();
    res.json(shops);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/shops', authRequired, async (req, res) => {
  try {
    const shops = await getAllShops();
    const incoming = req.body;
    let idx = shops.findIndex(s => s.id === incoming.id);
    if (idx === -1) {
      incoming.id = incoming.id || nanoid(8);
      shops.push(incoming);
    } else {
      shops[idx] = incoming;
    }
    await ghPutFile('data/shops.json', JSON.stringify(shops, null, 2), 'Update shops.json');
    // also write template if provided
    if (incoming.template) {
      await saveTemplate(incoming.id, incoming.template);
    }
    res.json({ ok: true, shop: incoming });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/shops/:id', authRequired, async (req, res) => {
  try {
    const shops = await getAllShops();
    const filtered = shops.filter(s => s.id !== req.params.id);
    await ghPutFile('data/shops.json', JSON.stringify(filtered, null, 2), 'Delete shop');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Template for a shop
app.get('/api/template', async (req, res) => {
  try {
    const { shopId } = req.query;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });
    const t = await getTemplate(shopId);
    res.json(t);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/template', authRequired, async (req, res) => {
  try {
    const { shopId, template } = req.body;
    if (!shopId || !template) return res.status(400).json({ error: 'shopId & template required' });
    await saveTemplate(shopId, template);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Checklist for a date
app.get('/api/checklist', async (req, res) => {
  try {
    const { shopId, date } = req.query;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });
    const t = await getTemplate(shopId);
    const d = date || todayStr();
    const entry = await getEntry(shopId, d);
    res.json({ date: d, template: t, entry: entry || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checklist', async (req, res) => {
  try {
    const { shopId, date, values, notes } = req.body || {};
    if (!shopId) return res.status(400).json({ error: 'shopId required' });
    const d = date || todayStr();
    const now = new Date().toISOString();
    const prev = await getEntry(shopId, d);
    const entry = {
      values: values || (prev ? prev.values : {}),
      notes: typeof notes === 'string' ? notes : (prev ? prev.notes : ''),
      updatedAt: now,
      createdAt: prev?.createdAt || now
    };
    await saveEntry(shopId, d, entry);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// History
app.get('/api/history/list', async (req, res) => {
  try {
    const { shopId } = req.query;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });
    const dates = await listEntryDates(shopId);
    res.json({ dates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/history/entry', async (req, res) => {
  try {
    const { shopId, date } = req.query;
    if (!shopId || !date) return res.status(400).json({ error: 'shopId & date required' });
    const entry = await getEntry(shopId, date);
    res.json(entry || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fallback to index for 404 of html routes
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) return res.status(404).send('Not found');
  next();
});

app.listen(PORT, () => console.log(`BUNCA server running on :${PORT}`));
