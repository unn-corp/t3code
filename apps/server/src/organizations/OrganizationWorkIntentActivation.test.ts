// @effect-diagnostics preferSchemaOverJson:off globalDateInEffect:off - Fixture rows use persisted JSON and grant expiry uses the server wall clock.
import { assert, it } from "@effect/vitest";
import {
  OrganizationBindingId,
  OrganizationId,
  OrganizationRoleId,
  OrganizationWorkflowId,
  OrganizationWorkflowStepId,
  OrganizationWorkflowTransitionId,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { OrganizationIntakeSourceId } from "../../../../packages/contracts/src/organizationIntake.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { OrganizationGitTargetPreflight } from "./OrganizationGitTargetPreflight.ts";
import {
  OrganizationFindingCorrelationAuthority,
  OrganizationFindingCorrelator,
  OrganizationFindingCorrelatorLayer,
} from "./OrganizationFindingCorrelator.ts";
import { makeOrganizationLiveWorkReadinessGate } from "./OrganizationLiveWorkReadinessGate.ts";
import {
  OrganizationProposalStore,
  OrganizationProposalStoreLive,
} from "./OrganizationProposalStore.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import {
  activateOrganizationWorkIntent,
  activateOrganizationWorkIntentFromStandingAuthorization,
  OrganizationWorkIntentActivationReadiness,
  readOrganizationWorkIntentActivationByWorkId,
} from "./OrganizationWorkIntentActivation.ts";
import { OrganizationWorkIntentStoreLive } from "./OrganizationWorkIntentStore.ts";
import { OrganizationWorkIntentStore } from "./OrganizationWorkIntentStore.ts";
import {
  createOrganizationStandingWorkAuthorization,
  reconcileOrganizationStandingWorkAuthorizationsOnce,
  revokeOrganizationStandingWorkAuthorization,
} from "./OrganizationStandingWorkAuthorization.ts";

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const step = OrganizationWorkflowStepId.make;
const transition = (id: string, from: string, to: string) => ({
  id: OrganizationWorkflowTransitionId.make(id),
  fromStepId: step(from),
  toStepId: step(to),
  maxTraversals: null,
});

