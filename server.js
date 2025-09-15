/**
 * BUNCA HACCP — Production Express Server (single-file edition)
 * ------------------------------------------------------------
 * Goals
 * - Minimal external files: you can deploy with only package.json + this file.
 * - Security: helmet, rate-limit, CORS, sane headers.
 * - Render-compatible: binds to process.env.PORT, provides /healthz.
 * - SEO basics: /robots.txt, /sitemap.xml.
 * - Fully working pages served from strings (/, /login, /impressum, /datenschutz).
 * - Assets served via routes: /assets/style.css and /assets/app.js
 * - Clean structure & graceful shutdown.
 *
 * Next steps (when you say “Next file”):
 * - Split into modules (auth, shops, checks, admin), SQLite, EJS views.
 * - Keep each new **code** file ≥ 500 lines as requested.
 */

'use strict';

// ------------------------- Imports -------------------------
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
require('dotenv').config();

// ------------------------- Config --------------------------
const APP_NAME = process.env.APP_NAME || 'BUNCA HACCP';
const NODE_ENV = process.env.NODE_ENV || 'production';
const PORT = Number(process.env.PORT || 3000);

// CORS (open; we can restrict later)
const corsOptions = {
  origin: (_origin, cb) => cb(null, true),
  credentials: false
};

// Rate limit (basic)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 120 req/min/IP
  standardHeaders: true,
  legacyHeaders: false
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
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(cors(corsOptions));
app.use(limiter);
app.disable('x-powered-by');

// ------------------------- Helpers -------------------------
const escapeHtml = (s='') =>
  String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');

const getBaseUrl = (req) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return `${proto}://${host}`;
};

