// public/js/auth.js
(function () {
  try {
    if (!window.API || !API.token || !API.token()) {
      var next = location.pathname.split('/').pop() || 'index.html';
      if (!/login\.html$/i.test(next)) {
        location.href = 'login.html?next=' + encodeURIComponent(next);
      }
    }
  } catch (e) {
    var next = location.pathname.split('/').pop() || 'index.html';
    location.href = 'login.html?next=' + encodeURIComponent(next);
  }
})();
