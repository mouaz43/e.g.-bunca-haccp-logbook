(async function(){
  const user = await me();
  if (!user || user.role !== 'admin') { location.href = 'index.html'; return; }

  const shopsTable = document.getElementById('shopsTable');
  const newShopBtn = document.getElementById('newShopBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  logoutBtn.onclick = async ()=> { await logout(); location.href='index.html'; };

  const modalEl = document.getElementById('shopModal');
  const shopModal = new bootstrap.Modal(modalEl);

  let editing = null; // shop object while editing

  function row(shop){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${shop.name}</td><td>${shop.city||'-'}</td><td>${shop.address||'-'}</td>
      <td><span class="badge ${shop.active?'bg-success':'bg-secondary'}">${shop.active?'aktiv':'inaktiv'}</span></td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-secondary me-2 edit">Bearbeiten</button>
        <button class="btn btn-sm btn-outline-danger del">Löschen</button>
      </td>`;
    tr.querySelector('.edit').onclick = () => openEditor(shop);
    tr.querySelector('.del').onclick = async () => {
      if (!confirm('Diesen Shop löschen?')) return;
      await api(`/api/shops/${shop.id}`, { method:'DELETE' });
      load();
    };
    return tr;
  }

  function itemRow(it){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="form-control form-control-sm label" value="${it.label||''}"></td>
      <td>
        <select class="form-select form-select-sm type">
          <option value="number" ${it.type==='number'?'selected':''}>Zahl</option>
          <option value="boolean" ${it.type==='boolean'?'selected':''}>Ja/Nein</option>
        </select>
      </td>
      <td><input class="form-control form-control-sm unit" value="${it.unit||''}"></td>
      <td>
        <select class="form-select form-select-sm rule">
          <option value="range" ${it.rule==='range'?'selected':''}>↔ Bereich</option>
          <option value="min" ${it.rule==='min'?'selected':''}>≥ Min</option>
          <option value="max" ${it.rule==='max'?'selected':''}>≤ Max</option>
        </select>
      </td>
      <td><input type="number" class="form-control form-control-sm min" value="${it.min ?? ''}"></td>
      <td><input type="number" class="form-control form-control-sm max" value="${it.max ?? ''}"></td>
      <td><button class="btn btn-sm btn-outline-danger x">x</button></td>
    `;
    tr.querySelector('.x').onclick = () => tr.remove();
    return tr;
  }
  function taskRow(t){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="form-control form-control-sm task" value="${t.task||''}"></td>
      <td>
        <select class="form-select form-select-sm freq">
          <option>täglich</option><option>woechentlich</option><option>monatlich</option>
        </select>
      </td>
      <td><input class="form-control form-control-sm area" value="${t.area||''}" placeholder="Bereich (z. B. Küche)"></td>
      <td><button class="btn btn-sm btn-outline-danger x">x</button></td>`;
    tr.querySelector('.freq').value = t.freq || 'täglich';
    tr.querySelector('.x').onclick = () => tr.remove();
    return tr;
  }

  function openEditor(shop){
    editing = shop || { name:'', city:'', address:'', active:true, items:[], cleaning:[] };
    document.getElementById('m_name').value = editing.name || '';
    document.getElementById('m_city').value = editing.city || '';
    document.getElementById('m_addr').value = editing.address || '';
    document.getElementById('m_active').checked = !!editing.active;

    const itemsBody = document.getElementById('m_items'); itemsBody.innerHTML='';
    (editing.items || []).forEach(it => itemsBody.appendChild(itemRow(it)));
    const cleanBody = document.getElementById('m_clean'); cleanBody.innerHTML='';
    (editing.cleaning || []).forEach(t => cleanBody.appendChild(taskRow(t)));

    document.getElementById('addItem').onclick = ()=> itemsBody.appendChild(itemRow({ type:'number', rule:'range' }));
    document.getElementById('addTask').onclick = ()=> cleanBody.appendChild(taskRow({ freq:'täglich' }));

    document.getElementById('saveShop').onclick = saveEditor;

    shopModal.show();
  }

  async function saveEditor(){
    const payload = {
      name: document.getElementById('m_name').value,
      city: document.getElementById('m_city').value,
      address: document.getElementById('m_addr').value,
      active: document.getElementById('m_active').checked,
      items: [],
      cleaning: []
    };
    // collect items
    document.querySelectorAll('#m_items tr').forEach(tr=>{
      payload.items.push({
        id: cryptoId(),
        label: tr.querySelector('.label').value,
        type: tr.querySelector('.type').value,
        unit: tr.querySelector('.unit').value,
        rule: tr.querySelector('.rule').value,
        min: tr.querySelector('.min').value === '' ? null : Number(tr.querySelector('.min').value),
        max: tr.querySelector('.max').value === '' ? null : Number(tr.querySelector('.max').value),
      });
    });
    // collect cleaning tasks
    document.querySelectorAll('#m_clean tr').forEach(tr=>{
      payload.cleaning.push({
        id: cryptoId(),
        task: tr.querySelector('.task').value,
        freq: tr.querySelector('.freq').value,
        area: tr.querySelector('.area').value
      });
    });

    if (editing.id) {
      await api(`/api/shops/${editing.id}`, { method:'PUT', body: payload });
    } else {
      await api('/api/shops', { method:'POST', body: payload });
    }
    shopModal.hide();
    load();
  }

  function cryptoId(){ return 'id_'+Math.random().toString(16).slice(2,10); }

  async function load(){
    const { shops } = await api('/api/shops');
    shopsTable.innerHTML = '';
    shops.forEach(s => shopsTable.appendChild(row(s)));
  }

  newShopBtn.onclick = ()=> openEditor(null);
  load();
})();
