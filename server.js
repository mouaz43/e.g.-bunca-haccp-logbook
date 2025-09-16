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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';

// --- DB ---
let db;
async function getDb() {
  if (!db) {
    db = await open({
      filename: path.join(__dirname, 'data.sqlite'),
      driver: sqlite3.Database
    });
  }
  return db;
}

async function migrate() {
  const db = await getDb();
  await db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')),
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

    /* Checklist templates per shop */
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

    /* One run (submission) with answers */
    CREATE TABLE IF NOT EXISTS check_runs (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      run_date TEXT NOT NULL,            -- yyyy-mm-dd
      note TEXT,
      created_by TEXT,                   -- user id (optional)
      created_at TEXT NOT NULL,
      FOREIGN KEY(shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS check_answers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      value TEXT,                        -- raw value as text (e.g. "4.2", "yes")
      ok INTEGER NOT NULL DEFAULT 0,     -- computed server-side (0/1)
      FOREIGN KEY(run_id) REFERENCES check_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES check_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_runs_shop_date ON check_runs(shop_id, run_date);
    CREATE INDEX IF NOT EXISTS idx_items_shop_pos ON check_items(shop_id, position);
  `);

  // Seed admin
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  if (adminEmail) {
    const existing = await db.get('SELECT id FROM users WHERE email = ?', adminEmail);
    if (!existing) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme', 12);
      await db.run(
        'INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?,?,?,?,?)',
        uuid(), adminEmail, hash, 'admin', new Date().toISOString()
      );
      console.log(`✅ Admin seeded: ${adminEmail}`);
    }
  }
}

// --- Middleware ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(SESSION_SECRET));
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 100 });
app.use('/api/', apiLimiter);

// Static
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// --- Helpers ---
async function createSession(userId) {
  const db = await getDb();
  const sid = uuid();
  const csrf = uuid();
  await db.run(
    'INSERT INTO sessions (id, user_id, csrf_token, created_at) VALUES (?,?,?,?)',
    sid, userId, csrf, new Date().toISOString()
  );
  return { sid, csrf };
}

async function getSession(req) {
  const sid = req.signedCookies.sid;
  if (!sid) return null;
  const db = await getDb();
  const session = await db.get(
    `SELECT s.id, s.csrf_token AS csrf, u.id AS user_id, u.email, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, sid
  );
  return session || null;
}

function requireAuth(roleOptional) {
  return async (req, res, next) => {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    if (roleOptional && session.role !== roleOptional) return res.status(403).json({ error: 'Forbidden' });
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const headerToken = req.get('x-csrf-token');
      if (!headerToken || headerToken !== session.csrf) {
        return res.status(419).json({ error: 'CSRF token invalid' });
      }
    }
    req.session = session;
    next();
  };
}

async function getShopBySlug(db, slug) {
  return db.get('SELECT * FROM shops WHERE slug = ?', slug);
}

// --- Auth API ---
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE email = ?', (email || '').toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const { sid, csrf } = await createSession(user.id);
  res.cookie('sid', sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    signed: true,
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
  res.json({ ok: true, role: user.role, csrf });
});

app.post('/api/auth/logout', requireAuth(), async (req, res) => {
  const db = await getDb();
  await db.run('DELETE FROM sessions WHERE id = ?', req.session.id);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/auth/session', async (req, res) => {
  const session = await getSession(req);
  res.json({ session: session ? { email: session.email, role: session.role, csrf: session.csrf } : null });
});

// --- Users (admin only) ---
app.get('/api/users', requireAuth('admin'), async (_req, res) => {
  const db = await getDb();
  const list = await db.all('SELECT id, email, role, created_at FROM users ORDER BY created_at DESC');
  res.json({ users: list });
});

app.post('/api/users', requireAuth('admin'), async (req, res) => {
  const { email, password, role } = req.body || {};
  if (!email || !password || !role) return res.status(400).json({ error: 'Missing fields' });
  if (!['admin','user'].includes(role)) return res.status(400).json({ error: 'Role invalid' });

  const db = await getDb();
  const exists = await db.get('SELECT id FROM users WHERE email = ?', email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'Email exists' });

  const hash = await bcrypt.hash(password, 12);
  const id = uuid();
  await db.run(
    'INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?,?,?,?,?)',
    id, email.toLowerCase(), hash, role, new Date().toISOString()
  );
  res.json({ ok: true, id });
});

