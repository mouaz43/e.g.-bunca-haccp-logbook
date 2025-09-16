import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import PDFDocument from 'pdfkit';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ---------- setup ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';

// S3 (optional)
const s3 = (process.env.S3_BUCKET && process.env.S3_KEY && process.env.S3_SECRET)
  ? new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT,
      credentials: { accessKeyId: process.env.S3_KEY, secretAccessKey: process.env.S3_SECRET }
    })
  : null;

// ---------- db ----------
let db;
async function getDb() {
  if (!db) {
    db = await open({ filename: path.join(__dirname, 'data.sqlite'), driver: sqlite3.Database });
  }
  return db;
}

async function columnExists(table, column) {
  const d = await getDb();
  const cols = await d.all(`PRAGMA table_info(${table})`);
  return cols.some(c => c.name === column);
}

async function addColumnIfMissing(table, column, decl) {
  const exists = await columnExists(table, column);
  if (!exists) {
    const d = await getDb();
    await d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

async function migrate() {
  const d = await getDb();
  await d.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','manager','staff','auditor')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      address TEXT,
      phone TEXT,
      description TEXT,
      image_url TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS check_items (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('temperature','boolean','number','text')),
      min REAL,
      max REAL,
      unit TEXT DEFAULT '°C',
      position INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY(shop_id) REFERENCES shops(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS check_runs (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      run_date TEXT NOT NULL,            -- yyyy-mm-dd
      note TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS check_answers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      value TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(run_id) REFERENCES check_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES check_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_runs_shop_date ON check_runs(shop_id, run_date);
    CREATE INDEX IF NOT EXISTS idx_items_shop_pos ON check_items(shop_id, position);
  `);

  // New tables
  await d.exec(`
    CREATE TABLE IF NOT EXISTS equipment (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      serial TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(shop_id) REFERENCES shops(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS corrective_actions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      description TEXT NOT NULL,
      assigned_to TEXT,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
      photo_url TEXT,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY(run_id) REFERENCES check_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES check_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      item_id TEXT,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES check_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_shops (
      user_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      PRIMARY KEY (user_id, shop_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(shop_id) REFERENCES shops(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      meta_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Add new columns if missing
  await addColumnIfMissing('check_items', 'equipment_id', 'TEXT');
  await addColumnIfMissing('check_items', 'shift', "TEXT DEFAULT 'morning'");
  await addColumnIfMissing('check_items', 'required', 'INTEGER NOT NULL DEFAULT 0');

  await addColumnIfMissing('check_runs', 'status', "TEXT NOT NULL DEFAULT 'draft'");
  await addColumnIfMissing('check_runs', 'submitted_by', 'TEXT');
  await addColumnIfMissing('check_runs', 'signed_by', 'TEXT');
  await addColumnIfMissing('check_runs', 'signed_at', 'TEXT');

  await addColumnIfMissing('check_answers', 'evidence_url', 'TEXT');

  // Seed admin if needed
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  if (adminEmail) {
    const existing = await d.get('SELECT id, role FROM users WHERE email = ?', adminEmail);
    if (!existing) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme', 12);
      await d.run(
        'INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?,?,?,?,?)',
        uuid(), adminEmail, hash, 'admin', new Date().toISOString()
      );
      console.log(`✅ Admin seeded: ${adminEmail}`);
    }
  }
}

// ---------- middleware & helpers ----------
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser(SESSION_SECRET));
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120 });
app.use('/api/', apiLimiter);

// static
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

async function createSession(userId) {
  const d = await getDb();
  const sid = uuid();
  const csrf = uuid();
  await d.run('INSERT INTO sessions (id, user_id, csrf_token, created_at) VALUES (?,?,?,?)',
    sid, userId, csrf, new Date().toISOString());
  return { sid, csrf };
}

async function getSession(req) {
  const sid = req.signedCookies.sid;
  if (!sid) return null;
  const d = await getDb();
  const s = await d.get(`
    SELECT s.id, s.csrf_token AS csrf, u.id AS user_id, u.email, u.role
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`, sid);
  return s || null;
}

function requireAuth(req, res, next) {
  getSession(req).then(session => {
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      const token = req.get('x-csrf-token');
      if (!token || token !== session.csrf) return res.status(419).json({ error: 'CSRF token invalid' });
    }
    req.session = session;
    next();
  }).catch(next);
}

function requireRole(...roles) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!roles.length) return next();
      if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'Forbidden' });
      next();
    });
  };
}