it.effect(
  "consumes a bounded HTTP-source grant and removes activated work from the waiting list",
  () => {
    const gate = makeOrganizationLiveWorkReadinessGate();
    const layer = Layer.mergeAll(
      OrganizationStoreLive,
      OrganizationWorkIntentStoreLive,
      OrganizationProposalStoreLive,
      OrganizationFindingCorrelatorLayer.pipe(
        Layer.provide(
          Layer.succeed(OrganizationFindingCorrelationAuthority, {
            permits: (principal) => principal.subject === "correlator",
          }),
        ),
      ),
      Layer.succeed(OrganizationGitTargetPreflight, { verify: () => Effect.void }),
      gate.activationReadinessLayer,
      gate.runtimeReadinessLayer,
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        resolveCommit: () => Effect.succeed({ commitSha: COMMIT }),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
    ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
    return Effect.gen(function* () {
      const fixture = yield* seed(false);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organization_provider_budget_limits
      SET max_concurrent = 1, max_daily_calls = 2, max_daily_estimated_tokens = 280000
      WHERE scope_kind = 'global' AND scope_id = '*'`;
      for (const [kind, id] of [
        ["organization", fixture.organizationId],
        ["project", fixture.projectId],
      ] as const)
        yield* sql`INSERT INTO organization_provider_budget_limits
        (scope_kind, scope_id, max_concurrent, max_daily_calls,
          max_daily_estimated_tokens, updated_at)
        VALUES (${kind}, ${id}, 1, 2, 280000, '2026-01-01T00:00:00.000Z')`;
      yield* gate.initialize(
        Effect.succeed("fixture-owner"),
        Effect.succeed({ held: [] }),
        Effect.succeed({ held: [] }),
      );
      const request = {
        organizationId: fixture.organizationId,
        requestId: `standing-${fixture.intentId}`,
        projectId: fixture.projectId,
        sourceId: OrganizationIntakeSourceId.make(fixture.sourceId),
        bindingId: fixture.bindingId,
        selection: selected(fixture.workflowId),
        maxActivations: 2,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
      yield* sql`UPDATE organization_intake_sources SET kind = 'manual'
      WHERE source_id = ${fixture.sourceId}`;
      assert.equal(
        (yield* createOrganizationStandingWorkAuthorization(request, actor).pipe(Effect.flip)).code,
        "forbidden",
      );
      yield* sql`UPDATE organization_intake_sources SET kind = 'generic-http'
      WHERE source_id = ${fixture.sourceId}`;
      yield* sql`UPDATE organization_provider_budget_limits SET max_daily_calls = 0
      WHERE scope_kind = 'global' AND scope_id = '*'`;
      assert.equal(
        (yield* createOrganizationStandingWorkAuthorization(request, actor).pipe(Effect.flip)).code,
        "unavailable",
      );
      yield* sql`UPDATE organization_provider_budget_limits SET max_daily_calls = 2
      WHERE scope_kind = 'global' AND scope_id = '*'`;
      assert.equal(
        (yield* createOrganizationStandingWorkAuthorization(
          { ...request, expiresAt: request.expiresAt.replace("Z", "+00:00") },
          actor,
        ).pipe(Effect.flip)).code,
        "invalid",
      );
      const grant = yield* createOrganizationStandingWorkAuthorization(request, actor);
      assert.equal(grant.usedActivations, 0);
      gate.revoke("broker_owner_unavailable");
      assert.deepStrictEqual(
        yield* createOrganizationStandingWorkAuthorization(request, actor),
        grant,
      );
      assert.equal(
        (yield* createOrganizationStandingWorkAuthorization(
          { ...request, requestId: `${request.requestId}-new` },
          actor,
        ).pipe(Effect.flip)).code,
        "unavailable",
      );
      const conflict = yield* createOrganizationStandingWorkAuthorization(
        { ...request, maxActivations: 1 },
        actor,
      ).pipe(Effect.flip);
      assert.equal(conflict.code, "conflict");
      yield* gate.initialize(
        Effect.succeed("fixture-owner-restored"),
        Effect.succeed({ held: [] }),
        Effect.succeed({ held: [] }),
      );
      const sourceB = `${fixture.sourceId}-b`;
      const sourceC = `${fixture.sourceId}-c`;
      for (const sourceId of [sourceB, sourceC])
        yield* sql`INSERT INTO organization_intake_sources
          (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
            credential_version, created_at, updated_at)
          VALUES (${sourceId}, ${fixture.organizationId}, ${fixture.projectId}, 'manual',
            ${sourceId}, 'human', 1, 1, '2026-01-01', '2026-01-01')`;
      const observation = (id: string, sourceId: string, correlationKey: string) =>
        sql`INSERT INTO organization_intake_observations
          (observation_id, organization_id, source_id, project_id, external_event_id,
            dedup_key, occurred_at, received_at, title, body, attributes_json)
          VALUES (${id}, ${fixture.organizationId}, ${sourceId}, ${fixture.projectId},
            ${id}, ${id}, '2026-01-02', '2026-01-02', 'Bug', 'Fix it',
            ${JSON.stringify({ correlationKey })})`;
      const correlator = yield* OrganizationFindingCorrelator;
      const correlate = (correlationKey: string) =>
        correlator.correlate(
          { organizationId: fixture.organizationId, projectId: fixture.projectId, correlationKey },
          { subject: "correlator" },
        );
      const savedEvidence = (findingId: string) =>
        sql<{ evidence_json: string }>`SELECT evidence_json FROM organization_intake_findings
          WHERE finding_id = ${findingId}`;
      const saveIntent = (
        findingId: string,
        evidence: string,
        proposalId: string,
        intentId: string,
      ) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO organization_work_proposals
            (proposal_id, organization_id, finding_id, project_id, binding_id, binding_version,
              published_revision, evidence_json, title, summary, state, version, created_at,
              updated_at)
            VALUES (${proposalId}, ${fixture.organizationId}, ${findingId},
              ${fixture.projectId}, ${fixture.bindingId}, ${fixture.bindingVersion},
              ${fixture.publishedRevision}, ${evidence}, 'Bug', 'Fix it',
              'proposed', 1, '2026-01-03', '2026-01-03')`;
          yield* sql`INSERT INTO organization_work_intents
            (intent_id, organization_id, proposal_id, proposal_version, finding_id, project_id,
              binding_id, binding_version, published_revision, evidence_json, requested_by,
              status, created_at)
            VALUES (${intentId}, ${fixture.organizationId}, ${proposalId}, 1,
              ${findingId}, ${fixture.projectId}, ${fixture.bindingId},
              ${fixture.bindingVersion}, ${fixture.publishedRevision}, ${evidence},
              'human', 'awaiting-activation', '2026-01-03')`;
        });
      const absentKey = `${fixture.intentId}-absent`;
      yield* observation(`${fixture.observationId}-b-absent`, sourceB, absentKey);
      yield* observation(`${fixture.observationId}-c-absent`, sourceC, absentKey);
      const absent = yield* correlate(absentKey);
      assert.equal(absent.outcome, "created");
      assert.equal(absent.finding?.evidence.length, 2);
      const absentFindingId = absent.finding!.id;
      const absentEvidence = (yield* savedEvidence(absentFindingId))[0]!.evidence_json;
      const absentIntentId = `${fixture.intentId}-absent`;
      yield* saveIntent(
        absentFindingId,
        absentEvidence,
        `${fixture.proposalId}-absent`,
        absentIntentId,
      );
      assert.equal((yield* reconcileOrganizationStandingWorkAuthorizationsOnce).examined, 0);
      assert.equal(
        (yield* activateOrganizationWorkIntentFromStandingAuthorization(
          {
            organizationId: fixture.organizationId,
            intentId: absentIntentId,
            selection: request.selection,
          },
          grant.id,
        ).pipe(Effect.flip)).code,
        "conflict",
      );
      const firstKey = `${fixture.intentId}-present-1`;
      yield* sql`UPDATE organization_intake_observations
        SET attributes_json = ${JSON.stringify({ correlationKey: firstKey })}
        WHERE observation_id = ${fixture.observationId}`;
      yield* observation(`${fixture.observationId}-b-1`, sourceB, firstKey);
      const firstFinding = yield* correlate(firstKey);
      assert.equal(firstFinding.outcome, "created");
      assert.equal(firstFinding.finding?.evidence.length, 2);
      const firstFindingId = firstFinding.finding!.id;
      const firstEvidence = (yield* savedEvidence(firstFindingId))[0]!.evidence_json;
      yield* saveIntent(firstFindingId, firstEvidence, fixture.proposalId, fixture.intentId);
      const pass = yield* reconcileOrganizationStandingWorkAuthorizationsOnce;
      assert.deepStrictEqual(pass, { examined: 1, activated: 1, skipped: 0 });
      const activated = (yield* sql<{ work_id: string; activated_by: string }>`
      SELECT work_id, activated_by FROM organization_work_intent_activations
      WHERE intent_id = ${fixture.intentId}`)[0];
      assert.ok(activated);
      assert.match(activated.activated_by, /^system:organization-standing:/);
      assert.equal(
        (yield* activateOrganizationWorkIntentFromStandingAuthorization(
          {
            organizationId: fixture.organizationId,
            intentId: fixture.intentId,
            selection: request.selection,
          },
          "another-standing-grant",
        ).pipe(Effect.flip)).code,
        "conflict",
      );
      assert.deepStrictEqual(
        (yield* (yield* OrganizationWorkIntentStore).list(fixture.organizationId)).map(
          (intent) => intent.id,
        ),
        [absentIntentId],
      );
      const usage = (yield* sql<{ used_activations: number }>`
      SELECT used_activations FROM organization_standing_work_authorizations
      WHERE authorization_id = ${grant.id}`)[0];
      assert.equal(usage?.used_activations, 1);
      assert.equal((yield* reconcileOrganizationStandingWorkAuthorizationsOnce).activated, 0);
      const secondKey = `${fixture.intentId}-present-2`;
      yield* observation(`${fixture.observationId}-a-2`, fixture.sourceId, secondKey);
      yield* observation(`${fixture.observationId}-b-2`, sourceB, secondKey);
      const secondFinding = yield* correlate(secondKey);
      assert.equal(secondFinding.outcome, "created");
      const secondFindingId = secondFinding.finding!.id;
      const secondEvidence = (yield* savedEvidence(secondFindingId))[0]!.evidence_json;
      const secondProposalId = `${fixture.proposalId}-second`;
      const secondIntentId = `${fixture.intentId}-second`;
      yield* saveIntent(secondFindingId, secondEvidence, secondProposalId, secondIntentId);
      assert.equal((yield* reconcileOrganizationStandingWorkAuthorizationsOnce).activated, 1);
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count
          FROM organization_standing_work_activation_uses
          WHERE authorization_id = ${grant.id}`)[0]?.count,
        2,
      );
      const renewed = yield* createOrganizationStandingWorkAuthorization(
        { ...request, requestId: `${request.requestId}-renewed` },
        actor,
      );
      assert.notEqual(renewed.id, grant.id);
      assert.equal(renewed.usedActivations, 0);
      const retired = (yield* sql<{
        revoked_at: string | null;
        revocation_reason: string | null;
      }>`SELECT revoked_at, revocation_reason
        FROM organization_standing_work_authorizations
        WHERE authorization_id = ${grant.id}`)[0];
      assert.ok(retired?.revoked_at);
      assert.equal(retired.revocation_reason, "exhausted");
      const scheduledKey = `${fixture.intentId}-reconciled`;
      yield* observation(`${fixture.observationId}-a-reconciled`, fixture.sourceId, scheduledKey);
      yield* observation(`${fixture.observationId}-b-reconciled`, sourceB, scheduledKey);
      const scheduledFinding = yield* correlate(scheduledKey);
      assert.equal(scheduledFinding.outcome, "created");
      const proposals = yield* (yield* OrganizationProposalStore).reconcileOnce();
      assert.equal(proposals.proposed, 1);
      const intents = yield* (yield* OrganizationWorkIntentStore).reconcileOnce();
      assert.equal(intents.created, 1);
      const reconciledIntent = (yield* sql<{ intent_id: string }>`
        SELECT intent_id FROM organization_work_intents
        WHERE finding_id = ${scheduledFinding.finding!.id}`)[0];
      assert.ok(reconciledIntent);
      assert.equal((yield* reconcileOrganizationStandingWorkAuthorizationsOnce).activated, 1);
      const reconciledActivation = (yield* sql<{ activated_by: string }>`
        SELECT activated_by FROM organization_work_intent_activations
        WHERE intent_id = ${reconciledIntent.intent_id}`)[0];
      assert.match(reconciledActivation?.activated_by ?? "", /^system:organization-standing:/);
      assert.equal((yield* (yield* OrganizationProposalStore).reconcileOnce()).proposed, 0);
      assert.equal((yield* (yield* OrganizationWorkIntentStore).reconcileOnce()).created, 0);
      assert.equal((yield* reconcileOrganizationStandingWorkAuthorizationsOnce).activated, 0);
      const revoked = yield* revokeOrganizationStandingWorkAuthorization(
        {
          organizationId: fixture.organizationId,
          authorizationId: renewed.id,
        },
        actor,
      );
      assert.ok(revoked.revokedAt);
      assert.equal(revoked.revocationReason, "manual");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("requires the recovered runtime gate for a full human-selected activation", () => {
  const gate = makeOrganizationLiveWorkReadinessGate();
  const layer = Layer.mergeAll(
    OrganizationStoreLive,
    OrganizationWorkIntentStoreLive,
    Layer.succeed(OrganizationGitTargetPreflight, { verify: () => Effect.void }),
    gate.activationReadinessLayer,
    Layer.succeed(GitVcsDriver.GitVcsDriver, {
      resolveCommit: () => Effect.succeed({ commitSha: COMMIT }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
  return Effect.gen(function* () {
    const fixture = yield* seed();
    const input = {
      organizationId: fixture.organizationId,
      intentId: fixture.intentId,
      selection: selected(fixture.workflowId),
    };
    const denied = yield* Effect.flip(activateOrganizationWorkIntent(input, actor));
    assert.equal(denied.code, "unavailable");
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* sql<{ count: number }>`SELECT count(*) AS count FROM organization_work_items`)[0]
        ?.count,
      0,
    );
    const status = yield* gate.initialize(
      Effect.succeed("fixture-owner-epoch"),
      Effect.succeed({ held: [] }),
      Effect.succeed({ held: [] }),
    );
    assert.equal(status.ready, true);
    const activated = yield* activateOrganizationWorkIntent(input, actor);
    assert.deepStrictEqual(activated.selection, input.selection);
    assert.deepStrictEqual(
      yield* readOrganizationWorkIntentActivationByWorkId(activated.workId),
      activated,
    );
    assert.equal(
      (yield* sql<{ count: number }>`SELECT count(*) AS count FROM organization_work_items`)[0]
        ?.count,
      1,
    );
  }).pipe(Effect.provide(layer));
});
let serial = 0;
let selectedBranchCommit = COMMIT;
const testLayer = it.layer(
  Layer.mergeAll(
    OrganizationStoreLive,
    OrganizationWorkIntentStoreLive,
    Layer.succeed(OrganizationGitTargetPreflight, { verify: () => Effect.void }),
    Layer.succeed(OrganizationWorkIntentActivationReadiness, { permits: () => true }),
    Layer.succeed(GitVcsDriver.GitVcsDriver, {
      resolveCommit: ({ revision }: { readonly revision: string }) =>
        Effect.succeed({ commitSha: revision === "HEAD" ? COMMIT : selectedBranchCommit }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const seed = (withIntent = true) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const tag = `activation-${++serial}`;
    const organizationId = OrganizationId.make(`${tag}-org`);
    const projectId = ProjectId.make(`${tag}-project`);
    const bindingId = OrganizationBindingId.make(`${tag}-binding`);
    const workflowId = OrganizationWorkflowId.make(`${tag}-workflow`);
    const sourceId = `${tag}-source`;
    const observationId = `${tag}-observation`;
    const findingId = `${tag}-finding`;
    const proposalId = `${tag}-proposal`;
    const intentId = `${tag}-intent`;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, ${tag}, ${`/tmp/${tag}`}, '[]', '2026-01-01', '2026-01-01')`;
    const organizations = yield* OrganizationStore;
    let org = yield* organizations.create({
      organizationId,
      mutationId: `${tag}-create`,
      title: tag,
      mission: "Repair one Project file",
      actor: "user",
    });
    org = yield* organizations.bindProject({
      organizationId,
      mutationId: `${tag}-bind`,
      baseRevision: org.draftRevision,
      actor: "user",
      bindingId,
      projectId,
      access: "write",
      capabilities: ["propose-work", "read-files", "write-files", "run-tests"],
      scope: null,
    });
    const bindingVersion = org.bindings.find((binding) => binding.id === bindingId)!.updatedAt;
    const worker = OrganizationRoleId.make(`${tag}-worker`);
    const qa = OrganizationRoleId.make(`${tag}-qa`);
    for (const [roleId, kind] of [
      [worker, "engineering"],
      [qa, "qa"],
    ] as const) {
      org = yield* organizations.mutate({
        organizationId,
        mutationId: `${tag}-${kind}`,
        baseRevision: org.draftRevision,
        actor: "user",
        change: {
          type: "add-role",
          role: {
            id: roleId,
            kind,
            title: kind,
            mandate: kind,
            poolSize: 1,
          },
        },
      });
    }
    org = yield* organizations.mutate({
      organizationId,
      mutationId: `${tag}-workflow`,
      baseRevision: org.draftRevision,
      actor: "user",
      change: {
        type: "upsert-workflow",
        workflow: {
          id: workflowId,
          title: "Reviewed change",
          version: 1,
          steps: [
            {
              id: step("trigger"),
              kind: "trigger",
              title: "Start",
              roleId: null,
              reviewsStepId: null,
            },
            { id: step("work"), kind: "work", title: "Build", roleId: worker, reviewsStepId: null },
            { id: step("qa"), kind: "qa", title: "Test", roleId: qa, reviewsStepId: step("work") },
            {
              id: step("approval"),
              kind: "approval",
              title: "Approve",
              roleId: org.directorRoleId,
              reviewsStepId: step("work"),
            },
            {
              id: step("integrate"),
              kind: "integrate",
              title: "Integrate",
              roleId: worker,
              reviewsStepId: null,
            },
            {
              id: step("finish"),
              kind: "finish",
              title: "Done",
              roleId: null,
              reviewsStepId: null,
            },
          ],
          transitions: [
            transition("t1", "trigger", "work"),
            transition("t2", "work", "qa"),
            transition("t3", "qa", "approval"),
            transition("t4", "approval", "integrate"),
            transition("t5", "integrate", "finish"),
          ],
        },
      },
    });
    org = yield* organizations.publish({
      organizationId,
      mutationId: `${tag}-publish`,
      baseRevision: org.draftRevision,
      actor: "user",
    });
    const evidence = JSON.stringify([{ observationId, sourceId, projectId }]);
    yield* sql`INSERT INTO organization_intake_sources
    (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
      credential_version, created_at, updated_at)
    VALUES (${sourceId}, ${organizationId}, ${projectId}, 'generic-http', ${tag}, 'human', 1,
      1, '2026-01-01', '2026-01-01')`;
    yield* sql`INSERT INTO organization_intake_observations
    (observation_id, organization_id, source_id, project_id, external_event_id,
      dedup_key, occurred_at, received_at, title, body, attributes_json)
    VALUES (${observationId}, ${organizationId}, ${sourceId}, ${projectId}, ${observationId},
      ${observationId}, '2026-01-02', '2026-01-02', 'Bug', 'Fix it', '{}')`;
    if (withIntent) {
      yield* sql`INSERT INTO organization_intake_findings
    (finding_id, organization_id, source_id, dedup_key, title, summary,
      observation_ids_json, state, created_at, project_id, evidence_json)
    VALUES (${findingId}, ${organizationId}, ${sourceId}, ${findingId}, 'Bug', 'Fix it',
      ${JSON.stringify([observationId])}, 'tentative', '2026-01-02', ${projectId}, ${evidence})`;
    }
    yield* sql`INSERT INTO organization_proposal_settings
    (organization_id, observation_mode_enabled, enabled_at, version, updated_by, updated_at)
    VALUES (${organizationId}, 1, '1970-01-01T00:00:00.000Z', 1, 'human', '2026-01-01')`;
    if (withIntent) {
      yield* sql`INSERT INTO organization_work_proposals
    (proposal_id, organization_id, finding_id, project_id, binding_id, binding_version,
      published_revision, evidence_json, title, summary, state, version, created_at, updated_at)
    VALUES (${proposalId}, ${organizationId}, ${findingId}, ${projectId}, ${bindingId},
      ${bindingVersion}, ${org.publishedRevision}, ${evidence}, 'Bug', 'Fix it',
      'proposed', 1, '2026-01-02', '2026-01-02')`;
      yield* sql`INSERT INTO organization_work_intents
    (intent_id, organization_id, proposal_id, proposal_version, finding_id, project_id,
      binding_id, binding_version, published_revision, evidence_json, requested_by,
      status, created_at)
    VALUES (${intentId}, ${organizationId}, ${proposalId}, 1, ${findingId}, ${projectId},
      ${bindingId}, ${bindingVersion}, ${org.publishedRevision}, ${evidence}, 'human',
      'awaiting-activation', '2026-01-02')`;
    }
    return {
      organizationId,
      projectId,
      bindingId,
      workflowId,
      intentId,
      proposalId,
      bindingVersion,
      publishedRevision: org.publishedRevision,
      sourceId,
      observationId,
      findingId,
    };
  });

const selected = (workflowId: OrganizationWorkflowId) => ({
  workflowId,
  targetRef: "refs/heads/main",
  fileName: "answer.mjs",
  taskText: "Make solve return twice the input value.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  qaPlan: {
    version: 1 as const,
    exportName: "solve",
    cases: [
      { input: { value: 2 }, expected: 4 },
      { input: { value: 5 }, expected: 10 },
    ],
  },
});
const actor = { subject: "human-reviewer", interactive: true } as const;

