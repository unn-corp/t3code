import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  type EnvironmentId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { phoneBrowserShareRequired, phoneBrowserTargetUrl } from "./temporaryBrowserShare";
import { createPreviewAutomationRequestConsumerAtom } from "~/components/preview/previewAutomationRequestConsumer";
import { createPreviewAutomationClientId } from "~/components/preview/previewAutomationClientId";
import {
  androidBrowserKey,
  androidBrowserRequest,
  closeAndroidBrowserTab,
  subscribeAndroidBrowser,
  supportsAndroidBrowser,
  useAndroidBrowserTabs,
} from "./browser";

const OPERATIONS: NonNullable<PreviewAutomationHost["supportedOperations"]> = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
];

export function AndroidBrowserHosts() {
  const { isReady, environments } = useEnvironments();
  const ids = useMemo(
    () =>
      environments
        .filter((environment) => environment.entry.enabled)
        .map((environment) => environment.environmentId),
    [environments],
  );
  const key = JSON.stringify(ids);
  useEffect(() => {
    if (!isReady || !supportsAndroidBrowser()) return;
    const allowedIds = JSON.parse(key) as EnvironmentId[];
    void androidBrowserRequest("retainEnvironments", { environmentIds: allowedIds }).catch(
      () => {},
    );
    useAndroidBrowserTabs.setState((state) => ({
      tabs: Object.fromEntries(
        Object.entries(state.tabs).filter(([, tab]) => allowedIds.includes(tab.environmentId)),
      ),
    }));
  }, [isReady, key]);
  if (!isReady || !supportsAndroidBrowser()) return null;
  return ids.map((environmentId) => (
    <PhoneBrowserHost key={environmentId} environmentId={environmentId} />
  ));
}

function PhoneBrowserHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [clientId] = useState(createPreviewAutomationClientId);
  const [connectionAtom] = useState(() => Atom.make<string | null>(null));
  const connectionId = useAtomValue(connectionAtom);
  const host = useMemo<PreviewAutomationHost>(
    () => ({ clientId, environmentId, supportedOperations: OPERATIONS }),
    [clientId, environmentId],
  );
  const requests = previewEnvironment.automationRequests({ environmentId, input: host });
  const events = previewEnvironment.events({ environmentId, input: {} });
  const list = useAtomQueryRunner(previewEnvironment.list, { reportFailure: false });
  const open = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const serverNavigate = useAtomCommand(previewEnvironment.navigate, { reportFailure: false });
  const respond = useAtomCommand(previewEnvironment.respondToAutomation, { reportFailure: false });
  const focus = useAtomCommand(previewEnvironment.focusAutomationHost, { reportFailure: false });
  const reportStatus = useAtomCommand(previewEnvironment.reportStatus, { reportFailure: false });
  const tabs = useAndroidBrowserTabs((state) => state.tabs);
  const foreground = useAndroidBrowserTabs((state) => state.foreground);

  useEffect(
    () =>
      subscribeAndroidBrowser((event) => {
        if (event.environmentId !== environmentId) return;
        void reportStatus({
          environmentId,
          input: {
            threadId: event.threadId,
            tabId: event.tabId,
            navStatus: event.navStatus,
            canGoBack: event.canGoBack,
            canGoForward: event.canGoForward,
          },
        });
      }),
    [environmentId, reportStatus],
  );

  // Subscribe to each close event, including tabs whose thread is no longer on screen.
  const lifecycle = useMemo(
    () =>
      Atom.make((get) => {
        get.subscribe(events, (result) => {
          if (!AsyncResult.isSuccess(result) || result.value.type !== "closed") return;
          const event = result.value;
          for (const [key, tab] of Object.entries(useAndroidBrowserTabs.getState().tabs)) {
            if (
              tab.environmentId === environmentId &&
              tab.threadId === event.threadId &&
              tab.tabId === event.tabId
            )
              void closeAndroidBrowserTab(key).catch(() => {});
          }
        });
      }).pipe(Atom.setIdleTTL(0)),
    [environmentId, events],
  );
  useAtomValue(lifecycle);

  const handle = useCallback(
    async (request: PreviewAutomationRequest): Promise<unknown> => {
      const threadRef = { environmentId, threadId: ThreadId.make(request.threadId) };
      const listed = await list({ environmentId, input: { threadId: threadRef.threadId } });
      if (listed._tag === "Failure") throw squashAtomCommandFailure(listed);
      reconcilePreviewServerSessions(threadRef, listed.value);
      let state = readThreadPreviewState(threadRef);
      let tabId = request.tabId ?? state.activeTabId;
      let snapshot = tabId ? state.sessions[tabId] : undefined;
      const input = request.input;
      if (request.operation === "open") {
        const options = input as PreviewAutomationOpenInput;
        if (options.reuseExistingTab === false) snapshot = undefined;
        if (!snapshot) {
          const result = await open({
            environmentId,
            input: {
              threadId: threadRef.threadId,
              ...(options.url
                ? {
                    url: normalizePreviewUrl(options.url),
                    shareLocalhost: phoneBrowserShareRequired(environmentId, options.url),
                  }
                : {}),
              viewport: { _tag: "fill" },
              profileId: "default",
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          snapshot = result.value;
          applyPreviewServerSnapshot(threadRef, snapshot);
          tabId = snapshot.tabId;
        }
      }
      if (!snapshot || !tabId) {
        if (request.operation === "status")
          return {
            available: true,
            visible: false,
            tabId: null,
            url: null,
            title: null,
            loading: false,
          } satisfies PreviewAutomationStatus;
        throw new Error("Open a phone browser tab first.");
      }
      state = readThreadPreviewState(threadRef);
      const key = androidBrowserKey(
        environmentId,
        state.serverEpoch,
        threadRef.threadId,
        snapshot.tabId,
      );
      const url = snapshot.navStatus._tag === "Idle" ? "about:blank" : snapshot.navStatus.url;
      await androidBrowserRequest("ensure", {
        key,
        ...threadRef,
        serverEpoch: state.serverEpoch,
        tabId: snapshot.tabId,
        url,
      });
      if (request.operation === "open") {
        const options = input as PreviewAutomationOpenInput;
        if (options.open !== false && options.show !== false)
          useRightPanelStore.getState().openBrowser(threadRef, snapshot.tabId);
        if (options.url) {
          const result = await serverNavigate({
            environmentId,
            input: {
              threadId: threadRef.threadId,
              tabId,
              url: normalizePreviewUrl(options.url),
              shareLocalhost: phoneBrowserShareRequired(environmentId, options.url),
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          const nav = result.value.navStatus;
          await androidBrowserRequest("command", {
            key,
            operation: "navigate",
            input: { url: nav._tag === "Idle" ? "about:blank" : nav.url, readiness: "none" },
          });
        }
        return await androidBrowserRequest("command", { key, operation: "status" });
      }
      if (request.operation === "navigate") {
        const options = input as PreviewAutomationNavigateInput;
        const target = options.target ?? { kind: "url" as const, url: options.url! };
        const requestedUrl = phoneBrowserTargetUrl(target);
        const result = await serverNavigate({
          environmentId,
          input: {
            threadId: threadRef.threadId,
            tabId,
            url: requestedUrl,
            shareLocalhost: phoneBrowserShareRequired(environmentId, requestedUrl),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const nav = result.value.navStatus;
        const resolved = {
          requestedUrl,
          resolvedUrl: nav._tag === "Idle" ? "about:blank" : nav.url,
          environmentId,
          resolutionKind:
            nav._tag !== "Idle" && nav.url === requestedUrl
              ? ("direct" as const)
              : ("direct-private-network" as const),
        };
        const status = await androidBrowserRequest<PreviewAutomationStatus>(
          "command",
          {
            key,
            operation: "navigate",
            input: { ...options, url: normalizePreviewUrl(resolved.resolvedUrl) },
          },
          request.timeoutMs + 1000,
        );
        return { ...status, ...resolved };
      }
      return androidBrowserRequest(
        "command",
        { key, operation: request.operation, input },
        request.timeoutMs + 1000,
      );
    },
    [environmentId, list, open, serverNavigate],
  );
  const [handlerAtom] = useState(() => Atom.make({ handle }));
  const setHandler = useAtomSet(handlerAtom);
  useEffect(() => {
    setHandler({ handle });
  }, [handle, setHandler]);
  const consumer = useMemo(
    () =>
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom: requests,
        clientId,
        connectionAtom,
        environmentId,
        requestHandlerAtom: handlerAtom,
        respond: (response) => respond({ environmentId, input: response }),
        label: `preview:phone:${environmentId}:${clientId}`,
      }),
    [requests, clientId, connectionAtom, environmentId, handlerAtom, respond],
  );
  useAtomValue(consumer);
  useEffect(() => {
    const report = () => {
      if (!connectionId) return;
      void focus({
        environmentId,
        input: {
          clientId,
          environmentId,
          connectionId,
          focused: foreground && document.hasFocus() && document.visibilityState === "visible",
          liveTabs: Object.values(tabs)
            .filter((tab) => tab.environmentId === environmentId)
            .map((tab) => ({
              threadId: tab.threadId,
              tabId: tab.tabId,
              visible: tab.visible && document.visibilityState === "visible",
            })),
        },
      });
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    document.addEventListener("visibilitychange", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      document.removeEventListener("visibilitychange", report);
    };
  }, [clientId, connectionId, environmentId, focus, foreground, tabs]);
  return null;
}
