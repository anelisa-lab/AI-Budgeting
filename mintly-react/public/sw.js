/* Minimal service worker: lets the phone install UniWallet as an app.
   It caches nothing — every request goes to the network, so you always get
   the latest code and live prices. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
