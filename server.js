/* Bunca HACCP Logbook — TailAdmin-Style, DE (Render-ready)
   Tech: Node 18+, Express, better-sqlite3, bcrypt, cookie-session, Helmet, Tailwind CDN
   Features v0.2:
   - Multi-Shop Accounts, "Eingeloggt bleiben" (7/30 Tage)
   - Seiten: Dashboard, Temperaturen, Wareneingang, Reinigung, Exporte, Einstellungen
   - Geräteverwaltung, Tagesmessungen (Abweichung + Maßnahme), Lieferungen, Reinigung
   - CSV-Export pro Datum
   Render extras:
   - DB path from env DB_FILE (use /var/data on Render persistent disk)
   - trust proxy + secure cookies in production
   - optional DISABLE_PUBLIC_REGISTRATION=true after first admin created
*/
import express from "express";
import helmet from "helmet";
import session from "cookie-session";
import bcrypt from "bcrypt";
import Database from "better-sqlite3";
import { randomUUID } from "uuid";

// ====== Config ======
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const COOKIE_NAME = "bunca_sess";
const DB_FILE = process.env.DB_FILE || "bunca-haccp.db";
const REG_LOCK = (process.env.DISABLE_PUBLIC_REGISTRATION || "").toLowerCase() === "true";

const app = express();
app.disable("x-powered-by");
// running behind Render proxy → needed for secure cookies to work
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'", "https://cdn.tailwindcss.com", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"]
    }
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  name: COOKIE_NAME,
  secret: SESSION_SECRET,
  sameSite: "lax",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production", // secure cookie on Render
  maxAge: 1000 * 60 * 60 * 24 * 7                 // 7 days default
}));

// ===== DB =====
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  shop_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- 'kuehl' | 'tk' | 'heiss'
  target_min REAL,
  target_max REAL,
  unit TEXT DEFAULT '°C',
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temp_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  measured_c REAL NOT NULL,
  status TEXT NOT NULL,          -- 'ok' | 'abweichung'
  correction TEXT,
  note TEXT,
  measured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  supplier TEXT NOT NULL,
  item TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  temp_type TEXT,                -- 'gekuehlt' | 'tk' | 'ambient'
  measured_temp REAL,
  best_before TEXT,
  issue TEXT,                    -- 'ok' | 'fehlend' | 'beschaedigt' | 'falsch_temp' | 'sonstiges'
  correction TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS cleaning_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  section TEXT,
  frequency TEXT NOT NULL,       -- 'taeglich' | 'woechentlich'
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cleaning_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  done_at TEXT NOT NULL,
  initials TEXT NOT NULL,
  note TEXT
);
`);

const nowISO = () => new Date().toISOString();
const todayStr = (d = new Date()) => d.toISOString().slice(0,10);

// ===== Helpers =====
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect("/login");
  next();
}
function userByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
}
function userById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}
function usersCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}
function createUser({ shop_name, email, password_hash }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO users (id, shop_name, email, password_hash, created_at)
              VALUES (@id,@shop_name,@email,@password_hash,@created_at)`)
    .run({ id, shop_name, email, password_hash, created_at: nowISO() });
  seedDefaults(id);
  return userById(id);
}
function seedDefaults(user_id) {
  const addDev = db.prepare(`INSERT INTO devices
    (id,user_id,name,type,target_min,target_max,unit,active,created_at)
    VALUES (@id,@user_id,@name,@type,@target_min,@target_max,'°C',1,@created_at)`);
  [
    { name:"Kühlschrank Theke", type:"kuehl", target_min:0, target_max:7 },
    { name:"Milch-Kühlschrank Bar", type:"kuehl", target_min:0, target_max:7 },
    { name:"Lager-Kühlschrank", type:"kuehl", target_min:0, target_max:7 },
    { name:"Tiefkühler", type:"tk", target_min:-25, target_max:-18 },
    { name:"Heißhaltung", type:"heiss", target_min:60, target_max:120 }
  ].forEach(d => addDev.run({ id: randomUUID(), user_id, ...d, created_at: nowISO() }));

  const addTask = db.prepare(`INSERT INTO cleaning_tasks
    (id,user_id,title,section,frequency,active,created_at)
    VALUES (@id,@user_id,@title,@section,@frequency,1,@created_at)`);
  [
    { title:"Theke & Arbeitsflächen reinigen", section:"Bar", frequency:"taeglich" },
    { title:"Mühlen & Siebträger reinigen", section:"Bar", frequency:"taeglich" },
    { title:"Milchsystem spülen/reinigen", section:"Bar", frequency:"taeglich" },
    { title:"Boden gründlich reinigen", section:"Allgemein", frequency:"taeglich" },
    { title:"Kühlgeräte-Dichtungen wischen", section:"Kühlung", frequency:"woechentlich" }
  ].forEach(t => addTask.run({ id: randomUUID(), user_id, ...t, created_at: nowISO() }));
}

