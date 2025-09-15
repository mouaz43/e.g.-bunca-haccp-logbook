// BUNCA HACCP – GitHub-backed app (Render + GitHub only)
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Octokit } = require('octokit');

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
app.use(express.json({ limit: '4mb' }));
app.use(express.static('public'));

// ---------- GitHub helpers ----------
async function ghGet(path) {
  const res = await octokit.rest.repos.getContent({ owner: OWNER, repo: REPO, path, ref: GITHUB_BRANCH });
  return res.data;
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
  if (!file || Array.isArray(file)) return fallback;
  const text = Buffer.from(file.content, 'base64').toString('utf8');
  return JSON.parse(text);
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

// ---------- defaults ----------
function defaultCheckItems() {
  return [
    { id: 'fridge1', label: 'Kühlschrank 1', type: 'number', unit: '°C', rule: 'range', min: 0, max: 7 },
    { id: 'fridge2', label: 'Kühlschrank 2', type: 'number', unit: '°C', rule: 'range', min: 0, max: 7 },
    { id: 'freezer', label: 'Tiefkühler',     type: 'number', unit: '°C', rule: 'max',   max: -18, note: '≤ −18°C' },
    { id: 'oven',    label: 'Ofen/Backstation', type: 'number', unit: '°C', rule: 'min', min: 180 },
    { id: 'dw82',    label: 'Spülmaschine Spültemperatur ≥ 82°C', type: 'boolean' },
    { id: 'handwash',label: 'Handwaschbecken Warmwasser vorhanden', type: 'boolean' },
    { id: 'cleaningDone', label: 'Reinigungsplan erledigt', type: 'boolean' }
  ];
}
function defaultCleaningPlan() {
  return [
    { id: 'surfaces',  name: 'Arbeitsflächen reinigen & desinfizieren', freq: 'daily',  area: 'Küche' },
    { id: 'sinks',     name: 'Becken/Armaturen reinigen',               freq: 'daily',  area: 'Küche' },
    { id: 'fridgeIn',  name: 'Kühlschrank innen wischen',               freq: 'weekly', area: 'Küche' },
    { id: 'ovenDeep',  name: 'Ofen/Backstation Grundreinigung',         freq: 'weekly', area: 'Backstube' },
    { id: 'freezerDef',name: 'Tiefkühler abtauen',                      freq: 'monthly',area: 'Lager' }
  ];
}

async function ensureFiles() {
  const users = await readJson('data/users.json', null);
  if (!users) await writeJson('data/users.json', [], 'init users.json');

  const shops = await readJson('data/shops.json', null);
  if (!shops) {
    const id = 'shop_default';
    await writeJson('data/shops.json', [{
      id, name: DEFAULT_SHOP, city: '', address: '', isActive: true,
      checkItems: defaultCheckItems(),
      cleaningPlan: defaultCleaningPlan()
    }], 'init shops.json');
  }
}
ensureFiles();

// ---------- auth ----------
function setUser(req, _res, next) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try { req.user = jwt.verify(h.slice(7), JWT_SECRET); } catch {}
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

  if (ADMIN_EMAIL && ADMIN_PASSWORD &&
      email.toLowerCase() === ADMIN_EMAIL.toLowerCase() &&
      password === ADMIN_PASSWORD) {
    const token = jwt.sign({ sub: 'admin', email, role: 'admin', shops: 'all' }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, role: 'admin', name: 'Admin' });
  }

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

// ---------- utils ----------
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const pathChecklist = (shopId, date) => `data/checklists/${shopId}/${date}.json`;
const pathCleaning  = (shopId, date) => `data/cleaning/${shopId}/${date}.json`;

function emptyChecklist(shop) {
  const values = {};
  (shop.checkItems || []).forEach(i => values[i.id] = i.type === 'boolean' ? false : null);
  return { date: todayStr(), shopId: shop.id, values, notes: '', issues: [], lastSavedBy: null, lastSavedAt: null };
}

