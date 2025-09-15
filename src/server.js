// ESM server. Requires: GITHUB_TOKEN, GITHUB_REPO (owner/repo), GITHUB_BRANCH (e.g. main)
// Optional: ADMIN_EMAIL, ADMIN_PASSWORD, DEFAULT_SHOP
import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { Octokit } from "octokit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cookieParser());
app.use(bodyParser.json({ limit: "1mb" }));

// Simple session (memory store is fine for one instance)
app.use(
  session({
    secret: process.env.JWT_SECRET || "change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: "lax" }
  })
);

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const DEFAULT_SHOP = process.env.DEFAULT_SHOP || "bunca-city";

const DATA_DIR = path.join(__dirname, "..", "data");
const SHOPS_FILE = path.join(DATA_DIR, "shops.json");
const ENTRIES_DIR = path.join(DATA_DIR, "entries");

const repoFull = process.env.GITHUB_REPO; // e.g. "mouaz43/e-g-bunca-haccp-logbook"
const [owner, repo] = (repoFull || "").split("/");
const branch = process.env.GITHUB_BRANCH || "main";
const gh = process.env.GITHUB_TOKEN ? new Octokit({ auth: process.env.GITHUB_TOKEN }) : null;

async function ensureDirs() {
  for (const p of [DATA_DIR, ENTRIES_DIR]) {
    try { await mkdir(p, { recursive: true }); } catch {}
  }
}
await ensureDirs();

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function readJSON(p, fallback = null) {
  if (!(await fileExists(p))) return fallback;
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch { return fallback; }
}

async function writeJSONLocal(p, obj) {
  await writeFile(p, JSON.stringify(obj, null, 2), "utf8");
}

async function getGitHubFileSha(filePath) {
  if (!gh) return null;
  try {
    const res = await gh.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner, repo, path: filePath, ref: branch
    });
    return res.data.sha;
  } catch {
    return null; // not found
  }
}

async function commitToGitHub(filePath, contentString, message) {
  if (!gh || !owner || !repo) return; // silently skip if no token
  const sha = await getGitHubFileSha(filePath);
  // base64 content
  const b64 = Buffer.from(contentString, "utf8").toString("base64");
  await gh.request("PUT /repos/{owner}/{repo}/contents/{path}", {
    owner, repo, path: filePath, message,
    content: b64, branch, sha: sha || undefined
  });
}

// ---------- AUTH ----------
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "bad_credentials" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- SHOPS (CONFIG) ----------
app.get("/api/shops", async (req, res) => {
  const data = await readJSON(SHOPS_FILE, { shops: [] });
  res.json({ ok: true, ...data });
});

// saves the entire shops array from Admin dialog
app.post("/api/shops", requireAdmin, async (req, res) => {
  const { shops } = req.body || {};
  if (!Array.isArray(shops)) return res.status(400).json({ ok: false, error: "invalid_payload" });

  // normalize basic fields so UI doesn't break
  for (const s of shops) {
    s.id ||= s.name?.toLowerCase().replace(/\s+/g, "-") || `shop_${Math.random().toString(36).slice(2,8)}`;
    s.active = !!s.active;
    s.checklist ||= [];
    s.cleaning ||= [];
  }

  const payload = { shops };
  await writeJSONLocal(SHOPS_FILE, payload);
  // push to GitHub (same relative path as in repo)
  await commitToGitHub("data/shops.json", JSON.stringify(payload, null, 2), "chore: update shops.json via app");
  res.json({ ok: true });
});

// ---------- DAILY ENTRIES ----------
app.get("/api/checklist", async (req, res) => {
  const date = (req.query.date || new Date().toISOString().slice(0,10));
  const shopId = req.query.shop || DEFAULT_SHOP;

  const shopsData = await readJSON(SHOPS_FILE, { shops: [] });
  const shop = shopsData.shops.find(s => s.id === shopId) || shopsData.shops.find(s => s.active) || shopsData.shops[0];

  if (!shop) return res.json({ ok: true, shop: null, items: [], cleaning: [], entry: null });

  const entryPath = path.join(ENTRIES_DIR, `${date}__${shop.id}.json`);
  const entry = await readJSON(entryPath, null);

  res.json({
    ok: true,
    shop,
    items: shop.checklist || [],
    cleaning: shop.cleaning || [],
    entry
  });
});

app.post("/api/checklist", async (req, res) => {
  const { date, shopId, values, tasks, notes } = req.body || {};
  if (!date || !shopId) return res.status(400).json({ ok: false, error: "missing_date_or_shop" });

  const entry = {
    date, shopId,
    values: values || {},         // map itemId -> value
    tasks: tasks || {},           // map taskId -> {done:true/false}
    notes: notes || "",
    savedAt: new Date().toISOString()
  };

  const entryPath = path.join(ENTRIES_DIR, `${date}__${shopId}.json`);
  await writeJSONLocal(entryPath, entry);

  // commit to GitHub at data/entries/<date>__<shopId>.json
  await commitToGitHub(`data/entries/${date}__${shopId}.json`, JSON.stringify(entry, null, 2), `save: entry ${date} ${shopId}`);

  res.json({ ok: true });
});

// ---------- STATIC ----------
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

// fallback to index
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("BUNCA HACCP server on", PORT);
});
