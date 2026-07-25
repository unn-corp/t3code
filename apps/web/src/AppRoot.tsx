import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { DesktopAgentNotificationCoordinator } from "./agentNotifications/DesktopAgentNotificationCoordinator";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  useEffect(() => {
    const subscribe = window.desktopBridge?.onAgentNotificationNavigate;
    if (typeof subscribe !== "function") return;
    return subscribe((deepLink) => {
      // The main process sends only the contract's relative thread route.
      void router.navigate({ to: deepLink as never });
    });
  }, [router]);

  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <DesktopAgentNotificationCoordinator />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
    </AppAtomRegistryProvider>
  );
}
