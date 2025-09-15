// BUNCA HACCP – GitHub-backed app (Render + GitHub only)
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Octokit } = require('octokit');

// --- env ---
const {
  PORT = 10000,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  JWT_SECRET,
  DEFAULT_SHOP = 'BUNCA · City',
  GITHUB_TOKEN,
  GITHUB_REPO,            // e.g. "mouaz43/e-g-bunca-haccp-logbook"
  GITHUB_BRANCH = 'main'
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_REPO || !JWT_SECRET) {
  console.error('Missing env: GITHUB_TOKEN, GITHUB_REPO, JWT_SECRET are required.');
  process.exit(1);
}

const [OWNER, REPO] = GITHUB_REPO.split('/');
const octokit = new Octokit({ auth: GITHUB_TOKEN });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// ---------- GitHub helpers ----------
async function ghGet(path) {
  const res = await octokit.rest.repos.getContent({ owner: OWNER, repo: REPO, path, ref: GITHUB_BRANCH });
  return res.data; // file: {content, sha,...} or array for dir
}
async function ghTryGet(path) { try { return await ghGet(path); } catch { return null; } }
async function ghPut(path, contentBase64, message, sha) {
  return octokit.rest.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path, branch: GITHUB_BRANCH,
    message, content: contentBase64, sha
  });
}
async function readJson(path, fallback = null) {
  const file = await ghTryGet(path);
  if (!file || Array.isArray(file)) { return fallback; }
  const buf = Buffer.from(file.content, 'base64').toString('utf8');
  return JSON.parse(buf);
}
async function writeJson(path, obj, message) {
  const existing = await ghTryGet(path);
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString('base64');
  await ghPut(path, content, message, existing && !Array.isArray(existing) ? existing.sha : undefined);
}
async function listDir(path) {
  const res = await ghTryGet(path);
  return Array.isArray(res) ? res : [];
}

// ---------- bootstrap data on first run ----------
async function ensureFiles() {
  const users = await readJson('data/users.json', null);
  if (!users) await writeJson('data/users.json', [], 'init users.json');

  const shops = await readJson('data/shops.json', null);
  if (!shops) {
    const id = 'shop_default';
    await writeJson('data/shops.json', [{
      id,
      name: DEFAULT_SHOP,
      city: '',
      address: '',
      isActive: true,
      targets: { fridge1Min: 0, fridge1Max: 7, fridge2Min: 0, fridge2Max: 7, freezerMax: -18, ovenMin: 180 }
    }], 'init shops.json');
  }
}
ensureFiles();

// ---------- auth ----------
function setUser(req, _res, next) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(h.slice(7), JWT_SECRET);
    } catch { /* ignore */ }
  }
  next();
}
app.use(setUser);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    const ok = Array.isArray(role) ? role.includes(req.user.role) : req.user.role === role;
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// ---------- login ----------
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  // Admin login (env-based)
  if (ADMIN_EMAIL && ADMIN_PASSWORD &&
      email.toLowerCase() === ADMIN_EMAIL.toLowerCase() &&
      password === ADMIN_PASSWORD) {
    const token = jwt.sign({ sub: 'admin', email, role: 'admin', shops: 'all' }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, role: 'admin', name: 'Admin' });
  }

  // Users from repo
  const users = await readJson('data/users.json', []);
  const u = users.find(x => x.email.toLowerCase() === email.toLowerCase());
  if (!u) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, u.passwordHash || '');
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ sub: u.id, email: u.email, role: u.role || 'staff', shops: u.shops || [] }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, role: u.role || 'staff', name: u.name || u.email });
});

// ---------- shops ----------
app.get('/api/shops', requireAuth, async (_req, res) => {
  const shops = await readJson('data/shops.json', []);
  res.json(shops);
});

// ---------- checklist (today) ----------
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function defaultChecklist(date, shop) {
  return {
    date,
    shopId: shop.id,
    readings: {
      fridge1: null, fridge2: null, freezer: null, oven: null,
      dishwasherOver82C: false, handwashHot: false, cleaningDone: false
    },
    notes: '',
    issues: [],
    lastSavedBy: null,
    lastSavedAt: null,
    targets: shop.targets || { fridge1Min: 0, fridge1Max: 7, fridge2Min: 0, fridge2Max: 7, freezerMax: -18, ovenMin: 180 }
  };
}

app.get('/api/today', requireAuth, async (req, res) => {
  const date = (req.query.date || todayStr()).trim();
  const shopId = (req.query.shopId || 'shop_default').trim();
  const shops = await readJson('data/shops.json', []);
  const shop = shops.find(s => s.id === shopId) || shops[0];

  const path = `data/checklists/${shop.id}/${date}.json`;
  const file = await ghTryGet(path);
  if (!file) return res.json(defaultChecklist(date, shop));

  const data = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  res.json(data);
});

