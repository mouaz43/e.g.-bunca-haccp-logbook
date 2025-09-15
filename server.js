/**
 * BUNCA HACCP — Single-file Production App
 * ----------------------------------------
 * Features:
 *  - Auth with roles (admin, worker), bcrypt passwords, sessions (SQLite store)
 *  - Admin: manage shops, users, assign users to shops, define daily check items per shop
 *  - Worker: submit daily checks for assigned shops
 *  - History with filters + CSV export
 *  - HACCP Info page
 *  - Security: helmet, rate-limit, CORS, CSRF
 *  - Deploys on Render (PORT binding, /healthz)
 *
 * IMPORTANT:
 *  - Default seed (first boot): admin@bunca.de / Admin!123  (can be overridden by ENV bootstrap)
 *  - ENV bootstrap (preferred): set ADMIN_EMAIL and ADMIN_PASSWORD (and optional ADMIN_ROLE, ADMIN_ASSIGN_SHOP_CODE)
 *  - SQLite DB at ./data/bunca.db
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

// Admin bootstrap via ENV
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_ROLE = (process.env.ADMIN_ROLE || 'admin').toLowerCase() === 'worker' ? 'worker' : 'admin';
const ADMIN_ASSIGN_SHOP_CODE = process.env.ADMIN_ASSIGN_SHOP_CODE || 'CITY';

// Paths
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'bunca.db');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ------------------------- DB ------------------------------
const db = new sqlite3.Database(DB_PATH);

// Run schema + seeds
db.serialize(() => {
  db.run(`PRAGMA foreign_keys = ON;`);

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

  db.run(`
    CREATE TABLE IF NOT EXISTS user_shops (
      user_id INTEGER NOT NULL,
      shop_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, shop_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS check_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT,
      type TEXT NOT NULL DEFAULT 'number',   -- 'number' | 'text'
      min_value REAL,
      max_value REAL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      date TEXT NOT NULL,                    -- YYYY-MM-DD
      value_number REAL,
      value_text TEXT,
      status TEXT NOT NULL,                  -- ok | warn | fail
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (item_id) REFERENCES check_items(id) ON DELETE CASCADE
    );
  `);

  // Seed a demo shop + default items (only if no shops exist)
  db.get(`SELECT COUNT(*) AS c FROM shops`, (err, row) => {
    if (err) { console.error('DB seed(shops) error:', err); return; }
    if (row.c === 0) {
      db.run(`INSERT INTO shops(name, code, address, phone) VALUES (?,?,?,?)`,
        ['BUNCA City', 'CITY', 'Musterstraße 1, 60311 Frankfurt', '+49 69 000000'],
        function seedItemsCb() {
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
          console.log('✅ Seeded example shop & items');
        }
      );
    }
  });

  // Seed default admin only if there are no users (first boot)
  db.get(`SELECT COUNT(*) AS c FROM users`, async (err, row) => {
    if (err) { console.error('DB seed(users) error:', err); return; }
    if (row.c === 0) {
      const hash = await bcrypt.hash('Admin!123', 10);
      db.run(`INSERT INTO users(email, password_hash, role) VALUES (?,?,?)`,
        ['admin@bunca.de', hash, 'admin']);
      console.log('✅ Seeded fallback admin: admin@bunca.de / Admin!123');
    }
    // After seeding, run ENV bootstrap (preferred)
    bootstrapAdminFromEnv();
  });
});

// ---- ENV-based admin/user bootstrap -----------------------
async function bootstrapAdminFromEnv() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('ℹ️ ADMIN_EMAIL/ADMIN_PASSWORD not set — skipping admin bootstrap.');
    return;
  }
  try {
    const hash = await bcrypt.hash(String(ADMIN_PASSWORD), 10);

    // Ensure shop by code (create if missing)
    function ensureShopByCode(code, cb) {
      db.get(`SELECT * FROM shops WHERE code = ?`, [code], (e, s) => {
        if (e) return cb(e);
        if (s) return cb(null, s);
        db.run(`INSERT INTO shops(name, code) VALUES (?,?)`, [code, code], function(err){
          if (err) return cb(err);
          cb(null, { id: this.lastID, name: code, code });
        });
      });
    }

    // Upsert user
    db.get(`SELECT * FROM users WHERE email = ?`, [ADMIN_EMAIL], (e1, user) => {
      if (e1) { console.error('Admin bootstrap lookup failed:', e1); return; }

      const finalizeAssign = (uid, shopId) => {
        db.run(`INSERT OR IGNORE INTO user_shops(user_id, shop_id) VALUES (?,?)`, [uid, shopId], (eA) => {
          if (eA) console.error('Admin shop assignment failed:', eA);
          else console.log(`✅ Admin bootstrap: ${ADMIN_EMAIL} (${ADMIN_ROLE}) assigned to shop code ${ADMIN_ASSIGN_SHOP_CODE}`);
        });
      };

      ensureShopByCode(ADMIN_ASSIGN_SHOP_CODE, (eShop, shop) => {
        if (eShop) { console.error('Admin bootstrap shop ensure failed:', eShop); return; }

        if (!user) {
          // Create
          db.run(`INSERT INTO users(email, password_hash, role, active) VALUES (?,?,?,1)`,
            [ADMIN_EMAIL, hash, ADMIN_ROLE], function(e2){
              if (e2) { console.error('Admin bootstrap create failed:', e2); return; }
              console.log(`✅ Admin bootstrap: created ${ADMIN_EMAIL} (${ADMIN_ROLE})`);
              finalizeAssign(this.lastID, shop.id);
            });
        } else {
          // Update password/role/active
          db.run(`UPDATE users SET password_hash=?, role=?, active=1 WHERE id=?`,
            [hash, ADMIN_ROLE, user.id], (e3) => {
              if (e3) { console.error('Admin bootstrap update failed:', e3); return; }
              console.log(`✅ Admin bootstrap: updated ${ADMIN_EMAIL} (${ADMIN_ROLE})`);
              finalizeAssign(user.id, shop.id);
            });
        }
      });
    });
  } catch (e) {
    console.error('Admin bootstrap error:', e);
  }
}

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

// CSRF (session-based)
const csrfProtection = csrf();
app.use(csrfProtection);

// Flash helper via session
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
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

function evalStatus(value, min, max) {
  if (value === null || value === undefined || value === '') return 'warn';
  if (typeof value === 'number' && (min != null || max != null)) {
    if (min != null && value < min) return 'fail';
    if (max != null && value > max) return 'fail';
    return 'ok';
  }
  return 'ok';
}

// ------------------------- UI (CSS/JS) ---------------------
const CSS = String.raw`
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

// tiny client JS
const JS = String.raw`(function(){'use strict';const t=document.querySelectorAll('[data-autosubmit]');t.forEach(f=>f.addEventListener('change',()=>f.submit()));})();`;

// ------------------------- Template helpers ----------------
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
function renderFlash(){const arr=globalThis.__flash__||[];if(!arr.length)return'';return arr.map(f=>`<div class="flash ${f.type}">${escapeHtml(f.msg)}</div>`).join('');}
app.use((req,res,next)=>{globalThis.__flash__=res.locals.flash||[];next();});
function resCsrf(req){return req.csrfToken();}

// ------------------------- Views ---------------------------
// (unchanged views from previous message — trimmed for brevity in this header)
// Home
function viewHome(req, shopsForUser = []) {
  const adminView = isAdmin(req);
  const intro = adminView
    ? `<h1 class="h1">Willkommen, Admin</h1>
       <p class="lead">Erstelle Shops, weise Mitarbeiter zu und definiere tägliche Checkpunkte. Danach siehst du alles in der History.</p>
       <div class="row">
         <a class="btn btn-primary" href="/admin">Zum Admin-Bereich</a>
         <a class="btn btn-ghost" href="/history">History</a>
       </div>`
    : `<h1 class="h1">Tägliche Checks</h1><p class="lead">Wähle deinen Shop und fülle die täglichen Checks aus.</p>`;

  const cards = shopsForUser.length
    ? `<div class="grid-3">`+shopsForUser.map(s=>`
        <div class="card"><div class="h2">${escapeHtml(s.name)}</div>
          <p class="muted">${escapeHtml(s.address||'')}</p>
          <div class="row">
            <a class="btn btn-primary" href="/shops/${s.id}/daily">Daily Check</a>
            <a class="btn btn-ghost" href="/shops/${s.id}/history">History</a>
          </div>
        </div>`).join('')+`</div>`
    : `<div class="card"><p class="muted">Noch keine Shops zugewiesen.</p></div>`;

  return shell({
    title:'Start',
    user:req.session.user,
    csrfToken:resCsrf(req),
    content:`<section class="hero"><div class="grid-2"><div>${intro}</div>
      <div class="card"><div class="h2">HACCP in BUNCA</div>
        <p class="muted">Standardisierte Daily Checks (Kühlschrank, Ofen, Espressomaschine, Espresso-Temperatur, Bohnen, Spülmaschine) plus eigene Punkte pro Shop.</p>
        <div class="row"><span class="chip">🔐 DSGVO</span><span class="chip">📦 CSV-Export</span><span class="chip">💼 Rollen</span></div>
      </div></div></section>${cards}`
  });
}
function viewLogin(req){
  return shell({
    title:'Login',
    user:req.session.user,
    csrfToken:resCsrf(req),
    content:`<div class="grid-2"><div><h1 class="h1">Anmelden</h1></div>
    <div class="card" style="max-width:520px">
      <form class="form" method="post" action="/login">
        <input type="hidden" name="_csrf" value="${resCsrf(req)}">
        <label><span>E-Mail</span><input class="input" name="email" type="email" required></label>
        <label><span>Passwort</span><input class="input" name="password" type="password" required></label>
        <button class="btn btn-primary" type="submit">Login</button>
      </form>
      <p class="muted" style="margin-top:8px">ENV-Admin aktiv, falls gesetzt.</p>
    </div></div>`
  });
}
function viewInfo(req){
  return shell({title:'HACCP Info',user:req.session.user,csrfToken:resCsrf(req),content:`<div class="grid-2">
  <div class="card"><div class="h2">HACCP – Basics</div>
    <ul><li>Kühlkette & Lagertemperaturen</li><li>Zubereitung</li><li>Reinigung</li><li>Schulung</li></ul></div>
  <div class="card"><div class="h2">Wie BUNCA hilft</div>
    <ul><li>Daily Checks je Shop</li><li>Grenzwerte → Status</li><li>History + CSV</li></ul></div></div>`});
}
function viewImpressum(req){return shell({title:'Impressum',user:req.session.user,csrfToken:resCsrf(req),content:`<div class="card"><div class="h2">Impressum</div><p>BUNCA Coffee GmbH – Musterstraße 1, 60311 Frankfurt.</p></div>`})}
function viewDatenschutz(req){return shell({title:'Datenschutz',user:req.session.user,csrfToken:resCsrf(req),content:`<div class="card"><div class="h2">Datenschutz</div><p class="muted">Datenverarbeitung nur für Auth & Checks.</p></div>`})}

// Admin shop items view and others are identical to the previous version (for space).
// --- For completeness, keep ALL routes and logic exactly as provided earlier. ---

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
  if (isAdmin(req)) {
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

// Info, History, Shop daily/history, Admin CRUD
// ---- KEEP the same route implementations from the previous file ----
// (To keep this message readable, I’m not repeating those 400+ lines here.)
// You already have them; only bootstrap + CSRF handler changed.
// If you lost them, tell me and I’ll repost the full file again verbatim.

// ------------------------- CSRF Error Handler --------------
app.use((err, req, res, next) => {
  if (err && err.code === 'EBADCSRFTOKEN') {
    // Token missing/expired/mismatched — show a friendly page.
    flash(req, 'fail', 'Sicherheits-Token war ungültig oder abgelaufen. Bitte Seite neu laden und erneut senden.');
    return res.status(403).send(shell({
      title: 'Fehler',
      user: req.session.user,
      csrfToken: resCsrf(req),
      content: `<div class="card"><div class="h2">Oops – ein Fehler ist aufgetreten</div><p class="muted">Bitte die Seite neu laden. Wenn das Problem weiter besteht, Cookies im Browser prüfen.</p><div class="row"><a class="btn btn-primary" href="${escapeHtml(req.headers.referer || '/')}">Zurück</a></div></div>`
    }));
  }
  return next(err);
});

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
