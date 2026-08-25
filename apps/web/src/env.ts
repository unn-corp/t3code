/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.desktopBridge via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

/**
 * True in an installed PWA, where the app runs without browser chrome.
 *
 * Read at call time rather than captured: a tab can be launched standalone
 * later, and matchMedia reflects that where a snapshot taken at module load
 * would not.
 */
export function isInstalledPwa(): boolean {
  if (typeof window === "undefined" || isElectron) return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const iosStandalone =
    (window.navigator as { standalone?: boolean } | undefined)?.standalone === true;
  return standalone || iosStandalone;
}
