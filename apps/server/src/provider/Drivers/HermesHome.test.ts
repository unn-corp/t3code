import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeHermesEnvironment } from "./HermesHome.ts";

describe("makeHermesEnvironment", () => {
  it.layer(NodeServices.layer)("sets HERMES_HOME without altering HOME", (it) => {
    it.effect("resolves a configured Hermes home path", () =>
      Effect.gen(function* () {
        const environment = yield* makeHermesEnvironment(
          { homePath: "~/.hermes-work" },
          { HOME: "/host/home", EXISTING: "value" },
        );
        expect(environment.HOME).toBe("/host/home");
        expect(environment.HERMES_HOME).toMatch(/\.hermes-work$/);
        expect(environment.EXISTING).toBe("value");
      }),
    );
  });
});