function countDeviations(values, items) {
  let dev = 0;
  for (const i of items) {
    const v = values[i.id];
    if (i.type !== 'number' || v === null || v === '' || Number.isNaN(v)) continue;
    if (i.rule === 'range' && (v < i.min || v > i.max)) dev++;
    if (i.rule === 'max'   && (v > i.max)) dev++;
    if (i.rule === 'min'   && (v < i.min)) dev++;
  }
  return dev;
}

// ---------- daily checklist ----------
app.get('/api/today', requireAuth, async (req, res) => {
  const date = (req.query.date || todayStr()).trim();
  const shopId = (req.query.shopId || 'shop_default').trim();
  const shops = await readJson('data/shops.json', []);
  const shop = shops.find(s => s.id === shopId) || shops[0];

  const file = await ghTryGet(pathChecklist(shop.id, date));
  const data = file
    ? JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
    : emptyChecklist(shop);

  res.json({ ...data, items: shop.checkItems || [] });
});

app.post('/api/today', requireAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.date || !body.shopId || typeof body.values !== 'object')
    return res.status(400).json({ error: 'date, shopId, values required' });

  body.lastSavedBy = req.user.email;
  body.lastSavedAt = new Date().toISOString();

  await writeJson(pathChecklist(body.shopId, body.date), body, `checklist ${body.shopId} ${body.date}`);
  res.json({ ok: true });
});

// ---------- history (dates only) ----------
app.get('/api/history', requireAuth, async (req, res) => {
  const shopId = (req.query.shopId || 'shop_default').trim();
  const dir = `data/checklists/${shopId}`;
  const items = await listDir(dir);
  const dates = items.filter(x => x.type === 'file' && x.name.endsWith('.json'))
                     .map(x => x.name.replace('.json', ''))
                     .sort().reverse();
  res.json(dates);
});

// ---------- Cleaning Plan (per day status) ----------
app.get('/api/cleaning', requireAuth, async (req, res) => {
  const date = (req.query.date || todayStr()).trim();
  const shopId = (req.query.shopId || 'shop_default').trim();
  const shops = await readJson('data/shops.json', []);
  const shop = shops.find(s => s.id === shopId) || shops[0];

  const file = await ghTryGet(pathCleaning(shop.id, date));
  const data = file
    ? JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
    : { date, shopId: shop.id, tasks: (shop.cleaningPlan || []).map(t => ({ id: t.id, done: false, note: '' })), lastSavedBy: null, lastSavedAt: null };

  res.json({ ...data, plan: shop.cleaningPlan || [] });
});
app.post('/api/cleaning', requireAuth, async (req, res) => {
  const { date, shopId, tasks } = req.body || {};
  if (!date || !shopId || !Array.isArray(tasks)) return res.status(400).json({ error: 'date, shopId, tasks[] required' });
  const body = { date, shopId, tasks, lastSavedBy: req.user.email, lastSavedAt: new Date().toISOString() };
  await writeJson(pathCleaning(shopId, date), body, `cleaning ${shopId} ${date}`);
  res.json({ ok: true });
});

// ---------- ADMIN (shops & users) ----------
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
    checkItems: Array.isArray(s.checkItems) && s.checkItems.length ? s.checkItems : defaultCheckItems(),
    cleaningPlan: Array.isArray(s.cleaningPlan) ? s.cleaningPlan : defaultCleaningPlan()
  };
  shops.push(shop);
  await writeJson('data/shops.json', shops, `admin: add shop ${shop.name}`);
  res.status(201).json(shop);
});
app.put('/api/admin/shops/:id', requireRole('admin'), async (req, res) => {
  const shops = await readJson('data/shops.json', []);
  const i = shops.findIndex(s => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'not found' });
  const s = req.body || {};
  shops[i] = {
    ...shops[i],
    name: s.name ?? shops[i].name,
    city: s.city ?? shops[i].city,
    address: s.address ?? shops[i].address,
    isActive: s.isActive ?? shops[i].isActive,
    checkItems: Array.isArray(s.checkItems) ? s.checkItems : shops[i].checkItems,
    cleaningPlan: Array.isArray(s.cleaningPlan) ? s.cleaningPlan : shops[i].cleaningPlan
  };
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

// users (same as before)
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
