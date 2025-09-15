// BUNCA HACCP — Render + GitHub JSON storage
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Octokit } = require("@octokit/rest");
const { stringify } = require("csv-stringify/sync");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const {
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_BRANCH = "main",
  JWT_SECRET = "dev-secret",
  DEFAULT_SHOP = "BUNCA · Hauptbahnhof",
  REGISTRATION_CODE
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.error("Missing GITHUB_TOKEN or GITHUB_REPO env vars.");
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const [owner, repo] = (GITHUB_REPO || "").split("/");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const slug = s =>
  s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

// ---------- GitHub helpers ----------
async function getFile(filePath) {
  try {
    const { data } = await octokit.repos.getContent({
      owner, repo, path: filePath, ref: GITHUB_BRANCH
    });
    if (Array.isArray(data)) throw new Error("Expected file, got directory");
    const content = Buffer.from(data.content, "base64").toString("utf8");
    return { content, sha: data.sha };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function putFile(filePath, content, message, sha) {
  return await octokit.repos.createOrUpdateFileContents({
    owner, repo, path: filePath, branch: GITHUB_BRANCH, message,
    content: Buffer.from(content).toString("base64"),
    sha
  });
}

async function ensureBootstrap() {
  // Ensure data folders & base files
  const shopsPath = "data/shops.json";
  const usersPath = "data/users.json";

  let shops = await getJSON(shopsPath);
  if (!shops) {
    shops = [{ id: slug(DEFAULT_SHOP), name: DEFAULT_SHOP }];
    await saveJSON(shopsPath, shops, "bootstrap: shops.json");
  }

  let users = await getJSON(usersPath);
  if (!users) {
    // default admin (password from env is optional; else 'admin1234')
    const adminPass = process.env.ADMIN_PASSWORD || "admin1234";
    const hash = await bcrypt.hash(adminPass, 10);
    users = [{
      id: uuidv4(),
      email: process.env.ADMIN_EMAIL || "admin@bunca.local",
      passwordHash: hash,
      role: "admin",
      shopId: shops[0].id
    }];
    await saveJSON(usersPath, users, "bootstrap: users.json (admin)");
    console.log("Bootstrap admin created:",
      (process.env.ADMIN_EMAIL || "admin@bunca.local"),
      "pass:", adminPass);
  }
}

async function getJSON(filePath) {
  const f = await getFile(filePath);
  if (!f) return null;
  try { return JSON.parse(f.content); } catch { return null; }
}

async function saveJSON(filePath, obj, message) {
  const existing = await getFile(filePath);
  const json = JSON.stringify(obj, null, 2) + "\n";
  await putFile(filePath, json, message || `update ${filePath}`, existing?.sha);
}

// ---------- Auth ----------
function sign(user) {
  return jwt.sign({ uid: user.id, role: user.role, shopId: user.shopId }, JWT_SECRET, { expiresIn: "14d" });
}

function authRequired(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// ---------- API ----------
app.get("/api/me", async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (!token) return res.json({ user: null });
    const payload = jwt.verify(token, JWT_SECRET);
    const users = await getJSON("data/users.json");
    const user = users.find(u => u.id === payload.uid);
    if (!user) return res.json({ user: null });
    const shops = await getJSON("data/shops.json");
    const shop = shops.find(s => s.id === user.shopId);
    res.json({ user: { id: user.id, email: user.email, role: user.role, shopId: user.shopId }, shop });
  } catch {
    res.json({ user: null });
  }
});

app.get("/api/shops", async (req, res) => {
  const shops = await getJSON("data/shops.json");
  res.json({ shops: shops || [] });
});

app.post("/api/register", async (req, res) => {
  try {
    if (!REGISTRATION_CODE) return res.status(403).json({ error: "Registrierung deaktiviert" });
    const { code, email, password, shopId } = req.body || {};
    if (code !== REGISTRATION_CODE) return res.status(403).json({ error: "Falscher Registrierungscode" });
    if (!email || !password || !shopId) return res.status(400).json({ error: "Missing fields" });

    const shops = await getJSON("data/shops.json");
    if (!shops.find(s => s.id === shopId)) return res.status(400).json({ error: "Unbekannter Shop" });

    const usersPath = "data/users.json";
    const users = (await getJSON(usersPath)) || [];
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
      return res.status(409).json({ error: "E-Mail bereits vorhanden" });
    }
    const hash = await bcrypt.hash(password, 10);
    const newUser = { id: uuidv4(), email, passwordHash: hash, role: "shop", shopId };
    users.push(newUser);
    await saveJSON(usersPath, users, `user: register ${email}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Register failed" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  const users = await getJSON("data/users.json");
  const user = users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user) return res.status(401).json({ error: "Login fehlgeschlagen" });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Login fehlgeschlagen" });

  res.cookie("token", sign(user), { httpOnly: true, sameSite: "lax", maxAge: 14 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

// Read today’s checklist
app.get("/api/checks/:shopId/:date", authRequired, async (req, res) => {
  const { shopId, date } = req.params;
  if (req.user.role !== "admin" && req.user.shopId !== shopId) return res.status(403).json({ error: "Forbidden" });
  const fp = `data/checks/${shopId}/${date}.json`;
  const row = await getJSON(fp);
  res.json({ row: row || null });
});

// Save/Upsert today’s checklist
app.post("/api/checks/:shopId/:date", authRequired, async (req, res) => {
  const { shopId, date } = req.params;
  if (req.user.role !== "admin" && req.user.shopId !== shopId) return res.status(403).json({ error: "Forbidden" });
  const fp = `data/checks/${shopId}/${date}.json`;
  await saveJSON(fp, req.body, `checklist: ${shopId} ${date}`);
  res.json({ ok: true });
});

// Simple history list by directory scan
app.get("/api/history/:shopId", authRequired, async (req, res) => {
  const { shopId } = req.params;
  if (req.user.role !== "admin" && req.user.shopId !== shopId) return res.status(403).json({ error: "Forbidden" });
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: `data/checks/${shopId}`, ref: GITHUB_BRANCH });
    const files = Array.isArray(data) ? data.filter(d => d.type === "file").map(d => d.name.replace(".json","")).sort().reverse() : [];
    res.json({ dates: files });
  } catch (e) {
    if (e.status === 404) return res.json({ dates: [] });
    throw e;
  }
});

// CSV export (last 30 days)
app.get("/api/export/:shopId.csv", authRequired, async (req, res) => {
  const { shopId } = req.params;
  if (req.user.role !== "admin" && req.user.shopId !== shopId) return res.status(403).end();
  // list dir
  let files = [];
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: `data/checks/${shopId}`, ref: GITHUB_BRANCH });
    files = Array.isArray(data) ? data.filter(d => d.type === "file").map(d => d.name).sort().slice(-30) : [];
  } catch {}
  const rows = [];
  for (const f of files) {
    const date = f.replace(".json","");
    const obj = await getJSON(`data/checks/${shopId}/${f}`);
    rows.push({
      date,
      fridge1_c: obj?.fridge1_c ?? "",
      fridge2_c: obj?.fridge2_c ?? "",
      freezer_c: obj?.freezer_c ?? "",
      oven_c: obj?.oven_c ?? "",
      dishwasher_rinse_c: obj?.dishwasher_rinse_c ?? "",
      warm_water_available: obj?.warm_water_available ?? "",
      cleaning_done: obj?.cleaning_done ?? "",
      notes: obj?.notes ?? "",
      issues: obj?.issues ?? ""
    });
  }
  const csv = stringify(rows, { header: true });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${shopId}-export.csv"`);
  res.send(csv);
});

// Fallback
app.get("/healthz", (_, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  await ensureBootstrap();
  console.log("BUNCA HACCP running on :" + port);
});
