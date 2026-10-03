import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { OrganizationArchitectTurnOutput } from "./organizationArchitect.ts";

const decode = Schema.decodeUnknownExit(OrganizationArchitectTurnOutput);
const role = {
  id: "engineering-1",
  kind: "engineering",
  title: "Engineering",
  mandate: "Investigate scoped findings",
  poolSize: 2,
};
const workflow = {
  id: "review-work",
  title: "Review work",
  version: 1,
  steps: [
    { id: "start", kind: "trigger", title: "Request arrives", roleId: null, reviewsStepId: null },
    { id: "build", kind: "work", title: "Build", roleId: "engineering-1", reviewsStepId: null },
    { id: "done", kind: "finish", title: "Done", roleId: null, reviewsStepId: null },
  ],
  transitions: [
    { id: "start-build", fromStepId: "start", toStepId: "build", maxTraversals: null },
    { id: "build-done", fromStepId: "build", toStepId: "done", maxTraversals: null },
  ],
};

describe("Organization Architect proposal boundary", () => {
  it("accepts a bounded draft role suggestion", () => {
    expect(
      Exit.isSuccess(
        decode({
          reply: "I suggest an engineering role for the draft.",
          proposals: [{ baseRevision: 3, change: { type: "add-role", role } }],
        }),
      ),
    ).toBe(true);
  });

  it("accepts a versioned workflow suggestion without granting authority", () => {
    const result = decode({
      reply: "Review this draft workflow.",
      proposals: [
        {
          baseRevision: 3,
          change: {
            type: "upsert-workflow",
            workflow: {
              ...workflow,
              authority: ["write-files"],
              budget: 10_000,
            },
          },
        },
      ],
    });
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      const change = result.value.proposals[0]?.change;
      expect(change).toMatchObject({
        type: "upsert-workflow",
        workflow: { id: "review-work", version: 1 },
      });
      if (change?.type === "upsert-workflow") {
        expect(change.workflow).not.toHaveProperty("authority");
        expect(change.workflow).not.toHaveProperty("budget");
      }
    }
  });

  it("rejects authority and lifecycle changes outside the Architect proposal schema", () => {
    for (const change of [
      { type: "remove-role", roleId: "director" },
      { type: "upsert-workflow", workflow: {} },
      { type: "upsert-workflow", workflow: { ...workflow, version: 0 } },
      { type: "set-lifecycle", lifecycle: "active" },
      { type: "add-role", role: { ...role, kind: "director" } },
      { type: "add-role", role: { ...role, poolSize: 1_000 } },
    ]) {
      expect(
        Exit.isFailure(decode({ reply: "Proposed", proposals: [{ baseRevision: 3, change }] })),
      ).toBe(true);
    }
  });

  it("rejects an unbounded proposal batch", () => {
    const change = { type: "add-role", role };
    expect(
      Exit.isFailure(
        decode({
          reply: "Too many suggestions",
          proposals: Array.from({ length: 9 }, () => ({ baseRevision: 3, change })),
        }),
      ),
    ).toBe(true);
  });
});
