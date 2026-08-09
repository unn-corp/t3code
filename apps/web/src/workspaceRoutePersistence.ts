import { isElectron } from "./env";

export const LAST_WORKSPACE_ROUTE_STORAGE_KEY = "t3code:last-workspace-route:v1";
export const PERSISTED_WORKSPACE_ROUTE = "/agent-dashboard" as const;

export function readPersistedWorkspaceRoute(): string | null {
  if (!isElectron || typeof window === "undefined") {
    return null;
  }

  try {
    const value = window.localStorage.getItem(LAST_WORKSPACE_ROUTE_STORAGE_KEY);
    if (value === "/research") return PERSISTED_WORKSPACE_ROUTE;
    return value === PERSISTED_WORKSPACE_ROUTE || value?.startsWith(`${PERSISTED_WORKSPACE_ROUTE}/`)
      ? value
      : null;
  } catch {
    return null;
  }
}

export function restorePersistedWorkspaceRoute(): void {
  if (!isElectron || typeof window === "undefined" || window.location.hash.length > 1) {
    return;
  }

  const persistedWorkspaceRoute = readPersistedWorkspaceRoute();
  if (persistedWorkspaceRoute === null) {
    return;
  }

  try {
    window.history.replaceState(
      window.history.state,
      document.title,
      `${window.location.pathname}${window.location.search}#${persistedWorkspaceRoute}`,
    );
  } catch {
    // History can be unavailable in restricted renderer contexts.
  }
}

export function persistWorkspaceRoute(pathname: string): void {
  if (!isElectron || typeof window === "undefined") {
    return;
  }

  try {
    if (
      pathname === PERSISTED_WORKSPACE_ROUTE ||
      pathname.startsWith(`${PERSISTED_WORKSPACE_ROUTE}/`)
    ) {
      window.localStorage.setItem(LAST_WORKSPACE_ROUTE_STORAGE_KEY, pathname);
    } else if (pathname === "/") {
      window.localStorage.removeItem(LAST_WORKSPACE_ROUTE_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in restricted renderer contexts.
  }
}
