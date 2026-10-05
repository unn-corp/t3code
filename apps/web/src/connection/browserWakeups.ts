/** Visible browser returns should check the socket, including restored and unfrozen pages. */
export function installBrowserConnectionWakeups(
  page: Pick<Window, "addEventListener" | "removeEventListener">,
  document: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">,
  wake: () => void,
) {
  let disposed = false;
  let queued = false;
  const onVisible = () => {
    if (queued || disposed) return;
    queued = true;
    // One return can raise several lifecycle events. Check after they have
    // updated visibility, and let the connection supervisor probe its socket.
    queueMicrotask(() => {
      queued = false;
      if (!disposed && document.visibilityState === "visible") wake();
    });
  };
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) onVisible();
  };
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("resume", onVisible);
  page.addEventListener("focus", onVisible);
  page.addEventListener("pageshow", onPageShow);
  return () => {
    disposed = true;
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("resume", onVisible);
    page.removeEventListener("focus", onVisible);
    page.removeEventListener("pageshow", onPageShow);
  };
}
