import type { EnvironmentId, PreviewNavStatus, ThreadId } from "@t3tools/contracts";
import { isAndroidPwa } from "../env";
import { create } from "zustand";

interface BrowserBridge {
  postMessage(message: string): void;
  onmessage: ((event: { readonly data: string }) => void) | null;
}
export interface AndroidBrowserStatus {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly navStatus: PreviewNavStatus;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly visible: boolean;
}
declare global {
  interface Window {
    t3Browser?: BrowserBridge;
  }
}
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const listeners = new Set<(event: AndroidBrowserStatus) => void>();
export const useAndroidBrowserTabs = create<{
  tabs: Record<string, AndroidBrowserStatus>;
  foreground: boolean;
}>(() => ({ tabs: {}, foreground: true }));
let attached: BrowserBridge | undefined;
let sequence = 0;

export function supportsAndroidBrowser(): boolean {
  return isAndroidPwa && typeof window.t3Browser?.postMessage === "function";
}
function attach(bridge: BrowserBridge) {
  if (attached === bridge) return;
  attached = bridge;
  // AndroidX exposes one onmessage callback on its injected object.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  bridge.onmessage = ({ data }) => {
    try {
      const response: {
        id?: string;
        result?: unknown;
        error?: string;
        event?: AndroidBrowserStatus;
        foreground?: boolean;
        closed?: string;
        presentation?: { key: string; visible: boolean };
      } = JSON.parse(data);
      if (response.foreground !== undefined) {
        useAndroidBrowserTabs.setState({ foreground: response.foreground });
        return;
      }
      if (response.closed) {
        const key = response.closed;
        useAndroidBrowserTabs.setState((state) => {
          if (!state.tabs[key]) return state;
          const tabs = { ...state.tabs };
          delete tabs[key];
          return { tabs };
        });
        return;
      }
      if (response.presentation) {
        const { key, visible } = response.presentation;
        useAndroidBrowserTabs.setState((state) =>
          state.tabs[key] && state.tabs[key].visible !== visible
            ? { tabs: { ...state.tabs, [key]: { ...state.tabs[key], visible } } }
            : state,
        );
        return;
      }
      if (response.event) {
        useAndroidBrowserTabs.setState((state) => ({
          tabs: { ...state.tabs, [response.event!.key]: response.event! },
        }));
        for (const listener of listeners) listener(response.event);
        return;
      }
      const request = response.id ? pending.get(response.id) : undefined;
      if (!request || !response.id) return;
      pending.delete(response.id);
      if (response.error) request.reject(new Error(response.error));
      else request.resolve(response.result);
    } catch {
      /* An unrelated or malformed reply cannot resolve a request. */
    }
  };
}
export function androidBrowserRequest<T = unknown>(
  action: string,
  payload: unknown = {},
  timeoutMs = 20_000,
): Promise<T> {
  const bridge = window.t3Browser;
  if (!supportsAndroidBrowser() || !bridge)
    return Promise.reject(new Error("Update the Android app to use its phone browser."));
  attach(bridge);
  const id = `${Date.now()}:${++sequence}`;
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("The phone browser did not respond."));
    }, timeoutMs);
    pending.set(id, {
      resolve: (result) => {
        window.clearTimeout(timeout);
        resolve(result as T);
      },
      reject: (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    });
    try {
      // The native listener limits messages to the bundled app's main frame.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      bridge.postMessage(JSON.stringify({ id, action, payload }));
    } catch (error) {
      pending.delete(id);
      window.clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error("Could not contact the phone browser."));
    }
  });
}
export function subscribeAndroidBrowser(listener: (event: AndroidBrowserStatus) => void) {
  if (window.t3Browser) attach(window.t3Browser);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** A tab belongs to one environment, server lifetime, and thread. */
export function androidBrowserKey(
  environmentId: string,
  serverEpoch: string | null,
  threadId: string,
  tabId: string,
): string {
  return JSON.stringify([environmentId, serverEpoch, threadId, tabId]);
}
export async function closeAndroidBrowserTab(key: string) {
  useAndroidBrowserTabs.setState((state) => {
    const tabs = { ...state.tabs };
    delete tabs[key];
    return { tabs };
  });
  await androidBrowserRequest("close", { key });
}
