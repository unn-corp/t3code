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