async function ensureShopAccess(user, shopId) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'auditor') return true;
  if (user.role === 'manager' || user.role === 'staff') {
    const d = await getDb();
    const r = await d.get('SELECT 1 FROM user_shops WHERE user_id=? AND shop_id=?', user.user_id, shopId);
    return !!r;
  }
  return false;
}

async function getShopBySlug(slug) {
  const d = await getDb();
  return d.get('SELECT * FROM shops WHERE slug = ?', slug);
}

async function logAudit(userId, action, meta) {
  const d = await getDb();
  await d.run('INSERT INTO audit (id, user_id, action, meta_json, created_at) VALUES (?,?,?,?,?)',
    uuid(), userId || null, action, JSON.stringify(meta || {}), new Date().toISOString());
}

// compute ok
function computeOk(item, rawVal) {
  if (item.kind === 'boolean') {
    const v = String(rawVal).toLowerCase();
    return (v === 'true' || v === 'yes' || v === '1') ? 1 : 0;
  }
  if (item.kind === 'temperature' || item.kind === 'number') {
    const n = Number(rawVal);
    if (Number.isNaN(n)) return 0;
    if (item.min != null && n < item.min) return 0;
    if (item.max != null && n > item.max) return 0;
    return 1;
  }
  return String(rawVal ?? '').trim().length > 0 ? 1 : 0;
}

// ---------- routes ----------

// pages
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/shop/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/check/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'check.html')));
app.get('/history/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));

// auth
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const d = await getDb();
  const u = await d.get('SELECT * FROM users WHERE email=?', (email || '').toLowerCase());
  if (!u) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const { sid, csrf } = await createSession(u.id);
  res.cookie('sid', sid, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', signed: true,
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
  await logAudit(u.id, 'login', {});
  res.json({ ok: true, role: u.role, csrf });
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const d = await getDb();
  await d.run('DELETE FROM sessions WHERE id=?', req.session.id);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/auth/session', async (req, res) => {
  const s = await getSession(req);
  res.json({ session: s ? { email: s.email, role: s.role, csrf: s.csrf, user_id: s.user_id } : null });
});

// users (admin)
app.get('/api/users', requireRole('admin'), async (_req, res) => {
  const d = await getDb();
  const users = await d.all('SELECT id, email, role, created_at FROM users ORDER BY created_at DESC');
  res.json({ users });
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { email, password, role } = req.body || {};
  if (!email || !password || !role) return res.status(400).json({ error: 'Missing fields' });
  if (!['admin','manager','staff','auditor'].includes(role)) return res.status(400).json({ error: 'Role invalid' });
  const d = await getDb();
  const exists = await d.get('SELECT id FROM users WHERE email=?', (email || '').toLowerCase());
  if (exists) return res.status(409).json({ error: 'Email exists' });
  const id = uuid();
  const hash = await bcrypt.hash(password, 12);
  await d.run('INSERT INTO users (id,email,password_hash,role,created_at) VALUES (?,?,?,?,?)',
    id, (email||'').toLowerCase(), hash, role, new Date().toISOString());
  await logAudit(req.session.user_id, 'user.create', { id, email, role });
  res.json({ ok: true, id });
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  const d = await getDb();
  await d.run('DELETE FROM users WHERE id=?', req.params.id);
  await logAudit(req.session.user_id, 'user.delete', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/users/:id/assign-shops', requireRole('admin'), async (req, res) => {
  const { shop_ids } = req.body || {};
  const d = await getDb();
  await d.run('DELETE FROM user_shops WHERE user_id=?', req.params.id);
  if (Array.isArray(shop_ids) && shop_ids.length) {
    const tasks = shop_ids.map(sid =>
      d.run('INSERT OR IGNORE INTO user_shops (user_id, shop_id) VALUES (?,?)', req.params.id, sid)
    );
    await Promise.all(tasks);
  }
  await logAudit(req.session.user_id, 'user.assign_shops', { id: req.params.id, shop_ids: shop_ids || [] });
  res.json({ ok: true });
});

// shops
app.get('/api/shops', async (_req, res) => {
  const d = await getDb();
  const list = await d.all('SELECT id, name, slug, address, phone, description, image_url, status FROM shops ORDER BY created_at DESC');
  res.json({ shops: list });
});

app.get('/api/shops/:slug', async (req, res) => {
  const d = await getDb();
  const s = await d.get('SELECT * FROM shops WHERE slug=?', req.params.slug);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ shop: s });
});