app.post('/api/today', requireAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.date || !body.shopId) return res.status(400).json({ error: 'date and shopId required' });

  body.lastSavedBy = req.user.email;
  body.lastSavedAt = new Date().toISOString();

  const path = `data/checklists/${body.shopId}/${body.date}.json`;
  await writeJson(path, body, `checklist: ${body.shopId} ${body.date}`);
  res.json({ ok: true });
});

// history list (dates only)
app.get('/api/history', requireAuth, async (req, res) => {
  const shopId = (req.query.shopId || 'shop_default').trim();
  const dir = `data/checklists/${shopId}`;
  const items = await listDir(dir);
  const dates = items
    .filter(x => x.type === 'file' && x.name.endsWith('.json'))
    .map(x => x.name.replace('.json', ''))
    .sort()
    .reverse();
  res.json(dates);
});

// ---------- ADMIN (shops & users stored in repo JSON) ----------
app.get('/api/admin/shops', requireRole('admin'), async (_req, res) => {
  res.json(await readJson('data/shops.json', []));
});
app.post('/api/admin/shops', requireRole('admin'), async (req, res) => {
  const shops = await readJson('data/shops.json', []);
  const id = 'shop_' + Date.now().toString(36);
  const s = req.body || {};
  const shop = {
    id,
    name: s.name || 'Shop',
    city: s.city || '',
    address: s.address || '',
    isActive: s.isActive !== false,
    targets: {
      fridge1Min: 0, fridge1Max: 7,
      fridge2Min: 0, fridge2Max: 7,
      freezerMax: -18, ovenMin: 180,
      ...(s.targets || {})
    }
  };
  shops.push(shop);
  await writeJson('data/shops.json', shops, `admin: add shop ${shop.name}`);
  res.status(201).json(shop);
});
app.put('/api/admin/shops/:id', requireRole('admin'), async (req, res) => {
  const shops = await readJson('data/shops.json', []);
  const i = shops.findIndex(s => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'not found' });
  shops[i] = { ...shops[i], ...req.body, id: shops[i].id };
  await writeJson('data/shops.json', shops, `admin: update shop ${shops[i].name}`);
  res.json(shops[i]);
});
app.delete('/api/admin/shops/:id', requireRole('admin'), async (req, res) => {
  const shops = await readJson('data/shops.json', []);
  const next = shops.filter(s => s.id !== req.params.id);
  if (next.length === shops.length) return res.status(404).json({ error: 'not found' });
  await writeJson('data/shops.json', next, `admin: delete shop ${req.params.id}`);
  res.status(204).end();
});

// users
app.get('/api/admin/users', requireRole('admin'), async (_req, res) => {
  const users = await readJson('data/users.json', []);
  res.json(users.map(u => ({ ...u, passwordHash: undefined })));
});
app.post('/api/admin/users', requireRole('admin'), async (req, res) => {
  const users = await readJson('data/users.json', []);
  const { email, name, role = 'staff', shops = [], tempPassword } = req.body || {};
  if (!email || !tempPassword) return res.status(400).json({ error: 'email and tempPassword required' });
  if (users.some(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'email exists' });
  const id = 'user_' + Date.now().toString(36);
  const passwordHash = await bcrypt.hash(String(tempPassword), 10);
  const user = { id, email, name: name || email.split('@')[0], role, shops, passwordHash };
  users.push(user);
  await writeJson('data/users.json', users, `admin: add user ${email}`);
  res.status(201).json({ ...user, passwordHash: undefined });
});
app.put('/api/admin/users/:id', requireRole('admin'), async (req, res) => {
  const users = await readJson('data/users.json', []);
  const i = users.findIndex(u => u.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'not found' });
  const { email, name, role, shops } = req.body || {};
  users[i] = { ...users[i], ...(email ? { email } : {}), ...(name ? { name } : {}), ...(role ? { role } : {}), ...(shops ? { shops } : {}) };
  await writeJson('data/users.json', users, `admin: update user ${users[i].email}`);
  res.json({ ...users[i], passwordHash: undefined });
});
app.delete('/api/admin/users/:id', requireRole('admin'), async (req, res) => {
  const users = await readJson('data/users.json', []);
  const next = users.filter(u => u.id !== req.params.id);
  if (next.length === users.length) return res.status(404).json({ error: 'not found' });
  await writeJson('data/users.json', next, `admin: delete user ${req.params.id}`);
  res.status(204).end();
});
app.post('/api/admin/users/:id/reset-password', requireRole('admin'), async (req, res) => {
  const users = await readJson('data/users.json', []);
  const i = users.findIndex(u => u.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'not found' });
  const { tempPassword } = req.body || {};
  if (!tempPassword) return res.status(400).json({ error: 'tempPassword required' });
  users[i].passwordHash = await bcrypt.hash(String(tempPassword), 10);
  await writeJson('data/users.json', users, `admin: reset password ${users[i].email}`);
  res.json({ ok: true });
});

// ---------- server ----------
app.get('*', (_req, res) => res.sendFile(__dirname + '/public/index.html'));
app.listen(PORT, () => console.log(`BUNCA HACCP on :${PORT}`));
