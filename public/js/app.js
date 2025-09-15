const el = s => document.querySelector(s);
const fmtDate = d => d.toISOString().slice(0,10);

let SHOP = null;
let SHOPS = [];
let TODAY = fmtDate(new Date());
let ENTRY = null;

async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type":"application/json" }, ...opts });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function renderHeader() {
  const sel = el("#shopSelect");
  sel.innerHTML = SHOPS.map(s => `<option value="${s.id}" ${SHOP?.id===s.id?'selected':''}>${s.name}</option>`).join("");
  sel.onchange = async () => {
    SHOP = SHOPS.find(s => s.id === sel.value);
    await loadChecklist();
  };
  el("#logoutBtn").onclick = async () => {
    await api("/api/logout", { method:"POST" });
    location.reload();
  };
}

function ruleBadge(it) {
  if (it.rule === "range") return `(${it.min}–${it.max} ${it.unit||""})`;
  if (it.rule === "min") return `(≥ ${it.min} ${it.unit||""})`;
  if (it.rule === "max") return `(≤ ${it.max} ${it.unit||""})`;
  return "";
}

function renderItems(items, cleaning) {
  const box = el("#items");
  let html = "";

  if (items.length) {
    html += `<h3>Temperaturen / Werte</h3>`;
    for (const it of items) {
      const v = ENTRY?.values?.[it.id] ?? "";
      html += `
        <div class="row item">
          <label class="grow">${it.label} <span class="hint">${ruleBadge(it)}</span></label>
          <input data-id="${it.id}" type="number" step="0.1" value="${v}" class="input sm">
          <div class="unit">${it.unit||""}</div>
        </div>`;
    }
  }

  if (cleaning.length) {
    html += `<h3>Funktionen / Cleaning</h3>`;
    for (const t of cleaning) {
      const done = ENTRY?.tasks?.[t.id]?.done ? "checked" : "";
      html += `
        <label class="row item">
          <input data-task="${t.id}" type="checkbox" ${done}>
          <div class="grow">${t.label} <span class="hint">(${t.frequency}, ${t.area})</span></div>
        </label>`;
    }
  }

  box.innerHTML = html;
}

function computeAlerts(items) {
  let bad = 0, filled = 0;
  for (const it of items) {
    const v = Number(ENTRY?.values?.[it.id]);
    if (!Number.isFinite(v)) continue;
    filled++;
    if (it.rule === "range" && (v < it.min || v > it.max)) bad++;
    if (it.rule === "min" && v < it.min) bad++;
    if (it.rule === "max" && v > it.max) bad++;
  }
  return { bad, filled };
}

async function loadChecklist() {
  const q = new URLSearchParams({ date: TODAY, shop: SHOP?.id || "" }).toString();
  const data = await api(`/api/checklist?${q}`);

  SHOP = data.shop;
  SHOPS = SHOPS.length ? SHOPS : [data.shop]; // safeguard first load
  ENTRY = data.entry;

  renderHeader();

  el("#title").textContent = `HACCP Tages-Checkliste ${TODAY}`;
  el("#notes").value = ENTRY?.notes || "";

  renderItems(data.items, data.cleaning);

  const { bad, filled } = computeAlerts(data.items);
  el("#alertsCount").textContent = bad;
  el("#checksCount").textContent = `${filled}/${data.items.length}`;
  el("#lastSaved").textContent = ENTRY?.savedAt ? new Date(ENTRY.savedAt).toLocaleTimeString() : "–";
}

async function loadShops() {
  const data = await api("/api/shops");
  SHOPS = data.shops || [];
  SHOP = SHOPS.find(s => s.active) || SHOPS[0] || null;
}

async function save() {
  const values = {};
  document.querySelectorAll("input[data-id]").forEach(i => { values[i.dataset.id] = i.value; });

  const tasks = {};
  document.querySelectorAll("input[data-task]").forEach(i => { tasks[i.dataset.task] = { done: i.checked }; });

  const body = { date: TODAY, shopId: SHOP.id, values, tasks, notes: el("#notes").value };
  await api("/api/checklist", { method:"POST", body: JSON.stringify(body) });
  await loadChecklist();
}

el("#resetBtn").onclick = () => location.reload();
el("#saveBtn").onclick = save;

(async function init() {
  await loadShops();
  if (!SHOP) { alert("Kein Shop konfiguriert. Bitte Admin verwenden."); return; }
  await loadChecklist();
})();
