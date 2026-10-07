import { isAndroidPwa } from "../env";

export interface AndroidNotificationStatus {
  readonly permission: "ready" | "permission-needed" | "permission-blocked";
  readonly background: boolean;
  readonly notificationClientVisible?: boolean;
}
interface NativeNotificationBridge {
  postMessage(message: string): void;
  onmessage: ((event: { readonly data: string }) => void) | null;
}
declare global {
  interface Window {
    t3Notifications?: NativeNotificationBridge;
  }
}

const pending = new Map<
  string,
  { resolve: (result: AndroidNotificationStatus) => void; reject: (error: Error) => void }
>();
let attached: NativeNotificationBridge | undefined;
let nextRequestId = 0;

export function supportsAndroidNotifications(): boolean {
  return isAndroidPwa && typeof window.t3Notifications?.postMessage === "function";
}

/** Origin-restricted native messages, not the WebView's unsupported Web Push API. */
export function androidNotificationRequest(
  action:
    | "status"
    | "requestPermission"
    | "configure"
    | "register"
    | "background"
    | "test"
    | "settings"
    | "battery",
  payload?: unknown,
): Promise<AndroidNotificationStatus> {
  const bridge = window.t3Notifications;
  if (!supportsAndroidNotifications() || !bridge) {
    return Promise.reject(new Error("Android notifications are unavailable in this app build."));
  }
  if (attached !== bridge) {
    attached = bridge;
    // AndroidX's injected object exposes onmessage, not addEventListener.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    bridge.onmessage = ({ data }) => {
      try {
        const response: { id: string; result?: AndroidNotificationStatus; error?: string } =
          JSON.parse(data);
        const request = pending.get(response.id);
        if (!request) return;
        pending.delete(response.id);
        if (response.error || !response.result)
          request.reject(new Error(response.error ?? "Invalid Android notification response."));
        else request.resolve(response.result);
      } catch {
        /* A malformed or unrelated reply cannot settle a pending request. */
      }
    };
  }
  const id = `${Date.now()}:${++nextRequestId}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("Android notifications did not respond. Try again."));
    }, 60_000);
    pending.set(id, {
      resolve: (result) => {
        window.clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    });
    try {
      // AndroidX restricts the destination to the registered app origin natively.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      bridge.postMessage(JSON.stringify({ id, action, payload }));
    } catch (error) {
      pending.delete(id);
      window.clearTimeout(timeout);
      reject(
        error instanceof Error ? error : new Error("Could not contact Android notifications."),
      );
    }
  });
}
