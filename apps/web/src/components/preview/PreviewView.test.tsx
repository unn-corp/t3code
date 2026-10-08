import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
} from "@t3tools/contracts";
import { usePreviewAnnotationEditorStore } from "~/previewAnnotationEditorStore";
import { act, createElement, Profiler } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  readEnvironmentScope: vi.fn(() => true),
  setAnnotationSendEnabled: vi.fn(async (): Promise<void> => undefined),
  cancelPickElement: vi.fn(async () => undefined),
  submittedUrl: null as ((url: string) => void) | null,
  emptyStateUrl: null as ((url: string) => void) | null,
  togglePictureInPicture: null as (() => void) | null,
  toggleNativePictureInPicture: null as (() => void) | null,
  pictureInPicturePressed: false,
  miniPlayerTabId: null as string | null,
  openMiniPlayer: vi.fn(),
  closeMiniPlayer: vi.fn(),
  closeRightPanel: vi.fn(),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  captureAnnotationSnapshot: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  addImage: vi.fn(),
  toggleAnnotation: null as (() => void) | null,
  pictureInPicture: false,
  showEmptyState: false,
  loading: false,
  serverEpoch: null as string | null,
  recordingTabIds: new Set<string>(),
  recordingRuntimeTabId: null as string | null,
  recordVisitForThread: vi.fn(),
}));

const EMPTY_HISTORY: never[] = [];

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

vi.mock("~/browserHistoryStore", () => ({
  recordVisitForThread: mocks.recordVisitForThread,
  setTitleForThreadUrl: vi.fn(),
  removeUrlForThread: vi.fn(),
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT: 50,
  useThreadRecentHistory: () => EMPTY_HISTORY,
}));

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  readPreparedConnection: mocks.readPreparedConnection,
  readEnvironmentScope: mocks.readEnvironmentScope,
  useEnvironmentScope: mocks.readEnvironmentScope,
}));

// File-preview errors share a module with asset hooks. Keep the pure URL resolver
// without importing those hooks and their environment runtime into chrome tests.
vi.mock("~/assets/assetUrls", async () => {
  const { resolveAssetUrl } = await import("@t3tools/client-runtime/state/assets");
  return { resolveAssetUrl };
});

// Stubbed at the direct dependency rather than letting the real module pull in
// `useSettings` -> `state/server`, which would drag the whole settings and
// connection graph into a test that only cares about the browser chrome.
vi.mock("~/browser/browserDefaults", () => ({
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  browserDefaultOpenViewport: () => FILL_PREVIEW_VIEWPORT,
  browserDefaultOpenProfileId: () => DEFAULT_BROWSER_PROFILE_ID,
  browserDefaultTabState: () => ({
    zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
    colorScheme: DEFAULT_PREVIEW_APPEARANCE,
  }),
  browserResponsiveViewportForToggle: () => ({
    _tag: "freeform" as const,
    width: 1024,
    height: 768,
  }),
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: { addPreviewAnnotation: () => void; addImage: () => void }) => unknown,
  ) =>
    select({
      addPreviewAnnotation: mocks.addPreviewAnnotation,
      addImage: mocks.addImage,
    }),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  updatePreviewServerSnapshot: vi.fn(),
  useThreadPreviewState: () => ({
    activeTabId: "tab-1",
    serverEpoch: mocks.serverEpoch,
    desktopByTabId: {
      "tab-1": {
        hasWebContents: true,
        canGoBack: false,
        canGoForward: false,
        loading: mocks.loading,
        zoomFactor: 1,
        pictureInPicture: mocks.pictureInPicture,
        colorScheme: "system",
        audioMuted: false,
        audible: false,
        controller: "none",
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          "tab-1": {
            threadId: "thread-1",
            tabId: "tab-1",
            navStatus: {
              _tag: "Success",
              url: "http://example.com/",
              title: "Example",
            },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
  }),
}));

vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ label: "WSL" }),
  useEnvironmentHttpBaseUrl: () => "http://172.25.85.75:3773",
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { open: {}, resize: {} },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("~/browser/browserRecording", () => ({
  findActiveBrowserRecordingRuntimeTabId: () => mocks.recordingRuntimeTabId,
  isBrowserRecordingStartCancelledError: vi.fn(() => false),
  startBrowserRecording: vi.fn(),
  stopBrowserRecording: vi.fn(),
  useActiveBrowserRecordingTabIds: () => mocks.recordingTabIds,
}));

