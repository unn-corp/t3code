import { isElectron } from "./env";

export type PwaServiceWorkerState =
  | { readonly type: "unsupported" }
  | { readonly type: "ready"; readonly registration: ServiceWorkerRegistration }
  | { readonly type: "failed"; readonly error: Error };

let registrationPromise: Promise<PwaServiceWorkerState> | null = null;
let activeRegistration: ServiceWorkerRegistration | null = null;

/** Synchronous accessor for a registration preloaded during app boot. */
export function getActivePwaServiceWorkerRegistration(): ServiceWorkerRegistration | null {
  return activeRegistration;
}

function waitForActivation(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorkerRegistration> {
  if (registration.active !== null) return Promise.resolve(registration);
  const worker = registration.installing ?? registration.waiting;
  if (worker === null) {
    return Promise.reject(new Error("The service worker did not start installing."));
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.removeEventListener("statechange", onStateChange);
      reject(new Error("The service worker did not activate in time."));
    }, 5_000);
    const onStateChange = () => {
      if (worker.state === "activated") {
        window.clearTimeout(timeout);
        worker.removeEventListener("statechange", onStateChange);
        resolve(registration);
      } else if (worker.state === "redundant") {
        window.clearTimeout(timeout);
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("The service worker became redundant before activation."));
      }
    };
    worker.addEventListener("statechange", onStateChange);
  });
}

/** Registers the static worker only for the hosted HTTPS application. */
export function registerPwaServiceWorker(): Promise<PwaServiceWorkerState> {
  if (isElectron || !window.isSecureContext || !("serviceWorker" in navigator)) {
    return Promise.resolve({ type: "unsupported" });
  }
  if (registrationPromise !== null) return registrationPromise;

  registrationPromise = navigator.serviceWorker
    .register("/service-worker.js", { scope: "/" })
    .then(waitForActivation)
    .then((registration) => {
      activeRegistration = registration;
      return { type: "ready", registration } as const;
    })
    .catch((cause: unknown) => ({
      type: "failed" as const,
      error:
        cause instanceof Error ? cause : new Error("Could not register the PWA service worker."),
    }));
  return registrationPromise;
}

/**
 * Discards everything cached for this installation and reloads from the server.
 *
 * An installed PWA can hold a shell that names bundles by content hash, so a
 * stale shell keeps asking for files that no longer exist and the app pins
 * itself to an old build. The server now sends no-cache for the shell, which
 * prevents that going forward, but a client already holding a stale copy has
 * no way to notice on its own. This is that way out, and it is deliberately
 * blunt: unregister the workers, drop every cache, reload.
 *
 * Pairing and settings live in localStorage and IndexedDB, which are left
 * alone, so this does not sign the device out or lose its environments.
 */
export async function clearPwaCachesAndReload(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch {
    // A browser that refuses the registration list still benefits from the
    // cache drop and the reload below.
  }
  try {
    const keys = (await window.caches?.keys()) ?? [];
    await Promise.all(keys.map((key) => window.caches.delete(key)));
  } catch {
    // Same: a failure here must not stop the reload, which is what actually
    // re-fetches the shell.
  }
  // Replace rather than reload: a reload can be served from the back/forward
  // cache, which is the thing being escaped.
  window.location.replace(window.location.origin);
}
