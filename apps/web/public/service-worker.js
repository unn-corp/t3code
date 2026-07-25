/* global self, clients */

// Push registration is added by the authenticated notification settings flow.
// This worker intentionally does not cache API or thread data: auth/session
// state must always be fetched from the current environment.
self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || typeof payload.deepLink !== "string") return;
  if (
    !/^\/threads\/(?![^/]*%(?:2[fF]|5[cC]))(?:[^/?#%]|%[\dA-Fa-f]{2})+\/(?![^/]*%(?:2[fF]|5[cC]))(?:[^/?#%]|%[\dA-Fa-f]{2})+$/.test(
      payload.deepLink,
    )
  )
    return;

  const generic = payload.showProjectAndThreadNames !== true;
  const title = generic ? "T3 Code" : "T3 Code notification";
  const body = generic ? "Agent activity needs your attention." : "Open T3 Code to continue.";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { deepLink: payload.deepLink },
      tag: typeof payload.eventId === "string" ? payload.eventId : undefined,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const deepLink = event.notification.data?.deepLink;
  if (
    typeof deepLink !== "string" ||
    !/^\/threads\/(?![^/]*%(?:2[fF]|5[cC]))(?:[^/?#%]|%[\dA-Fa-f]{2})+\/(?![^/]*%(?:2[fF]|5[cC]))(?:[^/?#%]|%[\dA-Fa-f]{2})+$/.test(
      deepLink,
    )
  )
    return;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((openClients) => {
      const existing = openClients.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) return existing.focus().then(() => existing.navigate(deepLink));
      return clients.openWindow(deepLink);
    }),
  );
});
