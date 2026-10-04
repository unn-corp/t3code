import { useCallback, useEffect, useState } from "react";

import { registerPwaServiceWorker } from "../pwa";
import { getPwaPushConfig } from "./pwaPushRelay";

/** Preload push setup so subscribing can remain inside the next direct iOS tap. */
export function usePwaNotificationSetup() {
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    let configLoaded = false;
    let configLoading = false;
    const prepare = () => {
      void registerPwaServiceWorker();
      if (configLoaded || configLoading) return;
      configLoading = true;
      setIsConfigLoading(true);
      void getPwaPushConfig()
        .then((key) => {
          configLoaded = true;
          if (!cancelled) setVapidPublicKey(key);
        })
        .catch(() => {
          // Retry on the next arrival, network recovery, or enable interaction.
        })
        .finally(() => {
          configLoading = false;
          if (!cancelled) setIsConfigLoading(false);
        });
    };
    const prepareWhenVisible = () => {
      if (document.visibilityState === "visible") prepare();
    };
    prepare();
    window.addEventListener("online", prepare);
    window.addEventListener("focus", prepareWhenVisible);
    document.addEventListener("visibilitychange", prepareWhenVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("online", prepare);
      window.removeEventListener("focus", prepareWhenVisible);
      document.removeEventListener("visibilitychange", prepareWhenVisible);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- An explicit retry restarts failed preparation.
  }, [attempt]);

  return { vapidPublicKey, isConfigLoading, retry };
}
