// @effect-diagnostics nodeBuiltinImport:off - This Node-only server module uses synchronous host crypto for persistent IDs or hashes; replacing it would add Crypto service requirements through the persistence API.
import * as NodeCrypto from "node:crypto";
import { OrganizationPatchProposalOutput } from "../../../../packages/contracts/src/organizationPatchProposal.ts";
import * as Schema from "effect/Schema";
import type { OrganizationPatchSource } from "./OrganizationPatchSourceReader.ts";
import { createOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";

const decodeProposal = Schema.decodeUnknownSync(OrganizationPatchProposalOutput);
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export class OrganizationPatchArtifactBuildError extends Error {
  override readonly name = "OrganizationPatchArtifactBuildError";
}

/** Joins a pinned Git source and one tool-free proposal into reviewed artifact bytes. */
export function buildOrganizationPatchArtifact(
  source: OrganizationPatchSource,
  rawProposal: unknown,
): Uint8Array {
  let proposal: OrganizationPatchProposalOutput;
  try {
    proposal = decodeProposal(rawProposal);
  } catch {
    throw new OrganizationPatchArtifactBuildError("Patch proposal is invalid.");
  }
  const baseBytes = Buffer.from(source.content, "utf8");
  if (
    proposal.fileName !== source.relativePath ||
    proposal.baseDigest !== source.sha256 ||
    source.byteLength !== baseBytes.byteLength ||
    sha256(baseBytes) !== source.sha256
  )
    throw new OrganizationPatchArtifactBuildError(
      "Patch proposal does not match the pinned source bytes.",
    );
  try {
    return createOrganizationSingleFileArtifact({
      relativePath: source.relativePath,
      baseCommit: source.baseCommit,
      baseBlobOid: source.blobOid,
      baseMode: source.baseMode,
      baseSha256: source.sha256,
      baseBytes,
      replacementBytes: Buffer.from(proposal.replacementContent, "utf8"),
    });
  } catch {
    throw new OrganizationPatchArtifactBuildError(
      "Patch proposal cannot be encoded as a single-file artifact.",
    );
  }
}
