// assets/js/checklist.js
// Simple localStorage store keyed by shop + date, no backend required.

const BUNCA_PREFIX = "bunca:haccp";
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function keyFor(shop, date) {
  return `${BUNCA_PREFIX}:${shop}:${date}`;
}

function getSelectedShop() {
  const el = qs("#shopSelect");
  if (!el) return localStorage.getItem(`${BUNCA_PREFIX}:shop`) || "hauptbahnhof";
  return el.value;
}

function setSelectedShop(value) {
  localStorage.setItem(`${BUNCA_PREFIX}:shop`, value);
}

function loadChecklist(shop, date) {
  const raw = localStorage.getItem(keyFor(shop, date));
  return raw ? JSON.parse(raw) : null;
}

function saveChecklist(shop, date, data) {
  localStorage.setItem(keyFor(shop, date), JSON.stringify(data));
  localStorage.setItem(`${BUNCA_PREFIX}:lastSaved`, new Date().toISOString());
}

function deleteAllForShop(shop) {
  const keys = Object.keys(localStorage);
  keys.forEach(k => {
    if (k.startsWith(`${BUNCA_PREFIX}:${shop}:`)) {
      localStorage.removeItem(k);
    }
  });
}

function allDaysForShop(shop) {
  return Object.keys(localStorage)
    .filter(k => k.startsWith(`${BUNCA_PREFIX}:${shop}:`))
    .map(k => k.split(":").pop())
    .sort()
    .reverse();
}

// Temperature helpers (visual hints only)
const ranges = {
  k1: { min: 0, max: 7 },
  k2: { min: 0, max: 7 },
  tf: { max: -18 }, // <= -18
  ofen: { min: 180 }
};

function hintTemp(id, val) {
  const hint = qs(`#hint_${id}`);
  if (!hint) return;

  if (val === "" || val === null || isNaN(Number(val))) {
    hint.textContent = "";
    return;
  }

  const n = Number(val);
  let ok = true;
  if (id === "tf") ok = n <= ranges.tf.max;
  else if (id === "ofen") ok = n >= ranges.ofen.min;
  else ok = n >= ranges[id].min && n <= ranges[id].max;

  hint.innerHTML = ok
    ? `<span class="badge bg-success-subtle text-success"><i class="bi bi-check-circle me-1"></i>im Zielbereich</span>`
    : `<span class="badge bg-danger-subtle text-danger"><i class="bi bi-x-octagon me-1"></i>außerhalb Zielbereich</span>`;

  return ok;
}

function checklistFromForm() {
  const data = {
    date: todayISO(),
    shop: getSelectedShop(),
    temps: {
      k1: parseFloat(qs("#temp_k1")?.value || ""),
      k2: parseFloat(qs("#temp_k2")?.value || ""),
      tf: parseFloat(qs("#temp_tf")?.value || ""),
      ofen: parseFloat(qs("#temp_ofen")?.value || "")
    },
    checks: {
      spuel: !!qs("#check_spuel")?.checked,
      wasser: !!qs("#check_wasser")?.checked,
      reinigung: !!qs("#check_reinigung")?.checked,
      abtau: !!qs("#check_abtau")?.checked
    },
    notes: qs("#notes")?.value?.trim() || "",
    issues: loadChecklist(getSelectedShop(), todayISO())?.issues || [],
    savedAt: new Date().toISOString()
  };
  return data;
}

function fillFormFromChecklist(c) {
  if (!c) return;
  if (qs("#temp_k1")) qs("#temp_k1").value = c.temps.k1 ?? "";
  if (qs("#temp_k2")) qs("#temp_k2").value = c.temps.k2 ?? "";
  if (qs("#temp_tf")) qs("#temp_tf").value = c.temps.tf ?? "";
  if (qs("#temp_ofen")) qs("#temp_ofen").value = c.temps.ofen ?? "";

  if (qs("#check_spuel")) qs("#check_spuel").checked = !!c.checks.spuel;
  if (qs("#check_wasser")) qs("#check_wasser").checked = !!c.checks.wasser;
  if (qs("#check_reinigung")) qs("#check_reinigung").checked = !!c.checks.reinigung;
  if (qs("#check_abtau")) qs("#check_abtau").checked = !!c.checks.abtau;

  if (qs("#notes")) qs("#notes").value = c.notes || "";
}

