// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { HermesSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";
import { makeHermesTextGeneration } from "./HermesTextGeneration.ts";
import { architectTurnInput } from "./OrganizationArchitectFixture.ts";
import type * as TextGeneration from "./TextGeneration.ts";

const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../scripts/acp-mock-agent.ts",
);
const architectResponse = JSON.stringify({ reply: "Review QA.", proposals: [] });
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

function withFakeHermes<A, E, R>(
  env: Record<string, string>,
  run: (generation: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-hermes-architect-test-"),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const binaryPath = writeFakeCli({
      directory,
      name: "hermes",
      env,
      source: execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["acp"] }),
    });
    return yield* run(yield* makeHermesTextGeneration(decodeHermesSettings({ binaryPath })));
  }).pipe(Effect.scoped);
}

it.layer(NodeServices.layer)("HermesTextGeneration", (it) => {
  it.effect("generates an Architect reply", () =>
    withFakeHermes({ T3_ACP_PROMPT_RESPONSE_TEXT: architectResponse }, (generation) =>
      Effect.gen(function* () {
        const result = yield* generation.generateOrganizationArchitectTurn!(
          architectTurnInput("hermes", "grok-4.6"),
        );
        expect(result.reply).toBe("Review QA.");
      }),
    ),
  );
  it.effect("denies tool requests during Architect generation", () =>
    withFakeHermes(
      { T3_ACP_EMIT_TOOL_CALLS: "1", T3_ACP_PROMPT_RESPONSE_TEXT: architectResponse },
      (generation) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            generation.generateOrganizationArchitectTurn!(architectTurnInput("hermes", "grok-4.6")),
          );
          expect(error.detail).toContain("attempted tool work");
        }),
    ),
  );
});
