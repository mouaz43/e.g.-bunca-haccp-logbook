// public/js/historie.js
(async function () {
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  try { await API.me(); } catch { location.href = '/'; return; }

  let root = $('#historyApp');
  if (!root) {
    root = document.createElement('div');
    root.id = 'historyApp';
    root.style.maxWidth='900px'; root.style.margin='24px auto';
    root.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <select id="shopSelect"></select>
        <select id="dateSelect"></select>
      </div>
      <pre id="entryBox" style="padding:12px;border:1px solid #eee;border-radius:8px;background:#fafafa;white-space:pre-wrap"></pre>
    `;
    (document.querySelector('main') || document.body).appendChild(root);
  }

  const shopSel = $('#shopSelect'), dateSel = $('#dateSelect'), box = $('#entryBox');

  const shops = await API.listShops();
  shops.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name || s.id;
    shopSel.appendChild(opt);
  });
  shopSel.addEventListener('change', loadDates);
  dateSel.addEventListener('change', loadEntry);

  async function loadDates() {
    dateSel.innerHTML = '';
    const list = await API.listHistory(shopSel.value);
    list.forEach(d => {
      const o = document.createElement('option'); o.value = d; o.textContent = d;
      dateSel.appendChild(o);
    });
    if (list.length) await loadEntry();
    else box.textContent = 'Keine Einträge.';
  }
  async function loadEntry() {
    const e = await API.getHistoryEntry(shopSel.value, dateSel.value);
    box.textContent = JSON.stringify(e, null, 2);
  }

  shopSel.value = shops[0]?.id || 'shop_city';
  await loadDates();
})();
