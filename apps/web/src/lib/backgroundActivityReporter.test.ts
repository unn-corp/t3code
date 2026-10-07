import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, vi } from "vite-plus/test";

const android = vi.hoisted(() => ({ supported: vi.fn(() => false), request: vi.fn() }));
vi.mock("../android/notifications", () => ({
  supportsAndroidNotifications: android.supported,
  androidNotificationRequest: android.request,
}));

import {
  observeBackgroundActivitySubscription,
  retainedBackgroundScopes,
  wasRecentlyInteracted,
  createActivityReport,
  readNotificationClientVisibility,
} from "./backgroundActivityReporter.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  android.supported.mockReturnValue(false);
});

describe("wasRecentlyInteracted", () => {
  it("uses the phone's native awake visibility even if WebView still reports visible", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { visibilityState: "visible" });
    android.supported.mockReturnValue(true);
    android.request.mockResolvedValue({ notificationClientVisible: false });
    expect(await readNotificationClientVisibility()).toBe(false);
    vi.stubGlobal("document", { visibilityState: "hidden" });
    android.request.mockResolvedValue({ notificationClientVisible: true });
    expect(await readNotificationClientVisibility()).toBe(true);
  });
  it("uses native desktop visibility and supports older Android bridges", async () => {
    vi.stubGlobal("window", { desktopBridge: { getNotificationVisibility: async () => true } });
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(await readNotificationClientVisibility()).toBe(true);
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { visibilityState: "visible" });
    android.supported.mockReturnValue(true);
    android.request.mockResolvedValue({ permission: "ready", background: true });
    expect(await readNotificationClientVisibility()).toBe(true);
  });
  it("reports native visible/awake state independently of expired input and browser focus", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "fixture-client" },
      desktopBridge: {},
    });
    vi.stubGlobal("document", { visibilityState: "hidden", hasFocus: () => false });
    const environmentId = EnvironmentId.make("visibility-fixture");
    const visible = createActivityReport(environmentId, 0, 50_000, true);
    expect(visible).toMatchObject({
      visible: true,
      focused: false,
      recentlyInteracted: false,
      appState: "active",
    });
    expect(createActivityReport(environmentId, 50_000, 50_000, false)).toMatchObject({
      visible: false,
      appState: "background",
    });
  });
  it("expires interaction independently of window focus", () => {
    expect(wasRecentlyInteracted(10_000, 55_000)).toBe(true);
    expect(wasRecentlyInteracted(10_000, 55_001)).toBe(false);
  });

  it("rejects future timestamps", () => {
    expect(wasRecentlyInteracted(10_001, 10_000)).toBe(false);
  });

  it.effect("retains an observed subscription until its returned finalizer runs", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-observation-test");
      const scope = { type: "vcs-status" as const, cwd: "/repo" };
      const releasePassive = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd, includeRemote: false },
      });
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd },
      });

      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* releasePassive;
      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );
});
