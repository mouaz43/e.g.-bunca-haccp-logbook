// Simple helpers used by multiple pages (nav, auth, shop select)
(function(){
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('[data-nav]').forEach(a => {
    const href = a.getAttribute('href');
    if (href === path) a.classList.add('active');
  });

  // Shop dropdown (populates from API)
  const shopSel = document.querySelector('[data-shop-select]');
  const shopBadge = document.querySelector('[data-shop-badge]');

  async function loadShops(){
    try{
      const shops = await API.shops();
      if (shopSel) {
        shopSel.innerHTML = '';
        shops.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.id; opt.textContent = s.name;
          shopSel.appendChild(opt);
        });
        const saved = API.getShop().id || shops[0]?.id;
        if (saved) shopSel.value = saved;
        if (saved) { const s = shops.find(x=>x.id===saved); if (s) API.setShop(s.id, s.name); }
      }
      if (shopBadge && API.getShop().name) shopBadge.textContent = API.getShop().name;
    }catch(e){
      // not logged in, hide shop picker
      if (shopSel) shopSel.disabled = true;
    }
  }
  loadShops();

  if (shopSel) shopSel.addEventListener('change', e => {
    const id = e.target.value;
    const name = e.target.selectedOptions[0]?.textContent || '';
    API.setShop(id, name);
    if (shopBadge) shopBadge.textContent = name;
    if (path === 'index.html') location.reload();
  });

  // logout
  const logout = document.querySelector('[data-logout]');
  if (logout) logout.addEventListener('click', (e)=>{ e.preventDefault(); API.logout(); location.href='index.html'; });

})();
