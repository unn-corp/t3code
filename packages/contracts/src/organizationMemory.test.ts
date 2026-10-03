import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { OrganizationMemoryContent, OrganizationMemoryCreateInput } from "./organizationMemory.ts";

const content = {
  kind: "decision",
  title: "Use a scoped store",
  body: "User-approved design decision.",
  provenance: { kind: "user", reference: null, note: null },
  reviewedAt: null,
  staleAt: null,
  retainUntil: null,
};
const input = {
  mutationId: "memory-create",
  recordId: "memory-1",
  organizationId: "org-1",
  projectId: null,
  content,
};

describe("Organization memory contract", () => {
  it("accepts scoped, bounded user records", () => {
    expect(Exit.isSuccess(Schema.decodeUnknownExit(OrganizationMemoryCreateInput)(input))).toBe(
      true,
    );
  });
  it("rejects oversized content and unsupported record kinds", () => {
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(OrganizationMemoryContent)({
          ...content,
          body: "x".repeat(8_001),
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(OrganizationMemoryContent)({
          ...content,
          kind: "grant-authority",
        }),
      ),
    ).toBe(true);
  });
});
