const el = s => document.querySelector(s);

let SHOPS = [];
let editingIdx = -1;

async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type":"application/json" }, ...opts });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function uid(prefix) { return `${prefix}_${Math.random().toString(36).slice(2,8)}`; }

function renderList() {
  const box = el("#shopsList");
  if (!SHOPS.length) { box.innerHTML = "<div class='muted'>Noch keine Shops.</div>"; return; }
  box.innerHTML = `
    <div class="thead">
      <div>Name</div><div>Stadt</div><div>Adresse</div><div>Aktiv</div><div>Aktion</div>
    </div>
    ${SHOPS.map((s, i)=>`
      <div class="trow">
        <div>${s.name}</div>
        <div>${s.city||"–"}</div>
        <div>${s.address||"–"}</div>
        <div>${s.active ? "<span class='badge ok'>aktiv</span>" : "<span class='badge'>inaktiv</span>"}</div>
        <div class="row gap">
          <button class="btn" onclick="editShop(${i})">✏️</button>
          <button class="btn" onclick="delShop(${i})">🗑️</button>
        </div>
      </div>
    `).join("")}
  `;
}

function itemRow(it) {
  return `
  <div class="grid6 itemrow" data-id="${it.id}">
    <input class="i_label" placeholder="Label" value="${it.label||""}">
    <select class="i_type">
      <option value="number" ${it.type==="number"?"selected":""}>Zahl</option>
      <option value="boolean" ${it.type==="boolean"?"selected":""}>Ja/Nein</option>
    </select>
    <input class="i_unit" placeholder="Einheit (z.B. °C)" value="${it.unit||""}">
    <select class="i_rule">
      <option value="range" ${it.rule==="range"?"selected":""}>↔ Bereich</option>
      <option value="min" ${it.rule==="min"?"selected":""}>≥ Minimum</option>
      <option value="max" ${it.rule==="max"?"selected":""}>≤ Maximum</option>
    </select>
    <input type="number" class="i_min" placeholder="Min" value="${it.min ?? ""}">
    <input type="number" class="i_max" placeholder="Max" value="${it.max ?? ""}">
    <button class="btn danger sm item-del" type="button">x</button>
  </div>`;
}

function taskRow(t) {
  return `
  <div class="grid4 itemrow" data-id="${t.id}">
    <input class="t_label" placeholder="Aufgabe" value="${t.label||""}">
    <input class="t_freq" placeholder="Frequenz (z. B. täglich)" value="${t.frequency||"täglich"}">
    <input class="t_area" placeholder="Bereich (z. B. Küche)" value="${t.area||""}">
    <button class="btn danger sm task-del" type="button">x</button>
  </div>`;
}

function openDlgFor(shop, idx) {
  editingIdx = idx;
  el("#s_name").value = shop.name || "";
  el("#s_city").value = shop.city || "";
  el("#s_addr").value = shop.address || "";
  el("#s_active").checked = !!shop.active;

  const itemsTable = el("#itemsTable");
  itemsTable.innerHTML = (shop.checklist||[]).map(itemRow).join("");
  itemsTable.querySelectorAll(".item-del").forEach(btn => {
    btn.onclick = (e) => e.currentTarget.closest(".itemrow").remove();
  });

  const tasksTable = el("#tasksTable");
  tasksTable.innerHTML = (shop.cleaning||[]).map(taskRow).join("");
  tasksTable.querySelectorAll(".task-del").forEach(btn => {
    btn.onclick = (e) => e.currentTarget.closest(".itemrow").remove();
  });

  el("#addItem").onclick = () => {
    itemsTable.insertAdjacentHTML("beforeend", itemRow({ id: uid("item"), type:"number", rule:"range" }));
    itemsTable.querySelectorAll(".item-del").forEach(btn => btn.onclick = (e)=> e.currentTarget.closest(".itemrow").remove());
  };

  el("#addTask").onclick = () => {
    tasksTable.insertAdjacentHTML("beforeend", taskRow({ id: uid("task"), frequency:"täglich" }));
    tasksTable.querySelectorAll(".task-del").forEach(btn => btn.onclick = (e)=> e.currentTarget.closest(".itemrow").remove());
  };

  const dlg = el("#shopDlg");
  dlg.showModal();

  el("#saveShop").onclick = async () => {
    // collect rows
    const items = [...itemsTable.querySelectorAll(".itemrow")].map(r => ({
      id: r.dataset.id,
      label: r.querySelector(".i_label").value,
      type: r.querySelector(".i_type").value,
      unit: r.querySelector(".i_unit").value,
      rule: r.querySelector(".i_rule").value,
      min: r.querySelector(".i_min").value === "" ? undefined : Number(r.querySelector(".i_min").value),
      max: r.querySelector(".i_max").value === "" ? undefined : Number(r.querySelector(".i_max").value)
    }));

    const tasks = [...tasksTable.querySelectorAll(".itemrow")].map(r => ({
      id: r.dataset.id,
      label: r.querySelector(".t_label").value,
      frequency: r.querySelector(".t_freq").value,
      area: r.querySelector(".t_area").value
    }));

    const updated = {
      ...shop,
      name: el("#s_name").value.trim(),
      city: el("#s_city").value.trim(),
      address: el("#s_addr").value.trim(),
      active: el("#s_active").checked,
      checklist: items,
      cleaning: tasks
    };

    if (editingIdx >= 0) SHOPS[editingIdx] = updated;
    else {
      updated.id = updated.id || updated.name.toLowerCase().replace(/\s+/g, "-");
      SHOPS.push(updated);
    }

    await api("/api/shops", { method:"POST", body: JSON.stringify({ shops: SHOPS }) });
    dlg.close();
    await loadShops();
  };
}

window.editShop = (idx) => openDlgFor(SHOPS[idx], idx);
window.delShop = async (idx) => {
  if (!confirm("Shop wirklich löschen?")) return;
  SHOPS.splice(idx, 1);
  await api("/api/shops", { method:"POST", body: JSON.stringify({ shops: SHOPS }) });
  renderList();
};

el("#newShopBtn").onclick = () => openDlgFor({ id: "", name: "", active: true, checklist: [], cleaning: [] }, -1);

async function loadShops() {
  const data = await api("/api/shops");
  SHOPS = data.shops || [];
  renderList();
}

loadShops();
