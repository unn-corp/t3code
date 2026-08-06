import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  resolveHermesAcpBaseModelId,
} from "./HermesAcpSupport.ts";

describe("resolveHermesAcpBaseModelId", () => {
  it("preserves provider-qualified Hermes model ids", () => {
    expect(resolveHermesAcpBaseModelId(undefined)).toBeUndefined();
    expect(resolveHermesAcpBaseModelId("   ")).toBeUndefined();
    expect(resolveHermesAcpBaseModelId("  openrouter:hermes-test-custom-model  ")).toBe(
      "openrouter:hermes-test-custom-model",
    );
  });
});

describe("buildHermesAcpSpawnInput", () => {
  it("starts Hermes's ACP command and preserves the configured environment", () => {
    const spawn = buildHermesAcpSpawnInput(
      { binaryPath: "/usr/local/bin/hermes", homePath: "" },
      "/tmp/project",
      { HERMES_HOME: "/custom/hermes" },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        HERMES_HOME: "/custom/hermes",
      },
    });
  });
});

describe("applyHermesAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:hermes-build",
        requestedModelId: "openrouter:hermes-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["openrouter:hermes-mock-alt"]);
      expect(result).toBe("openrouter:hermes-mock-alt");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:hermes-build",
        requestedModelId: "openrouter:hermes-build",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openrouter:hermes-build");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:hermes-build",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openrouter:hermes-build");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openrouter:hermes-build",
          requestedModelId: "openrouter:hermes-mock-alt",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
