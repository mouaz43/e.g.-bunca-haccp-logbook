/* BUNCA HACCP – Backend (DE)
 * Express + SQLite + PDFKit
 * Endpunkte passend zu den gelieferten Frontend-Seiten.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const dayjs = require('dayjs');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@bunca.de';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123'; // bitte in PROD setzen!
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'bunca.db');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* -------------------- DB & Schema -------------------- */
const db = new Database(DB_PATH);

db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  address TEXT, phone TEXT, image_url TEXT, description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT, serial TEXT
);

CREATE TABLE IF NOT EXISTS check_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  min REAL, max REAL, unit TEXT,
  equipment_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL,
  shift TEXT NOT NULL DEFAULT 'morning',
  required INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  run_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  note TEXT,
  ok_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  signed_at TEXT
);

CREATE TABLE IF NOT EXISTS check_run_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES check_items(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  equipment_id INTEGER,
  unit TEXT,
  min REAL, max REAL,
  shift TEXT,
  value TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  evidence_url TEXT
);

CREATE TABLE IF NOT EXISTS corrective_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
  item_id INTEGER,
  description TEXT NOT NULL,
  assigned_to TEXT,
  due_date TEXT,
  photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS user_shops (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, shop_id)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
`);

// Seed admin if not exists
(function seedAdmin() {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(ADMIN_EMAIL);
  if (!row) {
    const hash = bcrypt.hashSync(ADMIN_PASS, 10);
    db.prepare('INSERT INTO users (email,password_hash,role,created_at) VALUES (?,?,?,?)')
      .run(ADMIN_EMAIL, hash, 'admin', new Date().toISOString());
    console.log('[seed] Admin erstellt:', ADMIN_EMAIL);
  }
})();

/* -------------------- App Setup -------------------- */
const app = express();
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* -------------------- Session / Auth (simpel) -------------------- */
function createCsrf() { return crypto.randomBytes(16).toString('hex'); }
function authFromCookie(req) {
  const sid = req.cookies.sid;
  if (!sid) return null;
  try {
    const json = Buffer.from(sid, 'base64url').toString('utf8');
    const data = JSON.parse(json);
    if (!data || !data.user_id) return null;
    const u = db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(data.user_id);
    if (!u) return null;
    return { ...u, csrf: data.csrf };
  } catch { return null; }
}
function setSession(res, user) {
  const csrf = createCsrf();
  const token = Buffer.from(JSON.stringify({ user_id: user.id, csrf })).toString('base64url');
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', path: '/' });
  return csrf;
}
function clearSession(res) { res.clearCookie('sid', { path: '/' }); }

app.get('/api/auth/session', (req, res) => {
  const s = authFromCookie(req);
  if (!s) return res.json({ session: null });
  res.json({ session: { user_id: s.id, email: s.email, role: s.role, csrf: s.csrf } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email || '');
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return res.json({ ok: false, error: 'Invalid credentials' });
  }
  const csrf = setSession(res, u);
  res.json({ ok: true, csrf, role: u.role });
});

app.post('/api/auth/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

/* -------------------- Helpers -------------------- */
function requireRole(role) {
  return (req, res, next) => {
    const s = authFromCookie(req);
    if (!s || (role && s.role !== role)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      if ((req.headers['x-csrf-token'] || '') !== s.csrf) return res.status(403).json({ ok: false, error: 'CSRF' });
    }
    req.session = s;
    next();
  };
}
function now() { return new Date().toISOString(); }
function ymd(d = new Date()) { return d.toISOString().slice(0,10); }
function toInt(x, def = 0) { const n = Number(x); return Number.isFinite(n) ? n : def; }
function statusLabelDE(s) {
  return s === 'signed' ? 'Unterschrieben' :
         s === 'submitted' ? 'Abgesendet' :
         s === 'draft' ? 'Entwurf' :
         s === 'closed' ? 'Geschlossen' : s;
}

/* -------------------- Shops -------------------- */
app.get('/api/shops', (req, res) => {
  const rows = db.prepare('SELECT * FROM shops ORDER BY id DESC').all();
  res.json({ shops: rows });
});
app.get('/api/shops/:slug', (req, res) => {
  const s = db.prepare('SELECT * FROM shops WHERE slug = ?').get(req.params.slug);
  res.json({ shop: s || null });
});
app.post('/api/shops', requireRole('admin'), (req, res) => {
  const { name, slug, status='open', address='', phone='', image_url='', description='' } = req.body || {};
  try {
    const info = db.prepare('INSERT INTO shops (name,slug,status,address,phone,image_url,description,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(name, slug, status, address, phone, image_url, description, now());
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete('/api/shops/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM shops WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* -------------------- Users -------------------- */
app.get('/api/users', requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT id,email,role,created_at FROM users ORDER BY id DESC').all();
  res.json({ users: rows });
});
app.post('/api/users', requireRole('admin'), (req, res) => {
  const { email, password, role='staff' } = req.body || {};
  try {
    const hash = bcrypt.hashSync(password || 'changeme', 10);
    const info = db.prepare('INSERT INTO users (email,password_hash,role,created_at) VALUES (?,?,?,?)')
      .run(email, hash, role, now());
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) { res.json({ ok:false, error: e.message }); }
});
app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/users/:id/assign-shops', requireRole('admin'), (req, res) => {
  const { shop_ids = [] } = req.body || {};
  const tx = db.transaction((uids) => {
    db.prepare('DELETE FROM user_shops WHERE user_id = ?').run(req.params.id);
    for (const sid of (uids || [])) {
      db.prepare('INSERT OR IGNORE INTO user_shops (user_id,shop_id) VALUES (?,?)').run(req.params.id, sid);
    }
  });
  tx(shop_ids);
  res.json({ ok: true });
});

/* -------------------- Equipment -------------------- */
app.get('/api/equipment', (req, res) => {
  let shop_id = req.query.shop_id;
  if (!shop_id && req.query.shop) {
    const s = db.prepare('SELECT id FROM shops WHERE slug = ?').get(req.query.shop);
    shop_id = s?.id;
  }
  const rows = db.prepare('SELECT * FROM equipment WHERE (? IS NULL OR shop_id = ?) ORDER BY id DESC')
    .all(shop_id || null, shop_id || null);
  res.json({ equipment: rows });
});
app.post('/api/equipment', requireRole('admin'), (req, res) => {
  const { shop_id, name, type='', serial='' } = req.body || {};
  try {
    const info = db.prepare('INSERT INTO equipment (shop_id,name,type,serial) VALUES (?,?,?,?)')
      .run(shop_id, name, type, serial);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) { res.json({ ok:false, error: e.message }); }
});
app.delete('/api/equipment/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM equipment WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* -------------------- Checklist Items -------------------- */
app.get('/api/check-items', (req, res) => {
  let shop_id = req.query.shop_id;
  if (!shop_id && req.query.shop) {
    const s = db.prepare('SELECT id FROM shops WHERE slug = ?').get(req.query.shop);
    shop_id = s?.id;
  }
  const shift = req.query.shift;
  const rows = db.prepare(`
    SELECT * FROM check_items
    WHERE (? IS NULL OR shop_id = ?)
      AND (? IS NULL OR shift = ?)
    ORDER BY position ASC, id ASC
  `).all(shop_id || null, shop_id || null, shift || null, shift || null);
  res.json({ items: rows });
});
app.post('/api/check-items', requireRole('admin'), (req, res) => {
  const { shop_id, label, kind='text', position=0, min=null, max=null, unit=null, equipment_id=null, shift='morning', required=0 } = req.body || {};
  try {
    const info = db.prepare(`
      INSERT INTO check_items (shop_id,label,kind,position,min,max,unit,equipment_id,shift,required)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(shop_id, label, kind, toInt(position), min, max, unit, equipment_id, shift, toInt(required));
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) { res.json({ ok:false, error: e.message }); }
});
app.put('/api/check-items/:id', requireRole('admin'), (req, res) => {
  const { position } = req.body || {};
  db.prepare('UPDATE check_items SET position = ? WHERE id = ?').run(toInt(position,0), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/check-items/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM check_items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/checklists/duplicate', requireRole('admin'), (req, res) => {
  const { from_shop_id, to_shop_id } = req.body || {};
  const items = db.prepare('SELECT * FROM check_items WHERE shop_id = ?').all(from_shop_id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM check_items WHERE shop_id = ?').run(to_shop_id);
    for (const i of items) {
      db.prepare(`
        INSERT INTO check_items (shop_id,label,kind,position,min,max,unit,equipment_id,shift,required)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(to_shop_id, i.label, i.kind, i.position, i.min, i.max, i.unit, i.equipment_id, i.shift, i.required);
    }
  });
  tx();
  res.json({ ok: true });
});

/* -------------------- Check Runs -------------------- */
function getShopIdBySlug(slug) {
  const s = db.prepare('SELECT id FROM shops WHERE slug = ?').get(slug);
  return s?.id || null;
}

app.get('/api/check-runs', async (req, res) => {
  const slug = req.query.shop;
  const shop_id = slug ? getShopIdBySlug(slug) : null;
  const from = req.query.from || '0000-01-01';
  const to = req.query.to || '9999-12-31';
  const status = req.query.status;

  const rows = db.prepare(`
    SELECT id, shop_id, run_date, status, note, ok_count, fail_count, created_at, signed_at
    FROM check_runs
    WHERE (? IS NULL OR shop_id = ?)
      AND run_date >= ? AND run_date <= ?
      AND (? IS NULL OR status = ?)
    ORDER BY created_at DESC
  `).all(shop_id || null, shop_id || null, from, to, status || null, status || null);

  res.json({ runs: rows });
});

app.get('/api/check-runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM check_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.json({ run: null });
  const answers = db.prepare(`
    SELECT a.*, e.name AS equipment_name
    FROM check_run_answers a
    LEFT JOIN equipment e ON e.id = a.equipment_id
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(run.id);
  const actions = db.prepare('SELECT * FROM corrective_actions WHERE run_id = ? ORDER BY id ASC').all(run.id);
  res.json({ run, answers, actions });
});

app.post('/api/check-runs', requireRole(), (req, res) => {
  const { shop_slug, answers = [], note = '', status = 'submitted' } = req.body || {};
  const shop_id = getShopIdBySlug(shop_slug);
  if (!shop_id) return res.json({ ok:false, error:'Filiale nicht gefunden' });

  const id = crypto.randomUUID();
  const run_date = ymd(new Date());
  let ok_count = 0, fail_count = 0;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO check_runs (id,shop_id,run_date,status,note,ok_count,fail_count,created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, shop_id, run_date, status, note, 0, 0, now());

    for (const a of answers) {
      const item = db.prepare('SELECT * FROM check_items WHERE id = ?').get(a.item_id);
      if (!item) continue;
      const kind = item.kind;
      const unit = item.unit;
      const min = item.min;
      const max = item.max;
      const shift = item.shift;
      const equipment_id = item.equipment_id || null;

      let ok = 1;
      if (kind === 'boolean') {
        const v = String(a.value || '').toLowerCase();
        ok = (v === 'true' || v === '1' || v === 'yes' || v === 'ja') ? 1 : 0;
      } else if (kind === 'number' || kind === 'temperature') {
        const n = Number(a.value);
        if (!Number.isFinite(n)) ok = 0;
        if (min !== null && n < Number(min)) ok = 0;
        if (max !== null && n > Number(max)) ok = 0;
      } else {
        ok = String(a.value || '').trim().length > 0 ? 1 : 0;
      }
      if (ok) ok_count++; else fail_count++;

      db.prepare(`
        INSERT INTO check_run_answers (run_id,item_id,label,kind,equipment_id,unit,min,max,shift,value,ok,evidence_url)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, item.id, item.label, kind, equipment_id, unit, min, max, shift, String(a.value ?? ''), ok, a.evidence_url || null);

      if (a.corrective && !ok) {
        db.prepare(`
          INSERT INTO corrective_actions (run_id,item_id,description,assigned_to,due_date,photo_url,status)
          VALUES (?,?,?,?,?,?,?)
        `).run(id, item.id, a.corrective.description, a.corrective.assigned_to || null, a.corrective.due_date || null, a.corrective.photo_url || null, 'open');
      }
    }

    db.prepare('UPDATE check_runs SET ok_count=?, fail_count=? WHERE id = ?').run(ok_count, fail_count, id);
  });

  tx();
  res.json({ ok: true, run_id: id });
});

app.post('/api/check-runs/:id/sign', requireRole(), (req, res) => {
  const { password } = req.body || {};
  // Einfachheit: Prüfe nur, ob Session-User existiert; optional Passwort checken
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.id);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return res.json({ ok:false, error:'Passwort ungültig' });
  }
  db.prepare('UPDATE check_runs SET status="signed", signed_at = ? WHERE id = ?').run(now(), req.params.id);
  res.json({ ok: true });
});

/* -------------------- Dashboard -------------------- */
app.get('/api/dashboard', (req, res) => {
  const slug = req.query.shop;
  const shop_id = slug ? getShopIdBySlug(slug) : null;
  const total = db.prepare(`
    SELECT COUNT(*) AS runs,
           SUM(CASE WHEN status='signed' THEN 1 ELSE 0 END) AS signed
    FROM check_runs WHERE (? IS NULL OR shop_id = ?)
  `).get(shop_id || null, shop_id || null);
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
    const r = db.prepare('SELECT SUM(fail_count) AS issues FROM check_runs WHERE run_date = ? AND (? IS NULL OR shop_id = ?)')
      .get(d, shop_id || null, shop_id || null);
    last7.push({ run_date: d, issues: r.issues || 0 });
  }
  res.json({ totals: total, last7 });
});

/* -------------------- CSV Export -------------------- */
app.get('/api/export/csv', (req, res) => {
  const slug = req.query.shop; const shop_id = slug ? getShopIdBySlug(slug) : null;
  const from = req.query.from || '0000-01-01';
  const to = req.query.to || '9999-12-31';
  const status = req.query.status;

  const runs = db.prepare(`
    SELECT * FROM check_runs
    WHERE (? IS NULL OR shop_id = ?)
      AND run_date >= ? AND run_date <= ?
      AND (? IS NULL OR status = ?)
    ORDER BY created_at DESC
  `).all(shop_id || null, shop_id || null, from, to, status || null, status || null);

  let csv = 'Datum;Status;OK;Probleme;Notiz\n';
  for (const r of runs) {
    const note = (r.note || '').replace(/\r?\n/g,' ').replace(/;/g, ',');
    csv += `${r.run_date};${statusLabelDE(r.status)};${r.ok_count};${r.fail_count};${note}\n`;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bunca-verlauf-${slug || 'alle'}.csv"`);
  res.send(csv);
});

/* -------------------- PDF Export (DE) -------------------- */
app.get('/api/export/pdf', async (req, res) => {
  const run_id = req.query.run_id;
  if (!run_id) return res.status(400).send('run_id erforderlich');

  const run = db.prepare('SELECT * FROM check_runs WHERE id = ?').get(run_id);
  if (!run) return res.status(404).send('Lauf nicht gefunden');

  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(run.shop_id);
  const answers = db.prepare(`
    SELECT a.*, e.name AS equipment_name
    FROM check_run_answers a
    LEFT JOIN equipment e ON e.id = a.equipment_id
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(run_id);
  const actions = db.prepare('SELECT * FROM corrective_actions WHERE run_id = ? ORDER BY id ASC').all(run_id);

  // Gruppieren nach Gerät
  const groups = {};
  for (const a of answers) {
    const key = a.equipment_id ? (a.equipment_name || 'Gerät') : 'Allgemein';
    groups[key] = groups[key] || [];
    groups[key].push(a);
  }

  // PDF aufsetzen
  const fileName = `bunca-haccp-${shop?.slug || 'filiale'}-${run.run_date}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: fileName } });
  doc.pipe(res);

  // Kopfbereich
  doc
    .fillColor('#111827')
    .fontSize(20).font('Helvetica-Bold').text('BUNCA HACCP', { continued: false })
    .moveDown(0.2)
    .fontSize(12).font('Helvetica')
    .text(`Filiale: ${shop?.name || '-'} (${shop?.slug || '-'})`)
    .text(`Datum: ${run.run_date}`)
    .text(`Status: ${statusLabelDE(run.status)}`)
    .text(`Unterschrieben am: ${run.signed_at ? dayjs(run.signed_at).format('YYYY-MM-DD HH:mm') : '—'}`)
    .moveDown(0.5)
    .text(`Notizen: ${run.note || '—'}`)
    .moveDown(0.6);

  // Trenner
  doc.moveTo(doc.x, doc.y).lineTo(559, doc.y).strokeColor('#e5e7eb').lineWidth(1).stroke();
  doc.moveDown(0.6);

  // Gruppen rendern
  const labelRow = (l, r, colW) => {
    doc.font('Helvetica-Bold').text(l, { continued: true, width: colW });
    doc.font('Helvetica').text(r);
  };

  const tableHeader = () => {
    doc
      .font('Helvetica-Bold')
      .fillColor('#111827')
      .text('Eintrag',  { width: 190 })
      .text('Wert',     { width: 120, continued: true })
      .text('Ziel',     { width: 120, continued: true })
      .text('Status',   { width: 80 });
    doc.moveDown(0.2);
    doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor('#e5e7eb').lineWidth(1).stroke();
    doc.moveDown(0.4);
  };

  Object.entries(groups).forEach(([gname, arr], gi) => {
    if (gi > 0) doc.addPage();

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#111827').text(gname);
    doc.moveDown(0.3);
    tableHeader();
    doc.fontSize(11).font('Helvetica').fillColor('#111827');

    for (const a of arr) {
      const target = (a.kind === 'temperature' || a.kind === 'number')
        ? `${a.min != null ? a.min : ''}${(a.min != null || a.max != null) ? '–' : ''}${a.max != null ? a.max : ''} ${a.unit || ''}`.trim()
        : '—';
      const value = `${a.value}${a.kind === 'temperature' ? ` ${a.unit || ''}` : ''}`;
      const status = a.ok ? 'OK' : 'Problem';

      // Zeile
      const yBefore = doc.y;
      doc.text(a.label,     { width: 190 });
      doc.y = yBefore; doc.x = 36 + 190; doc.text(value,    { width: 120 });
      doc.y = yBefore; doc.x = 36 + 190 + 120; doc.text(target || '—', { width: 120 });
      doc.y = yBefore; doc.x = 36 + 190 + 120 + 120; doc.text(status,  { width: 80 });
      doc.moveDown(0.2);

      // Korrekturmaßnahme für diesen Eintrag?
      const ca = actions.find(c => c.item_id === a.item_id);
      if (ca) {
        doc.fillColor('#6b7280').fontSize(10);
        doc.text(`• Korrekturmaßnahme: ${ca.description}`, { width: 500 });
        const meta = `   Zuständig: ${ca.assigned_to || '—'} · Fällig: ${ca.due_date || '—'}${ca.photo_url ? ` · Foto: ${ca.photo_url}` : ''}`;
        doc.text(meta, { width: 500 });
        doc.fillColor('#111827').fontSize(11);
      }

      // dünne Linie
      doc.moveDown(0.2);
      doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor('#f3f4f6').lineWidth(1).stroke();
      doc.moveDown(0.2);
    }
  });

  // Fuß
  doc.moveDown(0.6);
  doc.fontSize(10).fillColor('#6b7280').text('© BUNCA HACCP · Automatisch erzeugter Bericht', { align: 'left' });

  doc.end();
});

/* -------------------- Audit -------------------- */
app.get('/api/audit', requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all();
  res.json({ items: rows });
});

/* -------------------- Upload “Presign” (lokal) -------------------- */
/* Frontend ruft /api/uploads/sign auf und bekommt eine PUT-URL zurück,
 * wir speichern die Datei lokal in /uploads, damit Fotos in PDFs verlinkt werden können.
 */
app.post('/api/uploads/sign', requireRole(), (req, res) => {
  const { type='image/jpeg' } = req.body || {};
  const key = `${crypto.randomUUID()}.${(type.split('/')[1] || 'bin')}`;
  const url = `/uploads/${key}`;
  res.json({ ok: true, url, key: url });
});

// Lokaler PUT-Upload
const upload = multer({ storage: multer.memoryStorage() });
app.put('/uploads/:key', upload.single('file'), (req, res) => {
  const data = req.body && Object.keys(req.body).length ? Buffer.from('') : req.file?.buffer || req;
  // Wenn via fetch(..., body: file) ohne multipart: req ist ein stream; einfacher Weg:
  const out = fs.createWriteStream(path.join(UPLOAD_DIR, req.params.key), { flags: 'w' });
  req.pipe(out);
  req.on('end', () => res.status(200).end());
  req.on('error', () => res.status(500).end());
});

/* -------------------- Start -------------------- */
app.listen(PORT, () => {
  console.log(`BUNCA HACCP server running on http://localhost:${PORT}`);
});