vi.mock("~/browser/browserSurfaceStore", () => ({
  useBrowserSurfaceStore: (
    select: (state: { byTabId: Record<string, { rect?: unknown }> }) => unknown,
  ) => select({ byTabId: {} }),
}));

vi.mock("~/previewMiniPlayerStore", () => {
  const usePreviewMiniPlayerStore = Object.assign(
    (select: (state: unknown) => unknown) =>
      select({
        byThreadKey: mocks.miniPlayerTabId
          ? {
              "environment-1:thread-1": {
                source: { kind: "browser", tabId: mocks.miniPlayerTabId },
                position: null,
              },
            }
          : {},
      }),
    {
      getState: () => ({
        open: mocks.openMiniPlayer,
        close: mocks.closeMiniPlayer,
      }),
    },
  );
  return {
    browserMiniPlayerSource: (tabId: string) => ({ kind: "browser", tabId }),
    selectThreadPreviewMiniPlayerTabId: (
      byThreadKey: Record<string, { source: { tabId: string }; position: null }>,
    ) => byThreadKey["environment-1:thread-1"]?.source.tabId ?? null,
    usePreviewMiniPlayerStore,
  };
});

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ close: mocks.closeRightPanel }),
  },
}));

vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: vi.fn(),
  toastManager: { add: vi.fn() },
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    captureAnnotationSnapshot: mocks.captureAnnotationSnapshot,
    setAnnotationSendEnabled: mocks.setAnnotationSendEnabled,
    cancelPickElement: mocks.cancelPickElement,
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
  },
}));

vi.mock("./PreviewChromeRow", () => ({
  PreviewChromeRow: (props: {
    onSubmit: (url: string) => void;
    onPickElement?: () => void;
    onPictureInPicture?: () => void;
    pictureInPicture?: boolean;
    trailingActions?: {
      props: { actions?: { toggleNativePictureInPicture?: () => void } };
    };
  }) => {
    mocks.submittedUrl = props.onSubmit;
    mocks.toggleAnnotation = props.onPickElement ?? null;
    mocks.togglePictureInPicture = props.onPictureInPicture ?? null;
    mocks.toggleNativePictureInPicture =
      props.trailingActions?.props.actions?.toggleNativePictureInPicture ?? null;
    mocks.pictureInPicturePressed = props.pictureInPicture ?? false;
    return null;
  },
}));

vi.mock("./PreviewEmptyState", () => ({
  PreviewEmptyState: (props: { onOpenUrl: (url: string) => void }) => {
    mocks.emptyStateUrl = props.onOpenUrl;
    return null;
  },
}));
vi.mock("./PreviewMoreMenu", () => ({
  PreviewMoreMenu: (props: { actions: { toggleNativePictureInPicture?: () => void } }) => {
    mocks.toggleNativePictureInPicture = props.actions.toggleNativePictureInPicture ?? null;
    return null;
  },
}));
vi.mock("./PreviewUnreachable", () => ({ PreviewUnreachable: () => null }));
vi.mock("./ZoomIndicator", () => ({ ZoomIndicator: () => null }));
vi.mock("./AgentBrowserCursor", () => ({
  AgentBrowserCursor: () => createElement("agent-cursor"),
}));
vi.mock("~/browser/BrowserSurfaceSlot", () => ({ BrowserSurfaceSlot: () => null }));
vi.mock("./usePreviewSession", () => ({ usePreviewSession: vi.fn() }));

import { PreviewView } from "./PreviewView";
import { toastManager } from "~/components/ui/toast";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

// ReactDOM needs a host, but this unit suite intentionally has no DOM dependency.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

