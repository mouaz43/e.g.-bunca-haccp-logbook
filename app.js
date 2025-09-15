/* ============================================================================
   BUNCA HACCP — Pure HTML + JavaScript SPA
   ----------------------------------------------------------------------------
   - LocalStorage data model (users, shops, user_shops, items, checks)
   - Auth (admin/worker), session via sessionStorage
   - Admin: CRUD shops, users, assign to shops, items per shop
   - Worker: daily checks with auto status by min/max
   - History: filters + CSV export
   - Router: #/ paths map to views (home, login, admin, worker, history, info)
   - No backend, no frameworks.
   ============================================================================ */

// ------------------------------- Utilities ----------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  });
  children.flat().forEach(c => n.append(c.nodeType ? c : document.createTextNode(String(c))));
  return n;
};
const todayISO = () => new Date().toISOString().slice(0,10);
const cloneTpl = id => document.importNode($(`template#${id}`).content, true);

// Flash messages
const flashes = [];
function flash(type, msg, timeout = 3000) {
  flashes.push({ type, msg });
  renderFlashes();
  if (timeout) setTimeout(()=>{ flashes.shift(); renderFlashes(); }, timeout);
}
function renderFlashes() {
  const host = $("#flashHost");
  host.innerHTML = flashes.map(f => `<div class="flash ${f.type}">${escapeHtml(f.msg)}</div>`).join("");
}
const escapeHtml = s => String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");

// Forms → object
function formToObj(form) {
  const data = new FormData(form);
  const obj = {};
  for (const [k,v] of data.entries()) obj[k] = v;
  return obj;
}

// ------------------------------- Storage ------------------------------------
const STORE_KEY = "bunca.haccp.v1";
const SESSION_KEY = "bunca.session";

// seed if missing
function loadStore() {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) return JSON.parse(raw);
  const seed = makeSeed();
  localStorage.setItem(STORE_KEY, JSON.stringify(seed));
  return seed;
}
function saveStore(db) { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
function resetStore() { localStorage.removeItem(STORE_KEY); location.hash = "#/login"; location.reload(); }

function makeSeed() {
  // One default shop + items, and a default admin.
  const shops = [
    { id: 1, name: "BUNCA City", code: "CITY", address: "Musterstraße 1, 60311 Frankfurt", active: 1, created_at: new Date().toISOString() }
  ];
  const items = [
    { id: 1, shop_id: 1, name: "Kühlschrank Temperatur", unit: "°C", type: "number", min_value: -1, max_value: 7, sort_order: 1, active: 1 },
    { id: 2, shop_id: 1, name: "Ofen Temperatur (Standby)", unit: "°C", type: "number", min_value: 150, max_value: 250, sort_order: 2, active: 1 },
    { id: 3, shop_id: 1, name: "Espressomaschine Kessel", unit: "°C", type: "number", min_value: 110, max_value: 125, sort_order: 3, active: 1 },
    { id: 4, shop_id: 1, name: "Espresso Ausgabetemperatur", unit: "°C", type: "number", min_value: 60, max_value: 75, sort_order: 4, active: 1 },
    { id: 5, shop_id: 1, name: "Bohnenzustand", unit: "", type: "text", min_value: null, max_value: null, sort_order: 5, active: 1 },
    { id: 6, shop_id: 1, name: "Spülmaschine Temperatur", unit: "°C", type: "number", min_value: 60, max_value: 85, sort_order: 6, active: 1 },
  ];
  const users = [
    { id: 1, email: "admin@bunca.de", password: "Admin!123", role: "admin", active: 1, created_at: new Date().toISOString() }
  ];
  const user_shops = [{ user_id: 1, shop_id: 1 }];
  return { users, shops, user_shops, items, checks: [], seq: { user: 1, shop: 1, item: 6, check: 0 } };
}

let db = loadStore();

// ------------------------------- Auth ---------------------------------------
function currentSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}
function setSession(user) {
  if (user) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id:user.id, email:user.email, role:user.role }));
  else sessionStorage.removeItem(SESSION_KEY);
  toggleNavByAuth();
}
function requireAuth(role=null) {
  const s = currentSession();
  if (!s) { flash("fail","Bitte einloggen."); location.hash = "#/login"; return null; }
  if (role && s.role !== role) { flash("fail","Keine Berechtigung."); location.hash = "#/"; return null; }
  return s;
}
function login(email, password) {
  const u = db.users.find(u => u.email.trim().toLowerCase() === email.trim().toLowerCase() && u.password === password);
  if (!u) return null;
  if (!u.active) { flash("fail","Konto inaktiv."); return null; }
  setSession(u);
  return u;
}
function register(email, password, role) {
  if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) throw new Error("E-Mail existiert bereits");
  const id = ++db.seq.user;
  const user = { id, email, password, role, active: 1, created_at: new Date().toISOString() };
  db.users.push(user);
  saveStore(db);
  return user;
}
function logout(){ setSession(null); }

