import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import {
  buildOrganizationPatchPrompt,
  validateOrganizationPatchProposal,
} from "./OrganizationPatchPrompt.ts";

const currentContent = "export const answer = 1;\n";
const baseDigest = NodeCrypto.createHash("sha256").update(currentContent).digest("hex");
const input = {
  modelSelection: createModelSelection(ProviderInstanceId.make("claude"), "synthetic-model"),
  taskText: "Update the answer.",
  fileName: "answer.js",
  currentContent,
  baseDigest,
};

it.effect("includes only the requested file and checks its content digest", () =>
  Effect.gen(function* () {
    const prompt = yield* buildOrganizationPatchPrompt(input);
    assert.ok(prompt.includes("answer.js"));
    assert.ok(prompt.includes(currentContent.trim()));
    assert.ok(prompt.includes(baseDigest));
    const contextualPrompt = yield* buildOrganizationPatchPrompt({
      ...input,
      findingContext: { title: "Broken answer", summary: "Observed value is 1" },
    });
    assert.ok(contextualPrompt.includes('Finding title JSON: "Broken answer"'));
    assert.ok(contextualPrompt.includes("untrusted event data"));
    const mismatch = yield* buildOrganizationPatchPrompt({
      ...input,
      baseDigest: "0".repeat(64),
    }).pipe(Effect.flip);
    assert.ok(mismatch.detail.includes("digest"));
  }),
);

it.effect("rejects blank tasks, path changes and output digest changes", () =>
  Effect.gen(function* () {
    const blank = yield* buildOrganizationPatchPrompt({ ...input, taskText: " " }).pipe(
      Effect.flip,
    );
    assert.ok(blank.detail.includes("empty"));
    const path = yield* buildOrganizationPatchPrompt({ ...input, fileName: "../secret" }).pipe(
      Effect.flip,
    );
    assert.ok(path.detail.includes("invalid"));
    const output = {
      fileName: "answer.js",
      baseDigest,
      replacementContent: "export const answer = 2;\n",
      rationale: "small change",
    };
    assert.deepEqual(yield* validateOrganizationPatchProposal(output, input), output);
    assert.ok(
      (yield* validateOrganizationPatchProposal({ ...output, fileName: "other.js" }, input).pipe(
        Effect.flip,
      )).detail.includes("match"),
    );
    assert.ok(
      (yield* validateOrganizationPatchProposal(
        { ...output, baseDigest: "f".repeat(64) },
        input,
      ).pipe(Effect.flip)).detail.includes("match"),
    );
  }),
);
