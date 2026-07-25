/* global self, caches */

// Tombstone worker for a legacy "/sw.js" registration.
//
// This origin previously served a different app (a vite-plugin-pwa build whose
// worker took scope "/" and registered a NavigationRoute). That worker serves
// its own precached index.html for every navigation, so it keeps showing the
// old app no matter what this server returns.
//
// It could not expire on its own: this app answers unknown paths with the SPA
// fallback, so the browser's update check for "/sw.js" got 200 text/html. That
// is not a JavaScript MIME type, so the update failed and the old worker stayed
// installed and active, permanently.
//
// Serving a real script here lets that update succeed, which replaces the old
// worker with this one. This worker then drops every cache, unregisters itself,
// and reloads open windows so they fall through to the network. It has no fetch
// handler, so it never intercepts a request.
//
// This app's own PWA worker is "/service-worker.js" (a separate registration),
// which is unaffected. Keep this file until every client has been reclaimed.

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: "window" });
      for (const client of windows) {
        // Re-navigate so the freed window loads from the network.
        client.navigate(client.url);
      }
    })(),
  );
});
