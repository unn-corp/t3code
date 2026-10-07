import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, vi } from "vite-plus/test";

import {
  observeBackgroundActivitySubscription,
  retainedBackgroundScopes,
  wasRecentlyInteracted,
  createActivityReport,
} from "./backgroundActivityReporter.ts";

afterEach(() => vi.unstubAllGlobals());

describe("wasRecentlyInteracted", () => {
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
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd },
      });

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