app.delete('/api/users/:id', requireAuth('admin'), async (req, res) => {
  const db = await getDb();
  await db.run('DELETE FROM users WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// --- Shops (admin CRUD, public list/read) ---
app.get('/api/shops', async (_req, res) => {
  const db = await getDb();
  const list = await db.all('SELECT id, name, slug, address, phone, description, image_url, status FROM shops ORDER BY created_at DESC');
  res.json({ shops: list });
});

app.get('/api/shops/:slug', async (req, res) => {
  const db = await getDb();
  const item = await getShopBySlug(db, req.params.slug);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({ shop: item });
});

app.post('/api/shops', requireAuth('admin'), async (req, res) => {
  const { name, slug, address, phone, description, image_url, status='open' } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'Missing name/slug' });
  if (!['open','closed'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  const db = await getDb();
  const exists = await db.get('SELECT id FROM shops WHERE slug = ?', slug);
  if (exists) return res.status(409).json({ error: 'Slug exists' });
  const id = uuid();
  await db.run(
    'INSERT INTO shops (id, name, slug, address, phone, description, image_url, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, name, slug, address || '', phone || '', description || '', image_url || '', status, new Date().toISOString()
  );
  res.json({ ok: true, id });
});

app.put('/api/shops/:id', requireAuth('admin'), async (req, res) => {
  const { name, slug, address, phone, description, image_url, status } = req.body || {};
  const db = await getDb();
  const row = await db.get('SELECT id FROM shops WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (status && !['open','closed'].includes(status)) return res.status(400).json({ error: 'Bad status' });

  await db.run(`
    UPDATE shops SET
      name = COALESCE(?, name),
      slug = COALESCE(?, slug),
      address = COALESCE(?, address),
      phone = COALESCE(?, phone),
      description = COALESCE(?, description),
      image_url = COALESCE(?, image_url),
      status = COALESCE(?, status)
    WHERE id = ?`,
    name, slug, address, phone, description, image_url, status, req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/shops/:id', requireAuth('admin'), async (req, res) => {
  const db = await getDb();
  await db.run('DELETE FROM shops WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// --- Checklist Templates (Admin) ---
app.get('/api/check-items', async (req, res) => {
  // accepts ?shop=slug or ?shop_id=...
  const { shop, shop_id } = req.query;
  const db = await getDb();
  let sid = shop_id;
  if (shop && !sid) {
    const row = await getShopBySlug(db, shop);
    if (!row) return res.json({ items: [] });
    sid = row.id;
  }
  if (!sid) return res.status(400).json({ error: 'Missing shop' });
  const items = await db.all(
    'SELECT * FROM check_items WHERE shop_id = ? AND active = 1 ORDER BY position ASC, created_at ASC',
    sid
  );
  res.json({ items });
});

app.post('/api/check-items', requireAuth('admin'), async (req, res) => {
  const { shop_id, label, kind, min=null, max=null, unit='°C', position=0 } = req.body || {};
  if (!shop_id || !label || !kind) return res.status(400).json({ error: 'Missing fields' });
  if (!['temperature','boolean','number','text'].includes(kind)) return res.status(400).json({ error: 'Bad kind' });
  const db = await getDb();
  const shop = await db.get('SELECT id FROM shops WHERE id = ?', shop_id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });

  const id = uuid();
  await db.run(`
    INSERT INTO check_items (id, shop_id, label, kind, min, max, unit, position, active, created_at)
    VALUES (?,?,?,?,?,?,?,?,1,?)`,
    id, shop_id, label, kind, min, max, unit, position, new Date().toISOString()
  );
  res.json({ ok: true, id });
});

app.delete('/api/check-items/:id', requireAuth('admin'), async (req, res) => {
  const db = await getDb();
  await db.run('UPDATE check_items SET active = 0 WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// --- Submit a Daily Check (User/Admin) ---
function computeOk(item, rawVal) {
  if (item.kind === 'boolean') {
    const val = String(rawVal).toLowerCase();
    return (val === 'true' || val === 'yes' || val === '1') ? 1 : 0;
  }
  if (item.kind === 'temperature') {
    const n = Number(rawVal);
    if (Number.isNaN(n)) return 0;
    if (item.min != null && n < item.min) return 0;
    if (item.max != null && n > item.max) return 0;
    return 1;
  }
  // for number/text, mark as ok if value present
  return String(rawVal ?? '').trim().length > 0 ? 1 : 0;
}

app.post('/api/check-runs', requireAuth(), async (req, res) => {
  const { shop_slug, run_date, answers, note } = req.body || {};
  if (!shop_slug || !Array.isArray(answers)) return res.status(400).json({ error: 'Missing fields' });

  const db = await getDb();
  const shop = await getShopBySlug(db, shop_slug);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });

  const id = uuid();
  const dateStr = (run_date || new Date().toISOString().slice(0,10));
  await db.run(
    'INSERT INTO check_runs (id, shop_id, run_date, note, created_by, created_at) VALUES (?,?,?,?,?,?)',
    id, shop.id, dateStr, note || '', req.session?.user_id || null, new Date().toISOString()
  );

  // Load item definitions for ok computation
  const map = new Map();
  const defs = await db.all('SELECT * FROM check_items WHERE shop_id = ? AND active = 1', shop.id);
  defs.forEach(d => map.set(d.id, d));

  for (const a of answers) {
    if (!a || !a.item_id) continue;
    const def = map.get(a.item_id);
    if (!def) continue;
    const value = a.value ?? '';
    const ok = computeOk(def, value);
    await db.run(
      'INSERT INTO check_answers (id, run_id, item_id, value, ok) VALUES (?,?,?,?,?)',
      uuid(), id, a.item_id, String(value), ok
    );
  }

  res.json({ ok: true, run_id: id });
});

// --- History (public read) ---
app.get('/api/check-runs', async (req, res) => {
  // ?shop=slug&from=yyyy-mm-dd&to=yyyy-mm-dd
  const { shop, from, to } = req.query;
  if (!shop) return res.status(400).json({ error: 'Missing shop' });
  const db = await getDb();
  const s = await getShopBySlug(db, shop);
  if (!s) return res.json({ runs: [] });

  const rows = await db.all(
    `SELECT r.id, r.run_date, r.note, r.created_at,
            SUM(CASE WHEN a.ok=1 THEN 1 ELSE 0 END) AS ok_count,
            SUM(CASE WHEN a.ok=0 THEN 1 ELSE 0 END) AS fail_count
     FROM check_runs r
     LEFT JOIN check_answers a ON a.run_id = r.id
     WHERE r.shop_id = ?
       AND (? IS NULL OR r.run_date >= ?)
       AND (? IS NULL OR r.run_date <= ?)
     GROUP BY r.id
     ORDER BY r.run_date DESC, r.created_at DESC`,
    s.id, from || null, from || null, to || null, to || null
  );

  res.json({ runs: rows });
});

app.get('/api/check-runs/:id', async (req, res) => {
  const db = await getDb();
  const run = await db.get('SELECT * FROM check_runs WHERE id = ?', req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });

  const answers = await db.all(
    `SELECT a.id, a.item_id, a.value, a.ok, i.label, i.kind, i.unit, i.min, i.max
     FROM check_answers a
     JOIN check_items i ON i.id = a.item_id
     WHERE a.run_id = ?
     ORDER BY i.position ASC, a.id ASC`,
    req.params.id
  );
  res.json({ run, answers });
});

// --- Frontend routes ---
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/shop/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/check/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'check.html')));
app.get('/history/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));

// --- Boot ---
const args = process.argv.slice(2);
migrate().then(async () => {
  if (args.includes('--init-db')) {
    console.log('DB initialized.');
    process.exit(0);
  }
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
});