app.post('/api/shops', requireRole('admin'), async (req, res) => {
  const { name, slug, address, phone, description, image_url, status='open' } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'Missing name/slug' });
  if (!['open','closed'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  const d = await getDb();
  const exists = await d.get('SELECT id FROM shops WHERE slug=?', slug);
  if (exists) return res.status(409).json({ error: 'Slug exists' });
  const id = uuid();
  await d.run(
    'INSERT INTO shops (id,name,slug,address,phone,description,image_url,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, name, slug, address || '', phone || '', description || '', image_url || '', status, new Date().toISOString()
  );
  await logAudit(req.session.user_id, 'shop.create', { id, name, slug });
  res.json({ ok: true, id });
});

app.put('/api/shops/:id', requireRole('admin'), async (req, res) => {
  const { name, slug, address, phone, description, image_url, status } = req.body || {};
  const d = await getDb();
  const row = await d.get('SELECT id FROM shops WHERE id=?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (status && !['open','closed'].includes(status)) return res.status(400).json({ error: 'Bad status' });

  await d.run(`
    UPDATE shops SET
      name=COALESCE(?,name), slug=COALESCE(?,slug), address=COALESCE(?,address),
      phone=COALESCE(?,phone), description=COALESCE(?,description), image_url=COALESCE(?,image_url),
      status=COALESCE(?,status) WHERE id=?`,
    name, slug, address, phone, description, image_url, status, req.params.id
  );
  await logAudit(req.session.user_id, 'shop.update', { id: req.params.id });
  res.json({ ok: true });
});

app.delete('/api/shops/:id', requireRole('admin'), async (req, res) => {
  const d = await getDb();
  await d.run('DELETE FROM shops WHERE id=?', req.params.id);
  await logAudit(req.session.user_id, 'shop.delete', { id: req.params.id });
  res.json({ ok: true });
});

// equipment
app.get('/api/equipment', async (req, res) => {
  const { shop, shop_id } = req.query || {};
  const d = await getDb();
  let sid = shop_id;
  if (shop && !sid) {
    const s = await getShopBySlug(shop);
    if (!s) return res.json({ equipment: [] });
    sid = s.id;
  }
  if (!sid) return res.status(400).json({ error: 'Missing shop' });
  const rows = await d.all('SELECT * FROM equipment WHERE shop_id=? ORDER BY created_at DESC', sid);
  res.json({ equipment: rows });
});

app.post('/api/equipment', requireRole('admin','manager'), async (req, res) => {
  const { shop_id, name, type, serial } = req.body || {};
  if (!shop_id || !name) return res.status(400).json({ error: 'Missing fields' });
  if (req.session.role !== 'admin') {
    const ok = await ensureShopAccess(req.session, shop_id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  }
  const d = await getDb();
  const id = uuid();
  await d.run('INSERT INTO equipment (id,shop_id,name,type,serial,created_at) VALUES (?,?,?,?,?,?)',
    id, shop_id, name, type || '', serial || '', new Date().toISOString());
  await logAudit(req.session.user_id, 'equipment.create', { id, shop_id, name });
  res.json({ ok: true, id });
});

app.put('/api/equipment/:id', requireRole('admin','manager'), async (req, res) => {
  const { name, type, serial } = req.body || {};
  const d = await getDb();
  const row = await d.get('SELECT * FROM equipment WHERE id=?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.session.role !== 'admin') {
    const ok = await ensureShopAccess(req.session, row.shop_id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  }
  await d.run('UPDATE equipment SET name=COALESCE(?,name), type=COALESCE(?,type), serial=COALESCE(?,serial) WHERE id=?',
    name, type, serial, req.params.id);
  await logAudit(req.session.user_id, 'equipment.update', { id: req.params.id });
  res.json({ ok: true });
});

app.delete('/api/equipment/:id', requireRole('admin','manager'), async (req, res) => {
  const d = await getDb();
  const row = await d.get('SELECT * FROM equipment WHERE id=?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.session.role !== 'admin') {
    const ok = await ensureShopAccess(req.session, row.shop_id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  }
  await d.run('DELETE FROM equipment WHERE id=?', req.params.id);
  await logAudit(req.session.user_id, 'equipment.delete', { id: req.params.id });
  res.json({ ok: true });
});

// checklist items (now supports equipment/shift/required)
app.get('/api/check-items', async (req, res) => {
  const { shop, shop_id, shift } = req.query || {};
  const d = await getDb();
  let sid = shop_id;
  if (shop && !sid) {
    const s = await getShopBySlug(shop);
    if (!s) return res.json({ items: [] });
    sid = s.id;
  }
  if (!sid) return res.status(400).json({ error: 'Missing shop' });
  const params = [sid];
  let where = 'shop_id=? AND active=1';
  if (shift) { where += ' AND (shift=? OR shift IS NULL)'; params.push(shift); }
  const items = await d.all(
    `SELECT * FROM check_items WHERE ${where} ORDER BY position ASC, created_at ASC`, params
  );
  res.json({ items });
});

app.post('/api/check-items', requireRole('admin','manager'), async (req, res) => {
  const { shop_id, label, kind, min=null, max=null, unit='°C', position=0, equipment_id=null, shift='morning', required=0 } = req.body || {};
  if (!shop_id || !label || !kind) return res.status(400).json({ error: 'Missing fields' });
  if (!['temperature','boolean','number','text'].includes(kind)) return res.status(400).json({ error: 'Bad kind' });
  if (!['morning','mid','closing'].includes(shift)) return res.status(400).json({ error: 'Bad shift' });

  if (req.session.role !== 'admin') {
    const ok = await ensureShopAccess(req.session, shop_id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  }

  const d = await getDb();
  const id = uuid();
  await d.run(`
    INSERT INTO check_items (id,shop_id,label,kind,min,max,unit,position,active,created_at,equipment_id,shift,required)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`,
    id, shop_id, label, kind, min, max, unit, position, new Date().toISOString(), equipment_id, shift, required ? 1 : 0
  );
  await logAudit(req.session.user_id, 'checkitem.create', { id, shop_id, label, shift, required: !!required });
  res.json({ ok: true, id });
});

app.put('/api/check-items/:id', requireRole('admin','manager'), async (req, res) => {
  const d = await getDb();
  const row = await d.get('SELECT * FROM check_items WHERE id=?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.session.role !== 'admin') {
    const ok = await ensureShopAccess(req.session, row.shop_id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  }
  const { label, kind, min, max, unit, position, equipment_id, shift, required, active } = req.body || {};
  if (shift && !['morning','mid','closing'].includes(shift)) return res.status(400).json({ error: 'Bad shift' });
  await d.run(`
    UPDATE check_items SET
      label=COALESCE(?,label), kind=COALESCE(?,kind), min=COALESCE(?,min), max=COALESCE(?,max),
      unit=COALESCE(?,unit), position=COALESCE(?,position), equipment_id=COALESCE(?,equipment_id),
      shift=COALESCE(?,shift), required=COALESCE(?,required), active=COALESCE(?,active)
    WHERE id=?`,
    label, kind, min, max, unit, position, equipment_id, shift, (required==null?null:(required?1:0)),
    (active==null?null:(active?1:0)), req.params.id
  );
  await logAudit(req.session.user_id, 'checkitem.update', { id: req.params.id });
  res.json({ ok: true });
});

app.delete('/api/check-items/:id', requireRole('admin','manager'), async (req, res) => {
  const d = await getDb();
  const row = await d.get('SELECT * FROM check_items WHERE id=?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.session.role !== 'admin') {
    const ok = await ensureShopAccess(req.session, row.shop_id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  }
  await d.run('UPDATE check_items SET active=0 WHERE id=?', req.params.id);
  await logAudit(req.session.user_id, 'checkitem.delete', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/checklists/duplicate', requireRole('admin'), async (req, res) => {
  const { from_shop_id, to_shop_id } = req.body || {};
  if (!from_shop_id || !to_shop_id) return res.status(400).json({ error: 'Missing fields' });
  const d = await getDb();
  const items = await d.all('SELECT * FROM check_items WHERE shop_id=? AND active=1', from_shop_id);
  const now = new Date().toISOString();
  for (const it of items) {
    await d.run(`
      INSERT INTO check_items (id,shop_id,label,kind,min,max,unit,position,active,created_at,equipment_id,shift,required)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`,
      uuid(), to_shop_id, it.label, it.kind, it.min, it.max, it.unit, it.position, now, it.equipment_id || null, it.shift || 'morning', it.required || 0
    );
  }
  await logAudit(req.session.user_id, 'checklist.duplicate', { from_shop_id, to_shop_id, count: items.length });
  res.json({ ok: true, count: items.length });
});

// submit run
app.post('/api/check-runs', requireAuth, async (req, res) => {
  const { shop_slug, run_date, answers, note, status='submitted' } = req.body || {};
  if (!shop_slug || !Array.isArray(answers)) return res.status(400).json({ error: 'Missing fields' });
  const d = await getDb();
  const shop = await getShopBySlug(shop_slug);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });

  // ACL: manager/staff must have access
  if (req.session.role !== 'admin' && req.session.role !== 'auditor') {
    const ok = await ensureShopAccess(req.session, shop.id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  }

  const id = uuid();
  const dateStr = (run_date || new Date().toISOString().slice(0,10));
  await d.run(
    'INSERT INTO check_runs (id, shop_id, run_date, note, created_by, created_at, status, submitted_by) VALUES (?,?,?,?,?,?,?,?)',
    id, shop.id, dateStr, note || '', req.session.user_id, new Date().toISOString(), status, req.session.user_id
  );

  // load definitions for validation
  const defs = await d.all('SELECT * FROM check_items WHERE shop_id=? AND active=1', shop.id);
  const map = new Map(defs.map(x => [x.id, x]));

  // required validation
  for (const item of defs) {
    if (item.required) {
      const ans = answers.find(a => a.item_id === item.id);
      if (!ans || String(ans.value ?? '').trim() === '') {
        return res.status(400).json({ error: `Missing required: ${item.label}` });
      }
    }
  }

  for (const a of answers) {
    const def = map.get(a.item_id);
    if (!def) continue;
    const value = a.value ?? '';
    const ok = computeOk(def, value);
    await d.run('INSERT INTO check_answers (id, run_id, item_id, value, ok, evidence_url) VALUES (?,?,?,?,?,?)',
      uuid(), id, a.item_id, String(value), ok, a.evidence_url || null);
    // if failed and client provided corrective action
    if (a.corrective && !ok) {
      const ca = a.corrective;
      await d.run(
        'INSERT INTO corrective_actions (id, run_id, item_id, description, assigned_to, due_date, status, photo_url, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        uuid(), id, a.item_id, ca.description || 'Issue', ca.assigned_to || null, ca.due_date || null, 'open',
        ca.photo_url || null, new Date().toISOString()
      );
    }
  }

  await logAudit(req.session.user_id, 'run.submit', { run_id: id, shop_id: shop.id, status });
  res.json({ ok: true, run_id: id });
});

// sign-off (password-based)
app.post('/api/check-runs/:id/sign', requireRole('admin','manager','staff'), async (req, res) => {
  const { password } = req.body || {};
  const d = await getDb();
  const run = await d.get('SELECT * FROM check_runs WHERE id=?', req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });

  // ACL
  if (req.session.role !== 'admin') {
    const ok = await ensureShopAccess(req.session, run.shop_id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
  }

  const u = await d.get('SELECT * FROM users WHERE id=?', req.session.user_id);
  const okPass = password && await bcrypt.compare(password, u.password_hash);
  if (!okPass) return res.status(401).json({ error: 'Invalid credentials' });

  await d.run('UPDATE check_runs SET status=?, signed_by=?, signed_at=? WHERE id=?',
    'signed', req.session.user_id, new Date().toISOString(), req.params.id);
  await logAudit(req.session.user_id, 'run.sign', { run_id: req.params.id });
  res.json({ ok: true });
});

// get history
app.get('/api/check-runs', async (req, res) => {
  const { shop, from, to, shift, status, equipment_id } = req.query || {};
  if (!shop) return res.status(400).json({ error: 'Missing shop' });
  const d = await getDb();
  const s = await getShopBySlug(shop);
  if (!s) return res.json({ runs: [] });

  let where = 'r.shop_id = ?';
  const params = [s.id];
  if (from) { where += ' AND r.run_date >= ?'; params.push(from); }
  if (to) { where += ' AND r.run_date <= ?'; params.push(to); }
  if (status) { where += ' AND r.status = ?'; params.push(status); }
  // equipment filter via answers join -> exists items with that equipment_id
  let equipJoin = '';
  if (equipment_id) {
    equipJoin = ' JOIN check_answers aa ON aa.run_id=r.id JOIN check_items ii ON ii.id=aa.item_id ';
    where += ' AND ii.equipment_id = ?'; params.push(equipment_id);
  }

  const rows = await d.all(
    `SELECT r.id, r.run_date, r.note, r.status, r.created_at,
            SUM(CASE WHEN a.ok=1 THEN 1 ELSE 0 END) AS ok_count,
            SUM(CASE WHEN a.ok=0 THEN 1 ELSE 0 END) AS fail_count
     FROM check_runs r
     LEFT JOIN check_answers a ON a.run_id=r.id
     ${equipJoin}
     WHERE ${where}
     GROUP BY r.id
     ORDER BY r.run_date DESC, r.created_at DESC`,
     params
  );
  res.json({ runs: rows });
});

app.get('/api/check-runs/:id', async (req, res) => {
  const d = await getDb();
  const run = await d.get('SELECT * FROM check_runs WHERE id=?', req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });

  const answers = await d.all(`
    SELECT a.id, a.item_id, a.value, a.ok, a.evidence_url,
           i.label, i.kind, i.unit, i.min, i.max, i.shift, i.required, i.equipment_id,
           e.name AS equipment_name
    FROM check_answers a
    JOIN check_items i ON i.id=a.item_id
    LEFT JOIN equipment e ON e.id=i.equipment_id
    WHERE a.run_id=?
    ORDER BY i.position ASC, a.id ASC`, req.params.id
  );

  const actions = await d.all('SELECT * FROM corrective_actions WHERE run_id=? ORDER BY created_at ASC', req.params.id);

  res.json({ run, answers, actions });
});

// corrective actions
app.post('/api/corrective-actions', requireRole('admin','manager','staff'), async (req, res) => {
  const { run_id, item_id, description, assigned_to, due_date, photo_url } = req.body || {};
  if (!run_id || !item_id || !description) return res.status(400).json({ error: 'Missing fields' });
  const d = await getDb();
  const id = uuid();
  await d.run('INSERT INTO corrective_actions (id, run_id, item_id, description, assigned_to, due_date, status, photo_url, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, run_id, item_id, description, assigned_to || null, due_date || null, 'open', photo_url || null, new Date().toISOString());
  await logAudit(req.session.user_id, 'corrective.create', { id, run_id, item_id });
  res.json({ ok: true, id });
});

app.patch('/api/corrective-actions/:id', requireRole('admin','manager'), async (req, res) => {
  const { status } = req.body || {};
  if (!['open','done'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  const d = await getDb();
  await d.run('UPDATE corrective_actions SET status=?, closed_at=CASE WHEN ?="done" THEN ? ELSE closed_at END WHERE id=?',
    status, status, (status === 'done' ? new Date().toISOString() : null), req.params.id);
  await logAudit(req.session.user_id, 'corrective.update', { id: req.params.id, status });
  res.json({ ok: true });
});

// uploads (S3 presigned PUT)
app.post('/api/uploads/sign', requireAuth, async (req, res) => {
  if (!s3) return res.status(501).json({ error: 'S3 not configured' });
  const { type } = req.body || {};
  const ext = (type || '').split('/')[1] || 'bin';
  const key = `haccp/${uuid()}.${ext}`;
  const cmd = new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, ContentType: type || 'application/octet-stream' });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 60 });
  res.json({ ok: true, url, key });
});

// exports
app.get('/api/export/csv', async (req, res) => {
  // re-use list logic
  const r = await (await fetchLike(`/api/check-runs?${new URLSearchParams(req.query).toString()}`)).json();
  const rows = r.runs || [];
  let csv = 'date,status,ok,issues,note\n';
  rows.forEach(x => {
    const n = (x.note || '').replace(/"/g, '""');
    csv += `${x.run_date},${x.status},${x.ok_count||0},${x.fail_count||0},"${n}"\n`;
  });
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="bunca-history.csv"');
  res.send(csv);
});

// helper to call own endpoint without http (for csv)
async function fetchLike(url) {
  const u = new URL(url, 'http://local/');
  const req = { query: Object.fromEntries(u.searchParams.entries()) };
  return {
    json: async () => {
      return await new Promise(resolve => {
        const res = { json: (o) => resolve(o), status: () => res, end: () => {} };
        app._router.handle({ method: 'GET', url: u.pathname, query: req.query, headers: {} }, res, () => resolve({}));
      });
    }
  };
}

app.get('/api/export/pdf', async (req, res) => {
  const { run_id } = req.query || {};
  if (!run_id) return res.status(400).json({ error: 'Missing run_id' });
  const d = await getDb();
  const run = await d.get('SELECT r.*, s.name AS shop_name FROM check_runs r JOIN shops s ON s.id=r.shop_id WHERE r.id=?', run_id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  const answers = await d.all(`
    SELECT a.*, i.label, i.kind, i.unit, i.min, i.max, e.name AS equipment_name
    FROM check_answers a
    JOIN check_items i ON i.id=a.item_id
    LEFT JOIN equipment e ON e.id=i.equipment_id
    WHERE a.run_id=? ORDER BY i.position ASC`, run_id);

  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition','inline; filename="bunca-run.pdf"');
  doc.pipe(res);

  doc.fontSize(18).text('BUNCA HACCP — Daily Checklist', { align: 'left' });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Shop: ${run.shop_name}`);
  doc.text(`Date: ${run.run_date}`);
  doc.text(`Status: ${run.status}`);
  if (run.signed_at) doc.text(`Signed at: ${run.signed_at}`);
  doc.moveDown();

  answers.forEach(a => {
    const line = `${a.label}${a.equipment_name ? ` (${a.equipment_name})` : ''}: ${a.value}${a.kind==='temperature' ? ` ${a.unit||''}` : ''} — ${a.ok ? 'OK' : 'ISSUE'}`;
    doc.fontSize(12).text(line);
  });
  if (run.note) { doc.moveDown(); doc.text(`Notes: ${run.note}`); }

  doc.end();
});

// dashboard (simple)
app.get('/api/dashboard', async (req, res) => {
  const { shop } = req.query || {};
  if (!shop) return res.status(400).json({ error: 'Missing shop' });
  const d = await getDb();
  const s = await getShopBySlug(shop);
  if (!s) return res.status(404).json({ error: 'Shop not found' });
  const totals = await d.get(`
    SELECT COUNT(*) AS runs,
           SUM(CASE WHEN status='signed' THEN 1 ELSE 0 END) AS signed
    FROM check_runs WHERE shop_id=?`, s.id);
  const last7 = await d.all(`
    SELECT run_date,
           SUM(CASE WHEN a.ok=0 THEN 1 ELSE 0 END) AS issues
    FROM check_runs r LEFT JOIN check_answers a ON a.run_id=r.id
    WHERE r.shop_id=? AND r.run_date >= date('now','-7 day')
    GROUP BY r.run_date ORDER BY r.run_date ASC`, s.id);
  res.json({ totals, last7 });
});

// audit (admin)
app.get('/api/audit', requireRole('admin'), async (req, res) => {
  const d = await getDb();
  const items = await d.all('SELECT * FROM audit ORDER BY created_at DESC LIMIT 200');
  res.json({ items });
});

// ---------- boot ----------
const args = process.argv.slice(2);
migrate().then(async () => {
  if (args.includes('--init-db')) {
    console.log('DB initialized.');
    process.exit(0);
  }
  app.listen(PORT, () => console.log(`🚀 BUNCA HACCP API on http://localhost:${PORT}`));
});
