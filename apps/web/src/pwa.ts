import { isElectron } from "./env";

/** Registers the static worker only for the hosted HTTPS application. */
export function registerPwaServiceWorker(): void {
  if (isElectron || !window.isSecureContext || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {
    // PWA support is optional. Authentication and normal browser use remain available.
  });
}
