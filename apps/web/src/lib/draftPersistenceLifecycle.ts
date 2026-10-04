/** Phone PWAs can be terminated while hidden without ever firing beforeunload. */
export function installDraftPersistenceLifecycle(
  page: Pick<Window, "addEventListener" | "removeEventListener">,
  visibility: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">,
  flush: () => void,
) {
  const onHidden = () => {
    if (visibility.visibilityState === "hidden") flush();
  };
  page.addEventListener("beforeunload", flush);
  page.addEventListener("pagehide", flush);
  visibility.addEventListener("visibilitychange", onHidden);
  return () => {
    page.removeEventListener("beforeunload", flush);
    page.removeEventListener("pagehide", flush);
    visibility.removeEventListener("visibilitychange", onHidden);
  };
}
