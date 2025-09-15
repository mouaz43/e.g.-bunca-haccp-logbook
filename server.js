// server.js
// BUNCA HACCP – tiny API that stores config in your GitHub repo (no DB).
// Requires env: ADMIN_EMAIL, ADMIN_PASSWORD, REGISTRATION_CODE (optional),
// JWT_SECRET, GITHUB_TOKEN, GITHUB_REPO ("owner/repo"), GITHUB_BRANCH (e.g. "main").

import express from "express";
import path from "path";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ---- ENV ----
const {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  REGISTRATION_CODE,
  JWT_SECRET = crypto.randomBytes(16).toString("hex"),
  GITHUB_TOKEN,
  GITHUB_REPO,         // "owner/repo"
  GITHUB_BRANCH = "main",
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.error("Missing GITHUB_TOKEN or GITHUB_REPO env.");
}

const [GH_OWNER, GH_REPO] = (GITHUB_REPO || "").split("/");
const SHOPS_PATH = "data/shops.json";

// ---- helpers ----
function sign(payload, expiresIn = "7d") {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}
function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

// GitHub REST (use built-in fetch; no Octokit needed)
async function ghGetContents(pathInRepo) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(pathInRepo)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "bunca-haccp",
    },
  });
  if (r.status === 404) return { exists: false };
  if (!r.ok) throw new Error(`GitHub GET ${pathInRepo} -> ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf8");
  return { exists: true, sha: data.sha, text: content };
}

async function ghPutContents(pathInRepo, text, sha = undefined, message = "Update shops.json") {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(pathInRepo)}`;
  const body = {
    message,
    content: Buffer.from(text, "utf8").toString("base64"),
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
  };
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "bunca-haccp",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`GitHub PUT ${pathInRepo} -> ${r.status} ${t}`);
  }
  return r.json();
}

// in-memory cache to avoid hammering GitHub
let cache = { shops: null, sha: null, ts: 0 };
const CACHE_MS = 10_000;

function defaultShops() {
  return [{
    id: "shop_default",
    name: "BUNCA · City",
    city: "",
    address: "",
    active: true,
    items: [
      { id: "item_fridge1", label: "Kühlschrank 1", type: "number", unit: "°C", rule: "range", min: 0, max: 7 },
      { id: "item_fridge2", label: "Kühlschrank 2", type: "number", unit: "°C", rule: "range", min: 0, max: 7 },
      { id: "item_freezer", label: "Tiefkühler", type: "number", unit: "°C", rule: "max",   min: null, max: -18 },
      { id: "item_oven",    label: "Ofen/Backstation Betriebstemperatur", type: "number", unit: "°C", rule: "min", min: 180, max: null },
      { id: "item_dish",    label: "Spülmaschine ≥82°C", type: "boolean", unit: "", rule: "", min: null, max: null },
      { id: "item_sink",    label: "Handwaschbecken Warmwasser", type: "boolean", unit: "", rule: "", min: null, max: null },
    ],
    cleaningPlan: [
      { id: "task_surfaces", name: "Arbeitsflächen desinfizieren", freq: "daily",   area: "Küche" },
      { id: "task_fridge",   name: "Kühlschrank reinigen",        freq: "weekly",  area: "Kältebereich" },
      { id: "task_oven",     name: "Ofen gründlich reinigen",     freq: "weekly",  area: "Backstation" },
      { id: "task_freezer",  name: "Tiefkühler abtauen",          freq: "monthly", area: "Kältebereich" },
    ],
  }];
}

async function loadShops() {
  const now = Date.now();
  if (cache.shops && now - cache.ts < CACHE_MS) return { shops: cache.shops, sha: cache.sha };

  const got = await ghGetContents(SHOPS_PATH);
  if (!got.exists) {
    // init file with default content
    const initial = JSON.stringify(defaultShops(), null, 2);
    const put = await ghPutContents(SHOPS_PATH, initial, undefined, "Initialize shops.json");
    cache = { shops: JSON.parse(initial), sha: put.content.sha, ts: now };
    return { shops: cache.shops, sha: cache.sha };
  }
  const shops = JSON.parse(got.text || "[]");
  cache = { shops, sha: got.sha, ts: now };
  return { shops, sha: got.sha };
}

async function saveShops(nextShops, commitMsg = "Update shops.json") {
  const { sha } = await loadShops();
  const text = JSON.stringify(nextShops, null, 2);
  const put = await ghPutContents(SHOPS_PATH, text, sha, commitMsg);
  cache = { shops: nextShops, sha: put.content.sha, ts: Date.now() };
  return nextShops;
}

// ---- Auth ----
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    return res.json({ token: sign({ role: "admin", email }), role: "admin" });
  }
  // allow staff login with shared code
  if (REGISTRATION_CODE && password === REGISTRATION_CODE) {
    return res.json({ token: sign({ role: "user", email }), role: "user" });
  }
  return res.status(401).json({ error: "Login fehlgeschlagen" });
});

app.get("/api/auth/profile", auth, (req, res) => {
  res.json({ email: req.user.email, role: req.user.role });
});

// ---- Public: read shops (no cache for clients) ----
app.get("/api/shops", async (req, res) => {
  try {
    const { shops } = await loadShops();
    res.set("Cache-Control", "no-store"); // make sure UI always sees latest
    res.json(shops.filter(s => s.active !== false));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Konnte Shops nicht laden" });
  }
});

// ---- Admin CRUD ----
app.get("/api/admin/shops", auth, adminOnly, async (req, res) => {
  try {
    const { shops } = await loadShops();
    res.set("Cache-Control", "no-store");
    res.json(shops);
  } catch (e) {
    res.status(500).json({ error: "Konnte Shops nicht laden" });
  }
});

app.post("/api/admin/shops", auth, adminOnly, async (req, res) => {
  try {
    const shop = req.body || {};
    if (!shop.id) shop.id = "shop_" + Math.random().toString(36).slice(2, 8);
    const { shops } = await loadShops();
    const exists = shops.find(s => s.id === shop.id);
    if (exists) return res.status(409).json({ error: "ID existiert bereits" });
    const next = [...shops, shop];
    await saveShops(next, `Add shop ${shop.name || shop.id}`);
    res.json(shop);
  } catch (e) {
    res.status(500).json({ error: "Speichern fehlgeschlagen" });
  }
});

app.put("/api/admin/shops/:id", auth, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const shop = req.body || {};
    const { shops } = await loadShops();
    const idx = shops.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: "Shop nicht gefunden" });
    const next = shops.slice();
    next[idx] = shop;
    await saveShops(next, `Update shop ${shop.name || id}`);
    res.json(shop);
  } catch (e) {
    res.status(500).json({ error: "Speichern fehlgeschlagen" });
  }
});

app.delete("/api/admin/shops/:id", auth, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { shops } = await loadShops();
    const next = shops.filter(s => s.id !== id);
    await saveShops(next, `Delete shop ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Löschen fehlgeschlagen" });
  }
});

// ---- static files ----
app.use(express.static(path.join(__dirname, "public"), { etag: false, lastModified: false, cacheControl: false }));

// ---- start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`BUNCA server on :${PORT}`);
});
