// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Disposable Git, broker, and SQLite fixture.
import { assert, it } from "@effect/vitest";
import {
  OrganizationBindingId,
  OrganizationId,
  OrganizationRoleId,
  OrganizationWorkflowId,
  OrganizationWorkflowStepId,
  OrganizationWorkflowTransitionId,
  OrganizationWorkId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeOrganizationLiveWorkReadinessGate } from "./OrganizationLiveWorkReadinessGate.ts";
import { organizationSingleFileApprovalProjectRootDigest } from "./OrganizationSingleFileApprovalRevision.ts";
import {
  coordinateOrganizationGitIntegration,
  OrganizationGitIntegrationAuthority,
} from "./OrganizationGitIntegrationCoordinator.ts";
import { decideOrganizationWorkApprovalForSession } from "./OrganizationWorkApprovalRpc.ts";
import {
  makeOrganizationLiveWorkExecutor,
  makeOrganizationLiveWorkSource,
} from "./OrganizationLiveWorkExecutor.ts";
import {
  makeOrganizationLiveWorkScopedActions,
  makeOrganizationLiveWorkScopedRuntimeLayer,
} from "./OrganizationLiveWorkProductionComposition.ts";
import {
  serveOrganizationScopeLaunchBroker,
  organizationScopeLaunchBrokerClient,
} from "./OrganizationScopeLaunchBroker.ts";
import { isOrganizationScopedSandboxAvailable } from "./OrganizationScopedSandboxHost.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import { OrganizationWorkStore } from "./OrganizationWorkStore.ts";
import { OrganizationWorkStoreReadOnlyLive } from "./OrganizationWorkRuntimeLayers.ts";

const orgId = OrganizationId.make("live-fixture-org");
const projectId = ProjectId.make("live-fixture-project");
const bindingId = OrganizationBindingId.make("live-fixture-binding");
const workflowId = OrganizationWorkflowId.make("live-fixture-workflow");
const workId = OrganizationWorkId.make("live-fixture-work");
const sourceId = "live-fixture-source";
const findingId = "live-fixture-finding";
const proposalId = "live-fixture-proposal";
const intentId = "live-fixture-intent";
const stamp = "2026-01-01T00:00:00.000Z";
const step = OrganizationWorkflowStepId.make;
const transition = (id: string, from: string, to: string) => ({
  id: OrganizationWorkflowTransitionId.make(id),
  fromStepId: step(from),
  toStepId: step(to),
  maxTraversals: null,
});
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  }).trim();