testLayer("Organization work intent activation", (it) => {
  it.effect("activates one intent atomically and replays its immutable selection", () =>
    Effect.gen(function* () {
      selectedBranchCommit = COMMIT;
      const fixture = yield* seed();
      const input = {
        organizationId: fixture.organizationId,
        intentId: fixture.intentId,
        selection: selected(fixture.workflowId),
      };
      const first = yield* activateOrganizationWorkIntent(input, actor);
      assert.equal(first.selection.targetRef, "refs/heads/main");
      assert.equal(first.selection.qaPlan.cases[0]?.expected, 4);
      assert.deepStrictEqual(
        yield* readOrganizationWorkIntentActivationByWorkId(first.workId),
        first,
      );
      const replay = yield* activateOrganizationWorkIntent(input, actor);
      assert.deepStrictEqual(replay, first);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM organization_work_items
        WHERE organization_id = ${fixture.organizationId}`;
      assert.equal(rows[0]?.count, 1);
      const org = yield* (yield* OrganizationStore).get({ organizationId: fixture.organizationId });
      assert.equal(org.lifecycle, "active");
      const changed = yield* Effect.flip(
        activateOrganizationWorkIntent(
          {
            ...input,
            selection: { ...input.selection, taskText: "Another task" },
          },
          actor,
        ),
      );
      assert.equal(changed.code, "conflict");
    }),
  );

  it.effect("requires an interactive actor and explicit runtime readiness", () =>
    Effect.gen(function* () {
      const fixture = yield* seed();
      const input = {
        organizationId: fixture.organizationId,
        intentId: fixture.intentId,
        selection: selected(fixture.workflowId),
      };
      assert.equal(
        (yield* Effect.flip(
          activateOrganizationWorkIntent(input, { subject: "service", interactive: false }),
        )).code,
        "forbidden",
      );
      const disabled = yield* Effect.flip(
        activateOrganizationWorkIntent(input, actor).pipe(
          Effect.provideService(OrganizationWorkIntentActivationReadiness, {
            permits: () => false,
          }),
        ),
      );
      assert.equal(disabled.code, "unavailable");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM organization_work_items
        WHERE organization_id = ${fixture.organizationId}`)[0]?.count,
        0,
      );
    }),
  );

  it.effect("keeps the Organization draft when evidence is revoked or target branch moved", () =>
    Effect.gen(function* () {
      selectedBranchCommit = COMMIT;
      const fixture = yield* seed();
      const input = {
        organizationId: fixture.organizationId,
        intentId: fixture.intentId,
        selection: selected(fixture.workflowId),
      };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organization_intake_sources SET enabled = 0 WHERE source_id = ${fixture.sourceId}`;
      assert.equal(
        (yield* Effect.flip(activateOrganizationWorkIntent(input, actor))).code,
        "conflict",
      );
      yield* sql`UPDATE organization_intake_sources SET enabled = 1 WHERE source_id = ${fixture.sourceId}`;
      selectedBranchCommit = OTHER_COMMIT;
      assert.equal(
        (yield* Effect.flip(activateOrganizationWorkIntent(input, actor))).code,
        "conflict",
      );
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM organization_work_items
        WHERE organization_id = ${fixture.organizationId}`)[0]?.count,
        0,
      );
      assert.equal(
        (yield* (yield* OrganizationStore).get({ organizationId: fixture.organizationId }))
          .lifecycle,
        "draft",
      );
      selectedBranchCommit = COMMIT;
    }),
  );

  it.effect("rolls lifecycle activation back when WorkStore rejects the intent", () =>
    Effect.gen(function* () {
      selectedBranchCommit = COMMIT;
      const fixture = yield* seed();
      const sql = yield* SqlClient.SqlClient;
      // Intent freshness still sees the saved provenance; WorkStore's stronger
      // observation-ID check rejects creation after lifecycle activation.
      yield* sql`UPDATE organization_intake_findings SET observation_ids_json = '[]'
        WHERE finding_id = ${fixture.findingId}`;
      const error = yield* Effect.flip(
        activateOrganizationWorkIntent(
          {
            organizationId: fixture.organizationId,
            intentId: fixture.intentId,
            selection: selected(fixture.workflowId),
          },
          actor,
        ),
      );
      assert.equal(error.code, "invalid");
      assert.equal(
        (yield* (yield* OrganizationStore).get({ organizationId: fixture.organizationId }))
          .lifecycle,
        "draft",
      );
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM organization_work_items
        WHERE organization_id = ${fixture.organizationId}`)[0]?.count,
        0,
      );
    }),
  );
});
