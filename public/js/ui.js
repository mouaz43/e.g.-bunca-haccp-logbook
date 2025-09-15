/* public/js/ui.js
   Small UI helpers shared by pages
*/
window.UI = (function () {
  function markActiveNav() {
    const path = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll("[data-nav]").forEach((a) => {
      const href = a.getAttribute("href");
      if (href === path) a.classList.add("active");
    });
  }

  async function fillShopSelect(shops, selectedId) {
    const sel = document.querySelector("[data-shop-select]");
    if (!sel) return;
    sel.innerHTML = "";
    shops.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name || "Shop";
      if (selectedId && selectedId === s.id) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = (e) => {
      API.setShopId(e.target.value);
      // Keep the page in sync without a full reload if the page has a loader
      // Prefer dispatching a custom event so each page can react
      window.dispatchEvent(new CustomEvent("bunca:shop-changed", { detail: { id: e.target.value } }));
      // Fallback: reload if the page has no dynamic loader
      if (!window._buncaHandlesShopChange) location.reload();
    };
  }

  function hookLogout() {
    const btn = document.querySelector("[data-logout]");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      API.logout();
      location.href = "login.html";
    });
  }

  function setToday(selector = "#today") {
    const el = document.querySelector(selector);
    if (!el) return;
    const d = new Date();
    el.textContent = d.toLocaleDateString("de-DE", {
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }

  return { markActiveNav, fillShopSelect, hookLogout, setToday };
})();
