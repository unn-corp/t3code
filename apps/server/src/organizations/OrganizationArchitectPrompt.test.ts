import {
  OrganizationId,
  OrganizationRoleId,
  OrganizationWorkflowId,
  OrganizationWorkflowStepId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { buildOrganizationArchitectPrompt } from "./OrganizationArchitectPrompt.ts";

it.effect("Architect prompt projects only the selected configuration and transcript fields", () =>
  Effect.gen(function* () {
    const organization = {
      id: OrganizationId.make("org-test"),
      title: "Studio",
      mission: "Plan useful work",
      draftRevision: 2,
      graph: { roles: [], edges: [] },
      workflows: [],
      bindings: [{ secretRepositoryPath: "/private/repository" }],
    };
    const transcript = [
      { role: "user" as const, text: "Add QA", internalNote: "secret transcript note" },
    ];
    const prompt = yield* buildOrganizationArchitectPrompt({
      modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), "test-model"),
      organization,
      transcript,
      userText: "What would you change?",
    });

    expect(prompt).toContain("Plan useful work");
    expect(prompt).toContain("Add QA");
    expect(prompt).toContain("mission, intended outcomes, and success measures");
    expect(prompt).toContain("triggers, recurring workflows, handoffs");
    expect(prompt).toContain("needed resources, access, and decision authority");
    expect(prompt).toContain("Ask one focused question");
    expect(prompt).toContain("Offer concrete structural proposals incrementally");
    expect(prompt).not.toContain("/private/repository");
    expect(prompt).not.toContain("secret transcript note");
  }),
);

it.effect("Architect prompt redacts credentials from projected Organization text", () =>
  Effect.gen(function* () {
    const prompt = yield* buildOrganizationArchitectPrompt({
      modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), "test-model"),
      organization: {
        id: OrganizationId.make("org-redaction-test"),
        title: "Studio OPENAI_API_KEY=supersecret",
        mission: "Build services. Authorization: Bearer abc123token. Keep the useful mission.",
        draftRevision: 3,
        graph: {
          roles: [
            {
              id: OrganizationRoleId.make("engineer"),
              kind: "engineering",
              title: "Engineer ghp_abcdefghijklmnopqrstuvwxyz123456",
              mandate: "Review quality. password='hunter2'; test with sk-abcdefghijklmnop1234",
              poolSize: 1,
            },
          ],
          edges: [],
        },
        workflows: [],
      },
      transcript: [],
      userText: "Improve this structure.",
    });

    expect(prompt).toContain("Keep the useful mission.");
    expect(prompt).toContain("Review quality.");
    expect(prompt).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(prompt).toContain("Bearer [REDACTED]");
    for (const credential of [
      "supersecret",
      "abc123token",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "hunter2",
      "sk-abcdefghijklmnop1234",
    ]) {
      expect(prompt).not.toContain(credential);
    }
  }),
);

it.effect("Architect prompt redacts transcript text and rejects credential-like identifiers", () =>
  Effect.gen(function* () {
    const base = {
      modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), "test-model"),
      organization: {
        id: OrganizationId.make("safe-org"),
        title: "Studio",
        mission: "Plan",
        draftRevision: 1,
        graph: { roles: [], edges: [] },
        workflows: [],
      },
      transcript: [{ role: "user" as const, text: "OPENAI_API_KEY=transcriptsecret" }],
      userText: "Use token=currentsecret to investigate",
    };
    const prompt = yield* buildOrganizationArchitectPrompt(base);
    expect(prompt).not.toContain("transcriptsecret");
    expect(prompt).not.toContain("currentsecret");
    expect(prompt).toContain("OPENAI_API_KEY=[REDACTED]");

    const rejected = yield* Effect.flip(
      buildOrganizationArchitectPrompt({
        ...base,
        organization: {
          ...base.organization,
          graph: {
            roles: [
              {
                id: OrganizationRoleId.make("api_key=identifiersecret"),
                kind: "engineering" as const,
                title: "Engineering",
                mandate: "Investigate",
                poolSize: 1,
              },
            ],
            edges: [],
          },
        },
      }),
    );
    expect(rejected.detail).toContain("identifiers contain credential-like text");
  }),
);

it.effect("Architect prompt includes versioned workflow context without authority fields", () =>
  Effect.gen(function* () {
    const workflow = {
      id: OrganizationWorkflowId.make("review-work"),
      title: "Review work password='hidden-workflow-secret'",
      version: 2,
      steps: [
        {
          id: OrganizationWorkflowStepId.make("request"),
          kind: "trigger" as const,
          title: "Request arrives",
          roleId: null,
          reviewsStepId: null,
        },
      ],
      transitions: [],
      authority: ["write-files"],
    };
    const prompt = yield* buildOrganizationArchitectPrompt({
      modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), "test-model"),
      organization: {
        id: OrganizationId.make("workflow-org"),
        title: "Studio",
        mission: "Ship quality software",
        draftRevision: 3,
        graph: { roles: [], edges: [] },
        workflows: [workflow],
      },
      transcript: [],
      userText: "Improve the review workflow.",
    });
    expect(prompt).toContain('"id":"review-work"');
    expect(prompt).toContain('"version":2');
    expect(prompt).toContain('"title":"Request arrives"');
    expect(prompt).toContain("current version plus 1");
    expect(prompt).toContain("upsert-workflow");
    expect(prompt).not.toContain("hidden-workflow-secret");
    expect(prompt).not.toContain('"authority"');
  }),
);

it.effect("Architect prompt summarizes oversized workflow detail within the snapshot limit", () =>
  Effect.gen(function* () {
    const steps = Array.from({ length: 64 }, (_, index) => ({
      id: OrganizationWorkflowStepId.make(`step-${index}`),
      kind: "work" as const,
      title: `Step ${index} ${"x".repeat(140)}`,
      roleId: null,
      reviewsStepId: null,
    }));
    const prompt = yield* buildOrganizationArchitectPrompt({
      modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), "test-model"),
      organization: {
        id: OrganizationId.make("large-workflow-org"),
        title: "Studio",
        mission: "Ship quality software",
        draftRevision: 3,
        graph: { roles: [], edges: [] },
        workflows: [
          {
            id: OrganizationWorkflowId.make("large-workflow"),
            title: "Large workflow",
            version: 4,
            steps,
            transitions: [],
          },
        ],
      },
      transcript: [],
      userText: "What workflow should we design next?",
    });
    expect(prompt).toContain('"workflowDetailsOmitted":true');
    expect(prompt).toContain('"version":4');
    expect(prompt).toContain('"stepCount":64');
    expect(prompt).not.toContain("Step 63");
  }),
);