function countChecks(c) {
  const tempVals = Object.values(c.temps).filter(v => typeof v === "number" && !Number.isNaN(v));
  const tempTargetsOk = [
    hintTemp("k1", c.temps.k1),
    hintTemp("k2", c.temps.k2),
    hintTemp("tf", c.temps.tf),
    hintTemp("ofen", c.temps.ofen)
  ].filter(v => v !== undefined);
  const checksCount = Object.values(c.checks).length + tempVals.length;
  const checksOk =
    (c.checks.spuel?1:0) + (c.checks.wasser?1:0) +
    (c.checks.reinigung?1:0) + (c.checks.abtau?1:0) +
    tempTargetsOk.filter(Boolean).length;
  return { checksOk, checksCount };
}

function renderKpis(c) {
  if (!c) return;
  const { checksOk, checksCount } = countChecks(c);
  const issuesOpen = (c.issues || []).filter(i => !i.resolved).length;

  if (qs("#kpiChecks")) qs("#kpiChecks").textContent = `${checksOk}/${checksCount}`;
  if (qs("#kpiIssuesCount")) qs("#kpiIssuesCount").textContent = String(issuesOpen);
  if (qs("#kpiSavedAt")) {
    const saved = c.savedAt ? new Date(c.savedAt) : null;
    qs("#kpiSavedAt").textContent = saved ? saved.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–";
  }
  if (qs("#kpiShop")) {
    const shopMap = {
      hauptbahnhof: "Hauptbahnhof",
      prenzlauer: "Prenzlauer Berg",
      kreuzberg: "Kreuzberg"
    };
    qs("#kpiShop").textContent = shopMap[c.shop] || c.shop;
  }
}

function renderIssues(c) {
  const list = qs("#issuesList");
  if (!list) return;
  list.innerHTML = "";
  const issues = c?.issues || [];
  if (!issues.length) {
    list.innerHTML = `<div class="list-group-item text-secondary small">Noch keine Einträge.</div>`;
    return;
  }
  issues.forEach((it, idx) => {
    const li = document.createElement("div");
    li.className = "list-group-item d-flex align-items-start justify-content-between";
    li.innerHTML = `
      <div>
        <div class="fw-semibold">${escapeHtml(it.text || "(ohne Text)")}</div>
        <div class="small text-secondary">${new Date(it.createdAt).toLocaleString()}</div>
      </div>
      <div class="ms-3">
        <button class="btn btn-sm ${it.resolved ? "btn-outline-success" : "btn-success"} me-2" data-action="toggle" data-idx="${idx}">
          ${it.resolved ? '<i class="bi bi-check2-all"></i>' : '<i class="bi bi-check2"></i>'}
        </button>
        <button class="btn btn-sm btn-outline-danger" data-action="delete" data-idx="${idx}">
          <i class="bi bi-trash3"></i>
        </button>
      </div>
    `;
    list.appendChild(li);
  });

  list.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const action = btn.dataset.action;
    const idx = Number(btn.dataset.idx);
    const shop = getSelectedShop();
    const date = todayISO();
    const c = loadChecklist(shop, date) || { issues: [] };
    if (action === "toggle") {
      c.issues[idx].resolved = !c.issues[idx].resolved;
    } else if (action === "delete") {
      c.issues.splice(idx, 1);
    }
    saveChecklist(shop, date, c);
    renderIssues(c);
    renderKpis(c);
  }, { once: true }); // rebind each render
}