// ------------------------- CSS (served via route) ----------
const CSS = String.raw`
/* === BUNCA HACCP Base Styles (mobile-first, modern) === */
:root{
  --bg:#0e0f12; --panel:#14161b; --soft:#1a1d23;
  --text:#e9eef7; --muted:#a8b0bf;
  --brand:#3E2723; --cream:#F5EDE3; --gold:#C6A15B;
  --ok:#38b000; --warn:#ffb703; --fail:#e63946;
  --radius:18px; --radius-lg:26px; --shadow:0 10px 30px rgba(0,0,0,.35);
  --maxw:1120px; --focus:0 0 0 3px rgba(198,161,91,.28);
}
@media (prefers-color-scheme: light){
  :root{ --bg:#f7f8fb; --panel:#ffffff; --soft:#f0f2f6; --text:#1a1c21; --muted:#4a5568; --brand:#6b4a3a; --cream:#3E2723; --gold:#b58939; --shadow:0 8px 22px rgba(0,0,0,.08); }
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;background:linear-gradient(180deg,var(--bg) 0%, #121419 100%);color:var(--text);
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 18px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.grid{display:grid;gap:18px}
.grid-2{display:grid;gap:18px;grid-template-columns:1fr}
@media(min-width:920px){.grid-2{grid-template-columns:1fr 1fr}}
.grid-3{display:grid;gap:18px;grid-template-columns:1fr}
@media(min-width:920px){.grid-3{grid-template-columns:repeat(3,1fr)}}
.card{
  background:linear-gradient(180deg,var(--panel),#0f1115);
  border:1px solid rgba(255,255,255,.06);
  border-radius:var(--radius-lg);
  padding:18px;box-shadow:var(--shadow);
}
.soft{background:linear-gradient(180deg,var(--soft),var(--panel));border:1px dashed rgba(255,255,255,.08)}
.badge{
  display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid rgba(255,255,255,.08);
  border-radius:999px;background:rgba(255,255,255,.05);font-size:13px;color:var(--muted)
}
.btn{
  cursor:pointer;display:inline-flex;justify-content:center;align-items:center;gap:8px;
  padding:12px 16px;border:none;border-radius:14px;font-weight:800;
  transition:transform .06s ease, box-shadow .2s ease;outline:none;
}
.btn:focus{box-shadow:var(--focus)} .btn:active{transform:translateY(1px)}
.btn-primary{background:linear-gradient(180deg,var(--gold),#9f7e3d);color:#14161b;box-shadow:var(--shadow)}
.btn-ghost{background:transparent;border:1px solid rgba(255,255,255,.12);color:var(--text)}
.btn-danger{background:linear-gradient(180deg,#e15a64,#b92f39);color:#fff}
.btn-ok{background:linear-gradient(180deg,#49c469,#2a8b41);color:#fff}
.btn-warn{background:linear-gradient(180deg,#ffcc66,#e0971d);color:#14161b}
.chip{border:1px solid rgba(255,255,255,.08);padding:6px 10px;border-radius:999px}
.muted{color:var(--muted)} .kpi{font-weight:900;font-size:1.6rem}
.ok{color:var(--ok)} .warn{color:var(--warn)} .fail{color:var(--fail)}
.spacer{height:12px} .divider{height:1px;background:rgba(255,255,255,.08);margin:6px 0}
.input, select, textarea{
  width:100%;padding:12px 14px;border-radius:14px;background:#0c0d11;color:var(--text);
  border:1px solid rgba(255,255,255,.07);outline:none;transition:border-color .15s ease, box-shadow .15s ease;
}
.input:focus, select:focus, textarea:focus{border-color:var(--gold);box-shadow:var(--focus)}
label>span{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
.form{display:grid;gap:12px}
.table{width:100%;border-collapse:separate;border-spacing:0}
.table th, .table td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);text-align:left;font-size:14px}
.table th{font-weight:800;color:var(--muted)} .table tr:hover td{background:rgba(255,255,255,.03)}

/* Header/Nav */
.site-header{position:sticky;top:0;z-index:40;background:rgba(14,15,18,.7);backdrop-filter:blur(10px);border-bottom:1px solid rgba(255,255,255,.06)}
.nav{display:flex;align-items:center;justify-content:space-between;height:64px}
.brand{display:flex;gap:10px;align-items:center}
.logo{inline-size:34px;block-size:34px;border-radius:10px;background:radial-gradient(100% 100% at 50% 0%,var(--brand),#1d1110);display:grid;place-items:center;color:var(--cream);font-weight:800}
.brand span{font-weight:900;letter-spacing:.3px}
.links{display:flex;gap:14px;align-items:center}
.link{opacity:.92;padding:8px 10px;border-radius:12px}
.link:hover{opacity:1;background:rgba(255,255,255,.06)}
.menu-btn{display:none}
@media(max-width:860px){.links{display:none}.menu-btn{display:inline-flex}.mobile-menu{display:grid}}
.mobile-menu{display:none;gap:10px;padding:10px}
.mobile-menu a{padding:10px;border-radius:12px;background:rgba(255,255,255,.04)}
.theme-toggle{border-radius:999px;padding:8px 10px}

/* Page */
main.page{padding:28px 0 56px}
.hero{padding:42px 0 16px}
.h1{font-size:clamp(28px,4.5vw,52px);line-height:1.05;margin:10px 0 8px;font-weight:900;letter-spacing:.2px}
.h2{font-size:clamp(22px,3.2vw,34px);font-weight:900;margin:0 0 12px}
.lead{font-size:clamp(15px,2vw,18px);color:var(--muted);max-width:70ch}
.section{padding:24px 0}
.tabs{display:flex;gap:8px;flex-wrap:wrap}
.tabs .tab{padding:10px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.12);cursor:pointer}
.tabs .tab[aria-selected="true"]{background:linear-gradient(180deg,var(--gold),#9f7e3d);color:#14161b;border-color:transparent}

/* Footer */
.site-footer{padding:26px 0;border-top:1px solid rgba(255,255,255,.06);color:var(--muted)}
.footer-inner{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.logo.sm{inline-size:26px;block-size:26px;border-radius:8px}

/* Dialog/Toast */
dialog{border:none;border-radius:16px;max-width:720px;width:96vw;background:linear-gradient(180deg,var(--panel),#0f1115);color:var(--text);padding:0}
dialog::backdrop{background:rgba(0,0,0,.55)}
.dialog-header{padding:18px 18px 0;font-weight:800}
.dialog-body{padding:12px 18px;color:var(--muted)}
.dialog-actions{padding:0 18px 18px}
.toast{position:fixed;right:14px;bottom:14px;z-index:60;display:none;min-width:220px;max-width:360px;background:linear-gradient(180deg,var(--panel),#0f1115);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:12px 14px;box-shadow:var(--shadow)}
.toast.show{display:block;animation:pop .14s ease}
@keyframes pop{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}}

.hidden{display:none !important}.center{display:grid;place-items:center}
`;

