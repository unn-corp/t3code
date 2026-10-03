// @effect-diagnostics nodeBuiltinImport:off - Disposable fixtures exercise a real scoped Linux sandbox.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert";
import * as NodeCrypto from "node:crypto";
import { createOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import { isOrganizationScopedSandboxAvailable } from "./OrganizationScopedSandboxHost.ts";
import {
  evaluateOrganizationSingleFileQA,
  type OrganizationSingleFileQAPlan,
} from "./OrganizationSingleFileQAEvaluator.ts";

const hash = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const base = Buffer.from("export function solve(input) { return input.value; }\n");
const plan: OrganizationSingleFileQAPlan = {
  version: 1,
  exportName: "solve",
  cases: [
    { input: { value: 2 }, expected: 4 },
    { input: { value: 7 }, expected: 14 },
  ],
};
const reviewed = (replacement: string) => {
  const bytes = createOrganizationSingleFileArtifact({
    relativePath: "answer.mjs",
    baseCommit: "a".repeat(40),
    baseBlobOid: "b".repeat(40),
    baseMode: "100644",
    baseSha256: hash(base),
    baseBytes: base,
    replacementBytes: Buffer.from(replacement),
  });
  return { reviewedArtifactBytes: bytes, reviewedArtifactSha256: hash(bytes), plan };
};

it("rejects a changed artifact digest before launching a sandbox", async () => {
  const input = reviewed("export function solve(input) { return input.value * 2; }\n");
  await NodeAssert.rejects(
    evaluateOrganizationSingleFileQA({ ...input, reviewedArtifactSha256: "0".repeat(64) }),
    /SHA-256 does not match/,
  );
});

it("rejects malformed plan shape with a typed evaluator error", async () => {
  const input = reviewed("export function solve(input) { return input.value * 2; }\n");
  await NodeAssert.rejects(
    evaluateOrganizationSingleFileQA({
      ...input,
      plan: null as unknown as OrganizationSingleFileQAPlan,
    }),
    { name: "OrganizationSingleFileQAEvaluatorError" },
  );
});

const available = isOrganizationScopedSandboxAvailable();

it.skipIf(!available)(
  "accepts exact independently expected values from a real scoped sandbox",
  async () => {
    const result = await evaluateOrganizationSingleFileQA(
      reviewed("export function solve(input) { return input.value * 2; }\n"),
    );
    NodeAssert.strict.equal(result.accepted, true);
    NodeAssert.strict.equal(result.reason, "passed");
    NodeAssert.strict.match(
      result.sandboxIdentity.unitName,
      /^t3-org-sandbox-[a-f0-9]{32}\.scope$/,
    );
    const evidence = JSON.parse(Buffer.from(result.evidenceBytes).toString("utf8"));
    NodeAssert.strict.equal(evidence.accepted, true);
    NodeAssert.strict.equal(evidence.observedDigests.length, 2);
    NodeAssert.strict.equal(
      evidence.sandboxIdentity.invocationId,
      result.sandboxIdentity.invocationId,
    );
  },
);

it.skipIf(!available)(
  "rejects a deliberately faulty replacement despite a clean process exit",
  async () => {
    const result = await evaluateOrganizationSingleFileQA(
      reviewed("export function solve(input) { return input.value; }\n"),
    );
    NodeAssert.strict.equal(result.accepted, false);
    NodeAssert.strict.equal(result.reason, "wrong_result");
  },
);

it.skipIf(!available)("rejects process.exit(0) before complete case results", async () => {
  const result = await evaluateOrganizationSingleFileQA(
    reviewed("export function solve() { process.exit(0); }\n"),
  );
  NodeAssert.strict.equal(result.accepted, false);
  NodeAssert.strict.equal(result.reason, "invalid_output");
});

it.skipIf(!available)("rejects forged PASS text and extra protocol output", async () => {
  const result = await evaluateOrganizationSingleFileQA(
    reviewed(
      "export function solve(input) { console.log('PASS accepted=true'); return input.value * 2; }\n",
    ),
  );
  NodeAssert.strict.equal(result.accepted, false);
  NodeAssert.strict.equal(result.reason, "invalid_output");
});