function renderTodayPreview() {
  const list = qs("#todayChecklistPreview");
  if (!list) return;
  const items = [
    { label: "Kühlschrank 1", el: "#temp_k1", unit: "°C" },
    { label: "Kühlschrank 2", el: "#temp_k2", unit: "°C" },
    { label: "Tiefkühler", el: "#temp_tf", unit: "°C" },
    { label: "Ofen/Backstation", el: "#temp_ofen", unit: "°C" },
    { label: "Spülmaschine ≥82°C", el: "#check_spuel", type: "check" },
    { label: "Handwaschbecken Warmwasser", el: "#check_wasser", type: "check" },
    { label: "Reinigungsplan erledigt", el: "#check_reinigung", type: "check" },
    { label: "Abtau-Status geprüft", el: "#check_abtau", type: "check" },
  ];

  list.innerHTML = "";
  items.forEach(it => {
    let val = "–";
    if (it.type === "check") {
      val = qs(it.el)?.checked ? "✔️" : "—";
    } else {
      const raw = qs(it.el)?.value || "";
      val = raw !== "" ? `${raw}${it.unit}` : "—";
    }
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-center";
    li.innerHTML = `<span>${it.label}</span><span class="text-secondary">${val}</span>`;
    list.appendChild(li);
  });
}

// CSV export (history)
function toCSVRow(arr) {
  return arr.map(v => {
    if (v == null) return "";
    const s = String(v).replaceAll('"', '""');
    return s.includes(",") || s.includes("\n") || s.includes('"') ? `"${s}"` : s;
  }).join(",");
}

function historyAsCSV(shop) {
  const dates = allDaysForShop(shop).sort();
  const rows = [];
  rows.push([
    "Shop","Datum","Kühlschrank1","Kühlschrank2","Tiefkühler","Ofen",
    "Spülmaschine≥82","Warmwasser","Reinigung erledigt","Abtau geprüft",
    "Abweichungen offen","Notizen","Gespeichert um"
  ]);
  dates.forEach(d => {
    const c = loadChecklist(shop, d);
    if (!c) return;
    rows.push([
      shop, d, c.temps.k1 ?? "", c.temps.k2 ?? "", c.temps.tf ?? "", c.temps.ofen ?? "",
      c.checks.spuel ? "ja" : "nein",
      c.checks.wasser ? "ja" : "nein",
      c.checks.reinigung ? "ja" : "nein",
      c.checks.abtau ? "ja" : "nein",
      (c.issues || []).filter(i => !i.resolved).length,
      (c.notes || "").replaceAll("\n"," "),
      c.savedAt ? new Date(c.savedAt).toLocaleString() : ""
    ]);
  });
  return rows.map(toCSVRow).join("\n");
}

function download(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// HTML escaping for issue text
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  })[c]);
}

