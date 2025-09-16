<script>
/* Global helpers + navbar behavior. No modules needed. */
window.Bunca = {
  csrf(){ return sessionStorage.getItem('csrf') || ''; },
  async requireSession(role){
    const r = await fetch('/api/auth/session'); const d = await r.json();
    if(!d.session){ location.href='/login'; return null; }
    if(role && d.session.role !== role){ location.href='/login'; return null; }
    if(!sessionStorage.getItem('csrf')) sessionStorage.setItem('csrf', d.session.csrf);
    return d.session;
  },
  async api(url, method='GET', body){
    const opt = { method, headers:{} };
    if(['POST','PUT','PATCH','DELETE'].includes(method)){
      opt.headers['Content-Type'] = 'application/json';
      opt.headers['x-csrf-token'] = Bunca.csrf();
      opt.body = JSON.stringify(body || {});
    }
    const res = await fetch(url, opt);
    return res.json();
  }
};

// Navbar toggle + active state
document.addEventListener('DOMContentLoaded', ()=>{
  const btn = document.querySelector('#menuToggle');
  const nav = document.querySelector('#mainNav');
  if(btn && nav){ btn.addEventListener('click', ()=> nav.classList.toggle('open')); }

  const links = document.querySelectorAll('#mainNav a');
  const path = location.pathname;
  links.forEach(a=>{
    if(a.getAttribute('href') === path) a.classList.add('active');
  });

  // Floating quick menu (mobile)
  const fab = document.getElementById('fab');
  const fabMenu = document.getElementById('fabMenu');
  if(fab && fabMenu){
    fab.addEventListener('click', ()=> fabMenu.classList.toggle('open'));
    document.addEventListener('click', (e)=>{
      if(!fab.contains(e.target) && !fabMenu.contains(e.target)) fabMenu.classList.remove('open');
    });
  }
});
</script>
