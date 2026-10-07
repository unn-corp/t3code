// @effect-diagnostics nodeBuiltinImport:off - Disposable fixtures use Node UUIDs to create unique isolated database and filesystem data.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  buildOrganizationPatchArtifact,
  OrganizationPatchArtifactBuildError,
} from "./OrganizationPatchArtifactBuilder.ts";
import type { OrganizationPatchSource } from "./OrganizationPatchSourceReader.ts";
import { decodeOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";

const content = "export const answer = 1;\n";
const sha256 = (bytes: string) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const source: OrganizationPatchSource = {
  relativePath: "source.mjs",
  baseCommit: "a".repeat(40),
  blobOid: "b".repeat(40),
  baseMode: "100644",
  content,
  sha256: sha256(content),
  byteLength: Buffer.byteLength(content),
};
const proposal = {
  fileName: "source.mjs",
  baseDigest: source.sha256,
  replacementContent: "export const answer = 2;\n",
  rationale: "One scoped replacement",
};

it("encodes a proposal against the pinned source into exact reviewed bytes", () => {
  const artifact = decodeOrganizationSingleFileArtifact(
    buildOrganizationPatchArtifact(source, proposal),
  );
  assert.equal(artifact.relativePath, source.relativePath);
  assert.equal(artifact.baseCommit, source.baseCommit);
  assert.equal(artifact.baseBlobOid, source.blobOid);
  assert.equal(artifact.baseMode, source.baseMode);
  assert.equal(artifact.baseSha256, source.sha256);
  assert.equal(
    Buffer.from(artifact.replacementBytes).toString("utf8"),
    proposal.replacementContent,
  );
  assert.equal(artifact.replacementSha256, sha256(proposal.replacementContent));
});

it("rejects a changed target, stale digest, changed source, and oversized replacement", () => {
  for (const candidate of [
    { ...proposal, fileName: "other.mjs" },
    { ...proposal, baseDigest: "0".repeat(64) },
    { ...proposal, replacementContent: "x".repeat(65 * 1024) },
  ])
    assert.throws(
      () => buildOrganizationPatchArtifact(source, candidate),
      OrganizationPatchArtifactBuildError,
    );
  assert.throws(
    () => buildOrganizationPatchArtifact({ ...source, content: "changed" }, proposal),
    OrganizationPatchArtifactBuildError,
  );
  assert.throws(
    () =>
      buildOrganizationPatchArtifact({ ...source, relativePath: "nested/source.mjs" }, proposal),
    OrganizationPatchArtifactBuildError,
  );
});
