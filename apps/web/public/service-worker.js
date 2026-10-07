/* global self, clients */

// Push registration is tied to a local installed-PWA credential, never a T3
// Connect account. This worker intentionally has no account/session data.
// This worker intentionally does not cache API or thread data: auth/session
// state must always be fetched from the current environment.
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

// The transport uses /threads/:environment/:thread; the web router omits /threads.
// Accept canonical URLs too, including notifications stored by this worker.
function notificationDestination(deepLink) {
  if (deepLink === "/") return "/";
  if (typeof deepLink !== "string" || deepLink.includes("\\")) return null;
  const match =
    /^\/(?:threads\/)?((?![^/]*%(?:2[fF]|5[cC]))(?:[^/?#%]|%[\dA-Fa-f]{2})+)\/((?![^/]*%(?:2[fF]|5[cC]))(?:[^/?#%]|%[\dA-Fa-f]{2})+)$/.exec(
      deepLink,
    );
  if (!match) return null;
  try {
    if (
      match
        .slice(1)
        .map(decodeURIComponent)
        .some((part) => part === "." || part === "..")
    )
      return null;
  } catch {
    return null;
  }
  return `/${match[1]}/${match[2]}`;
}

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || typeof payload.deepLink !== "string") return;
  const deepLink = notificationDestination(payload.deepLink);
  if (deepLink === null) return;

  const generic = payload.showProjectAndThreadNames !== true;
  const title =
    generic || typeof payload.title !== "string" || payload.title.length === 0
      ? "Arcwright Code"
      : payload.title;
  const body =
    generic || typeof payload.body !== "string" || payload.body.length === 0
      ? "Agent activity needs your attention."
      : payload.body;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { deepLink },
      tag: typeof payload.eventId === "string" ? payload.eventId : undefined,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const deepLink = notificationDestination(event.notification.data?.deepLink);
  if (deepLink === null) return;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((openClients) => {
      const sameOriginClients = openClients.filter(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      const matching = sameOriginClients.find(
        (client) => new URL(client.url).pathname === deepLink,
      );
      if (matching) return matching.focus();
      const existing = sameOriginClients[0];
      if (existing) return existing.focus().then(() => existing.navigate(deepLink));
      return clients.openWindow(deepLink);
    }),
  );
});