const seed = (root: string, commit: string) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Fixture', ${root}, '[]', ${stamp}, ${stamp})`;
    const orgs = yield* OrganizationStore;
    let org = yield* orgs.create({
      organizationId: orgId,
      mutationId: "live-fixture-create",
      title: "Live fixture",
      mission: "Repair one Project file",
      actor: "user",
    });
    org = yield* orgs.bindProject({
      organizationId: orgId,
      mutationId: "live-fixture-bind",
      baseRevision: org.draftRevision,
      actor: "user",
      bindingId,
      projectId,
      access: "write",
      capabilities: ["propose-work", "read-files", "write-files", "run-tests"],
      scope: null,
    });
    const bindingVersion = org.bindings.find((binding) => binding.id === bindingId)!.updatedAt;
    const worker = OrganizationRoleId.make("live-fixture-worker");
    const reviewer = OrganizationRoleId.make("live-fixture-qa");
    for (const [roleId, kind] of [
      [worker, "engineering"],
      [reviewer, "qa"],
    ] as const)
      org = yield* orgs.mutate({
        organizationId: orgId,
        mutationId: `live-fixture-${kind}`,
        baseRevision: org.draftRevision,
        actor: "user",
        change: {
          type: "add-role",
          role: { id: roleId, kind, title: kind, mandate: kind, poolSize: 1 },
        },
      });
    org = yield* orgs.mutate({
      organizationId: orgId,
      mutationId: "live-fixture-workflow",
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
            {
              id: step("qa"),
              kind: "qa",
              title: "Check",
              roleId: reviewer,
              reviewsStepId: step("work"),
            },
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
              title: "Land",
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
    org = yield* orgs.publish({
      organizationId: orgId,
      mutationId: "live-fixture-publish",
      baseRevision: org.draftRevision,
      actor: "user",
    });
    yield* sql`UPDATE organizations SET lifecycle = 'active' WHERE organization_id = ${orgId}`;
    yield* sql`INSERT INTO organization_intake_sources
      (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
       credential_version, created_at, updated_at)
      VALUES (${sourceId}, ${orgId}, ${projectId}, 'manual', 'Fixture', 'human', 1, 1,
        ${stamp}, ${stamp})`;
    yield* sql`INSERT INTO organization_intake_findings
      (finding_id, organization_id, source_id, dedup_key, title, summary,
       observation_ids_json, state, created_at, project_id, evidence_json)
      VALUES (${findingId}, ${orgId}, ${sourceId}, ${findingId}, 'Incorrect answer',
        'Double the value', '[]', 'tentative', ${stamp}, ${projectId}, '[]')`;
    yield* sql`INSERT INTO organization_work_proposals
      (proposal_id, organization_id, finding_id, project_id, binding_id,
       binding_version, published_revision, evidence_json, title, summary,
       state, version, created_at, updated_at)
      VALUES (${proposalId}, ${orgId}, ${findingId}, ${projectId}, ${bindingId},
        ${bindingVersion}, ${org.publishedRevision}, '[]', 'Fixture', 'Fixture',
        'proposed', 1, ${stamp}, ${stamp})`;
    yield* sql`INSERT INTO organization_work_intents
      (intent_id, organization_id, proposal_id, proposal_version, finding_id,
       project_id, binding_id, binding_version, published_revision, evidence_json,
       requested_by, created_at)
      VALUES (${intentId}, ${orgId}, ${proposalId}, 1, ${findingId}, ${projectId},
        ${bindingId}, ${bindingVersion}, ${org.publishedRevision}, '[]', 'human', ${stamp})`;
    yield* sql`INSERT INTO organization_work_items
      (work_id, request_id, request_json, organization_id, finding_id, project_id,
       binding_id, binding_version, scope, published_revision, workflow_id,
       workflow_version, code_revision, status, attempt_limit, attempt_count,
       creator_subject, created_at, updated_at)
      VALUES (${workId}, 'live-fixture-request', '{}', ${orgId}, ${findingId}, ${projectId},
        ${bindingId}, ${bindingVersion}, NULL, ${org.publishedRevision}, ${workflowId}, 1,
        ${commit}, 'pending', 1, 0, 'fixture-human', ${stamp}, ${stamp})`;
    const selection = {
      workflowId,
      targetRef: "refs/heads/organization-work",
      fileName: "answer.mjs",
      taskText: "Make solve return double the input value.",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "fixture-model" },
      qaPlan: { version: 1, exportName: "solve", cases: [{ input: { value: 2 }, expected: 4 }] },
    };
    yield* sql`INSERT INTO organization_work_intent_activations
      (intent_id, organization_id, work_id, selection_json, activated_by, activated_at)
      VALUES (${intentId}, ${orgId}, ${workId}, ${JSON.stringify(selection)},
        'fixture-human', ${stamp})`;
    yield* sql`UPDATE organization_provider_budget_limits
      SET max_concurrent = 1, max_daily_calls = 1, max_daily_estimated_tokens = 140000
      WHERE scope_kind = 'global' AND scope_id = '*'`;
    for (const [kind, id] of [
      ["organization", orgId],
      ["project", projectId],
    ] as const)
      yield* sql`INSERT INTO organization_provider_budget_limits
        (scope_kind, scope_id, max_concurrent, max_daily_calls,
         max_daily_estimated_tokens, updated_at)
        VALUES (${kind}, ${id}, 1, 1, 140000, ${stamp})`;
  });