// Nav visibility depending on auth/role
function toggleNavByAuth() {
  const s = currentSession();
  const outLinks = $$('[data-auth="out"]');
  const inLinks  = $$('[data-auth="in"]');
  const adminLinks = $$('[data-role="admin"]');
  const workerLinks = $$('[data-role="worker"]');
  const logoutLink = $("#logoutLink");

  if (s) {
    outLinks.forEach(x => x.classList.add("hide"));
    inLinks.forEach(x => x.classList.remove("hide"));
    logoutLink.classList.remove("hide");
  } else {
    outLinks.forEach(x => x.classList.remove("hide"));
    inLinks.forEach(x => x.classList.add("hide"));
    logoutLink.classList.add("hide");
  }
  adminLinks.forEach(x => x.classList.toggle("hide", !s || s.role !== "admin"));
  workerLinks.forEach(x => x.classList.toggle("hide", !s || s.role !== "worker"));
}

// ----------------------------- Business Logic -------------------------------
function ensureShopByCode(code, nameIfCreate = null) {
  let shop = db.shops.find(s => (s.code||"").toUpperCase() === String(code).toUpperCase());
  if (!shop) {
    const id = ++db.seq.shop;
    shop = { id, name: nameIfCreate || code, code: code.toUpperCase(), address: "", active: 1, created_at: new Date().toISOString() };
    db.shops.push(shop); saveStore(db);
  }
  return shop;
}

function assignUserToShop(userId, shopId) {
  if (!db.user_shops.some(us => us.user_id===userId && us.shop_id===shopId)) {
    db.user_shops.push({ user_id:userId, shop_id:shopId });
    saveStore(db);
  }
}

function shopsForUser(userId, role) {
  if (role === "admin") return db.shops.filter(s => s.active);
  const ids = db.user_shops.filter(x => x.user_id===userId).map(x => x.shop_id);
  return db.shops.filter(s => ids.includes(s.id) && s.active);
}

function itemsForShop(shopId) {
  return db.items.filter(i => i.shop_id===shopId && i.active).sort((a,b)=> a.sort_order - b.sort_order || a.id - b.id);
}

function statusFor(value, min, max, isText=false) {
  if (isText) return value && String(value).trim() ? "ok" : "warn";
  if (value===null || value===undefined || value==="") return "warn";
  const n = Number(value);
  if (!Number.isFinite(n)) return "warn";
  if (min!=null && n < Number(min)) return "fail";
  if (max!=null && n > Number(max)) return "fail";
  return "ok";
}

function addCheck({shop_id, user_id, item_id, date, value_number, value_text, note}) {
  const id = ++db.seq.check;
  const it = db.items.find(i => i.id===item_id);
  const st = it.type==="number"
    ? statusFor(value_number, it.min_value, it.max_value, false)
    : statusFor(value_text, null, null, true);
  db.checks.push({
    id, shop_id, user_id, item_id, date,
    value_number: it.type==="number" ? Number(value_number) : null,
    value_text: it.type==="text" ? String(value_text||"") : null,
    status: st, note: note||"", created_at: new Date().toISOString()
  });
  saveStore(db);
  return st;
}

// History query
function queryHistory({shopId="", from="", to="", status=""}) {
  let rows = db.checks.map(c => ({
    ...c,
    shop_name: (db.shops.find(s => s.id===c.shop_id)||{}).name || "",
    item_name: (db.items.find(i => i.id===c.item_id)||{}).name || "",
    user_email: (db.users.find(u => u.id===c.user_id)||{}).email || ""
  }));
  if (shopId) rows = rows.filter(r => r.shop_id === Number(shopId));
  if (from)   rows = rows.filter(r => r.date >= from);
  if (to)     rows = rows.filter(r => r.date <= to);
  if (status) rows = rows.filter(r => r.status === status);
  rows.sort((a,b)=> b.date.localeCompare(a.date) || b.id - a.id);
  return rows.slice(0, 1000);
}
function toCSV(rows) {
  const head = ["date","shop","item","value","status","user","note"];
  const out = [head.join(",")];
  for (const r of rows) {
    const v = r.value_text ?? r.value_number ?? "";
    const esc = s => `"${String(s).replaceAll('"','""')}"`;
    out.push([r.date, r.shop_name, r.item_name, v, r.status, r.user_email, r.note||""].map(esc).join(","));
  }
  return out.join("\n");
}

