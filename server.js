const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const path = require('path');

// ------- ENV -------
const {
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_BRANCH = 'main',
  JWT_SECRET = 'please_change_me',
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  DEFAULT_SHOP = 'BUNCA · City'
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_REPO || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.log('Missing required env vars. Please set GITHUB_TOKEN, GITHUB_REPO, ADMIN_EMAIL, ADMIN_PASSWORD.');
}

const [owner, repo] = (GITHUB_REPO || 'owner/name').split('/');
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ------- helpers for GitHub file storage -------
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
async function getFile(p) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: p, ref: GITHUB_BRANCH });
    if (Array.isArray(data)) throw new Error('Path is a directory');
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { content, sha: data.sha };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
async function putFile(p, content, message) {
  const existing = await getFile(p);
  const params = {
    owner, repo, path: p, message,
    content: b64(content),
    branch: GITHUB_BRANCH
  };
  if (existing && existing.sha) params.sha = existing.sha;
  await octokit.repos.createOrUpdateFileContents(params);
}
async function loadJSON(p, fallback) {
  const f = await getFile(p);
  if (!f) return fallback;
  try { return JSON.parse(f.content); } catch { return fallback; }
}
async function saveJSON(p, obj, message) {
  await putFile(p, JSON.stringify(obj, null, 2), message);
}

// ------- auth helpers -------
function randomId(prefix='id') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}
function hashPassword(pw, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, s, 64).toString('hex');
  return { salt: s, hash };
}
function verifyPassword(pw, rec) {
  const hash = crypto.scryptSync(pw, rec.salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(rec.hash, 'hex'));
}
function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '7d' });
}
function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}
function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'forbidden' });
}

// ------- ensure store with admin user -------
const USERS = 'store/users.json';
const SHOPS = 'store/shops.json';

async function initStore() {
  const users = await loadJSON(USERS, null);
  if (!users) {
    const id = randomId('user');
    const { salt, hash } = hashPassword(ADMIN_PASSWORD);
    const seed = {
      users: [{
        id, email: ADMIN_EMAIL, role: 'admin', password: { salt, hash }
      }]
    };
    await saveJSON(USERS, seed, 'seed users.json with admin');
  }
  const shops = await loadJSON(SHOPS, null);
  if (!shops) {
    const seed = { shops: [{
      id: randomId('shop'),
      name: DEFAULT_SHOP,
      city: '',
      address: '',
      active: true,
      items: [
        { id: randomId('item'), label: 'Kühlschrank 1', type: 'number', unit: '°C', rule: 'range', min: 0, max: 7 },
        { id: randomId('item'), label: 'Kühlschrank 2', type: 'number', unit: '°C', rule: 'range', min: 0, max: 7 },
        { id: randomId('item'), label: 'Tiefkühler',    type: 'number', unit: '°C', rule: 'max',   min: -999, max: -18 },
        { id: randomId('item'), label: 'Ofen/Backstation Betriebstemp', type: 'number', unit: '°C', rule: 'min', min: 180, max: 999 }
      ],
      cleaning: [
        { id: randomId('task'), task: 'Arbeitsflächen reinigen', freq: 'täglich', area: 'Küche' }
      ]
    }]};
    await saveJSON(SHOPS, seed, 'seed shops.json with default shop');
  }
}
initStore().catch(console.error);

// ------- app -------
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// --- auth ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const db = await loadJSON(USERS, { users: [] });
  const user = db.users.find(u => u.email.toLowerCase() === String(email||'').toLowerCase());
  if (!user || !verifyPassword(password || '', user.password))
    return res.status(401).json({ error: 'invalid_credentials' });

  const token = sign(user);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 7*24*60*60*1000 });
  res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  res.json({ ok: true, user: req.user });
});

// --- user registration (optional) ---
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
  const db = await loadJSON(USERS, { users: [] });
  if (db.users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'email_exists' });
  const rec = { id: randomId('user'), email, role: 'user', password: hashPassword(password) };
  db.users.push(rec);
  await saveJSON(USERS, db, `register user ${email}`);
  res.json({ ok: true });
});

// --- shops CRUD ---
app.get('/api/shops', requireAuth, async (req, res) => {
  const db = await loadJSON(SHOPS, { shops: [] });
  res.json({ shops: db.shops });
});

