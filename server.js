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

if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_EMAIL/ADMIN_PASSWORD missing in env. Using defaults not allowed in production.');
}

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
  `);

  // Seed admin if not exists
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  if (adminEmail) {
    const existing = await db.get('SELECT id FROM users WHERE email = ?', adminEmail);
    if (!existing) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await db.run(
        'INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?,?,?,?,?)',
        uuid(), adminEmail, hash, 'admin', new Date().toISOString()
      );
      console.log(`✅ Admin seeded: ${adminEmail}`);
    }
  }
}

// --- Middleware ---
app.use(helmet({
  contentSecurityPolicy: false // keep simple for MVP; can harden later
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(SESSION_SECRET));
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
});
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

function requireAuth(role) {
  return async (req, res, next) => {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    if (role && session.role !== role) return res.status(403).json({ error: 'Forbidden' });
    // CSRF check for state-changing requests
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
  const item = await db.get('SELECT * FROM shops WHERE slug = ?', req.params.slug);
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

// --- Routes (frontend) ---
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/shop/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));

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
