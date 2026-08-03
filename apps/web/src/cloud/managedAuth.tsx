import { useAuth } from "@clerk/react";
import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useRef, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveRelayClerkTokenOptions } from "./publicConfig";
import { unsubscribeBrowserPush } from "../agentNotifications/browserNotifications";

let relayTokenProvider: (() => Promise<string | null>) | null = null;

export async function readManagedRelayClerkToken(): Promise<string | null> {
  return relayTokenProvider?.() ?? null;
}

export function deactivateManagedRelayAuthentication(): void {
  relayTokenProvider = null;
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  relayTokenProvider = readClerkToken;
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken,
  });
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const removeRelayEnvironments = useAtomCommand(environmentCatalog.removeRelayEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    let cancelled = false;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;

    const queueAccountCleanup = (readPreviousClerkToken = relayTokenProvider) => {
      // This is deliberately local and does not depend on the old Clerk token:
      // on a shared device it prevents a previous account receiving pushes even
      // if remote deletion cannot complete during sign-out.
      const webPushSubscriptionId =
        typeof window === "undefined"
          ? null
          : window.localStorage.getItem("t3code.webPushSubscriptionId");
      void unsubscribeBrowserPush().catch(() => undefined);
      if (typeof window !== "undefined") {
        window.localStorage.removeItem("t3code.webPushSubscriptionId");
      }
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition.then(async () => {
        const deleteRemoteWebPushSubscription = async () => {
          if (!webPushSubscriptionId || !readPreviousClerkToken) return;
          const clerkToken = await readPreviousClerkToken();
          if (!clerkToken) return;
          await runtime.runPromiseExit(
            ManagedRelay.ManagedRelayClient.pipe(
              Effect.flatMap((client) =>
                client.unregisterWebPushSubscription
                  ? client.unregisterWebPushSubscription({
                      clerkToken,
                      subscriptionId: webPushSubscriptionId,
                    })
                  : Effect.void,
              ),
            ),
          );
        };
        const [environmentResult, _webPushResult, tokenResult] = await Promise.all([
          removeRelayEnvironments(),
          deleteRemoteWebPushSubscription(),
          settleAsyncResult(() =>
            runtime.runPromiseExit(
              ManagedRelay.ManagedRelayClient.pipe(
                Effect.flatMap((client) => client.resetTokenCache),
              ),
            ),
          ),
        ]);
        for (const result of [environmentResult, tokenResult]) {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        }
      });
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      const previousReadClerkToken = relayTokenProvider;
      deactivateManagedRelayAuthentication();
      if (previousAccount !== null) {
        void queueAccountCleanup(previousReadClerkToken);
      }
    } else {
      const tokenProvider = () => getToken(resolveRelayClerkTokenOptions());
      const activateSession = () => {
        if (!cancelled) {
          activateManagedRelayAuthentication(userId, tokenProvider);
        }
      };
      const activateAfterTransition = (transition: Promise<void>) => {
        void (async () => {
          const result = await settlePromise(async () => {
            await transition;
            activateSession();
          });
          reportAtomCommandResult(result, { label: "cloud account activation" });
        })();
      };
      if (previousAccount !== undefined && previousAccount !== null && previousAccount !== userId) {
        const previousReadClerkToken = relayTokenProvider;
        deactivateManagedRelayAuthentication();
        activateAfterTransition(queueAccountCleanup(previousReadClerkToken));
      } else {
        activateAfterTransition(accountTransitionRef.current ?? Promise.resolve());
      }
    }
    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn, removeRelayEnvironments, userId]);

  useEffect(() => () => deactivateManagedRelayAuthentication(), []);

  return children;
}
