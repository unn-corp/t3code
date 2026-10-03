// @effect-diagnostics preferSchemaOverJson:off - These cases mutate the exact JSON wire bytes.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  createOrganizationSingleFileArtifact,
  decodeOrganizationSingleFileArtifact,
  ORGANIZATION_SINGLE_FILE_ARTIFACT_MAX_BYTES,
  ORGANIZATION_SINGLE_FILE_REPLACEMENT_MAX_BYTES,
  OrganizationSingleFileArtifactError,
  type OrganizationSingleFileArtifactInput,
} from "./OrganizationSingleFileArtifact.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const baseBytes = utf8("export const answer = 1;\n");
const replacementBytes = utf8("export const answer = 2;\n");
const fixture: OrganizationSingleFileArtifactInput = {
  relativePath: "src/answer.ts",
  baseCommit: "a".repeat(40),
  baseBlobOid: "b".repeat(40),
  baseMode: "100644",
  baseSha256: sha256(baseBytes),
  baseBytes,
  replacementBytes,
};
const fail = (bytes: Uint8Array) =>
  assert.throws(
    () => decodeOrganizationSingleFileArtifact(bytes),
    OrganizationSingleFileArtifactError,
  );
const encodeJson = (value: unknown) => utf8(JSON.stringify(value));

it("round-trips deterministic versioned bytes and exact replacement identity", () => {
  const first = createOrganizationSingleFileArtifact(fixture);
  const second = createOrganizationSingleFileArtifact({ ...fixture });
  assert.deepEqual(first, second);
  const decoded = decodeOrganizationSingleFileArtifact(first);
  assert.deepEqual(decoded, {
    version: 1,
    relativePath: fixture.relativePath,
    baseCommit: fixture.baseCommit,
    baseBlobOid: fixture.baseBlobOid,
    baseMode: fixture.baseMode,
    baseSha256: fixture.baseSha256,
    replacementBytes,
    replacementSha256: sha256(replacementBytes),
  });
  assert.deepEqual(
    createOrganizationSingleFileArtifact({ ...fixture, baseMode: "100755" }),
    createOrganizationSingleFileArtifact({ ...fixture, baseMode: "100755" }),
  );
  assert.notDeepEqual(
    first,
    createOrganizationSingleFileArtifact({ ...fixture, baseMode: "100755" }),
  );
});

it("rejects alternate JSON spellings, keys and base64 encodings", () => {
  const canonical = createOrganizationSingleFileArtifact(fixture);
  const value = JSON.parse(new TextDecoder().decode(canonical));
  fail(utf8(` ${new TextDecoder().decode(canonical)}`));
  fail(utf8(`${new TextDecoder().decode(canonical)}\n`));
  fail(encodeJson({ ...value, unknown: true }));
  fail(utf8(new TextDecoder().decode(canonical).replace('"version":1', '"version":1,"version":1')));
  fail(encodeJson({ replacementBase64: value.replacementBase64, ...value }));
  fail(encodeJson({ ...value, version: 2 }));
  fail(encodeJson({ ...value, replacementBase64: value.replacementBase64.replace(/=+$/, "") }));
  fail(encodeJson({ ...value, replacementSha256: "0".repeat(64) }));
});

it("rejects unsafe paths, non-full Git IDs and mismatched base digest", () => {
  for (const relativePath of [
    "../secret",
    "/absolute",
    "src/../secret",
    "src//file",
    "src\\file",
    ".git/config",
    "src/.git/config",
    "src/./file",
    "src/é.ts",
    "-flag",
  ])
    assert.throws(
      () => createOrganizationSingleFileArtifact({ ...fixture, relativePath }),
      OrganizationSingleFileArtifactError,
    );
  for (const baseCommit of ["A".repeat(40), "a".repeat(39), "a".repeat(65)])
    assert.throws(
      () => createOrganizationSingleFileArtifact({ ...fixture, baseCommit }),
      OrganizationSingleFileArtifactError,
    );
  assert.throws(
    () => createOrganizationSingleFileArtifact({ ...fixture, baseBlobOid: "b".repeat(64) }),
    OrganizationSingleFileArtifactError,
  );
  assert.throws(
    () => createOrganizationSingleFileArtifact({ ...fixture, baseSha256: "0".repeat(64) }),
    OrganizationSingleFileArtifactError,
  );
});

it("rejects invalid UTF-8, NUL, empty and oversized replacement bytes", () => {
  for (const replacement of [
    new Uint8Array(),
    Uint8Array.of(0xff),
    utf8("x\0y"),
    new Uint8Array(ORGANIZATION_SINGLE_FILE_REPLACEMENT_MAX_BYTES + 1).fill(65),
  ])
    assert.throws(
      () => createOrganizationSingleFileArtifact({ ...fixture, replacementBytes: replacement }),
      OrganizationSingleFileArtifactError,
    );
  assert.throws(
    () => createOrganizationSingleFileArtifact({ ...fixture, baseBytes: Uint8Array.of(0xff) }),
    OrganizationSingleFileArtifactError,
  );
  fail(Uint8Array.of(0xff));
  fail(utf8("{}\0"));
  fail(new Uint8Array(ORGANIZATION_SINGLE_FILE_ARTIFACT_MAX_BYTES + 1).fill(65));
});

it("accepts the 64 KiB replacement boundary within the 128 KiB wire cap", () => {
  const exact = new Uint8Array(ORGANIZATION_SINGLE_FILE_REPLACEMENT_MAX_BYTES).fill(65);
  const bytes = createOrganizationSingleFileArtifact({ ...fixture, replacementBytes: exact });
  assert.isAtMost(bytes.byteLength, ORGANIZATION_SINGLE_FILE_ARTIFACT_MAX_BYTES);
  assert.deepEqual(decodeOrganizationSingleFileArtifact(bytes).replacementBytes, exact);
});
