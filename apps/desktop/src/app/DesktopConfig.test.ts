import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DesktopConfig, layerTest } from "./DesktopConfig.ts";

describe("Arcwright Code update configuration", () => {
  it.effect.each([
    ["enables updates by default", {}, false],
    ["disables updates with the fork setting", { ARCWRIGHT_CODE_DISABLE_AUTO_UPDATE: "1" }, true],
    ["accepts the legacy setting", { T3CODE_DISABLE_AUTO_UPDATE: "1" }, true],
    [
      "lets the fork setting enable updates over an inherited legacy disable",
      { ARCWRIGHT_CODE_DISABLE_AUTO_UPDATE: "0", T3CODE_DISABLE_AUTO_UPDATE: "1" },
      false,
    ],
    [
      "lets the fork setting disable updates over a legacy enable",
      { ARCWRIGHT_CODE_DISABLE_AUTO_UPDATE: "1", T3CODE_DISABLE_AUTO_UPDATE: "0" },
      true,
    ],
  ] as const)("%s", ([_label, env, disabled]) =>
    Effect.gen(function* () {
      const config = yield* DesktopConfig;
      assert.equal(config.disableAutoUpdate, disabled);
    }).pipe(Effect.provide(layerTest(env))),
  );
});
