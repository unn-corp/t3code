import { useCallback, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useThreadPreviewState, applyPreviewServerSnapshot } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePreviewSession } from "~/components/preview/usePreviewSession";
import { PreviewChromeRow } from "~/components/preview/PreviewChromeRow";
import { PreviewEmptyState } from "~/components/preview/PreviewEmptyState";
import { phoneBrowserShareRequired } from "./temporaryBrowserShare";
import { toastManager } from "~/components/ui/toast";
import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  recordVisitForThread,
  removeUrlForThread,
  useThreadRecentHistory,
} from "~/browserHistoryStore";
import { AndroidBrowserSurface } from "./AndroidBrowserSurface";
import { androidBrowserKey, androidBrowserRequest } from "./browser";

export function AndroidPreviewView({
  threadRef,
  tabId: requestedTabId,
  configuredUrls,
  visible,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId?: string | null;
  readonly configuredUrls?: ReadonlyArray<string> | undefined;
  readonly visible: boolean;
}) {
  usePreviewSession(threadRef);
  const state = useThreadPreviewState(threadRef);
  const recentEntries = useThreadRecentHistory(threadRef, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
  const tabId = requestedTabId ?? state.activeTabId;
  const snapshot = tabId ? state.sessions[tabId] : undefined;
  const nav = snapshot?.navStatus;
  const url = nav && nav._tag !== "Idle" ? nav.url : "";
  const open = useAtomCommand(previewEnvironment.open);
  const serverNavigate = useAtomCommand(previewEnvironment.navigate);
  const [error, setError] = useState<string | null>(null);
  const key = tabId
    ? androidBrowserKey(threadRef.environmentId, state.serverEpoch, threadRef.threadId, tabId)
    : null;
  const command = useCallback(
    async (operation: string, input: unknown = {}) => {
      if (!key || !snapshot) return;
      try {
        setError(null);
        await androidBrowserRequest("ensure", {
          key,
          ...threadRef,
          serverEpoch: state.serverEpoch,
          tabId: snapshot.tabId,
          url: url || "about:blank",
        });
        let commandInput = input;
        if (operation === "navigate") {
          const requestedUrl = normalizePreviewUrl((input as { url: string }).url);
          const result = await serverNavigate({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              tabId: snapshot.tabId,
              url: requestedUrl,
              shareLocalhost: phoneBrowserShareRequired(threadRef.environmentId, requestedUrl),
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          const nav = result.value.navStatus;
          commandInput = {
            ...(input as object),
            url: nav._tag === "Idle" ? "about:blank" : nav.url,
          };
        }
        await androidBrowserRequest("command", { key, operation, input: commandInput });
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Phone browser failed");
        return false;
      }
    },
    [key, snapshot, state.serverEpoch, threadRef, url, serverNavigate],
  );
  const navigate = async (next: string) => {
    try {
      const resolvedUrl = normalizePreviewUrl(next);
      if (snapshot) {
        if (await command("navigate", { url: resolvedUrl, readiness: "none" }))
          recordVisitForThread(threadRef, resolvedUrl);
        return;
      }
      const result = await open({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          url: resolvedUrl,
          shareLocalhost: phoneBrowserShareRequired(threadRef.environmentId, resolvedUrl),
          viewport: { _tag: "fill" },
          profileId: "default",
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      applyPreviewServerSnapshot(threadRef, result.value);
      recordVisitForThread(threadRef, resolvedUrl);
      setError(null);
    } catch (cause) {
      const description =
        cause instanceof Error ? cause.message : "Could not open the phone browser";
      setError(description);
      toastManager.add({ type: "error", title: "Unable to open browser", description });
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PreviewChromeRow
        url={url}
        loading={nav?._tag === "Loading"}
        canGoBack={snapshot?.canGoBack ?? false}
        canGoForward={snapshot?.canGoForward ?? false}
        refreshDisabled={!snapshot}
        onBack={() => void command("back")}
        onForward={() => void command("forward")}
        onRefresh={() => void command("refresh")}
        onSubmit={(next) => void navigate(next)}
      />
      {error || nav?._tag === "LoadFailed" ? (
        <p role="status" className="shrink-0 px-3 py-2 text-sm text-destructive">
          {error ?? (nav?._tag === "LoadFailed" ? nav.description : "")}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {snapshot && nav?._tag !== "Idle" ? (
          <AndroidBrowserSurface
            threadRef={threadRef}
            serverEpoch={state.serverEpoch}
            snapshot={snapshot}
            visible={visible}
          />
        ) : (
          <PreviewEmptyState
            threadRef={threadRef}
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentEntries={recentEntries}
            onRemoveRecent={(next) => removeUrlForThread(threadRef, next)}
            onOpenUrl={(next) => void navigate(next)}
          />
        )}
      </div>
    </div>
  );
}
