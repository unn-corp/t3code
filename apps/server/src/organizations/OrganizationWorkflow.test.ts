import { assert, it } from "@effect/vitest";
import {
  OrganizationBindingId,
  OrganizationId,
  OrganizationRoleId,
  OrganizationWorkflowId,
  OrganizationWorkflowStepId,
  OrganizationWorkflowTransitionId,
  ProjectId,
  type OrganizationWorkflowDefinition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";

const layer = it.layer(
  OrganizationStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);
const stepId = OrganizationWorkflowStepId.make;
const transition = (id: string, from: string, to: string, maxTraversals: number | null = null) => ({
  id: OrganizationWorkflowTransitionId.make(id),
  fromStepId: stepId(from),
  toStepId: stepId(to),
  maxTraversals,
});
const workflow = (
  worker: OrganizationRoleId,
  reviewer: OrganizationRoleId,
): OrganizationWorkflowDefinition => ({
  id: OrganizationWorkflowId.make("bug-fix"),
  title: "Bug fix",
  version: 1,
  steps: [
    { id: stepId("start"), kind: "trigger", title: "Report", roleId: null, reviewsStepId: null },
    { id: stepId("work"), kind: "work", title: "Fix", roleId: worker, reviewsStepId: null },
    {
      id: stepId("qa"),
      kind: "qa",
      title: "Verify",
      roleId: reviewer,
      reviewsStepId: stepId("work"),
    },
    {
      id: stepId("integrate"),
      kind: "integrate",
      title: "Integrate",
      roleId: worker,
      reviewsStepId: null,
    },
    { id: stepId("done"), kind: "finish", title: "Done", roleId: null, reviewsStepId: null },
  ],
  transitions: [
    transition("start-work", "start", "work"),
    transition("work-qa", "work", "qa"),
    transition("qa-integrate", "qa", "integrate"),
    transition("integrate-done", "integrate", "done"),
  ],
});

const seed = (name: string) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const store = yield* OrganizationStore;
    const organizationId = OrganizationId.make(name);
    let state = yield* store.create({
      organizationId,
      mutationId: `${name}-create`,
      title: name,
      mission: "Maintain software",
      actor: "user",
    });
    const worker = OrganizationRoleId.make(`${name}-worker`);
    const reviewer = OrganizationRoleId.make(`${name}-reviewer`);
    state = yield* store.mutate({
      organizationId,
      mutationId: `${name}-worker-add`,
      baseRevision: state.draftRevision,
      actor: "user",
      change: {
        type: "add-role",
        role: {
          id: worker,
          kind: "engineering",
          title: "Engineer",
          mandate: "Implement",
          poolSize: 1,
        },
      },
    });
    state = yield* store.mutate({
      organizationId,
      mutationId: `${name}-reviewer-add`,
      baseRevision: state.draftRevision,
      actor: "user",
      change: {
        type: "add-role",
        role: {
          id: reviewer,
          kind: "qa",
          title: "QA",
          mandate: "Verify",
          poolSize: 1,
        },
      },
    });
    return { store, state, worker, reviewer };
  });
const upsert = (input: {
  name: string;
  baseRevision: number;
  definition: OrganizationWorkflowDefinition;
}) =>
  Effect.gen(function* () {
    const store = yield* OrganizationStore;
    return yield* store.mutate({
      organizationId: OrganizationId.make(input.name),
      mutationId: `${input.name}-workflow-v${input.definition.version}`,
      baseRevision: input.baseRevision,
      actor: "user",
      change: { type: "upsert-workflow", workflow: input.definition },
    });
  });

