(async function(){
  const loginCard = document.getElementById('loginCard');
  const dash = document.getElementById('dash');
  const shopSelect = document.getElementById('shopSelect');
  const logoutBtn = document.getElementById('logoutBtn');
  const loginBtn = document.getElementById('loginBtn');
  const adminBtn = document.getElementById('adminBtn');

  async function bindUser() {
    const user = await me();
    if (!user) {
      loginCard.classList.remove('d-none');
      dash.classList.add('d-none');
      adminBtn.classList.add('d-none');
      return;
    }
    if (user.role === 'admin') adminBtn.classList.remove('d-none');

    loginCard.classList.add('d-none');
    dash.classList.remove('d-none');

    // load shops
    const { shops } = await api('/api/shops');
    shopSelect.innerHTML = '';
    shops.forEach(s => shopSelect.appendChild(option(s.name, s.id)));
    loadChecklist();
  }

  async function loadChecklist() {
    const shopId = shopSelect.value || undefined;
    const data = await api(`/api/checklist?shopId=${encodeURIComponent(shopId||'')}&date=${today()}`);
    document.getElementById('dayLabel').textContent = data.date;
    renderForm(data.items, data.shop.id);
  }

  function renderForm(items, shopId) {
    const form = document.getElementById('checklistForm');
    form.innerHTML = '';
    items.forEach(it => {
      const col = document.createElement('div'); col.className='col-md-3';
      let inner = `<label class="form-label">${it.label}</label>`;
      if (it.type === 'number') {
        inner += `<div class="input-group">
          <input type="number" step="0.1" class="form-control" id="${it.id}">
          <span class="input-group-text">${it.unit||''}</span>
        </div>
        <div class="small-muted">Regel: ${it.rule} ${it.min ?? ''}–${it.max ?? ''}</div>`;
      } else { // boolean
        inner += `<div class="form-check">
          <input class="form-check-input" type="checkbox" id="${it.id}">
          <label class="form-check-label">OK</label>
        </div>`;
      }
      col.innerHTML = inner;
      form.appendChild(col);
    });

    document.getElementById('resetBtn').onclick = e => { e.preventDefault(); form.reset(); document.getElementById('notes').value=''; };
    document.getElementById('saveBtn').onclick = async e => {
      e.preventDefault();
      const values = {};
      items.forEach(it => {
        const el = document.getElementById(it.id);
        values[it.id] = (it.type === 'number') ? (el.value === '' ? '' : Number(el.value)) : !!el.checked;
      });
      const payload = { shopId: shopId, date: today(), values, notes: document.getElementById('notes').value };
      const r = await api('/api/checklist', { method:'POST', body: payload });
      document.getElementById('checksStat').textContent = `${r.checks}/${items.length}`;
      document.getElementById('devStat').textContent = r.deviations;
      alert('Gespeichert.');
    };
  }

  document.getElementById('loginBtn').onclick = async ()=> {
    const email = document.getElementById('loginEmail').value;
    const pw = document.getElementById('loginPassword').value;
    try { await login(email, pw); await bindUser(); } catch { alert('Login fehlgeschlagen'); }
  };
  logoutBtn.onclick = async ()=> { await logout(); location.reload(); };
  shopSelect.onchange = loadChecklist;

  bindUser();
})();
