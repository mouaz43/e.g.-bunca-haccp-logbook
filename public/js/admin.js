// public/js/admin.js
(async function () {
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  try { await API.me(); } catch { location.href = '/'; return; }

  // root container
  let root = $('#adminApp');
  if (!root) {
    root = document.createElement('div');
    root.id = 'adminApp';
    root.style.maxWidth = '1000px';
    root.style.margin = '24px auto';
    root.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2>Adminbereich</h2>
        <button id="btnNewShop">+ Neuer Shop</button>
      </div>
      <table style="width:100%;border-collapse:collapse" id="shopsTable">
        <thead>
          <tr>
            <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px">Name</th>
            <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px">Stadt</th>
            <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px">Adresse</th>
            <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px">Aktiv</th>
            <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">Aktion</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    `;
    (document.querySelector('main') || document.body).appendChild(root);
  }

  const tbody = $('#shopsTable tbody');

  function row(shop) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="padding:8px;border-bottom:1px solid #f1f1f1">${shop.name || shop.id}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f1f1">${shop.city || '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f1f1">${shop.address || '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f1f1">${shop.active ? 'aktiv' : 'inaktiv'}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f1f1;text-align:right">
        <button data-act="edit" data-id="${shop.id}">Bearbeiten</button>
        <button data-act="del" data-id="${shop.id}" style="margin-left:6px">Löschen</button>
      </td>`;
    return tr;
  }

  async function refresh() {
    const shops = await API.listShops();
    tbody.innerHTML = '';
    shops.forEach(s => tbody.appendChild(row(s)));
  }

  // ------- Editor Modal -------
  function openEditor(existing) {
    const modal = document.createElement('div');
    modal.style.position='fixed'; modal.style.inset='0'; modal.style.background='rgba(0,0,0,.3)';
    modal.style.display='grid'; modal.style.placeItems='center'; modal.style.zIndex='9999';

    const data = existing || { id:'', name:'', city:'', address:'', active:true };
    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;max-width:920px;width:92vw;padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <h3>${existing ? 'Shop bearbeiten' : 'Neuer Shop'}</h3>
          <button id="xClose">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
          <input id="fName" placeholder="Name" value="${data.name || ''}">
          <input id="fCity" placeholder="Stadt" value="${data.city || ''}">
          <input id="fAddr" placeholder="Adresse" value="${data.address || ''}">
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
          <input type="checkbox" id="fActive" ${data.active ? 'checked' : ''}> Aktiv
        </label>

        <h4 style="margin:8px 0">Checkliste (Items)</h4>
        <table style="width:100%;border-collapse:collapse" id="itemsTbl">
          <thead><tr>
            <th>Label</th><th>Typ</th><th>Einheit</th><th>Regel</th><th>Min</th><th>Max</th><th></th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <button id="addItem" style="margin:8px 0">+ Item</button>

        <h4 style="margin:12px 0 8px">Cleaning Plan</h4>
        <table style="width:100%;border-collapse:collapse" id="cleanTbl">
          <thead><tr>
            <th>Aufgabe</th><th>Frequenz</th><th>Bereich</th><th></th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <button id="addTask" style="margin:8px 0">+ Aufgabe</button>

        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
          <button id="btnSaveShop" style="background:#16a34a;color:#fff;border:0;border-radius:6px;padding:8px 14px">Speichern</button>
        </div>
      </div>`;

    function addItemRow(it = { label:'', type:'number', unit:'°C', rule:'range', min:0, max:7, id: crypto.randomUUID().slice(0,8) }) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input data-k="label" value="${it.label}"></td>
        <td>
          <select data-k="type">
            <option value="number" ${it.type==='number'?'selected':''}>Zahl</option>
            <option value="boolean" ${it.type==='boolean'?'selected':''}>Ja/Nein</option>
          </select>
        </td>
        <td><input data-k="unit" value="${it.unit||''}"></td>
        <td>
          <select data-k="rule">
            <option value="range" ${it.rule==='range'?'selected':''}>↔ Bereich</option>
            <option value="min" ${it.rule==='min'?'selected':''}>min</option>
            <option value="max" ${it.rule==='max'?'selected':''}>max</option>
          </select>
        </td>
        <td><input data-k="min" type="number" step="0.1" value="${it.min ?? ''}" style="width:90px"></td>
        <td><input data-k="max" type="number" step="0.1" value="${it.max ?? ''}" style="width:90px"></td>
        <td><button data-act="rm">x</button></td>
      `;
      tr.dataset.id = it.id || crypto.randomUUID().slice(0,8);
      $('#itemsTbl tbody', modal).appendChild(tr);
    }

    function addTaskRow(t = { id: crypto.randomUUID().slice(0,8), task:'', freq:'täglich', area:'' }) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input data-k="task" value="${t.task}"></td>
        <td>
          <select data-k="freq">
            <option value="täglich" ${t.freq==='täglich'?'selected':''}>täglich</option>
            <option value="wöchentlich" ${t.freq==='wöchentlich'?'selected':''}>wöchentlich</option>
            <option value="monatlich" ${t.freq==='monatlich'?'selected':''}>monatlich</option>
          </select>
        </td>
        <td><input data-k="area" value="${t.area||''}"></td>
        <td><button data-act="rm">x</button></td>
      `;
      tr.dataset.id = t.id || crypto.randomUUID().slice(0,8);
      $('#cleanTbl tbody', modal).appendChild(tr);
    }

    (async () => {
      if (data.id) {
        const tpl = await API.getTemplate(data.id);
        (tpl.items || []).forEach(addItemRow);
        (tpl.cleaning || []).forEach(addTaskRow);
      } else {
        addItemRow(); addTaskRow();
      }
    })();

    modal.addEventListener('click', (e) => {
      if (e.target.id === 'xClose') modal.remove();
      if (e.target.id === 'addItem') addItemRow();
      if (e.target.id === 'addTask') addTaskRow();
      if (e.target.dataset.act === 'rm') e.target.closest('tr')?.remove();
    });

    $('#btnSaveShop', modal).addEventListener('click', async () => {
      const items = $$('#itemsTbl tbody tr', modal).map(tr => {
        const get = (k) => $(`[data-k="${k}"]`, tr)?.value ?? '';
        const type = get('type');
        const rule = get('rule');
        const parseMaybe = (v) => v === '' ? undefined : Number(v);
        return {
          id: tr.dataset.id,
          label: get('label'),
          type,
          unit: get('unit'),
          rule,
          min: rule!=='max' ? parseMaybe(get('min')) : undefined,
          max: rule!=='min' ? parseMaybe(get('max')) : undefined
        };
      });

      const cleaning = $$('#cleanTbl tbody tr', modal).map(tr => {
        const get = (k) => $(`[data-k="${k}"]`, tr)?.value ?? '';
        return { id: tr.dataset.id, task: get('task'), freq: get('freq'), area: get('area') };
      });

      const payload = {
        id: data.id || undefined,
        name: $('#fName', modal).value.trim() || 'Neuer Shop',
        city: $('#fCity', modal).value.trim(),
        address: $('#fAddr', modal).value.trim(),
        active: $('#fActive', modal).checked,
        items, cleaning
      };

      try {
        await API.saveShop(payload);   // saves shop
        if (payload.id) {
          await API.saveTemplate(payload.id, { items, cleaning }); // ensure template synced
        }
        modal.remove();
        await refresh();
        alert('Gespeichert');
      } catch (err) {
        alert('Fehler: ' + err.message);
      }
    });

    document.body.appendChild(modal);
  }

  // events
  $('#btnNewShop', root).addEventListener('click', () => openEditor(null));
  tbody.addEventListener('click', async (e) => {
    const id = e.target?.dataset?.id;
    const act = e.target?.dataset?.act;
    if (!id || !act) return;
    if (act === 'edit') {
      const shops = await API.listShops();
      const shop = shops.find(s => s.id === id);
      openEditor(shop || { id, name: id, active: true });
    }
    if (act === 'del') {
      if (!confirm('Diesen Shop löschen?')) return;
      await API.deleteShop(id);
      await refresh();
    }
  });

  await refresh();
})();
