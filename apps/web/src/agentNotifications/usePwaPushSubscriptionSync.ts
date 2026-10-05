import { useEffect } from "react";

import { getExistingBrowserPushSubscription } from "./browserNotifications";

/** Reconcile saved preferences with the browser's actual push registration. */
export function usePwaPushSubscriptionSync({
  enabled,
  onSubscription,
  onMissingSubscription,
}: {
  readonly enabled: boolean;
  readonly onSubscription: (subscription: PushSubscription) => Promise<void>;
  readonly onMissingSubscription: () => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getExistingBrowserPushSubscription()
      .then((subscription) => {
        if (cancelled) return;
        if (subscription) return onSubscription(subscription);
        // Re-enabling must remain an explicit tap to satisfy iOS push activation.
        onMissingSubscription();
      })
      .catch(() => {
        // An unavailable browser API or relay does not prove the subscription is gone.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, onSubscription, onMissingSubscription]);
}
