import { isElectron } from "../env";

export type BrowserNotificationStatus =
  | "unsupported"
  | "permission-needed"
  | "permission-blocked"
  | "ready";

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

  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification("T3 Code", {
    body: "Browser notifications are working on this device.",
    tag: "t3-code-notification-preview",
  });
  return "ready";
}
