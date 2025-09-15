const $ = s => document.querySelector(s);
const todayISO = () => new Date().toISOString().slice(0,10);
const fmtDate = d => d.toLocaleDateString('de-DE', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

const state = { user:null, shop:null, shops:[], today:todayISO(), lastSaved:null };

function visible(el, on){ el.hidden = !on; }
function setText(sel, v){ const el=$(sel); if(el) el.textContent=v; }

function computeDeviations(){
  let dev=0;
  const n=v=>v===""?null:Number(v);
  const f1=n($("#fridge1").value), f2=n($("#fridge2").value), fr=n($("#freezer").value), ov=n($("#oven").value);
  if(f1!=null && (f1<0 || f1>7)) dev++;
  if(f2!=null && (f2<0 || f2>7)) dev++;
  if(fr!=null && fr>-18) dev++;
  if(ov!=null && ov<180) dev++;
  if(!$("#dishwasher_ok").checked) dev++;
  if(!$("#warmwater_ok").checked) dev++;
  if(!$("#cleaning_done").checked) dev++;
  setText("#kpi-deviations", dev);
  return dev;
}
function renderTodayPoints(){
  const rows = [
    ["Kühlschrank 1", $("#fridge1").value],
    ["Kühlschrank 2", $("#fridge2").value],
    ["Tiefkühler", $("#freezer").value],
    ["Ofen/Backstation", $("#oven").value],
    ["Spülmaschine ≥82°C", $("#dishwasher_ok").checked?"✓":"—"],
    ["Warmwasser vorhanden", $("#warmwater_ok").checked?"✓":"—"],
    ["Reinigungsplan erledigt", $("#cleaning_done").checked?"✓":"—"]
  ];
  $("#today-points").innerHTML = rows.map(([n,v])=>`<li><span>${n}</span><span class="muted">${v||"—"}</span></li>`).join("");
}
function updateKpis(){
  const filled = ["#fridge1","#fridge2","#freezer","#oven"].map(s=>!!$(s).value).filter(Boolean).length;
  setText("#kpi-done", filled);
}

async function api(path, opts={}){
  const r = await fetch(path, { headers:{ "Content-Type":"application/json" }, credentials:"include", ...opts });
  if(!r.ok) throw new Error((await r.text())||("HTTP "+r.status));
  const ct = r.headers.get("content-type")||"";
  return ct.includes("application/json") ? r.json() : r.text();
}

async function loadShops(){
  const { shops } = await api("/api/shops");
  state.shops = shops;
  const options = shops.map(s=>`<option value="${s.id}">${s.name}</option>`).join("");
  $("#register-shop").innerHTML = options;
  $("#shop-select").innerHTML = options;
}

async function me(){
  const { user, shop } = await api("/api/me");
  state.user = user; state.shop = shop;
  return user;
}

function nOrNull(v){ return v===""?null:Number(v); }
function payload(){
  return {
    shop_id: state.shop.id,
    entry_date: state.today,
    fridge1_c: nOrNull($("#fridge1").value),
    fridge2_c: nOrNull($("#fridge2").value),
    freezer_c: nOrNull($("#freezer").value),
    oven_c: nOrNull($("#oven").value),
    dishwasher_rinse_c: $("#dishwasher_ok").checked?82:null,
    warm_water_available: $("#warmwater_ok").checked,
    cleaning_done: $("#cleaning_done").checked,
    notes: ($("#notes").value||"").trim() || null,
    issues: ($("#issues").value||"").trim() || null
  };
}

async function loadToday(){
  if(!state.shop) return;
  const { row } = await api(`/api/checks/${state.shop.id}/${state.today}`);
  if(row){
    $("#fridge1").value = row.fridge1_c ?? "";
    $("#fridge2").value = row.fridge2_c ?? "";
    $("#freezer").value = row.freezer_c ?? "";
    $("#oven").value = row.oven_c ?? "";
    $("#dishwasher_ok").checked = !!row.dishwasher_rinse_c && row.dishwasher_rinse_c>=82;
    $("#warmwater_ok").checked = !!row.warm_water_available;
    $("#cleaning_done").checked = !!row.cleaning_done;
    $("#notes").value = row.notes ?? "";
    $("#issues").value = row.issues ?? "";
  } else {
    ["#fridge1","#fridge2","#freezer","#oven","#notes","#issues"].forEach(sel=>$(sel).value="");
    ["#dishwasher_ok","#warmwater_ok","#cleaning_done"].forEach(sel=>$(sel).checked=false);
  }
  renderIssuesList();
  renderTodayPoints(); computeDeviations(); updateKpis();
}

function renderIssuesList(){
  const issues = ($("#issues").value||"").trim();
  const items = issues ? issues.split(/\n|;/).map(s=>s.trim()).filter(Boolean) : [];
  $("#issues-list").innerHTML = items.length
    ? items.map(s=>`<li><span>${s}</span><span>heute</span></li>`).join("")
    : `<li><span>Keine Einträge.</span><span>–</span></li>`;
  setText("#kpi-issues", items.length);
}

async function saveToday(){
  await api(`/api/checks/${state.shop.id}/${state.today}`, { method:"POST", body: JSON.stringify(payload()) });
  setText("#kpi-saved", new Date().toLocaleTimeString('de-DE'));
  renderIssuesList();
}

function bind(){
  setText("#headline-date", new Date().toLocaleDateString('de-DE'));
  setText("#today-date", fmtDate(new Date()));
  setText("#year", new Date().getFullYear());

  $("#btn-login").addEventListener("click",()=>visible($("#auth-panel"),true));
  $("#btn-logout").addEventListener("click", async ()=>{ await api("/api/logout",{method:"POST"}); location.reload(); });
  $("#btn-save").addEventListener("click", saveToday);
  $("#btn-reset").addEventListener("click", ()=>{ if(confirm("Formular zurücksetzen?")) { ["#fridge1","#fridge2","#freezer","#oven","#notes","#issues"].forEach(sel=>$(sel).value=""); ["#dishwasher_ok","#warmwater_ok","#cleaning_done"].forEach(sel=>$(sel).checked=false); renderTodayPoints(); computeDeviations(); updateKpis(); }});
  $("#btn-history").addEventListener("click", async (e)=>{ e.preventDefault(); if(!state.shop) return; const h = await api(`/api/history/${state.shop.id}`); alert(`Einträge: ${h.dates.slice(0,10).join(", ") || "keine"}`); });
  $("#btn-view-issues").addEventListener("click", (e)=>{ e.preventDefault(); $("#issues").focus(); });

  ["#fridge1","#fridge2","#freezer","#oven","#dishwasher_ok","#warmwater_ok","#cleaning_done","#notes","#issues"]
    .forEach(sel => $(sel).addEventListener("input", ()=>{ renderTodayPoints(); computeDeviations(); updateKpis(); }));

  $("#login-form").addEventListener("submit", async e=>{
    e.preventDefault();
    const fd=new FormData(e.target);
    try{
      await api("/api/login",{method:"POST",body:JSON.stringify({email:fd.get("email"),password:fd.get("password")})});
      visible($("#auth-panel"),false); afterAuth();
    }catch(err){ const el=$("#auth-error"); el.textContent="Login fehlgeschlagen"; el.hidden=false; setTimeout(()=>el.hidden=true,4000); }
  });

  $("#link-register").addEventListener("click", e=>{e.preventDefault(); visible($("#login-form"),false); visible($("#register-form"),true);});
  $("#link-login").addEventListener("click", e=>{e.preventDefault(); visible($("#register-form"),false); visible($("#login-form"),true);});

  $("#register-form").addEventListener("submit", async e=>{
    e.preventDefault();
    const fd=new FormData(e.target);
    const body={ email:fd.get("email"), password:fd.get("password"), shopId:fd.get("shopId"), code:fd.get("code") };
    try{
      await api("/api/register",{method:"POST",body:JSON.stringify(body)});
      alert("Registrierung erfolgreich. Bitte anmelden.");
      visible($("#register-form"),false); visible($("#login-form"),true);
    }catch(err){ const el=$("#register-error"); el.textContent="Registrierung fehlgeschlagen"; el.hidden=false; setTimeout(()=>el.hidden=true,4000); }
  });

  $("#switch-shop").addEventListener("click",()=>$("#shop-dialog").showModal());
  $("#shop-apply").addEventListener("click", async ()=>{
    const id = $("#shop-select").value;
    if(state.user?.role!=="admin"){ alert("Nur Admins können den Shop wechseln."); return; }
    state.shop = state.shops.find(s=>s.id===id);
    setText("#shop-name", state.shop?.name || "—");
    await loadToday();
  });
}

async function afterAuth(){
  visible($("#btn-login"),false); visible($("#btn-logout"),true);
  visible($("#auth-panel"),false); visible($("#app"),true);

  await loadShops();
  const { user, shop } = await api("/api/me");
  state.user = user; state.shop = shop;
  setText("#shop-name", shop?.name || "—");
  $("#shop-select").value = shop?.id || "";
  await loadToday();
}

(async function init(){
  bind();
  await loadShops();
  const u = await me();
  if(u){ afterAuth(); } else { visible($("#auth-panel"),true); }
})();