// ---------- Page wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  const shopSelect = qs("#shopSelect");
  if (shopSelect) {
    // restore selected shop
    const savedShop = localStorage.getItem(`${BUNCA_PREFIX}:shop`);
    if (savedShop) shopSelect.value = savedShop;
    shopSelect.addEventListener("change", () => {
      setSelectedShop(shopSelect.value);
      location.reload(); // simplest way to refresh data per shop
    });
  }

  // header date
  const today = todayISO();
  if (qs("#todayLabel")) qs("#todayLabel").textContent = new Date().toLocaleDateString("de-DE", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  if (qs("#dateBadge")) qs("#dateBadge").textContent = today;

  // index.html behavior
  if (qs("#btnSave") || qs("#btnSaveBottom")) {
    const shop = getSelectedShop();

    // load existing for today
    const existing = loadChecklist(shop, today) || {
      date: today,
      shop,
      temps: { k1: "", k2: "", tf: "", ofen: "" },
      checks: { spuel: false, wasser: false, reinigung: false, abtau: false },
      notes: "",
      issues: [],
      savedAt: null
    };
    fillFormFromChecklist(existing);

    // show initial hints & KPIs
    ["k1","k2","tf","ofen"].forEach(id => hintTemp(id, qs(`#temp_${id}`)?.value));
    renderKpis(existing);
    renderIssues(existing);
    renderTodayPreview();

    // events
    qsa("input[type='number']").forEach(inp => {
      inp.addEventListener("input", () => {
        const id = inp.id.replace("temp_","");
        hintTemp(id, inp.value);
        renderTodayPreview();
      });
    });
    qsa("input[type='checkbox']").forEach(ch => ch.addEventListener("change", renderTodayPreview));
    if (qs("#notes")) qs("#notes").addEventListener("input", renderTodayPreview);

    const doSave = () => {
      const c = checklistFromForm();
      saveChecklist(c.shop, c.date, c);
      renderKpis(c);
      renderIssues(c);
      renderTodayPreview();
      // toast-ish
      if (window.bootstrap) {
        const btns = [qs("#btnSave"), qs("#btnSaveBottom")].filter(Boolean);
        btns.forEach(b => {
          b.disabled = true;
          setTimeout(() => (b.disabled = false), 500);
        });
      }
    };
    qs("#btnSave")?.addEventListener("click", doSave);
    qs("#btnSaveBottom")?.addEventListener("click", doSave);

    qs("#btnReset")?.addEventListener("click", () => {
      if (!confirm("Heutige Eingaben zurücksetzen?")) return;
      localStorage.removeItem(keyFor(shop, today));
      location.reload();
    });

    // Issue modal
    qs("#btnAddIssue")?.addEventListener("click", () => {
      const text = qs("#issueText").value.trim();
      if (!text) return;
      const c = loadChecklist(shop, today) || checklistFromForm();
      c.issues = c.issues || [];
      c.issues.push({ text, resolved: false, createdAt: new Date().toISOString() });
      saveChecklist(shop, today, c);
      qs("#issueText").value = "";
      renderIssues(c);
      renderKpis(c);
      // close modal
      const modalEl = qs("#issueModal");
      if (modalEl) bootstrap.Modal.getInstance(modalEl)?.hide();
    });
  }

  // historie.html behavior
  if (qs("#historyBody")) {
    const shop = getSelectedShop();

    const renderHistory = () => {
      const tbody = qs("#historyBody");
      const dates = allDaysForShop(shop);
      tbody.innerHTML = "";
      if (!dates.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-secondary small">Keine Einträge.</td></tr>`;
        return;
      }
      dates.forEach(d => {
        const c = loadChecklist(shop, d);
        const { checksOk, checksCount } = c ? countChecks(c) : { checksOk: 0, checksCount: 0 };
        const issuesOpen = (c?.issues || []).filter(i => !i.resolved).length;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="fw-semibold">${d}</td>
          <td>${checksOk}/${checksCount}</td>
          <td>${issuesOpen}</td>
          <td>${c?.savedAt ? new Date(c.savedAt).toLocaleString() : "–"}</td>
          <td>
            <button class="btn btn-sm btn-outline-primary" data-view="${d}"><i class="bi bi-eye"></i></button>
            <button class="btn btn-sm btn-outline-danger" data-del="${d}"><i class="bi bi-trash3"></i></button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    };

    renderHistory();

    qs("#shopSelect")?.addEventListener("change", (e) => {
      setSelectedShop(e.target.value);
      renderHistory();
    });

    qs("#btnExport")?.addEventListener("click", () => {
      const csv = historyAsCSV(shop);
      download(`bunca-haccp-${shop}.csv`, csv);
    });

    qs("#btnClearShop")?.addEventListener("click", () => {
      if (!confirm("Alle lokalen Einträge dieses Shops löschen?")) return;
      deleteAllForShop(shop);
      renderHistory();
    });

    // row actions
    qs("#historyBody").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const viewDate = btn.dataset.view;
      const delDate = btn.dataset.del;
      if (viewDate) {
        const c = loadChecklist(shop, viewDate);
        qs("#detailTitle").textContent = `${shop} · ${viewDate}`;
        qs("#detailPre").textContent = JSON.stringify(c, null, 2);
        const modal = new bootstrap.Modal(qs("#detailModal"));
        modal.show();
      } else if (delDate) {
        if (!confirm(`Eintrag ${delDate} löschen?`)) return;
        localStorage.removeItem(keyFor(shop, delDate));
        renderHistory();
      }
    });
  }
});
