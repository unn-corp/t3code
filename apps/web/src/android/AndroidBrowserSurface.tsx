import { useEffect, useEffectEvent, useRef } from "react";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { androidBrowserKey, androidBrowserRequest, useAndroidBrowserTabs } from "./browser";

/** A DOM slot positions a real Android WebView; page pixels never cross the network. */
export function AndroidBrowserSurface({
  threadRef,
  serverEpoch,
  snapshot,
  visible,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly serverEpoch: string | null;
  readonly snapshot: PreviewSessionSnapshot;
  readonly visible: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const foreground = useAndroidBrowserTabs((state) => state.foreground);
  const key = androidBrowserKey(
    threadRef.environmentId,
    serverEpoch,
    threadRef.threadId,
    snapshot.tabId,
  );
  const initialUrl = snapshot.navStatus._tag === "Idle" ? "about:blank" : snapshot.navStatus.url;
  const readInitialUrl = useEffectEvent(() => initialUrl);
  const environmentId = threadRef.environmentId;
  const threadId = threadRef.threadId;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let cancelled = false;
    let frame = 0;
    let last = "";
    const owner = `${Date.now()}:${Math.random()}`;
    const measure = () => {
      frame = 0;
      if (cancelled) return;
      const rect = node.getBoundingClientRect();
      // Native child views otherwise cover HTML dialogs and tab menus.
      const overlay = Array.from(
        document.querySelectorAll(
          '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-slot="popover-popup"][data-open],[data-slot="combobox-popup"][data-open],[data-slot="select-popup"][data-open]',
        ),
      ).some((element) => {
        // The mobile Browser panel itself is a sheet/dialog; its native child belongs inside it.
        if (element.contains(node)) return false;
        const bounds = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (
          bounds.width <= 0 ||
          bounds.height <= 0 ||
          style.visibility === "hidden" ||
          style.display === "none"
        )
          return false;
        return (
          element.getAttribute("aria-modal") === "true" ||
          (bounds.right > rect.left &&
            bounds.left < rect.right &&
            bounds.bottom > rect.top &&
            bounds.top < rect.bottom)
        );
      });
      const payload = {
        key,
        owner,
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(0, rect.x)),
        height: Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.y)),
        shellWidth: window.innerWidth,
        visible: visible && foreground && !overlay && document.visibilityState === "visible",
      };
      const next = JSON.stringify(payload);
      if (next === last) return;
      last = next;
      void androidBrowserRequest("surface", payload).catch(() => {
        last = "";
      });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "style",
        "class",
        "data-state",
        "data-open",
        "data-closed",
        "hidden",
        "aria-hidden",
      ],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("focus", schedule);
    void androidBrowserRequest("ensure", {
      key,
      environmentId,
      threadId,
      serverEpoch,
      tabId: snapshot.tabId,
      url: readInitialUrl(),
    })
      .then(schedule)
      .catch(() => {});
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("focus", schedule);
      void androidBrowserRequest("hide", { owner }).catch(() => {});
    };
  }, [foreground, key, serverEpoch, snapshot.tabId, environmentId, threadId, visible]);
  return <div ref={ref} className="absolute inset-0" aria-label="Phone browser" />;
}
