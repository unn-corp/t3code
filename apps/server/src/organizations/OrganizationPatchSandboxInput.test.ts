// @effect-diagnostics nodeBuiltinImport:off - Disposable fixtures use Node UUIDs to create unique isolated database and filesystem data.
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import {
  isOrganizationScopedSandboxAvailable,
  prepareOrganizationScopedSandbox,
} from "./OrganizationScopedSandboxHost.ts";
import { buildOrganizationPatchSandboxInput } from "./OrganizationPatchSandboxInput.ts";

const baseContent = "export const value = 1;\n";
const testContent = `import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from './subject.mjs';
test('replacement is exercised', () => assert.equal(value, 2));
`;
const baseDigest = NodeCrypto.createHash("sha256").update(baseContent).digest("hex");
const payload = (replacementContent: string) =>
  buildOrganizationPatchSandboxInput({
    sourceName: "subject.mjs",
    testName: "subject.test.mjs",
    baseContent,
    baseDigest,
    replacementContent,
    testContent,
  });

it("pins one flat source and test file to the original digest", () => {
  const built = payload("export const value = 2;\n");
  assert.equal(built.baseDigest, baseDigest);
  assert.match(built.replacementDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(built.sandboxInput.argv, ["/usr/bin/node", "/workspace/t3-work-applicator.mjs"]);
  assert.throws(() =>
    buildOrganizationPatchSandboxInput({
      sourceName: "../subject.mjs",
      testName: "subject.test.mjs",
      baseContent,
      baseDigest,
      replacementContent: "export const value = 2;\n",
      testContent,
    }),
  );
  assert.throws(() =>
    buildOrganizationPatchSandboxInput({
      sourceName: "subject.mjs",
      testName: "subject.test.mjs",
      baseContent,
      baseDigest: "0".repeat(64),
      replacementContent: "export const value = 2;\n",
      testContent,
    }),
  );
  assert.throws(() => payload("x".repeat(128 * 1024 + 1)));
});

it.skipIf(!isOrganizationScopedSandboxAvailable())(
  "runs a fixed sandboxed smoke test against the replacement",
  async () => {
    const built = payload("export const value = 2;\n");
    const handle = await prepareOrganizationScopedSandbox(built.sandboxInput);
    await handle.start();
    const result = await handle.wait();
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.outputLimitExceeded, false);
    const report = JSON.parse(result.stdout) as { sourceDigest: string; smokeExitZero: boolean };
    assert.equal(report.sourceDigest, built.replacementDigest);
    assert.equal(report.smokeExitZero, true);
  },
);

it.skipIf(!isOrganizationScopedSandboxAvailable())(
  "reports a failing smoke test for a faulty replacement",
  async () => {
    const handle = await prepareOrganizationScopedSandbox(
      payload("export const value = 3;\n").sandboxInput,
    );
    await handle.start();
    const result = await handle.wait();
    assert.equal(result.exitCode, 1);
    const report = JSON.parse(result.stdout) as { smokeExitZero: boolean };
    assert.equal(report.smokeExitZero, false);
  },
);

it.skipIf(!isOrganizationScopedSandboxAvailable())(
  "does not treat a clean exit forced by replacement code as independent QA",
  async () => {
    const handle = await prepareOrganizationScopedSandbox(
      payload("export const value = 3; process.exit(0);\n").sandboxInput,
    );
    await handle.start();
    const result = await handle.wait();
    const report = JSON.parse(result.stdout) as { smokeExitZero: boolean; stdout: string };
    assert.equal(result.exitCode, 0);
    assert.equal(report.smokeExitZero, true);
    assert.match(report.stdout, /pass 1/);
  },
);