app.post('/api/shops', requireAuth, requireAdmin, async (req, res) => {
  const db = await loadJSON(SHOPS, { shops: [] });
  const s = req.body;
  const rec = {
    id: randomId('shop'),
    name: s.name || 'Neuer Shop',
    city: s.city || '',
    address: s.address || '',
    active: !!s.active,
    items: Array.isArray(s.items) ? s.items : [],
    cleaning: Array.isArray(s.cleaning) ? s.cleaning : []
  };
  db.shops.push(rec);
  await saveJSON(SHOPS, db, `add shop ${rec.name}`);
  res.json({ ok: true, shop: rec });
});

app.put('/api/shops/:id', requireAuth, requireAdmin, async (req, res) => {
  const db = await loadJSON(SHOPS, { shops: [] });
  const i = db.shops.findIndex(s => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'shop_not_found' });
  db.shops[i] = { ...db.shops[i], ...req.body, id: db.shops[i].id };
  await saveJSON(SHOPS, db, `update shop ${db.shops[i].name}`);
  res.json({ ok: true, shop: db.shops[i] });
});

app.delete('/api/shops/:id', requireAuth, requireAdmin, async (req, res) => {
  const db = await loadJSON(SHOPS, { shops: [] });
  const i = db.shops.findIndex(s => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'shop_not_found' });
  const removed = db.shops.splice(i, 1)[0];
  await saveJSON(SHOPS, db, `delete shop ${removed.name}`);
  res.json({ ok: true });
});

// --- checklist (build form + save results) ---
function evaluateDeviation(rule, min, max, v) {
  if (v === '' || v === null || v === undefined) return false;
  const val = Number(v);
  if (Number.isNaN(val)) return true;
  if (rule === 'range') return !(val >= Number(min) && val <= Number(max));
  if (rule === 'min') return !(val >= Number(min));
  if (rule === 'max') return !(val <= Number(max));
  return false;
}

app.get('/api/checklist', requireAuth, async (req, res) => {
  const shopId = req.query.shopId;
  const date = String(req.query.date || new Date().toISOString().slice(0,10));
  const db = await loadJSON(SHOPS, { shops: [] });
  const shop = db.shops.find(s => s.id === shopId) || db.shops[0];
  if (!shop) return res.status(404).json({ error: 'no_shops' });
  res.json({ ok: true, date, shop: { id: shop.id, name: shop.name }, items: shop.items, cleaning: shop.cleaning });
});

app.post('/api/checklist', requireAuth, async (req, res) => {
  const { shopId, date, values, notes } = req.body || {};
  const db = await loadJSON(SHOPS, { shops: [] });
  const shop = db.shops.find(s => s.id === shopId);
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });

  const day = date || new Date().toISOString().slice(0,10);
  let checks = 0, deviations = 0;
  for (const it of shop.items) {
    const v = values?.[it.id];
    if (v !== undefined && v !== '') checks++;
    if (it.type === 'number') {
      if (evaluateDeviation(it.rule, it.min, it.max, v)) deviations++;
    } else if (it.type === 'boolean') {
      // no deviation by default on boolean
    }
  }
  const entry = {
    shopId: shop.id,
    date: day,
    by: req.user.email,
    values: values || {},
    notes: notes || '',
    checks,
    deviations
  };

  const logPath = `store/logs/${shop.id}/${day}.json`;
  await saveJSON(logPath, entry, `save checklist ${shop.name} ${day}`);
  res.json({ ok: true, checks, deviations });
});

// --- history ---
app.get('/api/history', requireAuth, async (req, res) => {
  const shopId = req.query.shopId;
  const db = await loadJSON(SHOPS, { shops: [] });
  const shop = db.shops.find(s => s.id === shopId) || db.shops[0];
  if (!shop) return res.json({ entries: [] });

  // list directory (GitHub API doesn't have "list dir" via getContent for directories)
  try {
    const { data } = await octokit.repos.getContent({
      owner, repo, path: `store/logs/${shop.id}`, ref: GITHUB_BRANCH
    });
    if (!Array.isArray(data)) return res.json({ entries: [] });
    const files = data.filter(f => f.type === 'file' && f.name.endsWith('.json'));
    const entries = [];
    for (const f of files) {
      const gf = await getFile(f.path);
      if (!gf) continue;
      try { entries.push(JSON.parse(gf.content)); } catch {}
    }
    entries.sort((a,b)=> a.date < b.date ? 1 : -1);
    res.json({ entries });
  } catch (e) {
    if (e.status === 404) return res.json({ entries: [] });
    throw e;
  }
});

// -------------- SPA pages --------------
app.get('/info.html', (req,res)=>res.sendFile(path.join(__dirname,'public','info.html')));
app.get('/admin.html', (req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/historie.html', (req,res)=>res.sendFile(path.join(__dirname,'public','historie.html')));
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// ------- start -------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Server running on :' + PORT);
});
