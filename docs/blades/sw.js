// Onyx Blades deck — minimal service worker.
// Exists so the board qualifies as an installable PWA. Network-first passthrough:
// we do NOT cache API/board responses (the board must stay live), we just let the
// browser install us. An offline shell could be added later if wanted.
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e){ /* passthrough — let the network handle it */ });
