import { assert, it } from "@effect/vitest";
import {
  OrganizationEdgeId,
  OrganizationId,
  OrganizationRoleId,
  OrganizationWorkflowId,
  OrganizationWorkflowStepId,
  OrganizationWorkflowTransitionId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrganizationArchitectMessageId } from "../../../../packages/contracts/src/organizationArchitect.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import {
  OrganizationArchitectTranscriptStore,
  OrganizationArchitectTranscriptStoreLive,
} from "./OrganizationArchitectTranscriptStore.ts";

const layer = it.layer(
  Layer.mergeAll(OrganizationStoreLive, OrganizationArchitectTranscriptStoreLive).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);
const principal = { subject: "interactive-user" } as const;
const organizationId = OrganizationId.make("architect-org-a");
const otherOrganizationId = OrganizationId.make("architect-org-b");
const modelSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "test-model");
const input = (messageId: string, organization = organizationId, baseRevision = 1) => ({
  organizationId: organization,
  messageId: OrganizationArchitectMessageId.make(messageId),
  baseRevision,
  text: "Add a scoped engineering role",
  modelSelection,
});
const output = (baseRevision = 1) => ({
  reply: "I propose a draft engineering role.",
  proposals: [
    {
      baseRevision,
      change: {
        type: "add-role" as const,
        role: {
          id: OrganizationRoleId.make("architect-engineering"),
          kind: "engineering" as const,
          title: "Engineering",
          mandate: "Investigate evidence",
          poolSize: 1,
        },
      },
    },
  ],
});
const initialize = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM organization_architect_proposals`;
  yield* sql`DELETE FROM organization_architect_messages`;
  yield* sql`DELETE FROM organization_architect_requests`;
  yield* sql`DELETE FROM organization_project_bindings`;
  yield* sql`DELETE FROM organization_config_versions`;
  yield* sql`DELETE FROM organization_audit`;
  yield* sql`DELETE FROM organizations`;
  const organizations = yield* OrganizationStore;
  yield* organizations.create({
    organizationId,
    mutationId: "architect-org-create-a",
    title: "Studio A",
    mission: "Plan",
    actor: "user",
  });
  yield* organizations.create({
    organizationId: otherOrganizationId,
    mutationId: "architect-org-create-b",
    title: "Studio B",
    mission: "Plan",
    actor: "user",
  });
});

layer("Organization Architect transcript", (it) => {
  it.effect("applies roles and a valid workflow together and rejects an invalid workflow", () =>
    Effect.gen(function* () {
      yield* initialize;
      const transcript = yield* OrganizationArchitectTranscriptStore;
      const organizations = yield* OrganizationStore;
      const current = yield* organizations.get({ organizationId });
      const engineer = OrganizationRoleId.make("workflow-engineer");
      const reviewer = OrganizationRoleId.make("workflow-reviewer");
      const trigger = OrganizationWorkflowStepId.make("start");
      const work = OrganizationWorkflowStepId.make("implement");
      const qa = OrganizationWorkflowStepId.make("review");
      const finish = OrganizationWorkflowStepId.make("done");
      const workflow = {
        id: OrganizationWorkflowId.make("remediation"),
        title: "Remediation",
        version: 1,
        steps: [
          {
            id: trigger,
            kind: "trigger" as const,
            title: "Start",
            roleId: null,
            reviewsStepId: null,
          },
          { id: work, kind: "work" as const, title: "Fix", roleId: engineer, reviewsStepId: null },
          { id: qa, kind: "qa" as const, title: "Review", roleId: reviewer, reviewsStepId: work },
          { id: finish, kind: "finish" as const, title: "Done", roleId: null, reviewsStepId: null },
        ],
        transitions: [
          {
            id: OrganizationWorkflowTransitionId.make("start-fix"),
            fromStepId: trigger,
            toStepId: work,
            maxTraversals: null,
          },
          {
            id: OrganizationWorkflowTransitionId.make("fix-review"),
            fromStepId: work,
            toStepId: qa,
            maxTraversals: null,
          },
          {
            id: OrganizationWorkflowTransitionId.make("review-done"),
            fromStepId: qa,
            toStepId: finish,
            maxTraversals: null,
          },
        ],
      };
      const request = input("architect-workflow-batch");
      yield* transcript.begin(request, principal);
      const completed = yield* transcript.complete(
        {
          organizationId,
          messageId: request.messageId,
          output: {
            reply: "Add Engineering, independent QA, and a bounded remediation workflow.",
            proposals: [
              {
                baseRevision: 1,
                change: {
                  type: "add-role",
                  role: {
                    id: engineer,
                    kind: "engineering",
                    title: "Engineering",
                    mandate: "Implement fixes",
                    poolSize: 1,
                  },
                },
              },
              {
                baseRevision: 1,
                change: {
                  type: "add-role",
                  role: {
                    id: reviewer,
                    kind: "qa",
                    title: "QA",
                    mandate: "Review fixes",
                    poolSize: 1,
                  },
                },
              },
              { baseRevision: 1, change: { type: "upsert-workflow", workflow } },
            ],
          },
        },
        principal,
      );
      const applied = yield* organizations.applyArchitectBatch({
        organizationId,
        mutationId: "architect-workflow-apply",
        baseRevision: current.draftRevision,
        proposalIds: completed.proposals.map((proposal) => proposal.id),
      });
      assert.equal(applied.draftRevision, current.draftRevision + 1);
      assert.equal(applied.workflows[0]?.id, workflow.id);
      assert.equal(applied.workflows[0]?.steps.length, 4);
      assert.equal((yield* organizations.get({ organizationId })).workflows.length, 1);

      const invalidRequest = input(
        "architect-invalid-workflow",
        organizationId,
        applied.draftRevision,
      );
      yield* transcript.begin(invalidRequest, principal);
      const invalid = yield* transcript.complete(
        {
          organizationId,
          messageId: invalidRequest.messageId,
          output: {
            reply: "Change the reviewer.",
            proposals: [
              {
                baseRevision: applied.draftRevision,
                change: {
                  type: "upsert-workflow",
                  workflow: {
                    ...workflow,
                    version: 2,
                    steps: workflow.steps.map((step) =>
                      step.id === qa ? { ...step, roleId: engineer } : step,
                    ),
                  },
                },
              },
            ],
          },
        },
        principal,
      );
      const failure = yield* Effect.flip(
        organizations.applyArchitectBatch({
          organizationId,
          mutationId: "architect-invalid-workflow-apply",
          baseRevision: applied.draftRevision,
          proposalIds: invalid.proposals.map((proposal) => proposal.id),
        }),
      );
      assert.equal(failure.code, "invalid");
      assert.equal(
        (yield* organizations.get({ organizationId })).draftRevision,
        applied.draftRevision,
      );
    }),
  );
  it.effect("applies a saved role and its relationship in one draft revision", () =>
    Effect.gen(function* () {
      yield* initialize;
      const transcript = yield* OrganizationArchitectTranscriptStore;
      const organizations = yield* OrganizationStore;
      const request = input("architect-message-batch");
      yield* transcript.begin(request, principal);
      const current = yield* organizations.get({ organizationId });
      const roleId = OrganizationRoleId.make("batch-qa");
      const completed = yield* transcript.complete(
        {
          organizationId,
          messageId: request.messageId,
          output: {
            reply: "Add a QA role reporting to the Director.",
            proposals: [
              {
                baseRevision: current.draftRevision,
                change: {
                  type: "add-role",
                  role: {
                    id: roleId,
                    kind: "qa",
                    title: "QA",
                    mandate: "Review work",
                    poolSize: 1,
                  },
                },
              },
              {
                baseRevision: current.draftRevision,
                change: {
                  type: "add-edge",
                  edge: {
                    id: OrganizationEdgeId.make("batch-qa-reports"),
                    kind: "reports-to",
                    fromRoleId: roleId,
                    toRoleId: current.directorRoleId,
                  },
                },
              },
            ],
          },
        },
        principal,
      );
      const applied = yield* organizations.applyArchitectBatch({
        organizationId,
        mutationId: "architect-batch-apply",
        baseRevision: current.draftRevision,
        proposalIds: completed.proposals.map((proposal) => proposal.id),
      });
      assert.equal(applied.draftRevision, current.draftRevision + 1);
      assert.isTrue(applied.graph.roles.some((role) => role.id === roleId));
      assert.isTrue(applied.graph.edges.some((edge) => edge.fromRoleId === roleId));
      const listed = yield* transcript.list({ organizationId });
      assert.deepEqual(
        new Set(listed.appliedProposalIds),
        new Set(completed.proposals.map((proposal) => proposal.id)),
      );
      const stale = yield* Effect.flip(
        organizations.applyArchitectBatch({
          organizationId,
          mutationId: "architect-batch-stale",
          baseRevision: current.draftRevision,
          proposalIds: completed.proposals.map((proposal) => proposal.id),
        }),
      );
      assert.equal(stale.code, "conflict");
      assert.equal(
        (yield* organizations.get({ organizationId })).draftRevision,
        applied.draftRevision,
      );
    }),
  );

  it.effect("reserves one request, persists restricted proposals, and never edits the graph", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationArchitectTranscriptStore;
      const organizations = yield* OrganizationStore;
      const send = input("architect-message-1");
      const first = yield* store.begin(send, principal);
      assert.equal(first.shouldGenerate, true);
      assert.equal(first.status, "pending");
      assert.equal((yield* store.begin(send, principal)).shouldGenerate, false);
      assert.equal(
        (yield* Effect.flip(store.begin(input("architect-message-2"), principal))).code,
        "conflict",
      );
      assert.equal(
        (yield* Effect.flip(
          store.begin(input("architect-message-1", otherOrganizationId), principal),
        )).code,
        "conflict",
      );
      assert.equal(
        (yield* Effect.flip(
          store.complete(
            { organizationId: otherOrganizationId, messageId: send.messageId, output: output() },
            principal,
          ),
        )).code,
        "not_found",
      );
      const before = yield* organizations.get({ organizationId });
      const completed = yield* store.complete(
        { organizationId, messageId: send.messageId, output: output() },
        principal,
      );
      assert.equal(completed.proposals.length, 1);
      assert.equal(completed.proposals[0]?.baseRevision, 1);
      assert.equal(completed.proposals[0]?.change.type, "add-role");
      assert.deepStrictEqual(
        yield* store.complete(
          { organizationId, messageId: send.messageId, output: output() },
          principal,
        ),
        completed,
      );
      const duplicate = yield* store.begin(send, principal);
      assert.equal(duplicate.shouldGenerate, false);
      assert.equal(duplicate.status, "completed");
      assert.deepStrictEqual(duplicate.result, completed);
      assert.equal(
        (yield* Effect.flip(
          store.complete(
            {
              organizationId,
              messageId: send.messageId,
              output: { ...output(), reply: "Changed" },
            },
            principal,
          ),
        )).code,
        "conflict",
      );
      const after = yield* organizations.get({ organizationId });
      assert.equal(after.draftRevision, before.draftRevision);
      assert.deepStrictEqual(after.graph, before.graph);
      const listed = yield* store.list({ organizationId });
      assert.equal(listed.messages.length, 2);
      assert.equal(listed.proposals.length, 1);
      assert.deepStrictEqual(listed.appliedProposalIds, []);
      assert.equal(listed.requests[0]?.status, "completed");
      assert.equal((yield* store.list({ organizationId: otherOrganizationId })).messages.length, 0);
      yield* organizations.mutate({
        organizationId,
        mutationId: completed.proposals[0]!.id,
        baseRevision: before.draftRevision,
        actor: "user",
        change: completed.proposals[0]!.change,
      });
      assert.deepStrictEqual((yield* store.list({ organizationId })).appliedProposalIds, [
        completed.proposals[0]!.id,
      ]);
    }),
  );

  it.effect(
    "does not mark a proposal applied when its mutation ID is reused for another edit",
    () =>
      Effect.gen(function* () {
        yield* initialize;
        const store = yield* OrganizationArchitectTranscriptStore;
        const organizations = yield* OrganizationStore;
        const send = input("architect-collision");
        yield* store.begin(send, principal);
        const completed = yield* store.complete(
          { organizationId, messageId: send.messageId, output: output() },
          principal,
        );
        yield* organizations.mutate({
          organizationId,
          mutationId: completed.proposals[0]!.id,
          baseRevision: 1,
          actor: "user",
          change: { type: "set-title", title: "Different edit" },
        });
        assert.deepStrictEqual((yield* store.list({ organizationId })).appliedProposalIds, []);
      }),
  );

  it.effect("rejects stale and archived turns before generation", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationArchitectTranscriptStore;
      const organizations = yield* OrganizationStore;
      const changed = yield* organizations.mutate({
        organizationId,
        mutationId: "architect-title-change",
        baseRevision: 1,
        actor: "user",
        change: { type: "set-title", title: "Revised Studio" },
      });
      assert.equal(
        (yield* Effect.flip(store.begin(input("stale-request"), principal))).code,
        "conflict",
      );
      assert.equal((yield* store.list({ organizationId })).requests.length, 0);
      yield* organizations.setLifecycle({
        organizationId,
        mutationId: "architect-archive",
        baseRevision: changed.draftRevision,
        actor: "user",
        lifecycle: "archived",
      });
      assert.equal(
        (yield* Effect.flip(
          store.begin(
            input("archived-request", organizationId, changed.draftRevision + 1),
            principal,
          ),
        )).code,
        "forbidden",
      );
      assert.equal((yield* store.list({ organizationId })).messages.length, 0);
    }),
  );

  it.effect("rejects a message over the UTF-8 prompt limit before reservation", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationArchitectTranscriptStore;
      const oversized = { ...input("large-emoji-message"), text: "😀".repeat(2_000) };
      assert.equal((yield* Effect.flip(store.begin(oversized, principal))).code, "invalid");
      assert.equal((yield* store.list({ organizationId })).requests.length, 0);
    }),
  );

  it.effect("records a sanitized failure and does not regenerate the same request", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationArchitectTranscriptStore;
      const send = { ...input("failed-request"), text: "Please inspect password=supersecret" };
      yield* store.begin(send, principal);
      yield* store.fail({ organizationId, messageId: send.messageId }, principal);
      yield* store.fail({ organizationId, messageId: send.messageId }, principal);
      const duplicate = yield* store.begin(send, principal);
      assert.equal(duplicate.shouldGenerate, false);
      assert.equal(duplicate.status, "failed");
      const listed = yield* store.list({ organizationId });
      assert.equal(listed.requests[0]?.status, "failed");
      assert.equal(listed.messages.length, 2);
      assert.equal(listed.messages[0]?.text.includes("supersecret"), false);
      assert.equal(listed.messages[1]?.text.includes("supersecret"), false);
      assert.equal(
        (yield* Effect.flip(
          store.complete(
            { organizationId, messageId: send.messageId, output: output() },
            principal,
          ),
        )).code,
        "conflict",
      );
    }),
  );

  it.effect("redacts credentials in stored proposal text", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationArchitectTranscriptStore;
      const send = input("redacted-proposal");
      yield* store.begin(send, principal);
      const proposed = output();
      const completed = yield* store.complete(
        {
          organizationId,
          messageId: send.messageId,
          output: {
            ...proposed,
            proposals: [
              {
                ...proposed.proposals[0]!,
                change: {
                  type: "add-role",
                  role: {
                    ...proposed.proposals[0]!.change.role,
                    mandate: "Inspect with token=raw-provider-secret",
                  },
                },
              },
            ],
          },
        },
        principal,
      );
      const change = completed.proposals[0]?.change;
      assert.equal(change?.type, "add-role");
      if (change?.type === "add-role") {
        assert.equal(change.role.mandate.includes("raw-provider-secret"), false);
        assert.equal(change.role.mandate.includes("[REDACTED]"), true);
      }
      const listed = yield* store.list({ organizationId });
      assert.deepStrictEqual(listed.proposals, completed.proposals);
    }),
  );

  it.effect("reconciles an interrupted pending turn without regenerating its request ID", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationArchitectTranscriptStore;
      const sql = yield* SqlClient.SqlClient;
      const interrupted = input("interrupted-request");
      yield* store.begin(interrupted, principal);
      yield* sql`UPDATE organization_architect_requests
        SET created_at = '1900-01-01T00:00:00.000Z'
        WHERE request_id = ${interrupted.messageId}`;
      const next = yield* store.begin(input("new-after-interruption"), principal);
      assert.equal(next.shouldGenerate, true);
      const duplicate = yield* store.begin(interrupted, principal);
      assert.equal(duplicate.shouldGenerate, false);
      assert.equal(duplicate.status, "failed");
      assert.equal(
        (yield* Effect.flip(
          store.complete(
            { organizationId, messageId: interrupted.messageId, output: output() },
            principal,
          ),
        )).code,
        "conflict",
      );
      const listed = yield* store.list({ organizationId });
      assert.equal(
        listed.requests.find((request) => request.requestId === interrupted.messageId)?.status,
        "failed",
      );
      assert.equal(
        listed.requests.find((request) => request.requestId === "new-after-interruption")?.status,
        "pending",
      );
      assert.equal(
        listed.messages.filter((message) => message.requestId === interrupted.messageId).length,
        2,
      );
    }),
  );

  it.effect("reconciles a stale pending turn when the Designer refreshes", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationArchitectTranscriptStore;
      const sql = yield* SqlClient.SqlClient;
      const interrupted = input("interrupted-list-refresh");
      yield* store.begin(interrupted, principal);
      yield* sql`UPDATE organization_architect_requests
        SET created_at = '1900-01-01T00:00:00.000Z'
        WHERE request_id = ${interrupted.messageId}`;
      const listed = yield* store.list({ organizationId });
      assert.equal(listed.requests[0]?.status, "failed");
      assert.equal(listed.messages.length, 2);
      assert.equal(listed.requests[0]?.failureMessage?.includes("expired"), true);
    }),
  );

  it.effect("bounds transcript reads to the latest fifty requests", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationArchitectTranscriptStore;
      for (let index = 0; index < 51; index++) {
        const send = input(`bounded-request-${String(index).padStart(2, "0")}`);
        yield* store.begin(send, principal);
        yield* store.complete(
          { organizationId, messageId: send.messageId, output: { reply: "Noted.", proposals: [] } },
          principal,
        );
      }
      const listed = yield* store.list({ organizationId });
      assert.equal(listed.requests.length, 50);
      assert.equal(listed.messages.length, 100);
      assert.equal(listed.proposals.length, 0);
      assert.equal(
        listed.requests.some((request) => request.requestId === "bounded-request-00"),
        false,
      );
    }),
  );
});
