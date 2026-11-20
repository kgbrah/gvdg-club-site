/* Start-up safety net for the club app (members page).
 * An iPhone home-screen app has no address bar and no reload button, so if the app's code fails to load or throws
 * while drawing the first screen, the person is left on a blank page with no way out (owner: "an apple user had a
 * blank white screen when opening the app"). If nothing has appeared in the app after a few seconds, this shows a
 * plain screen with Reload, Reload fresh (drops the app's saved files, keeps the sign-in), and what went wrong, so it
 * can be screenshotted. It goes away by itself as soon as the app draws something.
 * Plain old JavaScript on purpose: it has to run on phones where the app itself can't. */
(function () {
  "use strict";
  var WAIT_MS = 12000;
  var problems = [];

  function note(text) {
    text = String(text || "").replace(/\s+/g, " ").slice(0, 240);
    if (text && problems.length < 4 && problems.indexOf(text) < 0) problems.push(text);
  }
  window.addEventListener("error", function (event) {
    var target = event && event.target;
    if (target && target !== window && (target.src || target.href)) note("Couldn't load " + (target.src || target.href));
    else note(event && (event.message || (event.error && event.error.message)));
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    note(reason && (reason.message || reason));
  });

  function appText() {
    // Where the app draws: the sign-in gate and the dashboard (not the section around it, which holds <style> blocks).
    var ids = ["membersReactAuthGate", "membersReactDashboardApp"];
    var text = "";
    for (var i = 0; i < ids.length; i += 1) {
      var el = document.getElementById(ids[i]);
      // innerText is what's on screen; textContent would count the <style> blocks inside the dashboard section.
      if (el) text += typeof el.innerText === "string" ? el.innerText : el.textContent || "";
    }
    return text.replace(/\s+/g, "");
  }
  function blank() { return appText().length < 5; }

  // Fetch the app's own code from the network first (Safari can otherwise reuse the copy that failed), then reload.
  // Never waits more than a few seconds.
  function refreshAppCode() {
    var jobs = [];
    try {
      var scripts = document.querySelectorAll('script[type="module"][src]');
      for (var i = 0; i < scripts.length && window.fetch; i += 1) {
        jobs.push(fetch(scripts[i].src, { cache: "reload", credentials: "same-origin" })["catch"](function () { return null; }));
      }
    } catch (error) { /* reload anyway */ }
    return Promise.race([Promise.all(jobs), new Promise(function (resolve) { window.setTimeout(resolve, 4000); })]);
  }
  function reload() {
    refreshAppCode().then(go, go);
    function go() { window.location.reload(); }
  }

  function reloadFresh() {
    var jobs = [refreshAppCode()];
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        jobs.push(navigator.serviceWorker.getRegistrations().then(function (list) {
          return Promise.all(list.map(function (registration) { return registration.unregister(); }));
        }));
      }
      if (window.caches && caches.keys) {
        jobs.push(caches.keys().then(function (keys) { return Promise.all(keys.map(function (key) { return caches.delete(key); })); }));
      }
    } catch (error) { /* reload anyway */ }
    Promise.all(jobs).then(done, done);
    function done() { window.location.reload(); }
  }

  function button(label, onClick, primary) {
    var el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.style.cssText = "display:block;width:100%;margin:10px 0 0;padding:14px 16px;border-radius:10px;font:700 16px/1.2 system-ui,-apple-system,sans-serif;"
      + (primary ? "background:#1f7a3a;color:#fff;border:0;" : "background:transparent;color:inherit;border:1px solid currentColor;");
    el.addEventListener("click", onClick);
    return el;
  }

  var panel = null;
  function show() {
    if (panel || !blank()) return;
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    panel = document.createElement("div");
    panel.id = "gvdgBootRescue";
    panel.setAttribute("role", "alert");
    panel.style.cssText = "position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:max(24px,env(safe-area-inset-top)) 20px 24px;"
      + "font:16px/1.5 system-ui,-apple-system,sans-serif;" + (dark ? "background:#0f0f1e;color:#f2f2f7;" : "background:#fff;color:#1a1a2e;");
    var box = document.createElement("div");
    box.style.cssText = "max-width:420px;margin:12vh auto 0;";
    var title = document.createElement("h1");
    title.textContent = "GVDG didn't open properly";
    title.style.cssText = "font:800 22px/1.25 system-ui,-apple-system,sans-serif;margin:0 0 8px;";
    var line = document.createElement("p");
    line.textContent = "Try Reload. If it happens again, Reload fresh clears the app's saved files (you stay signed in).";
    line.style.cssText = "margin:0 0 8px;";
    box.appendChild(title);
    box.appendChild(line);
    box.appendChild(button("Reload", reload, true));
    box.appendChild(button("Reload fresh", reloadFresh, false));
    var details = document.createElement("p");
    details.style.cssText = "margin:18px 0 0;font-size:12px;opacity:.75;word-break:break-word;";
    details.textContent = "What went wrong: " + (problems.length ? problems.join(" · ") : "the app didn't start.") + " — " + (navigator.userAgent || "");
    box.appendChild(details);
    panel.appendChild(box);
    document.body.appendChild(panel);
    // The app may still finish (a slow connection): step aside as soon as it shows something.
    var watch = window.setInterval(function () {
      if (!blank() && panel) {
        panel.parentNode && panel.parentNode.removeChild(panel);
        panel = null;
        window.clearInterval(watch);
      }
    }, 1000);
  }

  function later() { window.setTimeout(function () { if (document.visibilityState !== "hidden") show(); }, WAIT_MS); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", later);
  else later();
  // Brought back from the background (an iPhone resumes home-screen apps where they were): check again.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") window.setTimeout(show, 4000);
  });
})();
