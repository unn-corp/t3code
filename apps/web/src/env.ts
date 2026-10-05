/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.desktopBridge via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

/** The Android APK bundles this client and owns its storage independently of any server. */
export const isAndroidPwa = import.meta.env.VITE_ANDROID_PWA === "1";

/**
 * True in an installed PWA, where the app runs without browser chrome.
 *
 * Read at call time rather than captured: a tab can be launched standalone
 * later, and matchMedia reflects that where a snapshot taken at module load
 * would not.
 */
export function isInstalledPwa(): boolean {
  if (typeof window === "undefined" || isElectron) return false;
  if (isAndroidPwa) return true;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const iosStandalone =
    (window.navigator as { standalone?: boolean } | undefined)?.standalone === true;
  return standalone || iosStandalone;
}
