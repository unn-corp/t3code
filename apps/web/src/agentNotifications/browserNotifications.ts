import { isElectron } from "../env";
import { getActivePwaServiceWorkerRegistration, registerPwaServiceWorker } from "../pwa";

export type BrowserNotificationStatus =
  | "unsupported"
  | "permission-needed"
  | "permission-blocked"
  | "ready";

export type BrowserPushSetupState =
  | "unsupported"
  | "not-installed"
  | "permission-needed"
  | "permission-blocked"
  | "permission-granted"
  | "worker-failed"
  | "subscribed";

function isStandalonePwa(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && navigator.standalone === true)
  );
}

function applicationServerKey(value: string): ArrayBuffer {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = atob(padded);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

export function getBrowserNotificationStatus(): BrowserNotificationStatus {
  if (
    isElectron ||
    !window.isSecureContext ||
    !("Notification" in window) ||
    !("serviceWorker" in navigator)
  ) {
    return "unsupported";
  }

  if (Notification.permission === "denied") return "permission-blocked";
  if (Notification.permission !== "granted") return "permission-needed";
  return "ready";
}

/** Must only be invoked from a direct user gesture. */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationStatus> {
  if (getBrowserNotificationStatus() === "unsupported") return "unsupported";
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
  return getBrowserNotificationStatus();
}

/** Displays a local worker notification. It deliberately does not contact the relay. */
export async function showBrowserNotificationPreview(): Promise<BrowserNotificationStatus> {
  const status = getBrowserNotificationStatus();
  if (status !== "ready") return status;

  const worker = await registerPwaServiceWorker();
  if (worker.type !== "ready")
    return worker.type === "unsupported" ? "unsupported" : "permission-needed";
  const registration = worker.registration;
  await registration.showNotification("T3 Code", {
    body: "Browser notifications are working on this device.",
    tag: "t3-code-notification-preview",
  });
  return "ready";
}

/** Must only be called from the direct notification-enable user gesture on iOS. */
export function subscribeBrowserPush(input: { readonly applicationServerKey: string }): Promise<{
  readonly state: BrowserPushSetupState;
  readonly subscription: PushSubscription | null;
}> {
  if (getBrowserNotificationStatus() === "unsupported") {
    return Promise.resolve({ state: "unsupported", subscription: null });
  }
  if (!isStandalonePwa()) return Promise.resolve({ state: "not-installed", subscription: null });
  if (Notification.permission !== "granted") {
    return requestBrowserNotificationPermission().then((permission) => ({
      state: permission === "ready" ? "permission-granted" : permission,
      subscription: null,
    }));
  }
  const registration = getActivePwaServiceWorkerRegistration();
  if (registration === null) return Promise.resolve({ state: "worker-failed", subscription: null });
  // Do not await before subscribe: iOS requires this call to occur while this
  // direct Switch interaction still has transient user activation.
  return registration.pushManager
    .subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(input.applicationServerKey),
    })
    .then((subscription) => ({ state: "subscribed" as const, subscription }));
}

export async function unsubscribeBrowserPush(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

export async function getExistingBrowserPushSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}