// ------------------------- JS (served via route) ------------
const JS = String.raw`
// BUNCA HACCP front-end (vanilla JS)
// - Mobile menu toggle
// - Theme toggle (persisted)
// - Lead form (demo) -> localStorage
// - Simple toast feedback
(function(){
  'use strict';
  const $ = (sel, root=document) => root.querySelector(sel);

  // Theme
  const THEME_KEY = 'bunca_theme';
  function applyTheme(t){
    document.documentElement.setAttribute('data-theme', t);
    try{ localStorage.setItem(THEME_KEY, t);}catch(e){}
  }
  function toggleTheme(){
    const current = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }
  window.toggleTheme = toggleTheme;
  try{ const saved = localStorage.getItem(THEME_KEY); if(saved) applyTheme(saved);}catch(e){}

  // Mobile nav
  const menuBtn = document.getElementById('menuBtn');
  const mobileNav = document.getElementById('mobileNav');
  if(menuBtn && mobileNav){
    menuBtn.addEventListener('click', ()=>{
      const open = !mobileNav.hasAttribute('hidden');
      if(open){ mobileNav.setAttribute('hidden',''); menuBtn.setAttribute('aria-expanded','false');}
      else{ mobileNav.removeAttribute('hidden'); menuBtn.setAttribute('aria-expanded','true');}
    });
  }

  // Toast
  const toast = document.getElementById('toast');
  function showToast(msg){
    if(!toast) return alert(msg);
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(()=>toast.classList.remove('show'), 3000);
  }
  window.showToast = showToast;

  // Lead form demo
  function submitLead(e){
    e.preventDefault();
    const name = document.getElementById('leadName')?.value?.trim();
    const email = document.getElementById('leadEmail')?.value?.trim();
    const ok = document.getElementById('leadConsent')?.checked;
    if(!name || !email || !ok) return showToast('Bitte Felder ausfüllen & Datenschutz zustimmen.');
    if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return showToast('Bitte gültige E-Mail.');
    try{
      const key='bunca_haccp_leads';
      const arr=JSON.parse(localStorage.getItem(key)||'[]');
      arr.push({name,email,ts:new Date().toISOString()});
      localStorage.setItem(key, JSON.stringify(arr));
    }catch(e){}
    document.getElementById('starterDialog')?.showModal();
    (e.target||{}).reset?.();
    showToast('Starter-Kit Link gesendet (Demo).');
    return false;
  }
  window.submitLead = submitLead;

  // Demo preview
  function demoPreview(){
    document.getElementById('demoDialog')?.showModal();
  }
  window.demoPreview = demoPreview;
})();
`;

// ------------------------- HTML Templates ------------------
function layoutHTML({ title, content }) {
  return `<!doctype html>
<html lang="de" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title ? `${title} · ${APP_NAME}` : APP_NAME)}</title>
  <meta name="color-scheme" content="dark light" />
  <meta name="description" content="BUNCA HACCP – modernes, audit-sicheres Toolkit für Gastronomie & Coffee Shops." />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%233E2723'/%3E%3Ctext x='50%25' y='54%25' text-anchor='middle' font-size='28' font-family='system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial' fill='%23F5EDE3'%3EB%3C/text%3E%3C/svg%3E" />
  <link rel="stylesheet" href="/assets/style.css" />
</head>
<body>
  <header class="site-header">
    <div class="wrap nav">
      <a class="brand" href="/">
        <div class="logo">B</div>
        <span>${escapeHtml(APP_NAME)}</span>
      </a>
      <nav class="links" aria-label="main">
        <a class="link" href="/">Start</a>
        <a class="link" href="/login">Login</a>
        <a class="link" href="/impressum">Impressum</a>
        <a class="link" href="/datenschutz">Datenschutz</a>
        <button class="btn btn-ghost theme-toggle" id="themeToggle" onclick="toggleTheme()" aria-label="Theme">🌓</button>
      </nav>
      <button class="btn btn-ghost menu-btn" id="menuBtn" aria-expanded="false" aria-controls="mobileNav" aria-label="Menü">☰</button>
    </div>
    <div class="wrap mobile-menu" id="mobileNav" hidden>
      <a href="/">Start</a>
      <a href="/login">Login</a>
      <a href="/impressum">Impressum</a>
      <a href="/datenschutz">Datenschutz</a>
      <div class="row">
        <button class="btn btn-ghost theme-toggle" onclick="toggleTheme()" aria-label="Theme (mobil)">🌓</button>
      </div>
    </div>
  </header>

  <main class="page">
    <div class="wrap">
      ${content}
    </div>
  </main>

  <footer class="site-footer">
    <div class="wrap footer-inner">
      <div class="row">
        <div class="logo sm">B</div>
        <span>${escapeHtml(APP_NAME)}</span>
      </div>
      <div class="row">
        <a href="/impressum">Impressum</a><span>·</span><a href="/datenschutz">Datenschutz</a>
      </div>
    </div>
  </footer>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <!-- Dialogs -->
  <dialog id="starterDialog">
    <form method="dialog">
      <div class="dialog-header">Starter-Kit ist auf dem Weg ✅</div>
      <div class="dialog-body">In dieser Demo wurde deine Anfrage lokal gespeichert. Später verknüpfen wir die echte API.</div>
      <div class="dialog-actions">
        <button class="btn btn-primary" value="close">Alles klar</button>
      </div>
    </form>
  </dialog>

  <dialog id="demoDialog">
    <form method="dialog">
      <div class="dialog-header">Vorschau: Temperatur-Check (Beispiel)</div>
      <div class="dialog-body"><pre style="white-space:pre-wrap;margin:0;font-family:ui-monospace">Datum: 2025-09-16
Kühlschrank 1: 3.2 °C  ✅
Kühlschrank 2: 7.1 °C  ⚠️ Grenzwert prüfen
Gefriertruhe: -17 °C   ✅
Reaktion: Dichtung prüfen, in 1h erneut messen.</pre></div>
      <div class="dialog-actions">
        <button class="btn btn-ghost" value="close">Schließen</button>
      </div>
    </form>
  </dialog>

  <script src="/assets/app.js" defer></script>
</body>
</html>`;
}

