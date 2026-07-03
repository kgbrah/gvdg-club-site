/*
 * Crotts — the GVDG persistent AI assistant widget.
 * Self-contained: injects its own styles + a floating avatar button that opens a chat panel
 * wired to the club Worker's POST /assistant (Cloudflare Workers AI). Theme-aware (uses the
 * site's CSS custom properties with fallbacks) and XSS-safe (textContent / createElement only).
 * Drop into any page with:  <script src="crotts.js" defer></script>
 */
(function () {
  'use strict';
  if (window.__crottsLoaded) return; // guard against double-injection
  window.__crottsLoaded = true;

  // Resolve the club API base. An explicit data-api-base/data-auth-base wins; otherwise derive it from
  // the host so ONE codebase serves prod, the gvdgclub.com dev site, Cloudflare Pages previews, and
  // localhost without per-deploy edits.
  function apiBase() {
    var b = document.body && (document.body.dataset.apiBase || document.body.dataset.authBase);
    if (!b) {
      var el = document.querySelector('[data-auth-base],[data-api-base]');
      if (el) b = el.dataset.authBase || el.dataset.apiBase;
    }
    b = (b || '').trim();
    if (b) return b.replace(/\/+$/, '');
    var h = location.hostname;
    if (h === '127.0.0.1' || h === 'localhost') return 'http://127.0.0.1:8788';
    if (h === 'greenvillediscgolf.com' || h === 'www.greenvillediscgolf.com') return 'https://auth.greenvillediscgolf.com';
    return 'https://auth.gvdgclub.com'; // gvdgclub.com + *.pages.dev previews + anything else = staging
  }
  var API = apiBase();
  var AVATAR = 'img/crotts.jpg';
  var history = []; // {role, content}, capped
  var busy = false, greeted = false;

  var css = [
    '#crotts-fab{position:fixed;left:18px;bottom:18px;width:60px;height:60px;border-radius:50%;border:3px solid var(--secondary,#2e7d32);background:#fff;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.28);z-index:9998;padding:0;overflow:hidden;transition:transform .15s}',
    '#crotts-fab:hover{transform:scale(1.06)}',
    '#crotts-fab img{width:100%;height:100%;object-fit:cover;object-position:center 28%;display:block}',
    '#crotts-badge{position:absolute;top:-3px;right:-3px;background:var(--secondary,#2e7d32);color:#fff;font-size:11px;font-weight:700;border-radius:999px;padding:1px 6px;border:2px solid #fff}',
    '#crotts-panel{position:fixed;left:18px;bottom:88px;width:340px;max-width:calc(100vw - 36px);height:460px;max-height:calc(100vh - 120px);background:var(--bg-primary,#fff);color:var(--text-primary,#1a1a1a);border:1px solid var(--border-color,#e0e0e0);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.3);z-index:9999;display:none;flex-direction:column;overflow:hidden;font-family:inherit}',
    '#crotts-panel.open{display:flex}',
    '#crotts-head{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--secondary,#2e7d32);color:#fff}',
    '#crotts-head img{width:36px;height:36px;border-radius:50%;object-fit:cover;object-position:center 28%;border:2px solid rgba(255,255,255,.6)}',
    '#crotts-head .t{font-weight:700;line-height:1.1}#crotts-head .s{font-size:11px;opacity:.85}',
    '#crotts-close{margin-left:auto;background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1}',
    '#crotts-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--bg-secondary,#f6f6f6)}',
    '.crotts-b{max-width:85%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.35;white-space:pre-wrap;word-wrap:break-word}',
    '.crotts-b.them{background:var(--bg-primary,#fff);color:var(--text-primary,#1a1a1a);border:1px solid var(--border-color,#e0e0e0);align-self:flex-start;border-bottom-left-radius:4px}',
    '.crotts-b.me{background:var(--secondary,#2e7d32);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}',
    '.crotts-b.err{background:#fdecea;color:#a12;border:1px solid #f5c6cb;align-self:flex-start}',
    '#crotts-form{display:flex;gap:6px;padding:10px;border-top:1px solid var(--border-color,#e0e0e0);background:var(--bg-primary,#fff)}',
    '#crotts-input{flex:1;resize:none;border:1px solid var(--border-color,#ccc);border-radius:9px;padding:8px;font:inherit;font-size:14px;background:var(--bg-secondary,#fff);color:var(--text-primary,#1a1a1a)}',
    '#crotts-send{background:var(--secondary,#2e7d32);color:#fff;border:none;border-radius:9px;padding:0 14px;font-weight:700;cursor:pointer}',
    '#crotts-send:disabled{opacity:.5;cursor:default}',
    '.crotts-typing{font-size:12px;color:var(--text-muted,#888);align-self:flex-start;padding:2px 4px}',
    '@media (max-width:768px){#crotts-fab{width:54px;height:54px;left:14px;bottom:calc(82px + env(safe-area-inset-bottom,0px))}#crotts-panel{left:12px;bottom:calc(148px + env(safe-area-inset-bottom,0px));max-width:calc(100vw - 24px);max-height:calc(100vh - 172px)}}',
    '@media (max-width:768px){#crotts-fab,#crotts-panel{display:none!important}}'
  ].join('');

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  var panel, msgs, input, sendBtn;

  function bubble(text, who) {
    var b = el('div', 'crotts-b ' + who, text);
    msgs.appendChild(b);
    msgs.scrollTop = msgs.scrollHeight;
    return b;
  }

  function greet() {
    if (greeted) return; greeted = true;
    bubble("Hey! I'm Crotts 🥏 — ask me about GVDG events, courses, or how to use the site.", 'them');
  }

  async function send() {
    var text = (input.value || '').trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true;
    bubble(text, 'me');
    input.value = '';
    var typing = el('div', 'crotts-typing', 'Crotts is typing…');
    msgs.appendChild(typing); msgs.scrollTop = msgs.scrollHeight;
    try {
      var res = await fetch(API + '/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: history.slice(-8) })
      });
      typing.remove();
      if (res.status === 429) { bubble("I'm getting a lot of questions right now — give me a minute and try again.", 'err'); }
      else if (!res.ok) { bubble("Sorry, I couldn't reach the club assistant just now.", 'err'); }
      else {
        var data = await res.json();
        var reply = (data && data.reply) ? String(data.reply) : "Hmm, I didn't catch that.";
        bubble(reply, 'them');
        history.push({ role: 'user', content: text });
        history.push({ role: 'assistant', content: reply });
        if (history.length > 16) history = history.slice(-16);
      }
    } catch (e) {
      typing.remove();
      bubble("Network hiccup — I couldn't reach the assistant.", 'err');
    } finally { busy = false; sendBtn.disabled = false; input.focus(); }
  }

  function buildPanel() {
    panel = el('div'); panel.id = 'crotts-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Crotts assistant');
    var head = el('div'); head.id = 'crotts-head';
    var av = el('img'); av.src = AVATAR; av.alt = 'Crotts'; head.appendChild(av);
    var titles = el('div'); titles.appendChild(el('div', 't', 'Crotts')); titles.appendChild(el('div', 's', 'GVDG assistant')); head.appendChild(titles);
    var close = el('button', null, '✕'); close.id = 'crotts-close'; close.setAttribute('aria-label', 'Close'); close.addEventListener('click', toggle); head.appendChild(close);
    panel.appendChild(head);
    msgs = el('div'); msgs.id = 'crotts-msgs'; panel.appendChild(msgs);
    var form = el('form'); form.id = 'crotts-form';
    input = el('textarea'); input.id = 'crotts-input'; input.rows = 1; input.placeholder = 'Ask Crotts…'; input.setAttribute('aria-label', 'Message Crotts');
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    sendBtn = el('button', null, 'Send'); sendBtn.id = 'crotts-send'; sendBtn.type = 'submit';
    form.appendChild(input); form.appendChild(sendBtn);
    form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    panel.appendChild(form);
    document.body.appendChild(panel);
  }

  function toggle() {
    if (!panel) buildPanel();
    var open = panel.classList.toggle('open');
    if (open) { greet(); setTimeout(function () { input && input.focus(); }, 50); }
  }

  function init() {
    var style = el('style'); style.textContent = css; document.head.appendChild(style);
    var fab = el('button'); fab.id = 'crotts-fab'; fab.setAttribute('aria-label', 'Open Crotts assistant'); fab.title = 'Ask Crotts';
    var img = el('img'); img.src = AVATAR; img.alt = 'Crotts'; fab.appendChild(img);
    fab.appendChild(el('span', null, '')); // (badge slot, unused for now)
    fab.addEventListener('click', toggle);
    document.body.appendChild(fab);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
