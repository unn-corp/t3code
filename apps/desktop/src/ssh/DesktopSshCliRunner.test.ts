import { assert, describe, it } from "@effect/vitest";
import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import { DesktopConfig, layerTest } from "../app/DesktopConfig.ts";
import { resolveDesktopSshCliRunner } from "./DesktopSshCliRunner.ts";

const preview = {
  isDevelopment: false,
  appVersion: "0.0.45-preview.20261008.9573",
  nodeEngineRange: "^24.13.1",
};

describe("SSH runtime selection", () => {
  it.effect("uses a configured archive for local previews without changing their identity", () =>
    Effect.gen(function* () {
      const config = yield* DesktopConfig;
      const runner = resolveDesktopSshCliRunner({
        ...preview,
        archiveVersion:
          config.sshArchiveVersion._tag === "Some" ? config.sshArchiveVersion.value : undefined,
      });
      assert.include(buildRemoteT3RunnerScript(runner), "T3_ARCHIVE_VERSION='0.0.45'");
    }).pipe(Effect.provide(layerTest({ ARCWRIGHT_CODE_SSH_ARCHIVE_VERSION: " 0.0.45 " }))),
  );
  it("keeps the exact app archive as the default", () => {
    assert.deepEqual(resolveDesktopSshCliRunner(preview), { archiveVersion: preview.appVersion });
  });
  it("preserves a development source runner over an archive pin", () => {
    assert.deepEqual(
      resolveDesktopSshCliRunner({
        ...preview,
        isDevelopment: true,
        nodeScriptPath: "/remote/server.mjs",
        archiveVersion: "0.0.45",
      }),
      { nodeScriptPath: "/remote/server.mjs", nodeEngineRange: preview.nodeEngineRange },
    );
  });
});