layer("Organization workflows", (it) => {
  it.effect("publishes a QA-gated workflow and pins its definition version", () =>
    Effect.gen(function* () {
      const { store, state, worker, reviewer } = yield* seed("workflow-valid");
      const definition = workflow(worker, reviewer);
      const draft = yield* upsert({
        name: "workflow-valid",
        baseRevision: state.draftRevision,
        definition,
      });
      const published = yield* store.publish({
        organizationId: draft.id,
        mutationId: "workflow-valid-publish",
        baseRevision: draft.draftRevision,
        actor: "user",
      });
      const revision = published.publishedRevision!;
      const old = yield* store.getPublishedConfig({ organizationId: draft.id, revision });
      assert.equal(old.workflows[0]?.version, 1);
      const newer = yield* upsert({
        name: "workflow-valid",
        baseRevision: published.draftRevision,
        definition: { ...definition, version: 2, title: "Revised" },
      });
      assert.equal(newer.workflows[0]?.version, 2);
      assert.equal(
        (yield* store.getPublishedConfig({ organizationId: draft.id, revision })).workflows[0]
          ?.version,
        1,
      );
    }),
  );

  it.effect("rejects a QA bypass and accepts a bounded retry after revision", () =>
    Effect.gen(function* () {
      const { store, state, worker, reviewer } = yield* seed("workflow-route");
      const base = workflow(worker, reviewer);
      const bypass = {
        ...base,
        transitions: [...base.transitions, transition("skip-qa", "work", "integrate")],
      };
      let draft = yield* upsert({
        name: "workflow-route",
        baseRevision: state.draftRevision,
        definition: bypass,
      });
      const rejected = yield* Effect.flip(
        store.publish({
          organizationId: draft.id,
          mutationId: "workflow-route-rejected",
          baseRevision: draft.draftRevision,
          actor: "user",
        }),
      );
      assert.equal(rejected.code, "invalid");
      assert.ok(rejected.message.includes("bypass QA"));
      const unbounded = {
        ...base,
        version: 2,
        transitions: [...base.transitions, transition("retry", "qa", "work")],
      };
      draft = yield* upsert({
        name: "workflow-route",
        baseRevision: draft.draftRevision,
        definition: unbounded,
      });
      const cycle = yield* Effect.flip(
        store.publish({
          organizationId: draft.id,
          mutationId: "workflow-route-cycle",
          baseRevision: draft.draftRevision,
          actor: "user",
        }),
      );
      assert.ok(cycle.message.includes("unbounded cycle"));
      const bounded = {
        ...base,
        version: 3,
        transitions: [...base.transitions, transition("retry", "qa", "work", 2)],
      };
      draft = yield* upsert({
        name: "workflow-route",
        baseRevision: draft.draftRevision,
        definition: bounded,
      });
      const published = yield* store.publish({
        organizationId: draft.id,
        mutationId: "workflow-route-publish",
        baseRevision: draft.draftRevision,
        actor: "user",
      });
      assert.equal(published.publishedRevision, published.draftRevision);
    }),
  );

  it.effect("requires QA for work added after an earlier QA gate", () =>
    Effect.gen(function* () {
      const { store, state, worker, reviewer } = yield* seed("workflow-late-work");
      const base = workflow(worker, reviewer);
      const workB = {
        id: stepId("work-b"),
        kind: "work" as const,
        title: "Follow-up change",
        roleId: worker,
        reviewsStepId: null,
      };
      const withoutSecondQa: OrganizationWorkflowDefinition = {
        ...base,
        steps: [...base.steps, workB],
        transitions: [
          ...base.transitions.filter((edge) => edge.id !== "qa-integrate"),
          transition("qa-work-b", "qa", "work-b"),
          transition("work-b-integrate", "work-b", "integrate"),
        ],
      };
      let draft = yield* upsert({
        name: "workflow-late-work",
        baseRevision: state.draftRevision,
        definition: withoutSecondQa,
      });
      const rejected = yield* Effect.flip(
        store.publish({
          organizationId: draft.id,
          mutationId: "workflow-late-work-rejected",
          baseRevision: draft.draftRevision,
          actor: "user",
        }),
      );
      assert.equal(rejected.code, "invalid");
      assert.ok(rejected.message.includes("bypass QA for prior work"));

      const withSecondQa: OrganizationWorkflowDefinition = {
        ...withoutSecondQa,
        version: 2,
        steps: [
          ...withoutSecondQa.steps,
          {
            id: stepId("qa-b"),
            kind: "qa",
            title: "Review follow-up",
            roleId: reviewer,
            reviewsStepId: stepId("work-b"),
          },
        ],
        transitions: [
          ...withoutSecondQa.transitions.filter((edge) => edge.id !== "work-b-integrate"),
          transition("work-b-qa-b", "work-b", "qa-b"),
          transition("qa-b-integrate", "qa-b", "integrate"),
        ],
      };
      draft = yield* upsert({
        name: "workflow-late-work",
        baseRevision: draft.draftRevision,
        definition: withSecondQa,
      });
      const published = yield* store.publish({
        organizationId: draft.id,
        mutationId: "workflow-late-work-published",
        baseRevision: draft.draftRevision,
        actor: "user",
      });
      assert.equal(published.publishedRevision, published.draftRevision);
    }),
  );

  it.effect("rejects dangling roles, dangling steps, and self-review at publication", () =>
    Effect.gen(function* () {
      const { store, state, worker, reviewer } = yield* seed("workflow-references");
      const base = workflow(worker, reviewer);
      let draft = yield* upsert({
        name: "workflow-references",
        baseRevision: state.draftRevision,
        definition: {
          ...base,
          steps: base.steps.map((step) =>
            step.kind === "qa" ? { ...step, roleId: OrganizationRoleId.make("missing") } : step,
          ),
        },
      });
      let error = yield* Effect.flip(
        store.publish({
          organizationId: draft.id,
          mutationId: "workflow-ref-role",
          baseRevision: draft.draftRevision,
          actor: "user",
        }),
      );
      assert.ok(error.message.includes("missing role"));
      draft = yield* upsert({
        name: "workflow-references",
        baseRevision: draft.draftRevision,
        definition: {
          ...base,
          version: 2,
          transitions: [...base.transitions, transition("dangling", "qa", "missing-step")],
        },
      });
      error = yield* Effect.flip(
        store.publish({
          organizationId: draft.id,
          mutationId: "workflow-ref-step",
          baseRevision: draft.draftRevision,
          actor: "user",
        }),
      );
      assert.ok(error.message.includes("missing step"));
      draft = yield* upsert({
        name: "workflow-references",
        baseRevision: draft.draftRevision,
        definition: {
          ...base,
          version: 3,
          steps: base.steps.map((step) =>
            step.kind === "qa" ? { ...step, roleId: worker } : step,
          ),
        },
      });
      error = yield* Effect.flip(
        store.publish({
          organizationId: draft.id,
          mutationId: "workflow-ref-self",
          baseRevision: draft.draftRevision,
          actor: "user",
        }),
      );
      assert.ok(error.message.includes("own role's work"));
    }),
  );

  it.effect("archives by detaching the old write steward and preserving its history", () =>
    Effect.gen(function* () {
      const { store, state } = yield* seed("workflow-archive");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('archive-target', 'Archive target', '/tmp/archive-target', '[]', '2026-01-01', '2026-01-01')
    `;
      const bound = yield* store.bindProject({
        organizationId: state.id,
        mutationId: "workflow-archive-bind",
        baseRevision: state.draftRevision,
        actor: "user",
        bindingId: OrganizationBindingId.make("archive-binding"),
        projectId: ProjectId.make("archive-target"),
        access: "write",
        capabilities: ["write-files"],
        scope: null,
      });
      const archived = yield* store.setLifecycle({
        organizationId: state.id,
        mutationId: "workflow-archive-end",
        baseRevision: bound.draftRevision,
        actor: "user",
        lifecycle: "archived",
      });
      assert.ok(archived.bindings[0]?.detachedAt);
      const replacement = yield* store.create({
        organizationId: OrganizationId.make("workflow-replacement"),
        mutationId: "workflow-replacement-create",
        title: "Replacement",
        mission: "Maintain",
        actor: "user",
      });
      const next = yield* store.bindProject({
        organizationId: replacement.id,
        mutationId: "workflow-replacement-bind",
        baseRevision: 1,
        actor: "user",
        bindingId: OrganizationBindingId.make("replacement-binding"),
        projectId: ProjectId.make("archive-target"),
        access: "write",
        capabilities: ["write-files"],
        scope: null,
      });
      assert.equal(next.bindings[0]?.access, "write");
      assert.equal(
        (yield* store.listAudit({ organizationId: state.id })).entries.at(-1)?.action,
        "lifecycle:archived",
      );
    }),
  );
});
