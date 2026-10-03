import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  OrganizationPatchProposalInput,
  OrganizationPatchProposalOutput,
} from "./organizationPatchProposal.ts";

const content = "export const answer = 1;\n";
const digest = "a".repeat(64);
const input = {
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "synthetic-model" },
  taskText: "Change the answer to 2.",
  fileName: "answer.js",
  currentContent: content,
  baseDigest: digest,
};
const decodeInput = Schema.decodeUnknownSync(OrganizationPatchProposalInput);
const decodeOutput = Schema.decodeUnknownSync(OrganizationPatchProposalOutput);

describe("Organization patch proposal contract", () => {
  it("accepts one flat UTF-8 file and bounded replacement", () => {
    expect(decodeInput(input).fileName).toBe("answer.js");
    expect(
      decodeOutput({
        fileName: "answer.js",
        baseDigest: digest,
        replacementContent: "export const answer = 2;\n",
        rationale: "Updates the constant.",
      }).replacementContent,
    ).toContain("2");
  });

  it("rejects paths, invalid hashes, NUL and byte-limit violations", () => {
    for (const fileName of ["../secret", "dir/file.js", "dir\\file.js", ".hidden", ".."])
      expect(() => decodeInput({ ...input, fileName })).toThrow();
    expect(() => decodeInput({ ...input, baseDigest: "abc" })).toThrow();
    expect(() => decodeInput({ ...input, currentContent: "a\0b" })).toThrow();
    expect(() => decodeInput({ ...input, taskText: "é".repeat(2_001) })).toThrow();
    expect(() => decodeInput({ ...input, currentContent: "x".repeat(65_537) })).toThrow();
    expect(() =>
      decodeOutput({
        fileName: "answer.js",
        baseDigest: digest,
        replacementContent: "x".repeat(65_537),
        rationale: "small",
      }),
    ).toThrow();
    expect(() =>
      decodeOutput({
        fileName: "answer.js",
        baseDigest: digest,
        replacementContent: "ok\0bad",
        rationale: "small",
      }),
    ).toThrow();
  });
});
