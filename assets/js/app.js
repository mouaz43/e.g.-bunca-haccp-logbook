// File: /assets/js/app.js
document.addEventListener('DOMContentLoaded', () => {
  // Highlight active nav link
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('[data-nav]').forEach(a => {
    if (a.getAttribute('href') === path || (path === '' && a.getAttribute('href') === 'index.html')) {
      a.classList.add('active');
    }
  });

  // Shop selector — remember selection per browser
  const sel = document.querySelector('#shopSelect');
  if (sel) {
    const saved = localStorage.getItem('bunca_shop');
    if (saved) sel.value = saved;
    sel.addEventListener('change', () => {
      localStorage.setItem('bunca_shop', sel.value);
      // optionally refresh the page if you render by shop
      // location.reload();
    });
  }

  // Demo: show "Admin" link only if role=admin (you can set this after login)
  const role = localStorage.getItem('bunca_role') || 'admin'; // default for now so you can see it
  const adminLink = document.querySelector('[data-admin-link]');
  if (adminLink) adminLink.classList.toggle('hide', role !== 'admin');

  // Logout button demo (front-end only)
  const logout = document.querySelector('[data-logout]');
  if (logout) logout.addEventListener('click', e => {
    e.preventDefault();
    // clear whatever you store on login
    localStorage.removeItem('bunca_role');
    // If your server handles logout, go to /logout instead:
    window.location.href = 'index.html';
  });
});