describe("PreviewView navigation", () => {
  beforeEach(() => {
    usePreviewAnnotationEditorStore.setState({ session: null, hydrated: true });
    mocks.navigate.mockClear();
    mocks.rememberPreviewUrl.mockClear();
    mocks.readPreparedConnection.mockClear();
    mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
    mocks.setAnnotationSendEnabled.mockClear();
    mocks.cancelPickElement.mockClear();
    mocks.submittedUrl = null;
    mocks.emptyStateUrl = null;
    mocks.togglePictureInPicture = null;
    mocks.toggleNativePictureInPicture = null;
    mocks.pictureInPicturePressed = false;
    mocks.miniPlayerTabId = null;
    mocks.openMiniPlayer.mockClear();
    mocks.closeMiniPlayer.mockClear();
    mocks.closeRightPanel.mockClear();
    mocks.openPictureInPicture.mockClear();
    mocks.closePictureInPicture.mockClear();
    mocks.pickElement.mockReset();
    mocks.addPreviewAnnotation.mockClear();
    vi.mocked(toastManager.add).mockClear();
    mocks.addImage.mockClear();
    mocks.toggleAnnotation = null;
    mocks.pictureInPicture = false;
    mocks.showEmptyState = false;
    mocks.loading = false;
    mocks.serverEpoch = null;
    mocks.recordingTabIds = new Set();
    mocks.recordingRuntimeTabId = null;
    mocks.recordVisitForThread.mockClear();
  });

  it("shows the cursor in a replacement browser while the old instance still records", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const hasCursor = (node: TestNode): boolean =>
      node.nodeName === "AGENT-CURSOR" || node.childNodes.some(hasCursor);
    mocks.recordingTabIds.add(TEST_RUNTIME_TAB_ID);
    mocks.recordingRuntimeTabId = TEST_RUNTIME_TAB_ID;
    try {
      await act(() => {
        root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />);
      });
      expect(hasCursor(container)).toBe(false);
      mocks.serverEpoch = "replacement-server";
      await act(() => {
        root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />);
      });
      expect(hasCursor(container)).toBe(true);
      expect(mocks.recordingTabIds.has(TEST_RUNTIME_TAB_ID)).toBe(true);
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("does not rerender while loading time passes", async () => {
    vi.useFakeTimers();
    mocks.loading = true;
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.createElement("div") as unknown as Element);
    const onRender = vi.fn();

    try {
      await act(() => {
        root.render(
          <Profiler id="preview" onRender={onRender}>
            <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
          </Profiler>,
        );
      });
      const initialRenderCount = onRender.mock.calls.length;

      await act(() => vi.advanceTimersByTimeAsync(1_000));

      expect(onRender).toHaveBeenCalledTimes(initialRenderCount);
    } finally {
      await act(() => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    [
      "https://localhost:8000/dashboard?mode=test#top",
      "https://localhost:8000/dashboard?mode=test#top",
    ],
    ["localhost:5173/app", "http://localhost:5173/app"],
  ])("preserves a direct localhost URL in a WSL environment", async (submitted, expected) => {
    renderToStaticMarkup(
      <PreviewView
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        tabId="tab-1"
        visible
      />,
    );

    expect(mocks.submittedUrl).not.toBeNull();
    mocks.submittedUrl?.(submitted);

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, expected),
    );
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      {
        environmentId: "environment-1",
        threadId: "thread-1",
      },
      expected,
    );
  });

  it("records a history visit with the normalized requested url on submit", async () => {
    renderToStaticMarkup(
      <PreviewView
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        tabId="tab-1"
        visible
      />,
    );

    mocks.submittedUrl?.("localhost:3000/admin");
    await vi.waitFor(() => {
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: expect.anything() }),
        "http://localhost:3000/admin",
      );
    });
  });

  it("maps an empty-state localhost server onto the WSL host", async () => {
    mocks.showEmptyState = true;
    renderToStaticMarkup(
      <PreviewView
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        tabId="tab-1"
        visible
      />,
    );

    expect(mocks.emptyStateUrl).not.toBeNull();
    mocks.emptyStateUrl?.("http://localhost:5173/app?mode=test#top");

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        TEST_RUNTIME_TAB_ID,
        "http://172.25.85.75:5173/app?mode=test#top",
      ),
    );
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      {
        environmentId: "environment-1",
        threadId: "thread-1",
      },
      "http://172.25.85.75:5173/app?mode=test#top",
    );
    await vi.waitFor(() =>
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: expect.anything() }),
        "http://localhost:5173/app?mode=test#top",
      ),
    );
  });

  it("opens and closes a thread-scoped floating preview for the active tab", async () => {
    const props = {
      threadRef: {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      },
      tabId: "tab-1",
      visible: true,
    } as const;

    renderToStaticMarkup(<PreviewView {...props} />);
    expect(mocks.pictureInPicturePressed).toBe(false);
    mocks.togglePictureInPicture?.();
    expect(mocks.openMiniPlayer).toHaveBeenCalledWith(props.threadRef, {
      kind: "browser",
      tabId: "tab-1",
    });
    expect(mocks.closeRightPanel).toHaveBeenCalledWith(props.threadRef);

    mocks.miniPlayerTabId = "tab-1";
    renderToStaticMarkup(<PreviewView {...props} />);
    expect(mocks.pictureInPicturePressed).toBe(true);
    mocks.togglePictureInPicture?.();
    expect(mocks.closeMiniPlayer).toHaveBeenCalledWith(props.threadRef);
  });

  it("keeps the native preview window as a secondary action", async () => {
    const props = {
      threadRef: {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      },
      tabId: "tab-1",
      visible: true,
    } as const;

    renderToStaticMarkup(<PreviewView {...props} />);
    mocks.toggleNativePictureInPicture?.();
    await vi.waitFor(() =>
      expect(mocks.openPictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );

    mocks.pictureInPicture = true;
    renderToStaticMarkup(<PreviewView {...props} />);
    mocks.toggleNativePictureInPicture?.();
    await vi.waitFor(() =>
      expect(mocks.closePictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );
  });

  it("opens the durable modal immediately and keeps the captured snapshot after the preview unmounts", async () => {
    const snapshot = {
      pageUrl: "https://example.com/original",
      pageTitle: "Original",
      width: 800,
      height: 600,
      elements: [],
      createdAt: "2026-10-08T00:00:00.000Z",
      screenshot: {
        dataUrl: "data:image/png;base64,aW1hZ2U=",
        width: 800,
        height: 600,
        cropRect: { x: 0, y: 0, width: 800, height: 600 },
      },
    };
    let resolveCapture!: (value: typeof snapshot) => void;
    mocks.captureAnnotationSnapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCapture = resolve;
      }),
    );
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.createElement("div") as unknown as Element);
    try {
      await act(async () =>
        root.render(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />),
      );
      await act(async () => mocks.toggleAnnotation?.());
      expect(usePreviewAnnotationEditorStore.getState().session).toMatchObject({
        status: "capturing",
        threadRef: TEST_THREAD_REF,
        tabId: TEST_RUNTIME_TAB_ID,
      });
      await act(async () => root.unmount());
      await act(async () => resolveCapture(snapshot));
      expect(usePreviewAnnotationEditorStore.getState().session).toMatchObject({
        status: "ready",
        snapshot,
        threadRef: TEST_THREAD_REF,
      });
      expect(mocks.cancelPickElement).not.toHaveBeenCalled();
      expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not replace or silently close an existing annotation when Annotate is clicked again", async () => {
    mocks.captureAnnotationSnapshot.mockReturnValueOnce(new Promise(() => {}));
    renderToStaticMarkup(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />);
    mocks.toggleAnnotation?.();
    const session = usePreviewAnnotationEditorStore.getState().session;
    mocks.toggleAnnotation?.();
    expect(usePreviewAnnotationEditorStore.getState().session).toEqual(session);
    expect(mocks.captureAnnotationSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.cancelPickElement).not.toHaveBeenCalled();
  });

  it("keeps capture errors in the modal instead of discarding the annotation", async () => {
    mocks.captureAnnotationSnapshot.mockRejectedValueOnce(
      new Error("Page reloaded during capture"),
    );
    renderToStaticMarkup(<PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />);
    mocks.toggleAnnotation?.();
    await vi.waitFor(() =>
      expect(usePreviewAnnotationEditorStore.getState().session).toMatchObject({
        status: "error",
        error: "Page reloaded during capture",
        threadRef: TEST_THREAD_REF,
      }),
    );
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
    expect(mocks.addImage).not.toHaveBeenCalled();
  });
});
