/**
 * BUNCA HACCP — Single-file Production App
 * ----------------------------------------
 * Features:
 *  - Auth with roles (admin, worker), bcrypt passwords, sessions (SQLite store)
 *  - Admin: manage shops, users, assign users to shops, define daily check items per shop
 *  - Worker: submit daily checks for assigned shops
 *  - History: review checks by shop/date with filters, CSV export
 *  - HACCP Info page
 *  - Security: helmet, rate-limit, CORS, CSRF
 *  - Deploys on Render (PORT binding, /healthz)
 *
 * IMPORTANT:
 *  - Default admin is seeded: email: admin@bunca.de  password: Admin!123
 *  - SQLite DB file at ./data/bunca.db (created automatically)
 *
 * Next steps (optional):
 *  - File uploads for manuals (multer)
 *  - Per-item min/max + auto status calc (already included)
 *  - Email invites, password reset, etc.
 */

'use strict';

// ------------------------- Imports -------------------------
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const csrf = require('csurf');
require('dotenv').config();

// ------------------------- Config --------------------------
const APP_NAME = process.env.APP_NAME || 'BUNCA HACCP';
const NODE_ENV = process.env.NODE_ENV || 'production';
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

// Paths
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'bunca.db');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ------------------------- DB ------------------------------
const db = new sqlite3.Database(DB_PATH);

