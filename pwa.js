(function () {
  'use strict';

  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var deferredInstall = null;

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

  if (!('serviceWorker' in navigator) || (location.protocol !== 'https:' && !local)) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () {});
  });
})();