// ===== Layout (TailAdmin-like) =====
const baseHead = (title = "BUNCA HACCP") => `
<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <meta name="description" content="BUNCA HACCP Logbuch — Multi-Filiale, sicher, modern." />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: { bunca:{ cream:'#efe7db', brown:'#3d2b1f', gold:'#c7a15a', ink:'#0f172a' } },
          borderRadius: { '2xl':'1.25rem' },
          boxShadow: { 'soft':'0 10px 25px rgba(0,0,0,0.08)' }
        }
      }
    }
  </script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
  <style>html,body{font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial}</style>
</head>
`;

const authLayout = (content, title = "Login") => `
${baseHead("BUNCA HACCP — " + title)}
<body class="min-h-screen bg-bunca-cream">
  <div class="min-h-screen grid place-items-center px-4">
    <div class="w-full max-w-md bg-white rounded-2xl shadow-soft p-6">
      <div class="flex items-center gap-3 mb-4">
        <div class="h-10 w-10 rounded-2xl bg-bunca-brown text-white grid place-items-center text-lg font-black">B</div>
        <div>
          <div class="text-bunca-brown font-extrabold tracking-wide">BUNCA — HACCP</div>
          <div class="text-sm text-bunca-brown/70">Digitales Logbuch für Café & Bäckerei</div>
        </div>
      </div>
      ${content}
      <p class="mt-6 text-xs text-bunca-brown/60">Daten werden lokal in der Filiale geführt und exportiert bei Bedarf.</p>
    </div>
  </div>
</body>
</html>
`;

const appLayout = (req, content, title = "Dashboard") => `
${baseHead("BUNCA HACCP — " + title)}
<body class="min-h-screen bg-bunca-cream">
  <div class="flex min-h-screen">
    <aside class="w-64 hidden md:block bg-white border-r border-black/5">
      <div class="p-4 flex items-center gap-3">
        <div class="h-10 w-10 rounded-2xl bg-bunca-brown text-white grid place-items-center text-lg font-black">B</div>
        <div>
          <div class="font-extrabold text-bunca-brown">BUNCA — HACCP</div>
          <div class="text-xs text-bunca-brown/70">${req.session.user.shop_name}</div>
        </div>
      </div>
      <nav class="mt-2 px-2 space-y-1">
        <a class="block px-3 py-2 rounded-xl hover:bg-bunca-cream" href="/dashboard">Dashboard</a>
        <a class="block px-3 py-2 rounded-xl hover:bg-bunca-cream" href="/temperaturen">Temperaturen</a>
        <a class="block px-3 py-2 rounded-xl hover:bg-bunca-cream" href="/wareneingang">Wareneingang</a>
        <a class="block px-3 py-2 rounded-xl hover:bg-bunca-cream" href="/reinigung">Reinigung</a>
        <a class="block px-3 py-2 rounded-xl hover:bg-bunca-cream" href="/exporte">Exporte</a>
        <a class="block px-3 py-2 rounded-xl hover:bg-bunca-cream" href="/einstellungen">Einstellungen</a>
        <div class="pt-2 border-t border-black/5"></div>
        <a class="block px-3 py-2 rounded-xl text-red-700 hover:bg-red-50" href="/logout">Logout</a>
      </nav>
    </aside>

    <main class="flex-1">
      <header class="sticky top-0 bg-white/70 backdrop-blur border-b border-black/5">
        <div class="px-4 py-3 flex items-center justify-between">
          <div class="md:hidden font-extrabold text-bunca-brown">BUNCA — HACCP</div>
          <div class="text-sm text-bunca-brown/70">${req.session.user.email}</div>
        </div>
      </header>
      <section class="p-4 md:p-6">
        ${content}
      </section>
    </main>
  </div>
</body>
</html>
`;

// ===== Routes: Auth =====
app.get("/", (req,res)=> req.session?.user ? res.redirect("/dashboard") : res.redirect("/login"));

app.get("/login", (req,res)=>{
  if (req.session?.user) return res.redirect("/dashboard");
  res.send(authLayout(`
    <form action="/login" method="post" class="grid gap-3">
      <div><label class="block text-sm mb-1">E-Mail</label>
        <input name="email" type="email" class="w-full rounded-xl border px-3 py-2" placeholder="you@bunca.de" required></div>
      <div><label class="block text-sm mb-1">Passwort</label>
        <input name="password" type="password" class="w-full rounded-xl border px-3 py-2" required></div>
      <label class="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" name="remember" value="1" class="accent-bunca-brown"> Eingeloggt bleiben (30 Tage)
      </label>
      <button class="mt-2 rounded-2xl bg-bunca-brown text-white px-4 py-2 font-semibold">Login</button>
      <p class="text-sm text-bunca-brown/70">Noch kein Konto? <a class="underline" href="/register">Registrieren</a></p>
    </form>
  `, "Login"));
});

app.post("/login", async (req,res)=>{
  const { email, password, remember } = req.body;
  const user = userByEmail(String(email||"").toLowerCase().trim());
  if (!user) return res.status(401).send(authLayout(`<div class="text-red-700 mb-3">Unbekannte E-Mail.</div><a class="underline" href="/login">Zurück</a>`));
  const ok = await bcrypt.compare(password||"", user.password_hash);
  if (!ok) return res.status(401).send(authLayout(`<div class="text-red-700 mb-3">Falsches Passwort.</div><a class="underline" href="/login">Zurück</a>`));
  req.session.user = { id:user.id, email:user.email, shop_name:user.shop_name };
  if (remember) req.sessionOptions.maxAge = 1000*60*60*24*30; // 30 Tage
  res.redirect("/dashboard");
});