function pageHome() {
  return layoutHTML({
    title: 'Start',
    content: `
<section class="hero">
  <div class="grid-2">
    <div>
      <span class="badge">BUNCA HACCP</span>
      <h1 class="h1">Frischer Start – Render-ready, ohne fehlende Dateien.</h1>
      <p class="lead">Dieses Grundgerüst läuft sofort. Es liefert Seiten, CSS & JS aus dem Server. Später splitten wir in Module (500+ Zeilen pro Code-Datei, wie gewünscht).</p>
      <div class="row">
        <a class="btn btn-primary" href="#starter">Starter-Kit holen</a>
        <a class="btn btn-ghost" href="/login">Login</a>
      </div>
      <div class="spacer"></div>
      <div class="row">
        <span class="chip">🔐 Helmet</span>
        <span class="chip">🛡️ Rate-Limit</span>
        <span class="chip">🌐 CORS</span>
        <span class="chip">❤️ Render Healthcheck</span>
      </div>
    </div>
    <div class="card">
      <div class="grid">
        <div class="h2">Was du bekommst</div>
        <div class="grid-3">
          <div class="soft card">
            <strong>Checklisten</strong>
            <p class="muted">Temperatur, Reinigung, Wareneingang – sofort nutzbar.</p>
          </div>
          <div class="soft card">
            <strong>Trainings-Leitfaden</strong>
            <p class="muted">Rechtliche Basics + kurzer Wissenstest.</p>
          </div>
          <div class="soft card">
            <strong>Best Practices</strong>
            <p class="muted">Grenzwerte & Eskalation bei Abweichungen.</p>
          </div>
        </div>
        <div class="spacer"></div>
        <form class="form" onsubmit="return submitLead(event)" id="starter">
          <label>
            <span>Name</span>
            <input class="input" id="leadName" placeholder="Vor- und Nachname" required />
          </label>
          <label>
            <span>E-Mail</span>
            <input class="input" id="leadEmail" type="email" placeholder="dein.name@bunca.de" required />
          </label>
          <label class="row" style="align-items:flex-start">
            <input id="leadConsent" type="checkbox" style="margin-top:4px" required />
            <span class="muted">Ich stimme der Verarbeitung meiner Daten zur Zusendung des Starter-Kits zu.</span>
          </label>
          <div class="row">
            <button class="btn btn-primary" type="submit">Download-Link senden</button>
            <button class="btn btn-ghost" type="button" onclick="demoPreview()">Beispiel ansehen</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap grid-3">
    <div class="card">
      <div class="h2">Warum BUNCA HACCP?</div>
      <p class="muted">Einheitliche Prozesse in allen Filialen, klare Verantwortlichkeiten und digitale Nachweise.</p>
    </div>
    <div class="card">
      <div class="h2">Für Teams gemacht</div>
      <p class="muted">Von Baristas bis Management: schnelle Trainings, klare Checklisten, mobile Nutzung.</p>
    </div>
    <div class="card">
      <div class="h2">Audit-bereit</div>
      <p class="muted">Saubere History, CSV-/JSON-Exporte, klare Eskalationswege und Zuständigkeiten.</p>
    </div>
  </div>
</section>
`
  });
}