// ------------------------------- Router -------------------------------------
const routes = {
  "": renderHome,
  "/": renderHome,
  "/login": renderLogin,
  "/logout": () => { logout(); flash("ok","Abgemeldet."); renderHome(); },
  "/admin": renderAdmin,
  "/worker": renderWorker,
  "/history": renderHistory,
  "/info": renderInfo,
  "/impressum": () => injectView("tpl-legal-impressum"),
  "/datenschutz": () => injectView("tpl-legal-datenschutz"),
};

function router() {
  const hash = location.hash.replace(/^#/, "");
  const path = (hash || "/").split("?")[0];
  const fn = routes[path] || (() => injectView("tpl-404"));
  fn();
}
window.addEventListener("hashchange", router);
window.addEventListener("load", () => {
  toggleNavByAuth();
  router();
});

// ----------------------------- Rendering ------------------------------------
function injectView(tplId) {
  const host = $("#viewHost");
  host.innerHTML = "";
  host.append(cloneTpl(tplId));
}

// Home
function renderHome() {
  injectView("tpl-home");
}

// Login & Register
function renderLogin() {
  injectView("tpl-login");
  const loginForm = $("#loginForm");
  const registerForm = $("#registerForm");
  $("#toRegister").addEventListener("click", ()=> { registerForm.scrollIntoView({behavior:"smooth"}); });

  loginForm.addEventListener("submit", (e)=>{
    e.preventDefault();
    const { email, password } = formToObj(loginForm);
    const u = login(email, password);
    if (!u) return flash("fail","Login fehlgeschlagen.");
    flash("ok",`Willkommen ${u.email}`);
    location.hash = u.role==="admin" ? "#/admin" : "#/worker";
  });

  registerForm.addEventListener("submit", (e)=>{
    e.preventDefault();
    const { email, password, role } = formToObj(registerForm);
    try{
      const u = register(email, password, role);
      // auto-assign default shop
      assignUserToShop(u.id, db.shops[0].id);
      saveStore(db);
      flash("ok","Registriert. Du kannst dich nun einloggen.");
      loginForm.scrollIntoView({behavior:"smooth"});
    }catch(err){
      flash("fail", err.message || "Registrierung fehlgeschlagen.");
    }
  });
}

// Admin
function renderAdmin() {
  const ses = requireAuth("admin"); if (!ses) return;
  injectView("tpl-admin");

  const tblShops = $("#tblShops tbody");
  const tblUsers = $("#tblUsers tbody");
  const selShopForItems = $("#formPickShopForItems select[name=shopId]");
  const tblItems = $("#tblItems");
  const formCreateItem = $("#formCreateItem");
  const formCreateShop = $("#formCreateShop");
  const formCreateUser = $("#formCreateUser");
  const formPickShopForItems = $("#formPickShopForItems");

  // ------ Shops ------
  function refreshShops() {
    tblShops.innerHTML = "";
    db.shops.filter(s=>s.active).forEach(s => {
      const tr = el("tr",{},[
        el("td",{},[s.name]),
        el("td",{},[s.code || ""]),
        el("td",{},[s.address || ""]),
        el("td",{},[
          el("button",{class:"btn btn-ghost",onclick:()=>{ selShopForItems.value=String(s.id); loadItems(); }},["Items"]),
          el("button",{class:"btn btn-danger",onclick:()=>{ s.active=0; saveStore(db); refreshShops(); flash("ok","Shop gelöscht."); }},["Löschen"]),
        ])
      ]);
      tblShops.append(tr);
    });
    // fill select
    selShopForItems.innerHTML = db.shops.filter(s=>s.active).map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
  }
  refreshShops();

  formCreateShop.addEventListener("submit",(e)=>{
    e.preventDefault();
    const { name, code, address } = formToObj(formCreateShop);
    const id = ++db.seq.shop;
    db.shops.push({ id, name, code: (code||"").toUpperCase(), address, active:1, created_at:new Date().toISOString() });
    saveStore(db);
    formCreateShop.reset();
    refreshShops();
    flash("ok","Shop erstellt.");
  });

  // ------ Users ------
  function shopsBadgesForUser(uid){
    const ids = db.user_shops.filter(x=>x.user_id===uid).map(x=>x.shop_id);
    return ids.map(id => {
      const s = db.shops.find(x=>x.id===id);
      return s ? `<span class="pill">${escapeHtml(s.code||s.name)}</span>` : "";
    }).join(" ");
  }
  function refreshUsers(){
    tblUsers.innerHTML="";
    db.users.forEach(u=>{
      const tr = el("tr",{},[
        el("td",{},[u.email]),
        el("td",{},[u.role]),
        el("td",{},[u.active ? "aktiv" : "inaktiv"]),
        el("td",{},[el("span",{class:"muted"},[el("span",{innerHTML: shopsBadgesForUser(u.id)})])]),
        el("td",{},[
          el("button",{class:"btn btn-ghost",onclick:()=>{u.active= u.active?0:1; saveStore(db); refreshUsers();}},[u.active?"Deaktivieren":"Aktivieren"]),
          el("button",{class:"btn btn-ghost",onclick:()=>{
            const code = prompt("Shop-Code zuweisen (z.B. CITY):","");
            if (!code) return;
            const s = ensureShopByCode(code, code);
            assignUserToShop(u.id, s.id);
            refreshUsers(); flash("ok","Zugewiesen.");
          }},["Shop zuweisen"]),
          el("button",{class:"btn btn-danger",onclick:()=>{
            if (!confirm("Benutzer wirklich löschen?")) return;
            db.user_shops = db.user_shops.filter(us=>us.user_id!==u.id);
            db.users = db.users.filter(x=>x.id!==u.id);
            saveStore(db); refreshUsers(); flash("ok","Benutzer gelöscht.");
          }},["Löschen"])
        ])
      ]);
      tblUsers.append(tr);
    });
  }
  refreshUsers();

  formCreateUser.addEventListener("submit",(e)=>{
    e.preventDefault();
    const { email, password, role, shopCode } = formToObj(formCreateUser);
    try{
      const u = register(email,password,role);
      if (shopCode) assignUserToShop(u.id, ensureShopByCode(shopCode, shopCode).id);
      saveStore(db);
      formCreateUser.reset(); refreshUsers();
      flash("ok","Benutzer erstellt.");
    }catch(err){ flash("fail",err.message||"Fehler."); }
  });

  // ------ Items ------
  function loadItems(){
    const shopId = Number(selShopForItems.value || db.shops[0]?.id);
    tblItems.innerHTML = "";
    itemsForShop(shopId).forEach(i=>{
      const tr = el("tr",{},[
        el("td",{},[String(i.sort_order)]),
        el("td",{},[i.name]),
        el("td",{},[i.type]),
        el("td",{},[i.min_value ?? ""]),
        el("td",{},[i.max_value ?? ""]),
        el("td",{},[i.unit || ""]),
        el("td",{},[
          el("button",{class:"btn btn-danger",onclick:()=>{
            i.active=0; saveStore(db); loadItems(); flash("ok","Item gelöscht.");
          }},["Löschen"])
        ])
      ]);
      tblItems.append(tr);
    });
  }
  formPickShopForItems.addEventListener("submit",(e)=>{ e.preventDefault(); loadItems(); });
  formCreateItem.addEventListener("submit",(e)=>{
    e.preventDefault();
    const shopId = Number(selShopForItems.value || db.shops[0]?.id);
    const { name, type, unit, min, max, sort } = formToObj(formCreateItem);
    const id = ++db.seq.item;
    db.items.push({
      id, shop_id: shopId, name, unit, type,
      min_value: min===""?null:Number(min), max_value: max===""?null:Number(max),
      sort_order: Number(sort||0), active:1
    });
    saveStore(db); formCreateItem.reset(); loadItems(); flash("ok","Item hinzugefügt.");
  });

  // initial items load
  if (db.shops.length) { selShopForItems.value = String(db.shops[0].id); loadItems(); }
}

// Worker (Daily Check)
function renderWorker() {
  const ses = requireAuth("worker") || requireAuth("admin"); // allow admin to try
  if (!ses) return;
  injectView("tpl-worker");

  const selShop = $("#formPickShopForDaily select[name=shopId]");
  const inputDate = $("#formPickShopForDaily input[name=date]");
  const formPick = $("#formPickShopForDaily");
  const formDaily = $("#formDaily");

  // fill shops
  const shops = shopsForUser(ses.id, ses.role);
  selShop.innerHTML = shops.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
  inputDate.value = todayISO();

  function renderDailyForm() {
    const shopId = Number(selShop.value || shops[0]?.id);
    const items = itemsForShop(shopId);
    formDaily.innerHTML = "";
    if (!items.length) return formDaily.append(el("p",{class:"muted"},["Keine Items definiert."]));
    items.forEach(i=>{
      const nameAttr = i.type==="number" ? `num_${i.id}` : `txt_${i.id}`;
      const hint = (i.min_value!=null || i.max_value!=null) ? `Grenzen: ${i.min_value ?? "–"} bis ${i.max_value ?? "–"} ${i.unit||""}` : "";
      const control = i.type==="number"
        ? el("input",{class:"input",name:nameAttr,type:"number",step:"0.1",placeholder:i.unit||"",required:true})
        : el("input",{class:"input",name:nameAttr,type:"text",placeholder:"OK / Hinweis",required:true});
      formDaily.append(
        el("label",{},[
          el("span",{},[`${i.name}${i.unit?` (${i.unit})`:""}`]),
          control,
          el("span",{class:"muted",style:"font-size:12px"},[hint])
        ])
      );
    });
    formDaily.append(
      el("label",{},[el("span",{},["Allgemeine Notiz (optional)"]), el("textarea",{class:"input",name:"note",rows:"3",placeholder:"Auffälligkeiten, Maßnahmen ..."})])
    );
    formDaily.append(el("button",{class:"btn btn-primary",type:"submit"},["Check senden"]));
  }

  formPick.addEventListener("submit",(e)=>{ e.preventDefault(); renderDailyForm(); });
  renderDailyForm();

  formDaily.addEventListener("submit",(e)=>{
    e.preventDefault();
    const shopId = Number(selShop.value);
    const date = inputDate.value || todayISO();
    const data = formToObj(formDaily);
    let worst = "ok";
    const items = itemsForShop(shopId);
    items.forEach(i=>{
      const numKey = `num_${i.id}`, txtKey = `txt_${i.id}`;
      const vNum = data[numKey] ?? null;
      const vTxt = data[txtKey] ?? null;
      const st = addCheck({
        shop_id: shopId, user_id: ses.id, item_id: i.id, date,
        value_number: i.type==="number" ? vNum : null,
        value_text: i.type==="text" ? vTxt : null,
        note: data.note || ""
      });
      if (st==="fail" || (st==="warn" && worst!=="fail")) worst = st;
    });
    flash(worst==="ok"?"ok":worst, `Daily Check gespeichert (${worst.toUpperCase()}).`);
    formDaily.reset();
  });
}

// History
function renderHistory() {
  const ses = requireAuth(); if (!ses) return;
  injectView("tpl-history");

  const selShop = $("#formHistoryFilters select[name=shopId]");
  const inputFrom = $("#formHistoryFilters input[name=from]");
  const inputTo   = $("#formHistoryFilters input[name=to]");
  const selStatus = $("#formHistoryFilters select[name=status]");
  const form = $("#formHistoryFilters");
  const tbody = $("#tblHistoryRows");
  const btnCsv = $("#btnExportCsv");

  // fill shops
  const shops = ses.role==="admin" ? db.shops.filter(s=>s.active) : shopsForUser(ses.id, ses.role);
  selShop.innerHTML = `<option value="">Alle</option>` + shops.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");

  function renderRows() {
    const rows = queryHistory({
      shopId: selShop.value,
      from: inputFrom.value,
      to: inputTo.value,
      status: selStatus.value
    });
    tbody.innerHTML = "";
    rows.forEach(r=>{
      const v = r.value_text ?? r.value_number ?? "";
      const tr = el("tr",{},[
        el("td",{},[r.date]),
        el("td",{},[r.shop_name]),
        el("td",{},[r.item_name]),
        el("td",{},[String(v)]),
        el("td",{},[el("span",{class:`kpi ${r.status}`},[r.status])]),
        el("td",{},[r.user_email]),
        el("td",{},[r.note||""])
      ]);
      tbody.append(tr);
    });
  }
  form.addEventListener("submit",(e)=>{ e.preventDefault(); renderRows(); });
  btnCsv.addEventListener("click", ()=>{
    const rows = queryHistory({
      shopId: selShop.value, from: inputFrom.value, to: inputTo.value, status: selStatus.value
    });
    const csv = toCSV(rows);
    const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = el("a",{href:url,download:"history.csv"}); document.body.append(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  renderRows();
}

// Info
function renderInfo(){ injectView("tpl-info"); }

// ------------------------------ Extras --------------------------------------
// Keep nav in sync when clicking Logout (route handler already logs out).
document.addEventListener("click", (e)=>{
  const a = e.target.closest('a[href="#/logout"]');
  if (a) setTimeout(()=>toggleNavByAuth(), 0);
});

// Developer helpers (optional)
// window.resetStore = resetStore;
// window.db = db;