app.get("/register", (req,res)=>{
  if (req.session?.user) return res.redirect("/dashboard");
  const locked = REG_LOCK && usersCount() > 0;
  if (locked) {
    return res.status(403).send(authLayout(`
      <div class="text-bunca-brown/80">
        Registrierung ist deaktiviert. Bitte wenden Sie sich an die/den Manager:in.
      </div>
      <div class="mt-3"><a class="underline" href="/login">Zum Login</a></div>
    `, "Registrierung gesperrt"));
  }
  res.send(authLayout(`
    <form action="/register" method="post" class="grid gap-3">
      <div><label class="block text-sm mb-1">Filiale / Shop-Name</label>
        <input name="shop_name" class="w-full rounded-xl border px-3 py-2" placeholder="BUNCA — City" required></div>
      <div><label class="block text-sm mb-1">E-Mail</label>
        <input name="email" type="email" class="w-full rounded-xl border px-3 py-2" placeholder="manager@bunca.de" required></div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-sm mb-1">Passwort</label>
          <input name="password" type="password" minlength="8" class="w-full rounded-xl border px-3 py-2" required></div>
        <div><label class="block text-sm mb-1">Passwort bestätigen</label>
          <input name="password2" type="password" minlength="8" class="w-full rounded-xl border px-3 py-2" required></div>
      </div>
      <button class="mt-2 rounded-2xl bg-bunca-brown text-white px-4 py-2 font-semibold">Konto anlegen</button>
      <p class="text-xs text-bunca-brown/70">Hinweis: Nach der ersten Einrichtung kann die Registrierung gesperrt werden.</p>
    </form>
  `, "Registrieren"));
});

app.post("/register", async (req,res)=>{
  const shop_name = String(req.body.shop_name||"").trim();
  const email = String(req.body.email||"").toLowerCase().trim();
  const pw = String(req.body.password||"");
  const pw2 = String(req.body.password2||"");
  const locked = REG_LOCK && usersCount() > 0;
  if (locked) return res.status(403).send(authLayout(`<div class="text-red-700 mb-3">Registrierung deaktiviert.</div><a class="underline" href="/login">Zum Login</a>`));
  if (!shop_name || !email || !pw) return res.status(400).send(authLayout(`<div class="text-red-700 mb-3">Bitte alle Felder ausfüllen.</div><a class="underline" href="/register">Zurück</a>`));
  if (pw !== pw2) return res.status(400).send(authLayout(`<div class="text-red-700 mb-3">Passwörter stimmen nicht überein.</div><a class="underline" href="/register">Zurück</a>`));
  if (userByEmail(email)) return res.status(400).send(authLayout(`<div class="text-red-700 mb-3">E-Mail bereits registriert.</div><a class="underline" href="/register">Zurück</a>`));
  const password_hash = await bcrypt.hash(pw, 12);
  createUser({ shop_name, email, password_hash });
  res.redirect("/login");
});

app.get("/logout", (req,res)=>{ req.session = null; res.redirect("/login"); });