// Run schema
db.serialize(() => {
  db.run(`PRAGMA foreign_keys = ON;`);

  // Users
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','worker')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Shops
  db.run(`
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE,
      address TEXT,
      phone TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // User-<->Shop mapping (workers can be assigned to one or multiple)
  db.run(`
    CREATE TABLE IF NOT EXISTS user_shops (
      user_id INTEGER NOT NULL,
      shop_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, shop_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
    );
  `);

  // Check items per shop (admin-defined)
  db.run(`
    CREATE TABLE IF NOT EXISTS check_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      name TEXT NOT NULL,            -- e.g., "Fridge", "Oven", "Espresso Machine"
      unit TEXT,                     -- e.g., "°C", "OK/Not OK", ""
      type TEXT NOT NULL DEFAULT 'number',  -- 'number' | 'text'
      min_value REAL,                -- threshold min (nullable)
      max_value REAL,                -- threshold max (nullable)
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
    );
  `);

  // Checks (daily submissions)
  db.run(`
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      date TEXT NOT NULL,            -- 'YYYY-MM-DD'
      value_number REAL,
      value_text TEXT,
      status TEXT NOT NULL,          -- 'ok' | 'warn' | 'fail'
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (item_id) REFERENCES check_items(id) ON DELETE CASCADE
    );
  `);

  // Seed admin & example shop if empty
  db.get(`SELECT COUNT(*) as c FROM users`, async (err, row) => {
    if (err) { console.error('DB seed (users) error:', err); return; }
    if (row.c === 0) {
      const hash = await bcrypt.hash('Admin!123', 10);
      db.run(`INSERT INTO users(email, password_hash, role) VALUES (?,?,?)`,
        ['admin@bunca.de', hash, 'admin']);
      console.log('✅ Seeded default admin: admin@bunca.de / Admin!123');
    }
  });

  db.get(`SELECT COUNT(*) as c FROM shops`, (err, row) => {
    if (err) { console.error('DB seed (shops) error:', err); return; }
    if (row.c === 0) {
      db.run(`INSERT INTO shops(name, code, address, phone) VALUES (?,?,?,?)`,
        ['BUNCA City', 'CITY', 'Musterstraße 1, 60311 Frankfurt', '+49 69 000000'],
        function insertItemsCb() {
          const shopId = this.lastID;
          const items = [
            { name: 'Kühlschrank Temperatur', unit: '°C', type: 'number', min: -1, max: 7, sort: 1 },
            { name: 'Ofen Temperatur (Standby)', unit: '°C', type: 'number', min: 150, max: 250, sort: 2 },
            { name: 'Espressomaschine Kessel', unit: '°C', type: 'number', min: 110, max: 125, sort: 3 },
            { name: 'Espresso Ausgabetemperatur', unit: '°C', type: 'number', min: 60, max: 75, sort: 4 },
            { name: 'Bohnenzustand', unit: '', type: 'text', min: null, max: null, sort: 5 },
            { name: 'Spülmaschine Temperatur', unit: '°C', type: 'number', min: 60, max: 85, sort: 6 }
          ];
          const stmt = db.prepare(`
            INSERT INTO check_items(shop_id, name, unit, type, min_value, max_value, sort_order)
            VALUES (?,?,?,?,?,?,?)
          `);
          items.forEach(i => stmt.run(shopId, i.name, i.unit, i.type, i.min, i.max, i.sort));
          stmt.finalize();
          console.log('✅ Seeded example shop & check items');
        }
      );
    }
  });
});

// ------------------------- App Setup -----------------------
const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "script-src": ["'self'"],
      "connect-src": ["'self'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

// CORS (open)
app.use(cors({ origin: (_o, cb) => cb(null, true) }));

// Session (SQLite)
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 8 // 8h
  }
}));

// Rate limit
app.use(rateLimit({ windowMs: 60 * 1000, max: 180 }));

// CSRF
const csrfProtection = csrf();
app.use(csrfProtection);

// Flash helper via session
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  res.locals.csrfToken = req.csrfToken();
  res.locals.user = req.session.user || null;
  res.locals.APP_NAME = APP_NAME;
  next();
});
function flash(req, type, msg) {
  if (!req.session.flash) req.session.flash = [];
  req.session.flash.push({ type, msg });
}

// ------------------------- Helpers -------------------------
const escapeHtml = (s = '') =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const todayISO = () => new Date().toISOString().slice(0, 10);

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    flash(req, 'warn', 'Bitte zuerst anmelden.');
    return res.redirect('/login');
  }
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      flash(req, 'fail', 'Keine Berechtigung.');
      return res.redirect('/');
    }
    next();
  };
}
function isAdmin(req) { return req.session.user?.role === 'admin'; }

// Status calculation based on min/max
function evalStatus(value, min, max) {
  if (value === null || value === undefined || value === '') return 'warn';
  if (typeof value === 'number' && (min != null || max != null)) {
    if (min != null && value < min) return 'fail';
    if (max != null && value > max) return 'fail';
    // Near edge? we could mark 'warn' but keep simple:
    return 'ok';
  }
  return 'ok';
}

// ------------------------- UI (CSS/JS) ---------------------
const CSS = String.raw`
/* Minimal design system (same as earlier, trimmed for brevity but complete) */
:root{--bg:#0e0f12;--panel:#14161b;--soft:#1a1d23;--text:#e9eef7;--muted:#a8b0bf;--brand:#3E2723;--cream:#F5EDE3;--gold:#C6A15B;--ok:#38b000;--warn:#ffb703;--fail:#e63946;--radius:18px;--radius-lg:26px;--shadow:0 10px 30px rgba(0,0,0,.35);--maxw:1120px;--focus:0 0 0 3px rgba(198,161,91,.28)}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:linear-gradient(180deg,var(--bg) 0%, #121419 100%);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
a{color:inherit;text-decoration:none}img{max-width:100%;display:block}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 18px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.grid{display:grid;gap:18px}
.grid-2{display:grid;gap:18px;grid-template-columns:1fr}
@media(min-width:920px){.grid-2{grid-template-columns:1fr 1fr}}
.grid-3{display:grid;gap:18px;grid-template-columns:1fr}
@media(min-width:1000px){.grid-3{grid-template-columns:repeat(3,1fr)}}
.card{background:linear-gradient(180deg,var(--panel),#0f1115);border:1px solid rgba(255,255,255,.06);border-radius:var(--radius-lg);padding:18px;box-shadow:var(--shadow)}
.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid rgba(255,255,255,.08);border-radius:999px;background:rgba(255,255,255,.05);font-size:13px;color:var(--muted)}
.btn{cursor:pointer;display:inline-flex;justify-content:center;align-items:center;gap:8px;padding:12px 16px;border:none;border-radius:14px;font-weight:800;transition:transform .06s ease, box-shadow .2s ease;outline:none}
.btn:focus{box-shadow:var(--focus)} .btn:active{transform:translateY(1px)}
.btn-primary{background:linear-gradient(180deg,var(--gold),#9f7e3d);color:#14161b;box-shadow:var(--shadow)}
.btn-ghost{background:transparent;border:1px solid rgba(255,255,255,.12);color:var(--text)}
.btn-danger{background:linear-gradient(180deg,#e15a64,#b92f39);color:#fff}
.chip{border:1px solid rgba(255,255,255,.08);padding:6px 10px;border-radius:999px}
.muted{color:var(--muted)}.kpi{font-weight:900;font-size:1.3rem}
.ok{color:var(--ok)}.warn{color:var(--warn)}.fail{color:var(--fail)}
.input,select,textarea{width:100%;padding:12px 14px;border-radius:14px;background:#0c0d11;color:var(--text);border:1px solid rgba(255,255,255,.07);outline:none;transition:border-color .15s ease,box-shadow .15s ease}
.input:focus,select:focus,textarea:focus{border-color:var(--gold);box-shadow:var(--focus)}
label>span{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
.form{display:grid;gap:12px}
.table{width:100%;border-collapse:separate;border-spacing:0}
.table th,.table td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);text-align:left;font-size:14px}
.table th{font-weight:800;color:var(--muted)}.table tr:hover td{background:rgba(255,255,255,.03)}
.site-header{position:sticky;top:0;z-index:40;background:rgba(14,15,18,.7);backdrop-filter:blur(10px);border-bottom:1px solid rgba(255,255,255,.06)}
.nav{display:flex;align-items:center;justify-content:space-between;height:64px}
.brand{display:flex;gap:10px;align-items:center}
.logo{inline-size:34px;block-size:34px;border-radius:10px;background:radial-gradient(100% 100% at 50% 0%,var(--brand),#1d1110);display:grid;place-items:center;color:var(--cream);font-weight:800}
.link{opacity:.92;padding:8px 10px;border-radius:12px}.link:hover{opacity:1;background:rgba(255,255,255,.06)}
main.page{padding:28px 0 56px}.hero{padding:42px 0 16px}
.h1{font-size:clamp(26px,4.5vw,48px);line-height:1.05;margin:10px 0 8px;font-weight:900;letter-spacing:.2px}
.h2{font-size:clamp(20px,3vw,30px);font-weight:900;margin:0 0 12px}
.lead{font-size:clamp(15px,2vw,18px);color:var(--muted);max-width:70ch}
.flash{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.06);margin:8px 0}
.flash.ok{background:rgba(56,176,0,.12)}.flash.warn{background:rgba(255,183,3,.12)}.flash.fail{background:rgba(230,57,70,.12)}
.footer{padding:26px 0;border-top:1px solid rgba(255,255,255,.06);color:var(--muted)}
dialog{border:none;border-radius:16px;max-width:720px;width:96vw;background:linear-gradient(180deg,var(--panel),#0f1115);color:var(--text);padding:0}
dialog::backdrop{background:rgba(0,0,0,.55)}.dialog-header{padding:18px 18px 0;font-weight:800}.dialog-body{padding:12px 18px;color:var(--muted)}.dialog-actions{padding:0 18px 18px}
`;

// Client JS (small: menu, toasts)
const JS = String.raw`
(function(){
  'use strict';
  const t=document.querySelectorAll('[data-autosubmit]'); t.forEach(f=>f.addEventListener('change',()=>f.submit()));
})();
`;

// ------------------------- Templating ----------------------
function shell({ title, user, csrfToken, content }) {
  const navRight = user ? `
    <form method="post" action="/logout" style="margin:0">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <button class="btn btn-ghost">Logout</button>
    </form>
  ` : `<a class="link" href="/login">Login</a>`;

  const roleTag = user ? `<span class="chip">${escapeHtml(user.email)} · ${user.role}</span>` : '';
  return `<!doctype html>
<html lang="de" data-theme="dark">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(title ? `${title} · ${APP_NAME}` : APP_NAME)}</title>
  <meta name="color-scheme" content="dark light"/>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%233E2723'/%3E%3Ctext x='50%25' y='54%25' text-anchor='middle' font-size='28' font-family='system-ui' fill='%23F5EDE3'%3EB%3C/text%3E%3C/svg%3E"/>
  <link rel="stylesheet" href="/assets/style.css"/>
</head>
<body>
  <header class="site-header">
    <div class="wrap nav">
      <a class="brand" href="/"><div class="logo">B</div><span>${APP_NAME}</span></a>
      <nav class="row">
        <a class="link" href="/">Start</a>
        <a class="link" href="/info">HACCP Info</a>
        ${user ? `<a class="link" href="/history">History</a>` : ''}
        ${isAdmin({session:{user}}) ? `<a class="link" href="/admin">Admin</a>` : ''}
        ${navRight}
      </nav>
    </div>
  </header>
  <main class="page">
    <div class="wrap">
      ${roleTag}
      ${renderFlash()}
      ${content}
    </div>
  </main>
  <footer class="footer">
    <div class="wrap row" style="justify-content:space-between">
      <div class="row"><div class="logo" style="inline-size:26px;block-size:26px;border-radius:8px">B</div><span>${APP_NAME}</span></div>
      <div class="row"><a class="link" href="/impressum">Impressum</a><span>·</span><a class="link" href="/datenschutz">Datenschutz</a></div>
    </div>
  </footer>
  <script src="/assets/app.js" defer></script>
</body>
</html>`;
}

function renderFlash() {
  // res.locals is not available here; we attach on global each request
  const arr = globalThis.__flash__ || [];
  if (!arr.length) return '';
  return arr.map(f => `<div class="flash ${f.type}">${escapeHtml(f.msg)}</div>`).join('');
}

// Inject flash per request
app.use((req, res, next) => {
  globalThis.__flash__ = res.locals.flash || [];
  next();
});

// ------------------------- Views ---------------------------
// Home (different for worker/admin)
function viewHome(req, shopsForUser = []) {
  const isAdminView = isAdmin(req);
  const intro = isAdminView
    ? `<h1 class="h1">Willkommen, Admin</h1>
       <p class="lead">Erstelle Shops, weise Mitarbeiter zu und definiere tägliche Checkpunkte. Dann kannst du die eingereichten Checks in der History einsehen.</p>
       <div class="row">
         <a class="btn btn-primary" href="/admin">Zum Admin-Bereich</a>
         <a class="btn btn-ghost" href="/history">History</a>
       </div>`
    : `<h1 class="h1">Tägliche Checks</h1>
       <p class="lead">Wähle deinen Shop und fülle die täglichen Checks aus.</p>`;

  const shopCards = shopsForUser.length
    ? `<div class="grid-3">` + shopsForUser.map(s => `
        <div class="card">
          <div class="h2">${escapeHtml(s.name)}</div>
          <p class="muted">${escapeHtml(s.address || '')}</p>
          <div class="row">
            <a class="btn btn-primary" href="/shops/${s.id}/daily">Daily Check</a>
            <a class="btn btn-ghost" href="/shops/${s.id}/history">History</a>
          </div>
        </div>`).join('') + `</div>`
    : `<div class="card"><p class="muted">Noch keine Shops zugewiesen.</p></div>`;

  return shell({
    title: 'Start',
    user: req.session.user,
    csrfToken: resCsrf(req),
    content: `
<section class="hero">
  <div class="grid-2">
    <div>${intro}</div>
    <div class="card">
      <div class="h2">HACCP in BUNCA</div>
      <p class="muted">Standardisierte tägliche Checks: Kühlschrank, Ofen, Espressomaschine, Espresso-Temperatur, Bohnenzustand, Spülmaschine – plus beliebige eigene Punkte pro Shop.</p>
      <div class="row">
        <span class="chip">🔐 DSGVO-konform</span>
        <span class="chip">📦 CSV-Export</span>
        <span class="chip">💼 Rollenbasiert</span>
      </div>
    </div>
  </div>
</section>
${shopCards}
    `
  });
}

function resCsrf(req) { return res.locals?.csrfToken ?? req.csrfToken(); } // fallback

// Login
function viewLogin(req) {
  return shell({
    title: 'Login',
    user: req.session.user,
    csrfToken: resCsrf(req),
    content: `
<div class="grid-2">
  <div>
    <h1 class="h1">Anmelden</h1>
    <p class="muted">Admin & Mitarbeiter loggen sich hier ein. Standard-Admin: <code>admin@bunca.de</code> / <code>Admin!123</code></p>
  </div>
  <div class="card" style="max-width:520px">
    <form class="form" method="post" action="/login">
      <input type="hidden" name="_csrf" value="${resCsrf(req)}">
      <label><span>E-Mail</span><input class="input" name="email" type="email" placeholder="dein.name@bunca.de" required></label>
      <label><span>Passwort</span><input class="input" name="password" type="password" placeholder="Passwort" required></label>
      <button class="btn btn-primary" type="submit">Login</button>
    </form>
  </div>
</div>`
  });
}

// HACCP Info page
function viewInfo(req) {
  return shell({
    title: 'HACCP Info',
    user: req.session.user,
    csrfToken: resCsrf(req),
    content: `
<div class="grid-2">
  <div>
    <h1 class="h1">HACCP – kurz erklärt</h1>
    <p class="lead">Hazard Analysis and Critical Control Points. Ziel: Risiken erkennen, steuern und dokumentieren.</p>
    <div class="card">
      <div class="h2">Typische Bereiche</div>
      <ul>
        <li>Wareneingang & Kühlkette</li>
        <li>Lagertemperaturen (Kühlschrank, Tiefkühlung)</li>
        <li>Zubereitung (Espresso, Milch, Ofen)</li>
        <li>Reinigung & Desinfektion</li>
        <li>Schulung & Unterweisung</li>
      </ul>
    </div>
  </div>
  <div class="card">
    <div class="h2">Wie BUNCA HACCP hilft</div>
    <ul>
      <li>Daily Check-Formulare je Shop</li>
      <li>Individuelle Prüfpositionen (Admin konfiguriert)</li>
      <li>Automatische Bewertung (ok/warn/fail) anhand Grenzwerte</li>
      <li>History mit Filtern + CSV-Export</li>
    </ul>
  </div>
</div>`
  });
}

// Admin dashboard
function viewAdmin(req, { shops = [], users = [], assignments = {} }) {
  // assignments: { user_id: [shop_id,...] }
  const shopRows = shops.map(s => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.code || '')}</td>
      <td>${escapeHtml(s.address || '')}</td>
      <td class="row">
        <a class="btn btn-ghost" href="/admin/shops/${s.id}">Check-Items</a>
        <form method="post" action="/admin/shops/${s.id}/delete" onsubmit="return confirm('Shop wirklich löschen?')" style="margin:0">
          <input type="hidden" name="_csrf" value="${resCsrf(req)}">
          <button class="btn btn-danger btn-sm">Löschen</button>
        </form>
      </td>
    </tr>`).join('');

  const userRows = users.map(u => {
    const shopsForUser = assignments[u.id] || [];
    return `<tr>
      <td>${escapeHtml(u.email)}</td>
      <td>${u.role}</td>
      <td>${u.active ? 'aktiv' : 'inaktiv'}</td>
      <td>${shopsForUser.map(id => {
        const s = shops.find(x => x.id === id);
        return s ? `<span class="chip">${escapeHtml(s.name)}</span>` : '';
      }).join(' ')}</td>
      <td class="row">
        <form method="post" action="/admin/users/${u.id}/toggle" style="margin:0">
          <input type="hidden" name="_csrf" value="${resCsrf(req)}">
          <button class="btn btn-ghost btn-sm">${u.active ? 'Deaktivieren' : 'Aktivieren'}</button>
        </form>
        <form method="post" action="/admin/users/${u.id}/reset" style="margin:0" onsubmit="return confirm('Passwort zurücksetzen?')">
          <input type="hidden" name="_csrf" value="${resCsrf(req)}">
          <button class="btn btn-ghost btn-sm">PW-Reset</button>
        </form>
        <form method="post" action="/admin/users/${u.id}/delete" style="margin:0" onsubmit="return confirm('User wirklich löschen?')">
          <input type="hidden" name="_csrf" value="${resCsrf(req)}">
          <button class="btn btn-danger btn-sm">Löschen</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  const shopOptions = shops.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

  return shell({
    title: 'Admin',
    user: req.session.user,
    csrfToken: resCsrf(req),
    content: `
<h1 class="h1">Admin</h1>
<div class="grid-2">
  <div class="card">
    <div class="h2">Shops</div>
    <table class="table">
      <thead><tr><th>Name</th><th>Code</th><th>Adresse</th><th>Aktionen</th></tr></thead>
      <tbody>${shopRows || '<tr><td colspan="4" class="muted">Keine Shops</td></tr>'}</tbody>
    </table>
    <div class="h2">Neuen Shop anlegen</div>
    <form class="form" method="post" action="/admin/shops/create">
      <input type="hidden" name="_csrf" value="${resCsrf(req)}">
      <label><span>Name</span><input class="input" name="name" required></label>
      <label><span>Code</span><input class="input" name="code" placeholder="z.B. CITY"></label>
      <label><span>Adresse</span><input class="input" name="address"></label>
      <label><span>Telefon</span><input class="input" name="phone"></label>
      <button class="btn btn-primary">Shop erstellen</button>
    </form>
  </div>

  <div class="card">
    <div class="h2">Benutzer</div>
    <table class="table">
      <thead><tr><th>E-Mail</th><th>Rolle</th><th>Status</th><th>Shops</th><th>Aktionen</th></tr></thead>
      <tbody>${userRows || '<tr><td colspan="5" class="muted">Keine Benutzer</td></tr>'}</tbody>
    </table>
    <div class="h2">Benutzer anlegen</div>
    <form class="form" method="post" action="/admin/users/create">
      <input type="hidden" name="_csrf" value="${resCsrf(req)}">
      <label><span>E-Mail</span><input class="input" name="email" type="email" required></label>
      <label><span>Rolle</span>
        <select name="role" required>
          <option value="worker">worker</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <label><span>Initiales Passwort</span><input class="input" name="password" type="password" placeholder="mind. 8 Zeichen" required></label>
      <label><span>Shop-Zuweisung</span>
        <select name="shop_id" required>${shopOptions}</select>
      </label>
      <button class="btn btn-primary">Benutzer erstellen</button>
    </form>
    <p class="muted">Hinweis: Du kannst Mitarbeiter mehreren Shops zuweisen, nachdem sie erstellt wurden.</p>
    <div class="h2">Weitere Zuweisung</div>
    <form class="form" method="post" action="/admin/users/assign">
      <input type="hidden" name="_csrf" value="${resCsrf(req)}">
      <label><span>User ID</span><input class="input" name="user_id" type="number" required></label>
      <label><span>Shop</span><select name="shop_id" required>${shopOptions}</select></label>
      <button class="btn btn-ghost">Zuweisen</button>
    </form>
  </div>
</div>
`
  });
}

// Admin: manage check items for a shop
function viewShopItems(req, shop, items = []) {
  const rows = items.map(i => `
  <tr>
    <td>${i.sort_order}</td>
    <td>${escapeHtml(i.name)}</td>
    <td>${escapeHtml(i.type)}</td>
    <td>${i.min_value ?? ''}</td>
    <td>${i.max_value ?? ''}</td>
    <td>${escapeHtml(i.unit || '')}</td>
    <td class="row">
      <form method="post" action="/admin/shops/${shop.id}/items/${i.id}/delete" style="margin:0" onsubmit="return confirm('Item löschen?')">
        <input type="hidden" name="_csrf" value="${resCsrf(req)}">
        <button class="btn btn-danger btn-sm">Löschen</button>
      </form>
    </td>
  </tr>`).join('');

  return shell({
    title: `Check-Items · ${shop.name}`,
    user: req.session.user,
    csrfToken: resCsrf(req),
    content: `
<h1 class="h1">Check-Items – ${escapeHtml(shop.name)}</h1>
<div class="grid-2">
  <div class="card">
    <div class="h2">Bestehende Items</div>
    <table class="table">
      <thead><tr><th>#</th><th>Name</th><th>Typ</th><th>Min</th><th>Max</th><th>Einheit</th><th>Aktionen</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">Noch keine Items</td></tr>'}</tbody>
    </table>
  </div>
  <div class="card">
    <div class="h2">Neues Item hinzufügen</div>
    <form class="form" method="post" action="/admin/shops/${shop.id}/items/create">
      <input type="hidden" name="_csrf" value="${resCsrf(req)}">
      <label><span>Name</span><input class="input" name="name" placeholder="z.B. Kühlschrank Temperatur" required></label>
      <label><span>Typ</span>
        <select name="type">
          <option value="number" selected>number</option>
          <option value="text">text</option>
        </select>
      </label>
      <label><span>Einheit</span><input class="input" name="unit" placeholder="°C"></label>
      <label><span>Min (optional)</span><input class="input" name="min_value" type="number" step="0.1"></label>
      <label><span>Max (optional)</span><input class="input" name="max_value" type="number" step="0.1"></label>
      <label><span>Sortierung</span><input class="input" name="sort_order" type="number" value="0"></label>
      <button class="btn btn-primary">Item hinzufügen</button>
    </form>
  </div>
</div>
`
  });
}

// Daily Check form (worker)
function viewDailyForm(req, shop, items) {
  const date = todayISO();
  const fields = items.map(i => {
    const nameAttr = i.type === 'number' ? `value_number_${i.id}` : `value_text_${i.id}`;
    const input = i.type === 'number'
      ? `<input class="input" name="${nameAttr}" type="number" step="0.1" placeholder="${i.unit || ''}" required>`
      : `<input class="input" name="${nameAttr}" type="text" placeholder="OK / Hinweis" required>`;
    const hint = (i.min_value != null || i.max_value != null)
      ? `<span class="muted" style="font-size:12px">Grenzen: ${i.min_value ?? '–'} bis ${i.max_value ?? '–'} ${i.unit || ''}</span>`
      : '';
    return `<label><span>${escapeHtml(i.name)} ${i.unit ? `(${escapeHtml(i.unit)})` : ''}</span>${input}${hint}</label>`;
  }).join('');

  return shell({
    title: `Daily Check · ${shop.name}`,
    user: req.session.user,
    csrfToken: resCsrf(req),
    content: `
<h1 class="h1">Daily Check – ${escapeHtml(shop.name)}</h1>
<div class="card" style="max-width:760px">
  <form class="form" method="post" action="/shops/${shop.id}/daily">
    <input type="hidden" name="_csrf" value="${resCsrf(req)}">
    <label><span>Datum</span><input class="input" name="date" type="date" value="${date}" required></label>
    ${fields}
    <label><span>Allgemeine Notiz (optional)</span><textarea class="input" name="note" rows="3" placeholder="Auffälligkeiten, Maßnahmen ..."></textarea></label>
    <button class="btn btn-primary">Check senden</button>
  </form>
</div>
<p class="muted">Hinweis: Der Status (ok/warn/fail) wird automatisch anhand der Grenzwerte berechnet.</p>
`
  });
}

// History list
function viewHistory(req, { shops, selectedShopId, rows, filters }) {
  const options = shops.map(s => `<option value="${s.id}" ${Number(selectedShopId)===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
  const trows = rows.map(r => `
  <tr>
    <td>${escapeHtml(r.date)}</td>
    <td>${escapeHtml(r.shop_name)}</td>
    <td>${escapeHtml(r.item_name)}</td>
    <td>${r.value_text ?? (r.value_number ?? '')}</td>
    <td><span class="kpi ${r.status}">${r.status}</span></td>
    <td>${escapeHtml(r.user_email || '')}</td>
    <td>${escapeHtml(r.note || '')}</td>
  </tr>`).join('');

  const q = filters || {};
  return shell({
    title: 'History',
    user: req.session.user,
    csrfToken: resCsrf(req),
    content: `
<h1 class="h1">History</h1>
<form class="row" method="get" action="/history" data-autosubmit>
  <label><span>Shop</span>
    <select name="shop_id" class="input"><option value="">Alle</option>${options}</select>
  </label>
  <label><span>Von</span><input class="input" name="from" type="date" value="${escapeHtml(q.from || '')}"></label>
  <label><span>Bis</span><input class="input" name="to" type="date" value="${escapeHtml(q.to || '')}"></label>
  <label><span>Status</span>
    <select name="status" class="input">
      <option value="">Alle</option>
      <option value="ok" ${q.status==='ok'?'selected':''}>ok</option>
      <option value="warn" ${q.status==='warn'?'selected':''}>warn</option>
      <option value="fail" ${q.status==='fail'?'selected':''}>fail</option>
    </select>
  </label>
  <a class="btn btn-ghost" href="/history.csv?shop_id=${encodeURIComponent(q.shop_id||'')}&from=${encodeURIComponent(q.from||'')}&to=${encodeURIComponent(q.to||'')}&status=${encodeURIComponent(q.status||'')}">CSV export</a>
</form>

<div class="card" style="margin-top:12px">
  <table class="table">
    <thead><tr><th>Datum</th><th>Shop</th><th>Item</th><th>Wert</th><th>Status</th><th>User</th><th>Notiz</th></tr></thead>
    <tbody>${trows || '<tr><td colspan="7" class="muted">Keine Daten</td></tr>'}</tbody>
  </table>
</div>`
  });
}

// Legal
function viewImpressum(req){return shell({title:'Impressum',user:req.session.user,csrfToken:resCsrf(req),content:`<div class="card"><div class="h2">Impressum</div><p>BUNCA Coffee GmbH – Musterstraße 1, 60311 Frankfurt.</p></div>`})}
function viewDatenschutz(req){return shell({title:'Datenschutz',user:req.session.user,csrfToken:resCsrf(req),content:`<div class="card"><div class="h2">Datenschutz</div><p class="muted">Wir verarbeiten personenbezogene Daten nur im erforderlichen Umfang für Auth und Checks.</p></div>`})}

// ------------------------- Routes --------------------------

// Health & assets
app.get('/healthz', (_req,res)=>res.status(200).send('ok'));
app.get('/assets/style.css', (_req,res)=>{res.setHeader('Content-Type','text/css; charset=utf-8');res.send(CSS);});
app.get('/assets/app.js', (_req,res)=>{res.setHeader('Content-Type','application/javascript; charset=utf-8');res.send(JS);});
app.get('/robots.txt',(req,res)=>{res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${getBaseUrl(req)}/sitemap.xml`);});
app.get('/sitemap.xml',(req,res)=>{const b=getBaseUrl(req);res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${b}/</loc></url><url><loc>${b}/login</loc></url><url><loc>${b}/info</loc></url><url><loc>${b}/history</loc></url></urlset>`);});

// Auth
app.get('/login',(req,res)=>res.send(viewLogin(req)));
app.post('/login',(req,res)=>{
  const {email,password}=req.body||{};
  db.get(`SELECT * FROM users WHERE email=? AND active=1`, [email], async (err,u)=>{
    if(err){console.error(err);flash(req,'fail','Fehler');return res.redirect('/login');}
    if(!u || !(await bcrypt.compare(password,u.password_hash))){
      flash(req,'fail','Login fehlgeschlagen');return res.redirect('/login');
    }
    req.session.user={id:u.id,email:u.email,role:u.role};
    flash(req,'ok','Willkommen!');
    res.redirect('/');
  });
});
app.post('/logout', requireAuth, (req,res)=>{req.session.destroy(()=>res.redirect('/login'));});

// Home
app.get('/', requireAuth, (req,res)=>{
  // shops for user
  if (isAdmin(req)) {
    // Show all shops in cards
    db.all(`SELECT * FROM shops WHERE active=1 ORDER BY name`, (err, shops)=>{
      if(err){console.error(err);flash(req,'fail','Fehler');return res.redirect('/login');}
      res.send(viewHome(req, shops));
    });
  } else {
    db.all(`
      SELECT s.* FROM shops s
      JOIN user_shops us ON us.shop_id = s.id
      WHERE us.user_id = ? AND s.active=1
      ORDER BY s.name
    `, [req.session.user.id], (err, shops)=>{
      if(err){console.error(err);flash(req,'fail','Fehler');return res.redirect('/login');}
      res.send(viewHome(req, shops));
    });
  }
});

// Info
app.get('/info', (req,res)=>res.send(viewInfo(req)));

// History (list)
app.get('/history', requireAuth, (req,res)=>{
  const q = {
    shop_id: req.query.shop_id || '',
    from: req.query.from || '',
    to: req.query.to || '',
    status: req.query.status || ''
  };
  const params = [];
  let where = '1=1';
  if (q.shop_id) { where += ' AND c.shop_id = ?'; params.push(q.shop_id); }
  if (q.from)    { where += ' AND c.date >= ?'; params.push(q.from); }
  if (q.to)      { where += ' AND c.date <= ?'; params.push(q.to); }
  if (q.status)  { where += ' AND c.status = ?'; params.push(q.status); }

  const sql = `
    SELECT c.*, s.name as shop_name, i.name as item_name, u.email as user_email
    FROM checks c
    JOIN shops s ON s.id = c.shop_id
    JOIN check_items i ON i.id = c.item_id
    LEFT JOIN users u ON u.id = c.user_id
    WHERE ${where}
    ORDER BY c.date DESC, c.created_at DESC
    LIMIT 500
  `;
  db.all(`SELECT * FROM shops WHERE active=1 ORDER BY name`, (e1, shops)=>{
    if(e1){console.error(e1);flash(req,'fail','Fehler');return res.redirect('/');}
    db.all(sql, params, (e2, rows)=>{
      if(e2){console.error(e2);flash(req,'fail','Fehler');return res.redirect('/');}
      res.send(viewHistory(req, { shops, selectedShopId: q.shop_id, rows, filters: q }));
    });
  });
});

// History CSV export
app.get('/history.csv', requireAuth, (req,res)=>{
  const q = {
    shop_id: req.query.shop_id || '',
    from: req.query.from || '',
    to: req.query.to || '',
    status: req.query.status || ''
  };
  const params = [];
  let where = '1=1';
  if (q.shop_id) { where += ' AND c.shop_id = ?'; params.push(q.shop_id); }
  if (q.from)    { where += ' AND c.date >= ?'; params.push(q.from); }
  if (q.to)      { where += ' AND c.date <= ?'; params.push(q.to); }
  if (q.status)  { where += ' AND c.status = ?'; params.push(q.status); }

  const sql = `
    SELECT c.date, s.name as shop, i.name as item, COALESCE(c.value_text, c.value_number) as value, c.status, u.email as user, c.note
    FROM checks c
    JOIN shops s ON s.id = c.shop_id
    JOIN check_items i ON i.id = c.item_id
    LEFT JOIN users u ON u.id = c.user_id
    WHERE ${where}
    ORDER BY c.date DESC, c.created_at DESC
  `;
  db.all(sql, params, (err, rows)=>{
    if(err){console.error(err);return res.status(500).send('error');}
    const header = 'date,shop,item,value,status,user,note\n';
    const csv = header + rows.map(r => [
      r.date, r.shop, r.item,
      String(r.value ?? '').replaceAll('"','""'),
      r.status, r.user || '', (r.note || '').replaceAll('"','""')
    ].map(x => `"${x}"`).join(',')).join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="history.csv"');
    res.send(csv);
  });
});

// Shop daily form
app.get('/shops/:id/daily', requireAuth, (req,res)=>{
  const shopId = Number(req.params.id);
  const uid = req.session.user.id;

  // Authorization: worker must be assigned to this shop (admins can always)
  const authSql = isAdmin(req)
    ? `SELECT * FROM shops WHERE id=? AND active=1`
    : `SELECT s.* FROM shops s JOIN user_shops us ON us.shop_id=s.id WHERE s.id=? AND us.user_id=? AND s.active=1`;

  const authParams = isAdmin(req) ? [shopId] : [shopId, uid];
  db.get(authSql, authParams, (e1, shop)=>{
    if(e1 || !shop){ flash(req,'fail','Kein Zugriff auf diesen Shop'); return res.redirect('/'); }
    db.all(`SELECT * FROM check_items WHERE shop_id=? AND active=1 ORDER BY sort_order, id`, [shopId], (e2, items)=>{
      if(e2){console.error(e2); flash(req,'fail','Fehler'); return res.redirect('/');}
      res.send(viewDailyForm(req, shop, items));
    });
  });
});

app.post('/shops/:id/daily', requireAuth, (req,res)=>{
  const shopId = Number(req.params.id);
  const uid = req.session.user.id;
  const { date, note } = req.body || {};

  const authSql = isAdmin(req)
    ? `SELECT * FROM shops WHERE id=? AND active=1`
    : `SELECT s.* FROM shops s JOIN user_shops us ON us.shop_id=s.id WHERE s.id=? AND us.user_id=? AND s.active=1`;
  const authParams = isAdmin(req) ? [shopId] : [shopId, uid];

  db.get(authSql, authParams, (e1, shop)=>{
    if(e1 || !shop){ flash(req,'fail','Kein Zugriff auf diesen Shop'); return res.redirect('/'); }
    db.all(`SELECT * FROM check_items WHERE shop_id=? AND active=1 ORDER BY sort_order, id`, [shopId], (e2, items)=>{
      if(e2){console.error(e2); flash(req,'fail','Fehler'); return res.redirect('/');}

      const ins = db.prepare(`
        INSERT INTO checks (shop_id, user_id, item_id, date, value_number, value_text, status, note)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      try {
        items.forEach(i => {
          const numField = `value_number_${i.id}`;
          const txtField = `value_text_${i.id}`;
          let vNum = null, vTxt = null;
          if (i.type === 'number') {
            const raw = req.body[numField];
            vNum = raw === '' || raw == null ? null : Number(raw);
          } else {
            vTxt = (req.body[txtField] ?? '').trim();
          }
          const status = i.type === 'number' ? evalStatus(vNum, i.min_value, i.max_value) : (vTxt ? 'ok' : 'warn');
          ins.run(shopId, uid, i.id, date || todayISO(), vNum, vTxt, status, note || null);
        });
        ins.finalize();
        flash(req, 'ok', 'Daily Check gespeichert.');
        res.redirect(`/shops/${shopId}/history`);
      } catch (e) {
        console.error(e);
        flash(req,'fail','Fehler beim Speichern.');
        res.redirect(`/shops/${shopId}/daily`);
      }
    });
  });
});

// Shop history (quick view)
app.get('/shops/:id/history', requireAuth, (req,res)=>{
  const shopId = Number(req.params.id);
  const uid = req.session.user.id;
  const authSql = isAdmin(req)
    ? `SELECT * FROM shops WHERE id=? AND active=1`
    : `SELECT s.* FROM shops s JOIN user_shops us ON us.shop_id=s.id WHERE s.id=? AND us.user_id=? AND s.active=1`;
  const authParams = isAdmin(req) ? [shopId] : [shopId, uid];

  db.get(authSql, authParams, (e1, shop)=>{
    if(e1 || !shop){ flash(req,'fail','Kein Zugriff auf diesen Shop'); return res.redirect('/'); }
    const sql = `
      SELECT c.*, i.name as item_name, u.email as user_email
      FROM checks c
      JOIN check_items i ON i.id=c.item_id
      LEFT JOIN users u ON u.id=c.user_id
      WHERE c.shop_id=?
      ORDER BY c.date DESC, c.created_at DESC
      LIMIT 200
    `;
    db.all(sql, [shopId], (e2, rows)=>{
      if(e2){console.error(e2); flash(req,'fail','Fehler'); return res.redirect('/');}
      const table = rows.map(r=>`
        <tr>
          <td>${escapeHtml(r.date)}</td>
          <td>${escapeHtml(r.item_name)}</td>
          <td>${r.value_text ?? (r.value_number ?? '')}</td>
          <td><span class="kpi ${r.status}">${r.status}</span></td>
          <td>${escapeHtml(r.user_email || '')}</td>
          <td>${escapeHtml(r.note || '')}</td>
        </tr>`).join('');
      res.send(shell({
        title:`History · ${shop.name}`,
        user:req.session.user,
        csrfToken:resCsrf(req),
        content:`
<h1 class="h1">History – ${escapeHtml(shop.name)}</h1>
<div class="row">
  <a class="btn btn-primary" href="/shops/${shopId}/daily">Neuer Daily Check</a>
  <a class="btn btn-ghost" href="/history?shop_id=${shopId}">Filter/Export</a>
</div>
<div class="card" style="margin-top:12px">
  <table class="table">
    <thead><tr><th>Datum</th><th>Item</th><th>Wert</th><th>Status</th><th>User</th><th>Notiz</th></tr></thead>
    <tbody>${table || '<tr><td colspan="6" class="muted">Keine Daten</td></tr>'}</tbody>
  </table>
</div>`
      }));
    });
  });
});

// Admin area
app.get('/admin', requireAuth, requireRole('admin'), (req,res)=>{
  db.all(`SELECT * FROM shops WHERE active=1 ORDER BY name`, (e1, shops)=>{
    if(e1){console.error(e1); flash(req,'fail','Fehler'); return res.redirect('/');}
    db.all(`SELECT id,email,role,active FROM users ORDER BY created_at DESC`, (e2, users)=>{
      if(e2){console.error(e2); flash(req,'fail','Fehler'); return res.redirect('/');}
      db.all(`SELECT user_id, shop_id FROM user_shops`, (e3, rows)=>{
        if(e3){console.error(e3); flash(req,'fail','Fehler'); return res.redirect('/');}
        const map = rows.reduce((acc,r)=>{acc[r.user_id]=acc[r.user_id]||[];acc[r.user_id].push(r.shop_id);return acc;}, {});
        res.send(viewAdmin(req,{shops,users,assignments:map}));
      });
    });
  });
});

// Create shop
app.post('/admin/shops/create', requireAuth, requireRole('admin'), (req,res)=>{
  const { name, code, address, phone } = req.body || {};
  db.run(`INSERT INTO shops(name, code, address, phone) VALUES (?,?,?,?)`, [name, code||null, address||null, phone||null], function(err){
    if(err){console.error(err); flash(req,'fail','Shop konnte nicht erstellt werden.');}
    else { flash(req,'ok','Shop erstellt.'); }
    res.redirect('/admin');
  });
});

// Delete shop
app.post('/admin/shops/:id/delete', requireAuth, requireRole('admin'), (req,res)=>{
  db.run(`DELETE FROM shops WHERE id=?`, [req.params.id], function(err){
    if(err){console.error(err); flash(req,'fail','Shop konnte nicht gelöscht werden.');}
    else { flash(req,'ok','Shop gelöscht.'); }
    res.redirect('/admin');
  });
});

// Shop items view
app.get('/admin/shops/:id', requireAuth, requireRole('admin'), (req,res)=>{
  const id = Number(req.params.id);
  db.get(`SELECT * FROM shops WHERE id=?`, [id], (e1, shop)=>{
    if(e1 || !shop){ flash(req,'fail','Shop nicht gefunden'); return res.redirect('/admin');}
    db.all(`SELECT * FROM check_items WHERE shop_id=? ORDER BY sort_order, id`, [id], (e2, items)=>{
      if(e2){console.error(e2); flash(req,'fail','Fehler'); return res.redirect('/admin');}
      res.send(viewShopItems(req, shop, items));
    });
  });
});

// Create item
app.post('/admin/shops/:id/items/create', requireAuth, requireRole('admin'), (req,res)=>{
  const id = Number(req.params.id);
  const { name, type, unit, min_value, max_value, sort_order } = req.body || {};
  const min = (min_value===''||min_value==null)?null:Number(min_value);
  const max = (max_value===''||max_value==null)?null:Number(max_value);
  db.run(`
    INSERT INTO check_items(shop_id, name, unit, type, min_value, max_value, sort_order)
    VALUES (?,?,?,?,?,?,?)
  `, [id, name, unit||null, type||'number', min, max, Number(sort_order||0)], function(err){
    if(err){console.error(err); flash(req,'fail','Item konnte nicht erstellt werden.');}
    else { flash(req,'ok','Item hinzugefügt.'); }
    res.redirect(`/admin/shops/${id}`);
  });
});

// Delete item
app.post('/admin/shops/:shopId/items/:itemId/delete', requireAuth, requireRole('admin'), (req,res)=>{
  db.run(`DELETE FROM check_items WHERE id=? AND shop_id=?`, [req.params.itemId, req.params.shopId], function(err){
    if(err){console.error(err); flash(req,'fail','Item konnte nicht gelöscht werden.');}
    else { flash(req,'ok','Item gelöscht.'); }
    res.redirect(`/admin/shops/${req.params.shopId}`);
  });
});

// Create user
app.post('/admin/users/create', requireAuth, requireRole('admin'), async (req,res)=>{
  const { email, role, password, shop_id } = req.body || {};
  try{
    const hash = await bcrypt.hash(String(password), 10);
    db.run(`INSERT INTO users(email, password_hash, role) VALUES (?,?,?)`, [email, hash, role], function(e1){
      if(e1){console.error(e1); flash(req,'fail','User existiert evtl. schon.'); return res.redirect('/admin');}
      const uid = this.lastID;
      db.run(`INSERT INTO user_shops(user_id, shop_id) VALUES (?,?)`, [uid, shop_id], function(e2){
        if(e2){console.error(e2); flash(req,'warn','User erstellt, aber Shopzuweisung fehlgeschlagen.');}
        else { flash(req,'ok','User erstellt und zugewiesen.'); }
        res.redirect('/admin');
      });
    });
  }catch(e){console.error(e); flash(req,'fail','Fehler'); res.redirect('/admin');}
});

// Assign user to another shop
app.post('/admin/users/assign', requireAuth, requireRole('admin'), (req,res)=>{
  const { user_id, shop_id } = req.body || {};
  db.run(`INSERT OR IGNORE INTO user_shops(user_id, shop_id) VALUES (?,?)`, [user_id, shop_id], function(err){
    if(err){console.error(err); flash(req,'fail','Zuweisung fehlgeschlagen.');}
    else { flash(req,'ok','Zugewiesen.'); }
    res.redirect('/admin');
  });
});

// Toggle user active
app.post('/admin/users/:id/toggle', requireAuth, requireRole('admin'), (req,res)=>{
  db.run(`UPDATE users SET active = 1 - active WHERE id=?`, [req.params.id], function(err){
    if(err){console.error(err); flash(req,'fail','Konnte Status nicht ändern.');}
    else { flash(req,'ok','Status geändert.'); }
    res.redirect('/admin');
  });
});

// Reset user password
app.post('/admin/users/:id/reset', requireAuth, requireRole('admin'), async (req,res)=>{
  const newHash = await bcrypt.hash('Reset!123', 10);
  db.run(`UPDATE users SET password_hash=? WHERE id=?`, [newHash, req.params.id], function(err){
    if(err){console.error(err); flash(req,'fail','PW-Reset fehlgeschlagen.');}
    else { flash(req,'ok','Passwort zurückgesetzt: Reset!123'); }
    res.redirect('/admin');
  });
});

// Delete user
app.post('/admin/users/:id/delete', requireAuth, requireRole('admin'), (req,res)=>{
  db.run(`DELETE FROM users WHERE id=?`, [req.params.id], function(err){
    if(err){console.error(err); flash(req,'fail','User konnte nicht gelöscht werden.');}
    else { flash(req,'ok','User gelöscht.'); }
    res.redirect('/admin');
  });
});

// Legal
app.get('/impressum',(req,res)=>res.send(viewImpressum(req)));
app.get('/datenschutz',(req,res)=>res.send(viewDatenschutz(req)));

// 404
app.use((req,res)=>{
  res.status(404).send(shell({
    title:'404',
    user:req.session.user,
    csrfToken:resCsrf(req),
    content:`<div class="card"><div class="h2">404 – Seite nicht gefunden</div><p><a class="btn btn-ghost" href="/">Zur Startseite</a></p></div>`
  }));
});

// 500
app.use((err, req, res, _next)=>{
  console.error('❌ Error:', err);
  res.status(500).send(shell({
    title:'Fehler',
    user:req.session.user,
    csrfToken:resCsrf(req),
    content:`<div class="card"><div class="h2">Oops – ein Fehler ist aufgetreten</div><pre style="white-space:pre-wrap">${escapeHtml(err?.message||String(err))}</pre></div>`
  }));
});

// ------------------------- Server --------------------------
const server = app.listen(PORT, ()=>console.log(`✅ ${APP_NAME} on http://localhost:${PORT}`));
function shutdown(signal){console.log(`\\n${signal} received. Shutting down...`);server.close(()=>{console.log('HTTP server closed.');process.exit(0);});}
['SIGINT','SIGTERM'].forEach(s=>process.on(s,()=>shutdown(s)));
process.on('unhandledRejection',err=>console.error('UNHANDLED REJECTION:',err));
process.on('uncaughtException',err=>console.error('UNCAUGHT EXCEPTION:',err));
