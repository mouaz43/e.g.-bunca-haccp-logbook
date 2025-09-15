(async function(){
  const shopSelect = document.getElementById('shopSelect');
  const { shops } = await api('/api/shops');
  shops.forEach(s=> shopSelect.appendChild(option(s.name, s.id)));
  shopSelect.onchange = load;
  async function load(){
    const { entries } = await api(`/api/history?shopId=${shopSelect.value}`);
    const list = document.getElementById('historyList');
    list.innerHTML='';
    entries.forEach(e=>{
      const a = document.createElement('a');
      a.className='list-group-item list-group-item-action';
      a.innerHTML = `<div class="d-flex w-100 justify-content-between">
        <h6 class="mb-1">${e.date}</h6>
        <small>Checks ${e.checks} · Abw. ${e.deviations}</small>
      </div>
      <small>${e.by||''}</small>`;
      list.appendChild(a);
    });
    document.getElementById('exportBtn').onclick = () => {
      const rows = [['date','checks','deviations','by','notes']];
      entries.forEach(e => rows.push([e.date,e.checks,e.deviations,e.by||'',(e.notes||'').replace(/\n/g,' ')]));
      const csv = rows.map(r=>r.map(csvEscape).join(',')).join('\n');
      const blob = new Blob([csv], {type:'text/csv'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `haccp_${shopSelect.selectedOptions[0].text}_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
    };
  }
  load();
})();