// ===== Dashboard =====
app.get("/dashboard", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const today = todayStr();
  const countDevs = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id=? AND active=1").get(uid).n;
  const doneTemps = db.prepare(`SELECT COUNT(*) AS n FROM temp_logs WHERE user_id=? AND measured_at LIKE ?`).get(uid, `${today}%`).n;
  const todaysDeliveries = db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE user_id=? AND received_at LIKE ?`).get(uid, `${today}%`).n;
  const doneCleaning = db.prepare(`SELECT COUNT(*) AS n FROM cleaning_logs WHERE user_id=? AND done_at LIKE ?`).get(uid, `${today}%`).n;

  const content = `
  <h1 class="text-2xl font-extrabold text-bunca-brown mb-4">Dashboard</h1>
  <div class="grid md:grid-cols-4 gap-4">
    <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5">
      <div class="text-sm text-bunca-brown/70">Geräte insgesamt</div>
      <div class="mt-2 text-3xl font-extrabold">${countDevs}</div>
      <a class="mt-3 inline-block text-sm underline" href="/einstellungen#geraete">Geräte verwalten</a>
    </div>
    <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5">
      <div class="text-sm text-bunca-brown/70">Temperatur-Checks heute</div>
      <div class="mt-2 text-3xl font-extrabold">${doneTemps}</div>
      <a class="mt-3 inline-block rounded-xl bg-bunca-brown text-white px-3 py-1.5" href="/temperaturen">Jetzt prüfen</a>
    </div>
    <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5">
      <div class="text-sm text-bunca-brown/70">Wareneingänge heute</div>
      <div class="mt-2 text-3xl font-extrabold">${todaysDeliveries}</div>
      <a class="mt-3 inline-block rounded-xl bg-bunca-brown text-white px-3 py-1.5" href="/wareneingang">Erfassen</a>
    </div>
    <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5">
      <div class="text-sm text-bunca-brown/70">Reinigungen heute</div>
      <div class="mt-2 text-3xl font-extrabold">${doneCleaning}</div>
      <a class="mt-3 inline-block rounded-xl bg-bunca-brown text-white px-3 py-1.5" href="/reinigung">Öffnen</a>
    </div>
  </div>
  `;
  res.send(appLayout(req, content, "Dashboard"));
});

// ===== Temperaturen =====
app.get("/temperaturen", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const devices = db.prepare("SELECT * FROM devices WHERE user_id=? AND active=1 ORDER BY type,name").all(uid);
  const today = todayStr();
  const logs = db.prepare(`
    SELECT t.*, d.name, d.type, d.target_min, d.target_max
    FROM temp_logs t
    JOIN devices d ON d.id=t.device_id
    WHERE t.user_id=? AND t.measured_at LIKE ?
    ORDER BY t.measured_at DESC
  `).all(uid, `${today}%`);

  const devRows = devices.map(d=>`
    <tr class="border-b last:border-0">
      <td class="py-2">${d.name}<div class="text-xs text-bunca-brown/60">${d.type.toUpperCase()} • Ziel: ${d.target_min??""}–${d.target_max??""} ${d.unit}</div></td>
      <td class="py-2">
        <form action="/temperaturen/log" method="post" class="flex gap-2 items-center">
          <input type="hidden" name="device_id" value="${d.id}">
          <input type="number" step="0.1" name="measured_c" required class="w-28 rounded-xl border px-3 py-2" placeholder="°C">
          <select name="status" class="rounded-xl border px-3 py-2">
            <option value="ok">OK</option>
            <option value="abweichung">Abweichung</option>
          </select>
          <input name="correction" class="flex-1 rounded-xl border px-3 py-2" placeholder="Maßnahme (bei Abweichung)">
          <input name="note" class="flex-1 rounded-xl border px-3 py-2" placeholder="Notiz (optional)">
          <button class="rounded-xl bg-bunca-brown text-white px-3 py-2">Speichern</button>
        </form>
      </td>
    </tr>
  `).join("");

  const logRows = logs.map(l=>`
    <tr class="border-b last:border-0">
      <td class="py-2">${l.measured_at.slice(11,16)} Uhr</td>
      <td class="py-2">${l.name}</td>
      <td class="py-2">${l.measured_c.toFixed(1)} °C</td>
      <td class="py-2 ${l.status==='ok'?'text-green-700':'text-red-700'}">${l.status.toUpperCase()}</td>
      <td class="py-2">${l.correction||""}</td>
      <td class="py-2">${l.note||""}</td>
    </tr>
  `).join("");

  const content = `
    <h1 class="text-2xl font-extrabold text-bunca-brown mb-4">Temperaturen — Heute (${today})</h1>

    <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5 mb-6">
      <div class="flex items-center justify-between mb-3">
        <div class="text-bunca-brown/80">Geräte erfassen</div>
        <a class="text-sm underline" href="/einstellungen#geraete">Geräte verwalten</a>
      </div>
      <div class="overflow-auto">
        <table class="min-w-full text-sm">
          <thead><tr class="text-left text-bunca-brown/70">
            <th class="py-2 pr-3">Gerät</th>
            <th class="py-2">Messung</th>
          </tr></thead>
          <tbody>${devRows || `<tr><td class="py-2" colspan="2">Keine Geräte vorhanden.</td></tr>`}</tbody>
        </table>
      </div>
    </div>

    <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5">
      <div class="flex items-center justify-between mb-3">
        <div class="text-bunca-brown/80">Heutige Einträge</div>
        <a class="rounded-xl bg-bunca-brown text-white px-3 py-1.5 text-sm" href="/export/temperaturen?date=${today}">CSV exportieren</a>
      </div>
      <div class="overflow-auto">
        <table class="min-w-full text-sm">
          <thead><tr class="text-left text-bunca-brown/70">
            <th class="py-2 pr-3">Zeit</th><th class="py-2 pr-3">Gerät</th><th class="py-2 pr-3">Messwert</th>
            <th class="py-2 pr-3">Status</th><th class="py-2 pr-3">Maßnahme</th><th class="py-2">Notiz</th>
          </tr></thead>
          <tbody>${logRows || `<tr><td class="py-2" colspan="6">Noch keine Einträge.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
  res.send(appLayout(req, content, "Temperaturen"));
});

app.post("/temperaturen/log", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const { device_id, measured_c, status, correction, note } = req.body;
  db.prepare(`INSERT INTO temp_logs (id,user_id,device_id,measured_c,status,correction,note,measured_at)
              VALUES (@id,@user_id,@device_id,@measured_c,@status,@correction,@note,@measured_at)`)
    .run({
      id: randomUUID(), user_id: uid, device_id,
      measured_c: parseFloat(measured_c),
      status: status==='abweichung' ? 'abweichung' : 'ok',
      correction: correction || null,
      note: note || null,
      measured_at: nowISO()
    });
  res.redirect("/temperaturen");
});

// ===== Wareneingang =====
app.get("/wareneingang", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const today = todayStr();
  const rows = db.prepare(`SELECT * FROM deliveries WHERE user_id=? AND received_at LIKE ? ORDER BY received_at DESC`).all(uid, `${today}%`);
  const list = rows.map(r=>`
    <tr class="border-b last:border-0">
      <td class="py-2">${r.received_at.slice(11,16)} Uhr</td>
      <td class="py-2">${r.supplier}</td>
      <td class="py-2">${r.item}</td>
      <td class="py-2">${r.quantity??""} ${r.unit??""}</td>
      <td class="py-2">${r.temp_type||""} ${r.measured_temp!=null?`/ ${r.measured_temp} °C`:""}</td>
      <td class="py-2">${r.best_before||""}</td>
      <td class="py-2 ${r.issue==='ok'?'text-green-700': (r.issue ? 'text-red-700':'')}">${r.issue||""}</td>
      <td class="py-2">${r.correction||""}</td>
    </tr>
  `).join("");

  const content = `
  <h1 class="text-2xl font-extrabold text-bunca-brown mb-4">Wareneingang — Heute (${today})</h1>

  <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5 mb-6">
    <div class="text-bunca-brown/80 mb-3">Lieferung erfassen</div>
    <form action="/wareneingang/add" method="post" class="grid md:grid-cols-3 gap-3">
      <input name="supplier" class="rounded-xl border px-3 py-2" placeholder="Lieferant (z. B. Bäckerei X)" required>
      <input name="item" class="rounded-xl border px-3 py-2" placeholder="Artikel (z. B. Croissants)" required>
      <div class="flex gap-2">
        <input name="quantity" type="number" step="0.01" class="w-32 rounded-xl border px-3 py-2" placeholder="Menge">
        <input name="unit" class="w-24 rounded-xl border px-3 py-2" placeholder="Einheit">
      </div>
      <select name="temp_type" class="rounded-xl border px-3 py-2">
        <option value="">— Temperaturart —</option>
        <option value="gekuehlt">gekühlt</option>
        <option value="tk">tiefgekühlt</option>
        <option value="ambient">ungekühlt</option>
      </select>
      <input name="measured_temp" type="number" step="0.1" class="rounded-xl border px-3 py-2" placeholder="gemessen °C">
      <input name="best_before" type="date" class="rounded-xl border px-3 py-2">
      <select name="issue" class="rounded-xl border px-3 py-2">
        <option value="ok">OK</option>
        <option value="fehlend">Fehlmenge</option>
        <option value="beschaedigt">Beschädigt</option>
        <option value="falsch_temp">Falsche Temperatur</option>
        <option value="sonstiges">Sonstiges</option>
      </select>
      <input name="correction" class="rounded-xl border px-3 py-2" placeholder="Maßnahme (z. B. Teilretoure)">
      <input name="note" class="rounded-xl border px-3 py-2 md:col-span-2" placeholder="Notiz (optional)">
      <button class="rounded-2xl bg-bunca-brown text-white px-4 py-2 font-semibold">Speichern</button>
    </form>
  </div>

  <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5">
    <div class="flex items-center justify-between mb-3">
      <div class="text-bunca-brown/80">Heutige Eingänge</div>
      <a class="rounded-xl bg-bunca-brown text-white px-3 py-1.5 text-sm" href="/export/wareneingang?date=${today}">CSV exportieren</a>
    </div>
    <div class="overflow-auto">
      <table class="min-w-full text-sm">
        <thead><tr class="text-left text-bunca-brown/70">
          <th class="py-2 pr-3">Zeit</th><th class="py-2 pr-3">Lieferant</th><th class="py-2 pr-3">Artikel</th>
          <th class="py-2 pr-3">Menge</th><th class="py-2 pr-3">Temp</th><th class="py-2 pr-3">MHD</th>
          <th class="py-2 pr-3">Abweichung</th><th class="py-2">Maßnahme</th>
        </tr></thead>
        <tbody>${list || `<tr><td class="py-2" colspan="8">Noch keine Einträge.</td></tr>`}</tbody>
      </table>
    </div>
  </div>
  `;
  res.send(appLayout(req, content, "Wareneingang"));
});

app.post("/wareneingang/add", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const { supplier, item, quantity, unit, temp_type, measured_temp, best_before, issue, correction, note } = req.body;
  db.prepare(`INSERT INTO deliveries
    (id,user_id,received_at,supplier,item,quantity,unit,temp_type,measured_temp,best_before,issue,correction,note)
    VALUES (@id,@user_id,@received_at,@supplier,@item,@quantity,@unit,@temp_type,@measured_temp,@best_before,@issue,@correction,@note)`)
    .run({
      id: randomUUID(), user_id: uid, received_at: nowISO(),
      supplier: supplier?.trim(), item: item?.trim(),
      quantity: quantity?parseFloat(quantity):null, unit: unit?.trim()||null,
      temp_type: temp_type||null,
      measured_temp: measured_temp!==""?parseFloat(measured_temp):null,
      best_before: best_before||null,
      issue: issue||"ok",
      correction: correction||null, note: note||null
    });
  res.redirect("/wareneingang");
});

// ===== Reinigung =====
app.get("/reinigung", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const today = todayStr();
  const tasks = db.prepare("SELECT * FROM cleaning_tasks WHERE user_id=? AND active=1 ORDER BY frequency, section, title").all(uid);
  const doneTodayIds = new Set(db.prepare(`SELECT task_id FROM cleaning_logs WHERE user_id=? AND done_at LIKE ?`).all(uid, `${today}%`).map(r=>r.task_id));

  const rows = tasks.map(t=>`
    <tr class="border-b last:border-0">
      <td class="py-2">${t.title}<div class="text-xs text-bunca-brown/60">${t.section||"—"} • ${t.frequency==="taeglich"?"täglich":"wöchentlich"}</div></td>
      <td class="py-2">
        ${doneTodayIds.has(t.id)
          ? `<span class="text-green-700">Erledigt heute</span>`
          : `<form action="/reinigung/done" method="post" class="flex items-center gap-2">
               <input type="hidden" name="task_id" value="${t.id}">
               <input name="initials" maxlength="3" class="w-20 rounded-xl border px-3 py-2" placeholder="Initialen" required>
               <input name="note" class="flex-1 rounded-xl border px-3 py-2" placeholder="Notiz (optional)">
               <button class="rounded-xl bg-bunca-brown text-white px-3 py-2">Abhaken</button>
             </form>`
        }
      </td>
    </tr>
  `).join("");

  const logs = db.prepare(`
    SELECT l.*, t.title FROM cleaning_logs l
    JOIN cleaning_tasks t ON t.id=l.task_id
    WHERE l.user_id=? AND l.done_at LIKE ?
    ORDER BY l.done_at DESC
  `).all(uid, `${today}%`);
  const logsRows = logs.map(l=>`
    <tr class="border-b last:border-0">
      <td class="py-2">${l.done_at.slice(11,16)} Uhr</td>
      <td class="py-2">${l.title}</td>
      <td class="py-2">${l.initials}</td>
      <td class="py-2">${l.note||""}</td>
    </tr>
  `).join("");

  const content = `
  <h1 class="text-2xl font-extrabold text-bunca-brown mb-4">Reinigung — Heute (${today})</h1>

  <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5 mb-6">
    <div class="text-bunca-brown/80 mb-3">Checkliste</div>
    <div class="overflow-auto">
      <table class="min-w-full text-sm">
        <thead><tr class="text-left text-bunca-brown/70"><th class="py-2 pr-3">Aufgabe</th><th class="py-2">Aktion</th></tr></thead>
        <tbody>${rows || `<tr><td class="py-2" colspan="2">Keine Aufgaben angelegt.</td></tr>`}</tbody>
      </table>
    </div>
  </div>

  <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5">
    <div class="flex items-center justify-between mb-3">
      <div class="text-bunca-brown/80">Heutige Nachweise</div>
      <a class="rounded-xl bg-bunca-brown text-white px-3 py-1.5 text-sm" href="/export/reinigung?date=${today}">CSV exportieren</a>
    </div>
    <div class="overflow-auto">
      <table class="min-w-full text-sm">
        <thead><tr class="text-left text-bunca-brown/70">
          <th class="py-2 pr-3">Zeit</th><th class="py-2 pr-3">Aufgabe</th><th class="py-2 pr-3">Initialen</th><th class="py-2">Notiz</th>
        </tr></thead>
        <tbody>${logsRows || `<tr><td class="py-2" colspan="4">Noch keine Einträge.</td></tr>`}</tbody>
      </table>
    </div>
  </div>
  `;
  res.send(appLayout(req, content, "Reinigung"));
});

app.post("/reinigung/done", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const { task_id, initials, note } = req.body;
  db.prepare(`INSERT INTO cleaning_logs (id,user_id,task_id,done_at,initials,note)
              VALUES (@id,@user_id,@task_id,@done_at,@initials,@note)`)
    .run({ id: randomUUID(), user_id: uid, task_id, done_at: nowISO(), initials: (initials||"").toUpperCase(), note: note||null });
  res.redirect("/reinigung");
});

// ===== Exporte =====
app.get("/exporte", requireAuth, (req,res)=>{
  const today = todayStr();
  const content = `
  <h1 class="text-2xl font-extrabold text-bunca-brown mb-4">Exporte</h1>
  <div class="bg-white rounded-2xl p-5 shadow-soft border border-black/5">
    <p class="text-bunca-brown/80 mb-3">CSV für ein Datum herunterladen (Standard: heute).</p>
    <div class="grid md:grid-cols-3 gap-3 items-end">
      <form class="flex items-center gap-2" action="/export/temperaturen" method="get">
        <label class="text-sm">Datum</label>
        <input type="date" name="date" class="rounded-xl border px-3 py-2" value="${today}">
        <button class="rounded-xl bg-bunca-brown text-white px-3 py-2">Temperaturen</button>
      </form>
      <form class="flex items-center gap-2" action="/export/wareneingang" method="get">
        <input type="date" name="date" class="rounded-xl border px-3 py-2" value="${today}">
        <button class="rounded-xl bg-bunca-brown text-white px-3 py-2">Wareneingang</button>
      </form>
      <form class="flex items-center gap-2" action="/export/reinigung" method="get">
        <input type="date" name="date" class="rounded-xl border px-3 py-2" value="${today}">
        <button class="rounded-xl bg-bunca-brown text-white px-3 py-2">Reinigung</button>
      </form>
    </div>
  </div>
  `;
  res.send(appLayout(req, content, "Exporte"));
});

function csvEscape(v){
  if (v==null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
function sendCSV(res, filename, headers, rows){
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.write(headers.map(csvEscape).join(",")+"\n");
  rows.forEach(r=> res.write(r.map(csvEscape).join(",")+"\n"));
  res.end();
}

app.get("/export/temperaturen", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const date = req.query.date || todayStr();
  const rows = db.prepare(`
    SELECT t.measured_at, d.name, d.type, t.measured_c, t.status, t.correction, t.note
    FROM temp_logs t
    JOIN devices d ON d.id=t.device_id
    WHERE t.user_id=? AND t.measured_at LIKE ?
    ORDER BY t.measured_at ASC
  `).all(uid, `${date}%`);
  const out = rows.map(r=>[r.measured_at, r.name, r.type, r.measured_c, r.status, r.correction||"", r.note||""]);
  sendCSV(res, `temperaturen_${date}.csv`,
    ["Zeit","Gerät","Typ","Messwert (°C)","Status","Maßnahme","Notiz"], out);
});

app.get("/export/wareneingang", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const date = req.query.date || todayStr();
  const rows = db.prepare(`
    SELECT * FROM deliveries
    WHERE user_id=? AND received_at LIKE ? ORDER BY received_at ASC
  `).all(uid, `${date}%`);
  const out = rows.map(r=>[
    r.received_at, r.supplier, r.item, r.quantity??"", r.unit??"",
    r.temp_type??"", r.measured_temp??"", r.best_before??"",
    r.issue??"", r.correction??"", r.note??""
  ]);
  sendCSV(res, `wareneingang_${date}.csv`,
    ["Zeit","Lieferant","Artikel","Menge","Einheit","Temp-Art","gemessen °C","MHD","Abweichung","Maßnahme","Notiz"], out);
});

app.get("/export/reinigung", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const date = req.query.date || todayStr();
  const rows = db.prepare(`
    SELECT l.done_at, t.title, t.section, t.frequency, l.initials, l.note
    FROM cleaning_logs l
    JOIN cleaning_tasks t ON t.id=l.task_id
    WHERE l.user_id=? AND l.done_at LIKE ?
    ORDER BY l.done_at ASC
  `).all(uid, `${date}%`);
  const out = rows.map(r=>[r.done_at, r.title, r.section??"", r.frequency, r.initials, r.note??""]);
  sendCSV(res, `reinigung_${date}.csv`,
    ["Zeit","Aufgabe","Bereich","Frequenz","Initialen","Notiz"], out);
});

// ===== Einstellungen =====
app.get("/einstellungen", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const u = req.session.user;
  const devices = db.prepare("SELECT * FROM devices WHERE user_id=? ORDER BY active DESC, type, name").all(uid);
  const tasks = db.prepare("SELECT * FROM cleaning_tasks WHERE user_id=? ORDER BY active DESC, frequency, section, title").all(uid);

  const devList = devices.map(d=>`
    <tr class="border-b last:border-0">
      <td class="py-2">${d.name}<div class="text-xs text-bunca-brown/60">${d.type.toUpperCase()} • Ziel: ${d.target_min??""}–${d.target_max??""} ${d.unit}</div></td>
      <td class="py-2">${d.active? "aktiv":"inaktiv"}</td>
      <td class="py-2">
        <form action="/einstellungen/device/delete" method="post" onsubmit="return confirm('Gerät löschen?')">
          <input type="hidden" name="id" value="${d.id}">
          <button class="text-red-700 underline text-sm">Löschen</button>
        </form>
      </td>
    </tr>
  `).join("");

  const taskList = tasks.map(t=>`
    <tr class="border-b last:border-0">
      <td class="py-2">${t.title}<div class="text-xs text-bunca-brown/60">${t.section||"—"} • ${t.frequency==="taeglich"?"täglich":"wöchentlich"}</div></td>
      <td class="py-2">${t.active? "aktiv":"inaktiv"}</td>
      <td class="py-2">
        <form action="/einstellungen/task/delete" method="post" onsubmit="return confirm('Aufgabe löschen?')">
          <input type="hidden" name="id" value="${t.id}">
          <button class="text-red-700 underline text-sm">Löschen</button>
        </form>
      </td>
    </tr>
  `).join("");

  const content = `
  <h1 class="text-2xl font-extrabold text-bunca-brown mb-4">Einstellungen</h1>

  <div class="grid md:grid-cols-2 gap-6">
    <div id="filiale" class="bg-white rounded-2xl p-5 shadow-soft border border-black/5">
      <div class="text-sm text-bunca-brown/70 mb-2">Deine Filiale</div>
      <div><span class="font-semibold">Shop:</span> ${u.shop_name}</div>
      <div><span class="font-semibold">E-Mail:</span> ${u.email}</div>
    </div>

    <div id="geraete" class="bg-white rounded-2xl p-5 shadow-soft border border-black/5">
      <div class="flex items-center justify-between mb-3">
        <div class="text-bunca-brown/80">Geräte verwalten</div>
      </div>
      <form action="/einstellungen/device/add" method="post" class="grid md:grid-cols-2 gap-2 mb-4">
        <input name="name" class="rounded-xl border px-3 py-2" placeholder="Name (z. B. Milch-KS)" required>
        <select name="type" class="rounded-xl border px-3 py-2" required>
          <option value="kuehl">Kühlgerät</option>
          <option value="tk">Tiefkühler</option>
          <option value="heiss">Heißhaltung</option>
        </select>
        <input name="target_min" type="number" step="0.1" class="rounded-xl border px-3 py-2" placeholder="Ziel min °C">
        <input name="target_max" type="number" step="0.1" class="rounded-xl border px-3 py-2" placeholder="Ziel max °C">
        <button class="rounded-xl bg-bunca-brown text-white px-3 py-2 md:col-span-2">Gerät hinzufügen</button>
      </form>
      <div class="overflow-auto">
        <table class="min-w-full text-sm">
          <thead><tr class="text-left text-bunca-brown/70"><th class="py-2 pr-3">Gerät</th><th class="py-2 pr-3">Status</th><th class="py-2">Aktion</th></tr></thead>
          <tbody>${devList || `<tr><td class="py-2" colspan="3">Keine Geräte.</td></tr>`}</tbody>
        </table>
      </div>
    </div>

    <div id="aufgaben" class="bg-white rounded-2xl p-5 shadow-soft border border-black/5 md:col-span-2">
      <div class="flex items-center justify-between mb-3">
        <div class="text-bunca-brown/80">Reinigungs-Aufgaben</div>
      </div>
      <form action="/einstellungen/task/add" method="post" class="grid md:grid-cols-4 gap-2 mb-4">
        <input name="title" class="rounded-xl border px-3 py-2 md:col-span-2" placeholder="Aufgabe (z. B. Siebträger reinigen)" required>
        <input name="section" class="rounded-xl border px-3 py-2" placeholder="Bereich (z. B. Bar)">
        <select name="frequency" class="rounded-xl border px-3 py-2" required>
          <option value="taeglich">täglich</option>
          <option value="woechentlich">wöchentlich</option>
        </select>
        <button class="rounded-xl bg-bunca-brown text-white px-3 py-2 md:col-span-4">Aufgabe hinzufügen</button>
      </form>
      <div class="overflow-auto">
        <table class="min-w-full text-sm">
          <thead><tr class="text-left text-bunca-brown/70"><th class="py-2 pr-3">Aufgabe</th><th class="py-2 pr-3">Status</th><th class="py-2">Aktion</th></tr></thead>
          <tbody>${taskList || `<tr><td class="py-2" colspan="3">Keine Aufgaben.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  </div>
  `;
  res.send(appLayout(req, content, "Einstellungen"));
});

app.post("/einstellungen/device/add", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const { name, type, target_min, target_max } = req.body;
  db.prepare(`INSERT INTO devices (id,user_id,name,type,target_min,target_max,active,created_at)
              VALUES (@id,@user_id,@name,@type,@target_min,@target_max,1,@created_at)`)
    .run({
      id: randomUUID(), user_id: uid,
      name: name?.trim(), type,
      target_min: target_min!==""?parseFloat(target_min):null,
      target_max: target_max!==""?parseFloat(target_max):null,
      created_at: nowISO()
    });
  res.redirect("/einstellungen#geraete");
});

app.post("/einstellungen/device/delete", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const { id } = req.body;
  db.prepare(`DELETE FROM devices WHERE id=? AND user_id=?`).run(id, uid);
  res.redirect("/einstellungen#geraete");
});

app.post("/einstellungen/task/add", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const { title, section, frequency } = req.body;
  db.prepare(`INSERT INTO cleaning_tasks (id,user_id,title,section,frequency,active,created_at)
              VALUES (@id,@user_id,@title,@section,@frequency,1,@created_at)`)
    .run({ id: randomUUID(), user_id: uid, title: title?.trim(), section: section?.trim()||null, frequency, created_at: nowISO() });
  res.redirect("/einstellungen#aufgaben");
});

app.post("/einstellungen/task/delete", requireAuth, (req,res)=>{
  const uid = req.session.user.id;
  const { id } = req.body;
  db.prepare(`DELETE FROM cleaning_tasks WHERE id=? AND user_id=?`).run(id, uid);
  res.redirect("/einstellungen#aufgaben");
});

// ===== Start =====
app.listen(PORT, ()=> console.log(`BUNCA HACCP läuft auf http://localhost:${PORT} (DB: ${DB_FILE})`));
