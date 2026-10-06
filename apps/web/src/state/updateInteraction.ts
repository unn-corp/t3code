import {
  beginAndroidUpload,
  markAndroidShellHealthy,
  supportsAndroidUpdates,
} from "../android/updates";
import { useEffect } from "react";
let uploadsInFlight = 0;
let inputActiveAt: number | null = null;
function report() {
  if (typeof window === "undefined") return;
  void window.desktopBridge
    ?.reportMaintenanceInteraction?.({ inputActiveAt, uploadsInFlight })
    .catch(() => {});
}
/** Covers the lifetime of an upload, including cancellation awaiting network termination. */
export function beginClientUpdateUpload(): (() => void) | Promise<() => void> {
  const hold = beginAndroidUpload();
  const admitted = (releaseAndroid: () => void) => {
    uploadsInFlight++;
    report();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      uploadsInFlight = Math.max(0, uploadsInFlight - 1);
      releaseAndroid();
      report();
    };
  };
  return typeof hold === "function" ? admitted(hold) : hold.then(admitted);
}
export function ClientUpdateInteractionCoordinator() {
  useEffect(() => {
    const input = () => {
      inputActiveAt = Date.now();
      report();
    };
    window.addEventListener("input", input);
    window.addEventListener("keydown", input);
    window.addEventListener("pointerdown", input);
    const heartbeat = window.setInterval(report, 30_000);
    if (supportsAndroidUpdates()) void markAndroidShellHealthy().catch(() => {});
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("input", input);
      window.removeEventListener("keydown", input);
      window.removeEventListener("pointerdown", input);
    };
  }, []);
  return null;
}
