/* BUNCA HACCP — Node/Express server with GitHub-backed storage */
require('dotenv').config();
const express = require('express');
const path = require('path');
const cookie = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { GitHubStore } = require('./store/githubStore');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookie());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ----- ENV -----
const {
  PORT = 10000,
  JWT_SECRET = 'CHANGE_ME',
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  REGISTRATION_CODE = 'BUNCA-2025',
  DEFAULT_SHOP = 'BUNCA · City',
  GITHUB_TOKEN,
  GITHUB_REPO,        // "owner/repo"
  GITHUB_BRANCH = 'main'
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.warn('⚠️  Missing GITHUB_TOKEN or GITHUB_REPO — API writes will fail.');
}

const store = new GitHubStore({
  token: GITHUB_TOKEN,
  repo: GITHUB_REPO,
  branch: GITHUB_BRANCH,
  file: 'store/db.json'
});

// ----- helpers -----
function nowISO() { return new Date().toISOString(); }
function dateKey(d = new Date()) { return d.toISOString().slice(0,10); } // YYYY-MM-DD

function ensureDbShape(db) {
  db.users ||= [];
  db.shops ||= [];
  db.entries ||= {}; // { [date]: { [shopId]: {items, notes, issues, deviations} } }
  return db;
}

async function loadDb() {
  const db = await store.read();
  return ensureDbShape(db);
}

async function saveDb(mutator, message) {
  const db = await loadDb();
  const next = await mutator(db);
  return store.write(next, message);
}

function uid(prefix='id') {
  return `${prefix}_${Math.random().toString(36).slice(2,8)}${Date.now().toString(36).slice(-2)}`;
}

// ----- auth middleware -----
function authOptional(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  next();
}
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}
function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

// ----- AUTH -----
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  // env admin
  if (ADMIN_EMAIL && ADMIN_PASSWORD && email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ email, role: 'admin', name: 'Admin' }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, role: 'admin', email, name: 'Admin' });
  }
  // users in db
  const db = await loadDb();
  const u = db.users.find(u => u.email.toLowerCase() === String(email||'').toLowerCase());
  if (u && bcrypt.compareSync(password || '', u.pass)) {
    const token = jwt.sign({ email: u.email, role: u.role || 'user', name: u.name || u.email }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, role: u.role || 'user', email: u.email, name: u.name || u.email });
  }
  return res.status(401).json({ error: 'invalid_credentials' });
});

app.post('/api/auth/register', authOptional, async (req, res) => {
  const { code, email, password, name } = req.body || {};
  if (!code || code !== REGISTRATION_CODE) return res.status(403).json({ error: 'invalid_code' });
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
  await saveDb(db => {
    if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) throw new Error('exists');
    db.users.push({ id: uid('usr'), email, name: name || email, role: 'user', pass: bcrypt.hashSync(password, 8), createdAt: nowISO() });
    return db;
  }, `Register ${email}`);
  res.json({ ok: true });
});

// ----- SHOPS -----
app.get('/api/shops', authRequired, async (_req, res) => {
  const db = await loadDb();
  res.json(db.shops);
});

app.post('/api/shops', authRequired, adminRequired, async (req, res) => {
  const { name, city, address, active=true, checklist=[], cleaningPlan=[] } = req.body || {};
  const shop = { id: uid('shop'), name, city, address, active, checklist, cleaningPlan, createdAt: nowISO() };
  await saveDb(db => { db.shops.push(shop); return db; }, `Create shop ${name}`);
  res.json(shop);
});

app.put('/api/shops/:id', authRequired, adminRequired, async (req, res) => {
  const { id } = req.params;
  const patch = req.body || {};
  let out;
  await saveDb(db => {
    const i = db.shops.findIndex(s => s.id === id);
    if (i === -1) throw new Error('not_found');
    db.shops[i] = { ...db.shops[i], ...patch, updatedAt: nowISO() };
    out = db.shops[i];
    return db;
  }, `Update shop ${id}`);
  res.json(out);
});

app.delete('/api/shops/:id', authRequired, adminRequired, async (req, res) => {
  const { id } = req.params;
  await saveDb(db => {
    db.shops = db.shops.filter(s => s.id !== id);
    return db;
  }, `Delete shop ${id}`);
  res.json({ ok: true });
});

// ----- TODAY (daily checklist) -----
app.get('/api/today', authRequired, async (req, res) => {
  const dkey = req.query.date || dateKey();
  const shopId = req.query.shopId;
  const db = await loadDb();
  const shop = db.shops.find(s => s.id === shopId) || db.shops.find(s => s.name === DEFAULT_SHOP) || db.shops[0];
  if (!shop) return res.json({ shop: null, items: [], notes: '', issues: [], deviations: 0 });
  const day = db.entries[dkey]?.[shop.id];
  if (day) return res.json({ shop, date: dkey, ...day });

  // create an unsaved default from template
  const items = shop.checklist.map(it => ({
    id: it.id, label: it.label, type: it.type, unit: it.unit, rule: it.rule, value: (it.type === 'boolean' ? false : ''), ok: true
  }));
  res.json({ shop, date: dkey, items, notes: '', issues: [], deviations: 0, unsaved: true });
});

app.post('/api/today', authRequired, async (req, res) => {
  const { shopId, date, items=[], notes='' } = req.body || {};
  if (!shopId) return res.status(400).json({ error: 'shop_required' });
  const dkey = date || dateKey();

  let result;
  await saveDb(db => {
    const shop = db.shops.find(s => s.id === shopId);
    if (!shop) throw new Error('shop_not_found');

    // evaluate rules
    let deviations = 0;
    const evaled = items.map(it => {
      let ok = true;
      if (it.type === 'number' && it.rule) {
        const v = Number(it.value);
        if (Number.isFinite(v)) {
          if (it.rule.kind === 'range') ok = v >= it.rule.min && v <= it.rule.max;
          if (it.rule.kind === 'min') ok = v >= it.rule.min;
          if (it.rule.kind === 'max') ok = v <= it.rule.max;
        }
      }
      if (it.type === 'boolean' && it.rule?.mustBeTrue) ok = !!it.value;
      if (!ok) deviations++;
      return { ...it, ok };
    });

    db.entries[dkey] ||= {};
    db.entries[dkey][shopId] = { items: evaled, notes, issues: [], deviations, savedAt: nowISO() };
    result = { date: dkey, shopId, items: evaled, notes, deviations };
    return db;
  }, `Save day ${dkey} for ${shopId}`);

  res.json(result);
});

// ----- HISTORY -----
app.get('/api/history', authRequired, async (req, res) => {
  const { shopId, from, to } = req.query || {};
  const db = await loadDb();
  const result = [];
  Object.keys(db.entries).sort().forEach(d => {
    if (from && d < from) return;
    if (to && d > to) return;
    const day = db.entries[d][shopId];
    if (day) result.push({ date: d, deviations: day.deviations, notes: day.notes, items: day.items });
  });
  res.json(result.reverse());
});

// ----- FALLBACK -----
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// ----- BOOT -----
app.listen(PORT, () => {
  console.log(`BUNCA HACCP server on :${PORT}`);
});