const available = isOrganizationScopedSandboxAvailable();

it.effect.skipIf(!available)(
  "runs activated Project work through a real broker and completes after a Git CAS crash",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-live-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const root = NodePath.join(directory, "project");
        const brokerDir = NodePath.join(directory, "broker");
        const database = NodePath.join(directory, "live.sqlite");
        yield* Effect.promise(() => NodeFSP.mkdir(root));
        git(root, "init", "-q");
        git(root, "symbolic-ref", "HEAD", "refs/heads/main");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "answer.mjs"),
            "export function solve(input) { return input.value; }\n",
          ),
        );
        git(root, "add", "--", "answer.mjs");
        git(
          root,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-qm",
          "base",
        );
        const commit = git(root, "rev-parse", "HEAD");
        git(root, "update-ref", "refs/heads/organization-work", commit);
        const broker = yield* Effect.acquireRelease(
          Effect.promise(() => serveOrganizationScopeLaunchBroker(brokerDir)),
          (owned) => Effect.promise(() => owned.close()),
        );
        assert.ok(broker);
        yield* Effect.promise(() => organizationScopeLaunchBrokerClient(brokerDir).activate());
        const gate = makeOrganizationLiveWorkReadinessGate();
        yield* gate.initialize(
          Effect.succeed("fixture-owner"),
          Effect.succeed({ held: [] }),
          Effect.succeed({ held: [] }),
        );
        let providerCalls = 0;
        const text = TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => Effect.die("unused"),
          generateOrganizationPatchProposal: (input) => {
            providerCalls++;
            return Effect.succeed({
              fileName: input.fileName,
              baseDigest: input.baseDigest,
              replacementContent: "export function solve(input) { return input.value * 2; }\n",
              rationale: "Fixture proposal",
            });
          },
        });
        const runtime = () =>
          Layer.mergeAll(
            OrganizationStoreLive,
            OrganizationWorkStoreReadOnlyLive,
            Layer.succeed(TextGeneration, text),
            Layer.succeed(GitVcsDriver.GitVcsDriver, {
              resolveCommit: ({
                cwd,
                revision,
              }: {
                readonly cwd: string;
                readonly revision: string;
              }) => Effect.sync(() => ({ commitSha: git(cwd, "rev-parse", revision) })),
            } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
            gate.runtimeReadinessLayer,
            gate.activationReadinessLayer,
          ).pipe(
            Layer.provideMerge(NodeSqliteClient.layer({ filename: database, readonly: false })),
          );
        let appliedCommit: string | null = null;
        yield* Effect.gen(function* () {
          yield* seed(root, commit);
          const source = yield* makeOrganizationLiveWorkSource;
          const actions = makeOrganizationLiveWorkScopedActions(brokerDir);
          const first = makeOrganizationLiveWorkExecutor(source, actions);
          const attempted = yield* first.runOnce();
          assert.equal(attempted[0]?.phase, "attempt");
          assert.equal(attempted[0]?.outcome, "completed");
          assert.equal(providerCalls, 1);
          const detail = yield* (yield* OrganizationWorkStore).getWork(workId);
          assert.equal(detail.work.status, "blocked");
          assert.equal(detail.attempts.at(-1)?.status, "submitted");
        }).pipe(Effect.provide(runtime()));
        yield* Effect.gen(function* () {
          const source = yield* makeOrganizationLiveWorkSource;
          const actions = makeOrganizationLiveWorkScopedActions(brokerDir);
          const restarted = makeOrganizationLiveWorkExecutor(source, actions);
          const reviewed = yield* restarted.runOnce();
          assert.equal(reviewed[0]?.phase, "qa");
          assert.equal(reviewed[0]?.outcome, "completed");
          const waiting = yield* (yield* OrganizationWorkStore).getWork(workId);
          assert.equal(waiting.work.status, "waiting-approval");
          assert.equal(waiting.attempts.at(-1)?.status, "qa-accepted");
          assert.equal(providerCalls, 1);
          assert.equal(git(root, "rev-parse", "HEAD"), commit);
          const attemptId = waiting.attempts.at(-1)?.id;
          assert.ok(attemptId);
          const sql = yield* SqlClient.SqlClient;
          const evidence = (yield* sql<{
            artifact_digest: string;
            qa_receipt_digest: string;
          }>`SELECT a.artifact_digest, q.receipt_digest AS qa_receipt_digest
            FROM organization_work_attempts a
            JOIN organization_work_qa_receipts q ON q.attempt_id = a.attempt_id
            WHERE a.attempt_id = ${attemptId}`)[0];
          assert.ok(evidence);
          yield* decideOrganizationWorkApprovalForSession(
            { method: "browser-session-cookie", subject: "fixture-human" },
            {
              organizationId: orgId,
              workId,
              attemptId,
              requestId: "fixture-human-approval",
              approved: true,
              reason: "Reviewed the independent QA result",
              artifactDigest: evidence.artifact_digest,
              qaReceiptDigest: evidence.qa_receipt_digest,
              baseCodeRevision: commit,
              bindingVersion: waiting.work.bindingVersion,
              projectRootDigest: organizationSingleFileApprovalProjectRootDigest(root),
            },
          );
          // Simulate a process crash after the atomic Git ref update, before
          // completion records success. The next scope opens a new SQLite client.
          const request = {
            attemptId,
            targetRef: "refs/heads/organization-work",
            integratorSubject: `system:organization-integrator:${workId}`,
          };
          const scoped = yield* makeOrganizationLiveWorkScopedRuntimeLayer(workId, brokerDir);
          const applied = yield* coordinateOrganizationGitIntegration(request).pipe(
            Effect.provideService(OrganizationGitIntegrationAuthority, {
              permitsAttempt: (input) =>
                input.attemptId === request.attemptId &&
                input.targetRef === request.targetRef &&
                input.integratorSubject === request.integratorSubject,
              permits: (input, context) =>
                input.attemptId === request.attemptId &&
                input.targetRef === request.targetRef &&
                input.integratorSubject === request.integratorSubject &&
                context.workId === workId &&
                context.organizationId === orgId &&
                context.projectId === projectId &&
                context.bindingId === bindingId &&
                context.approvalSubject === "fixture-human" &&
                context.baseCommit === commit,
            }),
            Effect.provide(scoped),
          );
          assert.equal(applied.appliedNow, true);
          appliedCommit = applied.resultCommit;
          assert.equal(git(root, "rev-parse", request.targetRef), appliedCommit);
          assert.equal(
            (yield* (yield* OrganizationWorkStore).getWork(workId)).work.status,
            "blocked",
          );
        }).pipe(Effect.provide(runtime()));
        yield* Effect.gen(function* () {
          const source = yield* makeOrganizationLiveWorkSource;
          const actions = makeOrganizationLiveWorkScopedActions(brokerDir);
          const restarted = makeOrganizationLiveWorkExecutor(source, actions);
          const integrated = yield* restarted.runOnce();
          assert.equal(integrated[0]?.phase, "integration");
          assert.equal(integrated[0]?.outcome, "completed");
          const finished = yield* (yield* OrganizationWorkStore).getWork(workId);
          assert.equal(finished.work.status, "succeeded");
          assert.equal(providerCalls, 1);
          assert.equal(git(root, "rev-parse", "HEAD"), commit);
          assert.equal(git(root, "rev-parse", "refs/heads/organization-work"), appliedCommit);
          const code = git(root, "show", "refs/heads/organization-work:answer.mjs");
          assert.match(code, /value \* 2/);
          const sql = yield* SqlClient.SqlClient;
          const receipts = yield* sql<{ count: number }>`SELECT count(*) AS count
            FROM organization_work_integration_receipts WHERE work_id = ${workId}`;
          assert.equal(receipts[0]?.count, 1);
        }).pipe(Effect.provide(runtime()));
      }),
    ),
);
