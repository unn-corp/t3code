import * as Schema from "effect/Schema";
import { ModelSelection } from "./orchestration.ts";

export const ORGANIZATION_PATCH_TASK_MAX_BYTES = 4_000;
export const ORGANIZATION_PATCH_SOURCE_MAX_BYTES = 64 * 1024;
export const ORGANIZATION_PATCH_REPLACEMENT_MAX_BYTES = 64 * 1024;
export const ORGANIZATION_PATCH_RATIONALE_MAX_BYTES = 2_000;

const utf8 = new TextEncoder();
const textWithin = (maxBytes: number) =>
  Schema.makeFilter((value: string) => {
    const bytes = utf8.encode(value);
    return (
      (!value.includes("\0") &&
        bytes.byteLength <= maxBytes &&
        new TextDecoder().decode(bytes) === value) ||
      `Text must be valid UTF-8 without NUL and at most ${maxBytes} bytes.`
    );
  });

/** A single flat file; no model-selected path or command is accepted. */
export const OrganizationPatchFileName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
);
export const OrganizationPatchBaseDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const OrganizationPatchProposalInput = Schema.Struct({
  modelSelection: ModelSelection,
  taskText: Schema.String.check(textWithin(ORGANIZATION_PATCH_TASK_MAX_BYTES)),
  findingContext: Schema.optional(
    Schema.Struct({
      title: Schema.String.check(textWithin(512)),
      summary: Schema.String.check(textWithin(2_048)),
    }),
  ),
  fileName: OrganizationPatchFileName,
  currentContent: Schema.String.check(textWithin(ORGANIZATION_PATCH_SOURCE_MAX_BYTES)),
  baseDigest: OrganizationPatchBaseDigest,
});
export type OrganizationPatchProposalInput = typeof OrganizationPatchProposalInput.Type;

/** A full replacement proposal, never an applied patch or execution receipt. */
export const OrganizationPatchProposalOutput = Schema.Struct({
  fileName: OrganizationPatchFileName,
  baseDigest: OrganizationPatchBaseDigest,
  replacementContent: Schema.String.check(textWithin(ORGANIZATION_PATCH_REPLACEMENT_MAX_BYTES)),
  rationale: Schema.String.check(textWithin(ORGANIZATION_PATCH_RATIONALE_MAX_BYTES)),
});
export type OrganizationPatchProposalOutput = typeof OrganizationPatchProposalOutput.Type;
