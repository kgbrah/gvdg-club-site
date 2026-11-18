(function () {
  'use strict';

  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var deferredInstall = null;
  var updateBanner = null;
  var registration = null;
  var refreshing = false;
  var refreshCancelled = false;
  var refreshError = '';
  var versionCheck = null;
  var checkVersionAgain = false;
  var workerCheck = null;
  var installedWorker = null;
  var snoozedWorker = null;
  var publishedCommit = '';
  var markerUnavailable = false;
  var SNOOZE_KEY = 'gvdg_update_snooze';
  var BUILD_KEY = 'gvdg_app_commit';
  var REFRESH_KEY = 'gvdg_update_requested';
  var SNOOZE_MS = 12 * 60 * 60 * 1000;
  var CHECK_MS = 5 * 60 * 1000;
  var REFRESH_TIMEOUT_MS = 15000;
  // How long Refresh gives a new service worker to take over before reloading anyway (see refreshNow).
  var ACTIVATION_GRACE_MS = 8000;
  var buildTag = document.querySelector('meta[name="gvdg-build"]');
  var stampedBuild = buildTag ? (buildTag.content || '').trim() : '';
  var documentBuild = stampedBuild || readStorage('localStorage', BUILD_KEY);
  var refreshReceipt = readRecord('sessionStorage', REFRESH_KEY);
  var startedOffline = navigator.onLine === false;
  var acceptedFirstMarker = false;

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredInstall = event;
    window.__gvdgPwaInstallAvailable = true;
    window.dispatchEvent(new CustomEvent('gvdg:pwa-install-available'));
  });

  window.addEventListener('gvdg:pwa-install-prompt', function () {
    if (!deferredInstall || typeof deferredInstall.prompt !== 'function') {
      window.dispatchEvent(new CustomEvent('gvdg:pwa-install-manual'));
      return;
    }
    var pending = deferredInstall;
    deferredInstall = null;
    window.__gvdgPwaInstallAvailable = false;
    pending.prompt();
    if (pending.userChoice && typeof pending.userChoice.then === 'function') {
      pending.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') {
          window.dispatchEvent(new CustomEvent('gvdg:pwa-installed'));
        }
      }).catch(function () {});
    }
  });

  function readStorage(storage, key) {
    try { return window[storage].getItem(key) || ''; }
    catch (err) { return ''; }
  }

  function readRecord(storage, key) {
    try { return JSON.parse(readStorage(storage, key)); }
    catch (err) { return null; }
  }

  function writeStorage(storage, key, value) {
    try {
      if (value == null) window[storage].removeItem(key);
      else window[storage].setItem(key, value);
    } catch (err) {}
  }

  function installedDisplay() {
    try {
      return window.matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui), (display-mode: window-controls-overlay)').matches
        || navigator.standalone === true;
    } catch (err) {
      return navigator.standalone === true;
    }
  }

  function scoringOpen() {
    if (!document.body) return false;
    return document.body.classList.contains('score-glove') || Boolean(document.querySelector('.score-glove-layout, .wrist-score'));
  }

  function tellInstalledApp() {
    var controller = navigator.serviceWorker?.controller;
    if (installedDisplay() && controller) controller.postMessage({ type: 'APP_WINDOW' });
  }

  function pendingUpdate() {
    if (publishedCommit && documentBuild !== publishedCommit) return { commit: publishedCommit };
    var waiting = registration?.waiting;
    if (waiting && navigator.serviceWorker.controller) return { worker: waiting };
    if (markerUnavailable && installedWorker) return { worker: installedWorker };
    return null;
  }

  var later = readRecord('localStorage', SNOOZE_KEY);
  function snoozed(offer) {
    if (!offer.commit) return offer.worker === snoozedWorker;
    return later && later.commit === offer.commit && later.until > Date.now();
  }

  function hideBanner() {
    if (updateBanner) updateBanner.remove();
    updateBanner = null;
  }

  function showBanner() {
    var offer = pendingUpdate();
    var cardOpen = scoringOpen();
    if (refreshing && cardOpen) refreshCancelled = true;
    if (!offer || snoozed(offer) || navigator.onLine === false || cardOpen || !document.body) {
      hideBanner();
      return;
    }
    if (!updateBanner) {
      var root = document.createElement('div');
      root.className = 'pwa-update';
      root.setAttribute('role', 'status');
      root.innerHTML = '<div class="pwa-update-copy"><strong>Update available</strong><p></p></div>'
        + '<div class="pwa-update-actions"><button type="button" class="pwa-update-refresh">Refresh</button>'
        + '<button type="button" class="pwa-update-later">Later</button></div>';
      root.querySelector('.pwa-update-refresh').addEventListener('click', refreshNow);
      root.querySelector('.pwa-update-later').addEventListener('click', function () {
        var next = pendingUpdate();
        if (!next || refreshing) return;
        if (next.commit) {
          later = { commit: next.commit, until: Date.now() + SNOOZE_MS };
          writeStorage('localStorage', SNOOZE_KEY, JSON.stringify(later));
        } else snoozedWorker = next.worker;
        hideBanner();
      });
      document.body.appendChild(root);
      updateBanner = root;
    }
    var text = updateBanner.querySelector('p');
    var message = refreshError || (refreshing
      ? 'Preparing the update…'
      : documentBuild ? 'Refresh to get the latest improvements.' : 'Refresh to check you’re using the latest club app.');
    if (text.textContent !== message) text.textContent = message;
    updateBanner.querySelector('.pwa-update-refresh').disabled = refreshing;
    updateBanner.querySelector('.pwa-update-later').disabled = refreshing;
  }

  function acceptVersion(commit) {
    if (!acceptedFirstMarker) {
      acceptedFirstMarker = true;
      // An explicit refresh is acknowledged by the next online document, not the old one.
      var confirmed = refreshReceipt && refreshReceipt.commit === commit
        && Date.now() - refreshReceipt.requestedAt < 5 * 60 * 1000;
      if (!stampedBuild && (confirmed || (!documentBuild && !startedOffline))) documentBuild = commit;
      if (documentBuild === commit) writeStorage('localStorage', BUILD_KEY, commit);
      writeStorage('sessionStorage', REFRESH_KEY, null);
    }
    if (publishedCommit !== commit) refreshError = '';
    publishedCommit = commit;
  }

  function checkPublishedBuild() {
    if (navigator.onLine === false) { startedOffline = startedOffline || !acceptedFirstMarker; return Promise.resolve(''); }
    if (versionCheck) return versionCheck;
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, REFRESH_TIMEOUT_MS);
    versionCheck = fetch('version.json?t=' + Date.now(), { cache: 'no-store', signal: controller.signal }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      var commit = data && typeof data.commit === 'string' && data.commit.trim();
      markerUnavailable = !commit;
      if (commit) acceptVersion(commit);
      else if (!acceptedFirstMarker && !documentBuild && navigator.serviceWorker?.controller) startedOffline = true;
      return commit || '';
    }).catch(function () {
      markerUnavailable = true;
      if (!acceptedFirstMarker && !documentBuild) startedOffline = true;
      return '';
    }).finally(function () {
      window.clearTimeout(timeout);
      versionCheck = null;
      showBanner();
      if (checkVersionAgain) {
        checkVersionAgain = false;
        void checkPublishedBuild();
      }
    });
    return versionCheck;
  }

  function checkWorker() {
    if (!registration || navigator.onLine === false) return Promise.resolve();
    if (!workerCheck) {
      workerCheck = registration.update().finally(function () { workerCheck = null; });
    }
    return workerCheck;
  }

  function checkForUpdates() {
    tellInstalledApp();
    showBanner();
    if (versionCheck) checkVersionAgain = true;
    else void checkPublishedBuild();
    checkWorker().catch(function () {});
  }

  function waitForControl(worker, sendSkipWaiting, limitMs) {
    return new Promise(function (resolve, reject) {
      var sent = false;
      var timeout = window.setTimeout(function () { finish(new Error('Update did not activate')); }, limitMs || REFRESH_TIMEOUT_MS);
      function finish(error) {
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('controllerchange', inspect);
        worker.removeEventListener('statechange', inspect);
        if (error) reject(error);
        else resolve();
      }
      function inspect() {
        if (navigator.serviceWorker.controller === worker && worker.state === 'activated') { finish(); return; }
        if (worker.state === 'redundant') { finish(new Error('Update was replaced')); return; }
        if (sendSkipWaiting && !sent && worker.state === 'installed') {
          sent = true;
          try { worker.postMessage({ type: 'SKIP_WAITING' }); }
          catch (err) { finish(err); }
        }
      }
      navigator.serviceWorker.addEventListener('controllerchange', inspect);
      worker.addEventListener('statechange', inspect);
      inspect();
    });
  }

  async function activateIncomingWorker(limitMs) {
    if (!registration) return;
    var incoming = registration.waiting || registration.installing;
    var active = registration.active;
    var controller = navigator.serviceWorker.controller;
    if (incoming) await waitForControl(incoming, true, limitMs);
    else if (active && controller && active !== controller) await waitForControl(active, false, limitMs);
  }

  async function checkPageAvailable() {
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, REFRESH_TIMEOUT_MS);
    try {
      // A HEAD request bypasses the offline document fallback in sw.js.
      var response = await fetch(location.href, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Page unavailable');
    } finally { window.clearTimeout(timeout); }
  }

  async function refreshNow() {
    var offer = pendingUpdate();
    if (!offer || refreshing || scoringOpen() || navigator.onLine === false) return;
    refreshing = true;
    refreshCancelled = false;
    refreshError = '';
    showBanner();
    try {
      // Only the network decides whether a refresh can happen: the published release and the page itself.
      var commit = await checkPublishedBuild();
      if ((offer.commit && !commit) || navigator.onLine === false) throw new Error('Could not verify the update');
      await checkPageAvailable();
      // Then give the new service worker a moment to take over, but never fail on it. Chromium can leave a new
      // worker "installed" and waiting for a long time while a page is open, and an install can fail (a full
      // storage quota, say); either used to end in "Couldn't refresh" on every tap, even on good signal. The
      // reload gets the new release anyway (pages, bundles and chunks load network-first or by versioned / hashed
      // URL), and the worker takes over on a later launch.
      try {
        await activateIncomingWorker(ACTIVATION_GRACE_MS);
      } catch (err) {
        if (window.console && console.warn) console.warn('[pwa] reloading without the new service worker:', err && err.message);
      }
      if (refreshCancelled || scoringOpen() || navigator.onLine === false) return;
      if (commit) {
        writeStorage('sessionStorage', REFRESH_KEY, JSON.stringify({ commit: commit, requestedAt: Date.now() }));
      }
      location.reload();
    } catch (err) {
      refreshError = 'Couldn’t refresh the app. Try again when connected.';
    } finally {
      refreshing = false;
      showBanner();
    }
  }

  function watchRegistration(value) {
    registration = value;
    var controller = navigator.serviceWorker.controller;
    function inspect(worker) {
      if (!worker) return;
      function changed() {
        if (worker.state === 'installed' && controller) {
          installedWorker = worker;
          showBanner();
          void checkPublishedBuild();
        }
      }
      worker.addEventListener('statechange', changed);
      changed();
    }
    if (registration.waiting) inspect(registration.waiting);
    inspect(registration.installing);
    registration.addEventListener('updatefound', function () { inspect(registration.installing); });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      var next = navigator.serviceWorker.controller;
      if (next && controller && next !== controller) installedWorker = next;
      controller = next;
      tellInstalledApp();
      showBanner();
      void checkPublishedBuild();
    });
    navigator.serviceWorker.ready.then(tellInstalledApp).catch(function () {});
    checkForUpdates();
  }

  function start() {
    checkForUpdates();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkForUpdates();
    });
    window.addEventListener('pageshow', function () { checkForUpdates(); });
    window.addEventListener('online', checkForUpdates);
    window.addEventListener('offline', showBanner);
    window.setInterval(function () {
      if (document.visibilityState === 'visible') checkForUpdates();
    }, CHECK_MS);
    if (document.body) {
      new MutationObserver(showBanner).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    if (!('serviceWorker' in navigator) || (location.protocol !== 'https:' && !local)) return;
    navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then(watchRegistration).catch(function () {});
  }

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();