function pageLogin() {
  return layoutHTML({
    title: 'Anmelden',
    content: `
<h2 class="h2">Anmelden</h2>
<div class="card" style="max-width:520px">
  <form class="form" onsubmit="showToast('Demo: Auth folgt in nächstem Modul'); return false;">
    <label><span>E-Mail</span><input class="input" type="email" placeholder="dein.name@bunca.de" required></label>
    <label><span>Passwort</span><input class="input" type="password" placeholder="Passwort" required></label>
    <button class="btn btn-primary" type="submit">Login</button>
  </form>
  <div class="spacer"></div>
  <p class="muted" style="font-size:13px">Hinweis: Echte Auth (Session/SQLite) liefern wir im nächsten 500+ Zeilen Modul.</p>
</div>
`
  });
}

function pageImpressum() {
  return layoutHTML({
    title: 'Impressum',
    content: `
<h2 class="h2">Impressum</h2>
<div class="card">
  <p>Firmenname: BUNCA Coffee GmbH (Beispiel)</p>
  <p>Adresse: Musterstraße 1, 60311 Frankfurt am Main</p>
  <p>Kontakt: info@bunca.de · Tel: +49 69 000000</p>
  <p>Geschäftsführer: Max Mustermann · USt-ID: DE000000000</p>
</div>
`
  });
}

function pageDatenschutz() {
  return layoutHTML({
    title: 'Datenschutz',
    content: `
<h2 class="h2">Datenschutzerklärung</h2>
<div class="card">
  <p class="muted">Kurz: Wir verarbeiten personenbezogene Daten nur im erforderlichen Umfang. Später ergänzen wir hier die Details zu Formularen, Cookies und Auftragsverarbeitern.</p>
</div>
`
  });
}

// ------------------------- Routes --------------------------
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/assets/style.css', (_req, res) => { res.setHeader('Content-Type','text/css; charset=utf-8'); res.send(CSS); });
app.get('/assets/app.js',   (_req, res) => { res.setHeader('Content-Type','application/javascript; charset=utf-8'); res.send(JS); });

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Sitemap: ' + getBaseUrl(req) + '/sitemap.xml'
  ].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  const base = getBaseUrl(req);
  res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${base}/login</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>
  <url><loc>${base}/impressum</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>
  <url><loc>${base}/datenschutz</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>
</urlset>`
  );
});

app.get('/',          (_req, res) => res.status(200).send(pageHome()));
app.get('/login',     (_req, res) => res.status(200).send(pageLogin()));
app.get('/impressum', (_req, res) => res.status(200).send(pageImpressum()));
app.get('/datenschutz',(_req, res)=> res.status(200).send(pageDatenschutz()));

app.use((req, res) => {
  res.status(404).send(layoutHTML({
    title: 'Seite nicht gefunden',
    content: `
      <div class="card">
        <h2>404 – Seite nicht gefunden</h2>
        <p>Die gewünschte Seite existiert nicht.</p>
        <p><a class="btn btn-ghost" href="/">Zur Startseite</a></p>
      </div>
    `
  }));
});

app.use((err, _req, res, _next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).send(layoutHTML({
    title: 'Fehler',
    content: `
      <div class="card">
        <h2>Oops – ein Fehler ist aufgetreten</h2>
        <pre style="white-space:pre-wrap">${escapeHtml(err?.message || String(err))}</pre>
        <p><a class="btn btn-ghost" href="/">Zur Startseite</a></p>
      </div>
    `
  }));
});

// ------------------------- Server --------------------------
const server = app.listen(PORT, () => {
  console.log(`✅ ${APP_NAME} running on http://localhost:${PORT} (env: ${NODE_ENV})`);
});
function shutdown(signal){ console.log(`\\n${signal} received. Shutting down...`); server.close(()=>{ console.log('HTTP server closed.'); process.exit(0);});}
['SIGINT','SIGTERM'].forEach(s=>process.on(s,()=>shutdown(s)));
process.on('unhandledRejection',(err)=>console.error('UNHANDLED REJECTION:',err));
process.on('uncaughtException',(err)=>console.error('UNCAUGHT EXCEPTION:',err));
