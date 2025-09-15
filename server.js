// server.js (CommonJS)
const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet'); // use helmet v6.x (CommonJS)
const cookieSession = require('cookie-session');
const Database = require('better-sqlite3');

const app = express();

/** pick a writable DB path on Render */
function pickDbPath() {
  if (process.env.DB_FILE) return process.env.DB_FILE;

  // Prefer persistent disk if mounted (Render)
  const varData = '/var/data';
  try {
    fs.mkdirSync(varData, { recursive: true });
    fs.accessSync(varData, fs.constants.W_OK);
    return path.join(varData, 'bunca-haccp.db');
  } catch {
    // Fallback to tmp (ephemeral)
    console.warn('[DB] /var/data not writable; falling back to /tmp');
    const tmp = '/tmp';
    fs.mkdirSync(tmp, { recursive: true });
    return path.join(tmp, 'bunca-haccp.db');
  }
}

app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  cookieSession({
    name: 'session',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  })
);

// init database
const dbPath = pickDbPath();
const dbDir = path.dirname(dbPath);
fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  role TEXT CHECK(role IN ('admin','staff')) NOT NULL DEFAULT 'staff',
  email TEXT UNIQUE,
  password_hash TEXT
);
CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  data TEXT
);
`);

app.get('/healthz', (_req, res) => res.json({ ok: true, db: dbPath }));

// static files (optional landing page)
const staticDir = path.join(__dirname, 'public');
if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('BUNCA HACCP API running'));
}

const port = process.env.PORT || 3000; // Render sets PORT
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
  console.log(`[DB] Using ${dbPath}`);
});
