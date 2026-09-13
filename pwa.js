(function () {
  'use strict';

  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var deferredInstall = null;
  var updateBanner = null;
  var refreshing = false;
  var SNOOZE_KEY = 'gvdg_update_snooze';
  var BUILD_KEY = 'gvdg_app_commit';
  var SNOOZE_MS = 12 * 60 * 60 * 1000;

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredInstall = event;
    window.__gvdgPwaInstallAvailable = true;
    window.dispatchEvent(new CustomEvent('gvdg:pwa-install-available'));
  });

  window.addEventListener('gvdg:pwa-install-prompt', function () {
    if (!deferredInstall || typeof deferredInstall.prompt !== 'function') return;
    deferredInstall.prompt();
    deferredInstall = null;
    window.__gvdgPwaInstallAvailable = false;
  });

  function standaloneDisplay() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    } catch (err) {
      return navigator.standalone === true;
    }
  }

  function iosDevice() {
    var ua = String(navigator.userAgent || '');
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function snoozed() {
    try {
      return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now();
    } catch (err) {
      return false;
    }
  }

  function hideBanner() {
    if (updateBanner && updateBanner.parentNode) updateBanner.parentNode.removeChild(updateBanner);
    updateBanner = null;
  }

  function snooze() {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    } catch (err) {}
    hideBanner();
  }

  function updateCopy() {
    if (iosDevice() && standaloneDisplay()) {
      return {
        title: 'Update available',
        body: 'This Home Screen app is on an older version. Tap Refresh. If nothing changes, swipe up to close GVDG, then open it again from your Home Screen.',
        action: 'Refresh',
      };
    }
    return {
      title: 'Update available',
      body: 'A newer version of the club app is ready. Tap Refresh. If the top bar is still orange, swipe GVDG away from Recents and open it again from the Home Screen.',
      action: 'Refresh',
    };
  }

  function showBanner(onRefresh) {
    if (updateBanner || snoozed() || !document.body) return;
    var copy = updateCopy();
    var root = document.createElement('div');
    root.className = 'pwa-update';
    root.setAttribute('role', 'status');

    var text = document.createElement('div');
    text.className = 'pwa-update-copy';
    var title = document.createElement('strong');
    title.textContent = copy.title;
    var body = document.createElement('p');
    body.textContent = copy.body;
    text.appendChild(title);
    text.appendChild(body);

    var actions = document.createElement('div');
    actions.className = 'pwa-update-actions';
    var refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'pwa-update-refresh';
    refreshBtn.textContent = copy.action;
    refreshBtn.addEventListener('click', onRefresh);
    var laterBtn = document.createElement('button');
    laterBtn.type = 'button';
    laterBtn.className = 'pwa-update-later';
    laterBtn.textContent = 'Later';
    laterBtn.addEventListener('click', snooze);
    actions.appendChild(refreshBtn);
    actions.appendChild(laterBtn);

    root.appendChild(text);
    root.appendChild(actions);
    document.body.appendChild(root);
    updateBanner = root;
  }

  function refreshNow(registration) {
    if (refreshing) return;
    refreshing = true;
    try {
      localStorage.removeItem(SNOOZE_KEY);
    } catch (err) {}
    if (registration && registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    window.setTimeout(function () {
      location.reload();
    }, 80);
  }

  function watchRegistration(registration) {
    if (!registration) return;
    function prompt() {
      showBanner(function () { refreshNow(registration); });
    }
    if (registration.waiting && navigator.serviceWorker.controller) prompt();
    registration.addEventListener('updatefound', function () {
      var worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', function () {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) prompt();
      });
    });
  }

  function checkPublishedBuild() {
    fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      if (!data || !data.commit) return;
      var seen = '';
      try {
        seen = localStorage.getItem(BUILD_KEY) || '';
      } catch (err) {}
      if (seen && seen !== data.commit) {
        showBanner(function () {
          try {
            localStorage.setItem(BUILD_KEY, data.commit);
          } catch (err) {}
          refreshNow();
        });
        return;
      }
      if (!seen) {
        try {
          localStorage.setItem(BUILD_KEY, data.commit);
        } catch (err) {}
      }
    }).catch(function () {});
  }

  checkPublishedBuild();

  if (!('serviceWorker' in navigator) || (location.protocol !== 'https:' && !local)) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then(function (registration) {
      watchRegistration(registration);
      function ping() {
        registration.update().catch(function () {});
      }
      ping();
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') ping();
      });
      window.addEventListener('pageshow', function (event) {
        if (event.persisted) ping();
      });
      window.setInterval(ping, 5 * 60 * 1000);
    }).catch(function () {});
  });
})();
