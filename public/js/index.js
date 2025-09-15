// public/js/index.js
(async function () {
  // --------- helpers ----------
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const store = {
    get shopId() { return localStorage.getItem('shopId') || 'shop_city'; },
    set shopId(v) { localStorage.setItem('shopId', v); }
  };

  function toast(msg, ok=true) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.position='fixed'; el.style.right='16px'; el.style.bottom='16px';
      el.style.padding='10px 14px'; el.style.borderRadius='10px';
      el.style.background = ok ? '#16a34a' : '#b91c1c';
      el.style.color='#fff'; el.style.zIndex='9999';
      document.body.appendChild(el);
    }
    el.style.background = ok ? '#16a34a' : '#b91c1c';
    el.textContent = msg;
    el.style.opacity = '1';
    setTimeout(()=> el.style.opacity='0', 2200);
  }

  function ensureContainer() {
    // We try to use existing containers; if not present, we create minimal ones.
    let shell = $('#checklist-shell');
    if (!shell) {
      shell = document.createElement('div');
      shell.id = 'checklist-shell';
      shell.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;margin:16px 0">
          <select id="shopSelect" style="padding:6px 8px;border-radius:6px"></select>
          <button id="btnLogout" style="padding:6px 10px;border-radius:6px">Abmelden</button>
        </div>
        <form id="checklistForm">
          <div id="itemsGrid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px"></div>
          <div style="margin-top:12px">
            <label for="notes"><b>Notizen / Issues</b></label>
            <textarea id="notes" rows="4" style="width:100%;margin-top:6px"></textarea>
          </div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button type="reset" id="btnReset">Zurücksetzen</button>
            <button type="submit" id="btnSave" style="background:#16a34a;color:#fff;border:0;border-radius:6px;padding:8px 14px">Speichern</button>
          </div>
        </form>
      `;
      const anchor = $('main') || document.body;
      anchor.appendChild(shell);
    }
    return shell;
  }

  function inputForItem(item) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <label style="display:block;margin-bottom:4px">${item.label}</label>
      <div style="display:flex;gap:6px;align-items:center">
        <input data-item="${item.id}" type="number" step="0.1" style="flex:1;padding:6px;border-radius:6px;border:1px solid #ddd">
        <span>${item.unit || ''}</span>
      </div>
      <div style="opacity:.7;font-size:.9em;margin-top:4px">
        ${ruleText(item)}
      </div>`;
    return wrap;
  }
  function ruleText(item) {
    if (item.rule === 'range')  return `Regel: Bereich ${item.min}–${item.max}`;
    if (item.rule === 'min')    return `Regel: min ${item.min}`;
    if (item.rule === 'max')    return `Regel: max ${item.max}`;
    return '';
  }

  // --------- auth & base UI ----------
  try { await API.me(); } catch {
    // inline login (minimal, no page change)
    const login = document.createElement('div');
    login.style.maxWidth='420px'; login.style.margin='60px auto';
    login.innerHTML = `
      <h2 style="margin-bottom:10px">Anmelden</h2>
      <form id="loginForm" style="display:grid;gap:10px">
        <input name="email" type="email" placeholder="E-Mail" required>
        <input name="password" type="password" placeholder="Passwort" required>
        <button type="submit">Login</button>
      </form>`;
    document.body.innerHTML = ''; document.body.appendChild(login);
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.login(fd.get('email'), fd.get('password'));
        location.reload();
      } catch (err) {
        alert('Login fehlgeschlagen: ' + err.message);
      }
    });
    return;
  }

  const shell = ensureContainer();
  const shopSelect = $('#shopSelect');
  const itemsGrid  = $('#itemsGrid');
  const notesEl    = $('#notes');
  const form       = $('#checklistForm');

  // --------- data flow ----------
  const shops = await API.listShops();
  if (!shops.length) {
    await API.saveShop({ name: 'BUNCA · City', active: true });
  }
  const myShops = await API.listShops();
  myShops.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name || s.id;
    shopSelect.appendChild(opt);
  });

  // initialize selected shop
  if (!myShops.find(s => s.id === store.shopId)) store.shopId = myShops[0].id;
  shopSelect.value = store.shopId;
  shopSelect.addEventListener('change', () => { store.shopId = shopSelect.value; load(); });

  $('#btnLogout')?.addEventListener('click', async () => { await API.logout(); location.reload(); });

  async function load() {
    // render items from template
    const tpl = await API.getTemplate(store.shopId);
    itemsGrid.innerHTML = '';
    (tpl.items || []).forEach(it => itemsGrid.appendChild(inputForItem(it)));

    // fill today values
    const today = API.today();
    const entry = await API.getChecklist(store.shopId, today);
    for (const [key, val] of Object.entries(entry.values || {})) {
      const inp = document.querySelector(`[data-item="${key}"]`);
      if (inp) inp.value = val;
    }
    notesEl.value = entry.notes || '';
  }

  // save checklist
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tpl = await API.getTemplate(store.shopId);
    const values = {};
    let deviations = 0;

    (tpl.items || []).forEach(it => {
      const el = document.querySelector(`[data-item="${it.id}"]`);
      if (!el) return;
      const num = el.value === '' ? null : Number(el.value);
      values[it.id] = num;
      if (num != null) {
        if (it.rule === 'range' && (num < it.min || num > it.max)) deviations++;
        if (it.rule === 'min'   && num < it.min) deviations++;
        if (it.rule === 'max'   && num > it.max) deviations++;
      }
    });

    try {
      await API.saveChecklist({
        shopId: store.shopId,
        date: API.today(),
        values,
        notes: notesEl.value || '',
        deviations
      });
      toast('Gespeichert ✓', true);
    } catch (err) {
      toast('Fehler: ' + err.message, false);
    }
  });

  await load();
})();
