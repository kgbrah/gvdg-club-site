// Shared site menu — the ONE source of truth for the top nav across every public page.
// Each page provides an empty <ul class="nav-links" id="navLinks"></ul>; this fills it (and a Donate
// button), and marks the current page. Edit MENU here and every page updates. The page keeps its own
// brand/logo, theme toggle, and mobile hamburger (which just toggles .nav-links visibility).
(function () {
  'use strict';

  var MENU = [
    { label: 'Home', href: 'index.html' },
    { label: 'Events', href: 'events.html' },
    { label: 'Ryder Cup', href: 'ryder-cup.html' },
    { label: 'Pro Shop', href: 'pro-shop.html' },
    { label: 'Blog', href: 'gvdg-blog.html' },
    { label: 'Members', href: 'gvdg-members.html' },
  ];
  var DONATE_URL = 'https://www.paypal.com/paypalme/greenvillediscgolf';

  // Compare ignoring directory + ".html" so it works with Pages clean URLs (/events) and /events.html and /.
  function basename(href) {
    return String(href).toLowerCase().replace(/[#?].*$/, '').replace(/^.*\//, '').replace(/\.html$/, '');
  }
  function currentPage() {
    var p = basename(location.pathname || '');
    return p === '' ? 'index' : p;
  }

  function injectStyle() {
    if (document.getElementById('navJsStyle')) return;
    var s = document.createElement('style');
    s.id = 'navJsStyle';
    s.textContent =
      '.nav-links a[aria-current="page"]{text-decoration:underline;text-underline-offset:5px;font-weight:800;}' +
      '.nav-links a.nav-donate{background:var(--accent,#f4a300);color:#1a1a1a!important;padding:.35rem .95rem;border-radius:999px;font-weight:800;}' +
      '.nav-links a.nav-donate:hover{filter:brightness(1.08);}';
    document.head.appendChild(s);
  }

  function build() {
    var ul = document.getElementById('navLinks');
    if (!ul) return;
    var cur = currentPage();
    ul.replaceChildren();
    MENU.forEach(function (m) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = m.href;
      a.textContent = m.label;
      if (basename(m.href) === cur) a.setAttribute('aria-current', 'page');
      li.appendChild(a);
      ul.appendChild(li);
    });
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.href = DONATE_URL;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'nav-donate';
    a.textContent = 'Donate';
    li.appendChild(a);
    ul.appendChild(li);
  }

  function init() { injectStyle(); build(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
