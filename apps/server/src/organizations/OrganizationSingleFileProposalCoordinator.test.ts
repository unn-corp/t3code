// @effect-diagnostics nodeBuiltinImport:off - Disposable Git fixture uses fixed argv and no repository scripts.
import { assert, it } from "@effect/vitest";
import {
  OrganizationBindingId,
  OrganizationId,
  OrganizationRoleId,
  OrganizationWorkflowId,
  OrganizationWorkflowStepId,
  OrganizationWorkflowTransitionId,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { OrganizationTentativeFindingId } from "../../../../packages/contracts/src/organizationIntake.ts";
import { OrganizationWorkId } from "../../../../packages/contracts/src/organizationWork.ts";
import type {
  OrganizationPatchProposalInput,
  OrganizationPatchProposalOutput,
} from "../../../../packages/contracts/src/organizationPatchProposal.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { decodeOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import {
  OrganizationPatchSourceReader,
  OrganizationPatchSourceReaderLive,
  readOrganizationPatchSource,
} from "./OrganizationPatchSourceReader.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import { OrganizationWorkLaunchPlannerLive } from "./OrganizationWorkLaunchPlanner.ts";
import {
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkArtifactVerifierDisabled,
  OrganizationWorkEvaluationVerifierDisabled,
  OrganizationWorkExecutionDisabled,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";
import {
  OrganizationSingleFileProposalPolicy,
  OrganizationSingleFileProposalPolicyDisabled,
  proposeOrganizationSingleFileArtifact,
} from "./OrganizationSingleFileProposalCoordinator.ts";

const organizationId = OrganizationId.make("proposal-coordinator-org");
const projectId = ProjectId.make("proposal-coordinator-project");
const bindingId = OrganizationBindingId.make("proposal-coordinator-binding");
const findingId = OrganizationTentativeFindingId.make("proposal-coordinator-finding");
const workId = OrganizationWorkId.make("proposal-coordinator-work");
const workflowId = OrganizationWorkflowId.make("proposal-coordinator-workflow");
const modelSelection = createModelSelection(ProviderInstanceId.make("claude"), "fixture-model");
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
const withRepo = <A, E, R>(use: (root: string, commit: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const directory = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "t3-org-proposal-"),
          );
          git(directory, "init", "-q");
          await NodeFSP.writeFile(
            NodePath.join(directory, "answer.mjs"),
            "export function solve(input) { return input.value; }\n",
          );
          git(directory, "add", "--", "answer.mjs");
          git(
            directory,
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
          return directory;
        }),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      return yield* use(root, git(root, "rev-parse", "HEAD"));
    }),
  );

const workLayer = OrganizationWorkStoreLayer.pipe(
  Layer.provide(OrganizationWorkExecutionDisabled),
  Layer.provide(OrganizationWorkArtifactVerifierDisabled),
  Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
  Layer.provide(OrganizationWorkApprovalVerifierDisabled),
  Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
);
type Generator = (
  input: OrganizationPatchProposalInput,
) => Effect.Effect<OrganizationPatchProposalOutput, SqlError, SqlClient.SqlClient>;
const generated = (input: OrganizationPatchProposalInput): OrganizationPatchProposalOutput => ({
  fileName: input.fileName,
  baseDigest: input.baseDigest,
  replacementContent: "export function solve(input) { return input.value * 2; }\n",
  rationale: "Bounded fixture replacement",
});
const textLayer = (generate: Generator) =>
  Layer.effect(
    TextGeneration,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        generateCommitMessage: () => Effect.die("unused"),
        generatePrContent: () => Effect.die("unused"),
        generateBranchName: () => Effect.die("unused"),
        generateThreadTitle: () => Effect.die("unused"),
        generateOrganizationPatchProposal: (input: OrganizationPatchProposalInput) =>
          generate(input).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(
              () =>
                new TextGenerationError({
                  operation: "generateOrganizationPatchProposal",
                  detail: "Fixture failed",
                }),
            ),
          ),
      };
    }),
  );
const policyLayer = (fileName = "answer.mjs") =>
  Layer.succeed(OrganizationSingleFileProposalPolicy, {
    select: (target) =>
      Effect.succeed({
        fileName,
        taskText: `Fix ${target.findingTitle}: ${target.findingSummary}`,
        modelSelection,
      }),
  });
const layer = (
  policy = policyLayer(),
  generate: Generator = (input) => Effect.succeed(generated(input)),
  alterSecondRead = false,
) => {
  const planner = OrganizationWorkLaunchPlannerLive.pipe(
    Layer.provideMerge(workLayer),
    Layer.provideMerge(
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        resolveCommit: (input: { readonly cwd: string; readonly revision: string }) =>
          Effect.sync(() => ({ commitSha: git(input.cwd, "rev-parse", input.revision) })),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
    ),
  );
  let reads = 0;
  const reader = alterSecondRead
    ? Layer.succeed(OrganizationPatchSourceReader, {
        read: (plan, path) =>
          readOrganizationPatchSource(plan, path).pipe(
            Effect.map((source) => {
              reads += 1;
              return reads === 2 ? { ...source, content: "changed pinned source" } : source;
            }),
          ),
      })
    : OrganizationPatchSourceReaderLive;
  return Layer.mergeAll(
    OrganizationStoreLive,
    planner,
    workLayer,
    reader,
    policy,
    textLayer(generate),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
};

const seed = (root: string, commit: string) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Project', ${root}, '[]', '2026-01-01', '2026-01-01')`;
    const orgs = yield* OrganizationStore;
    let state = yield* orgs.create({
      organizationId,
      mutationId: "proposal-create",
      title: "Proposal Org",
      mission: "Fix software",
      actor: "user",
    });
    state = yield* orgs.bindProject({
      organizationId,
      mutationId: "proposal-bind",
      baseRevision: state.draftRevision,
      actor: "user",
      bindingId,
      projectId,
      access: "write",
      capabilities: ["read-files", "write-files", "run-tests"],
      scope: null,
    });
    const bindingVersion = state.bindings.find((binding) => binding.id === bindingId)!.updatedAt;
    const worker = OrganizationRoleId.make("proposal-worker");
    const qa = OrganizationRoleId.make("proposal-qa");
    for (const [roleId, kind] of [
      [worker, "engineering"],
      [qa, "qa"],
    ] as const) {
      state = yield* orgs.mutate({
        organizationId,
        mutationId: `proposal-${kind}`,
        baseRevision: state.draftRevision,
        actor: "user",
        change: {
          type: "add-role",
          role: { id: roleId, kind, title: kind, mandate: kind, poolSize: 1 },
        },
      });
    }
    state = yield* orgs.mutate({
      organizationId,
      mutationId: "proposal-workflow",
      baseRevision: state.draftRevision,
      actor: "user",
      change: {
        type: "upsert-workflow",
        workflow: {
          id: workflowId,
          title: "QA workflow",
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
            { id: step("qa"), kind: "qa", title: "Check", roleId: qa, reviewsStepId: step("work") },
            {
              id: step("approval"),
              kind: "approval",
              title: "Approve",
              roleId: state.directorRoleId,
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
    const published = yield* orgs.publish({
      organizationId,
      mutationId: "proposal-publish",
      baseRevision: state.draftRevision,
      actor: "user",
    });
    // Test-only activation; no production Organization runtime is mounted.
    yield* sql`UPDATE organizations SET lifecycle = 'active' WHERE organization_id = ${organizationId}`;
    yield* sql`INSERT INTO organization_intake_sources
    (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
     credential_version, created_at, updated_at)
    VALUES ('proposal-source', ${organizationId}, ${projectId}, 'manual', 'Fixture source',
      'human', 1, 1, '2026-01-01', '2026-01-01')`;
    yield* sql`INSERT INTO organization_intake_findings
    (finding_id, organization_id, source_id, dedup_key, title, summary,
     observation_ids_json, state, created_at, project_id)
    VALUES (${findingId}, ${organizationId}, 'proposal-source', 'proposal-finding',
      'Incorrect doubling', 'Expected twice the input', '[]', 'tentative', '2026-01-01', ${projectId})`;
    yield* sql`INSERT INTO organization_work_items
    (work_id, request_id, request_json, organization_id, finding_id, project_id,
     binding_id, binding_version, scope, published_revision, workflow_id,
     workflow_version, code_revision, status, attempt_limit, attempt_count,
     creator_subject, created_at, updated_at)
    VALUES (${workId}, 'proposal-work-request', '{}', ${organizationId}, ${findingId}, ${projectId},
      ${bindingId}, ${bindingVersion}, NULL, ${published.publishedRevision}, ${workflowId}, 1, ${commit},
      'pending', 2, 0, 'creator', '2026-01-01', '2026-01-01')`;
  });
const codeOf = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

it.effect("returns exact canonical bytes without changing Git refs or dirty checkout", () =>
  withRepo((root, commit) =>
    Effect.gen(function* () {
      yield* seed(root, commit);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "answer.mjs"), "dirty checkout\n"),
      );
      const result = yield* proposeOrganizationSingleFileArtifact(workId);
      const decoded = decodeOrganizationSingleFileArtifact(result.artifactBytes);
      assert.equal(decoded.baseCommit, commit);
      assert.equal(decoded.relativePath, "answer.mjs");
      assert.equal(
        Buffer.from(decoded.replacementBytes).toString(),
        "export function solve(input) { return input.value * 2; }\n",
      );
      assert.equal(result.proposal.baseDigest, result.source.sha256);
      assert.equal(result.source.content, "export function solve(input) { return input.value; }\n");
      assert.equal(git(root, "rev-parse", "HEAD"), commit);
      assert.equal(git(root, "rev-list", "--all", "--count"), "1");
      assert.equal(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "answer.mjs"), "utf8")),
        "dirty checkout\n",
      );
    }).pipe(
      Effect.provide(
        layer(policyLayer(), (input) => {
          assert.match(input.taskText, /Incorrect doubling/);
          assert.match(input.taskText, /Expected twice the input/);
          assert.equal(
            input.currentContent,
            "export function solve(input) { return input.value; }\n",
          );
          return Effect.succeed(generated(input));
        }),
      ),
    ),
  ),
);

it.effect("denies proposal without server policy", () =>
  withRepo((root, commit) =>
    Effect.gen(function* () {
      yield* seed(root, commit);
      const denied = yield* proposeOrganizationSingleFileArtifact(workId).pipe(Effect.flip);
      assert.equal(codeOf(denied), "forbidden");
    }).pipe(Effect.provide(layer(OrganizationSingleFileProposalPolicyDisabled))),
  ),
);

it.effect("rejects wrong model file and base digest", () =>
  withRepo((root, commit) =>
    Effect.gen(function* () {
      yield* seed(root, commit);
      const wrong = yield* proposeOrganizationSingleFileArtifact(workId).pipe(Effect.flip);
      assert.equal(codeOf(wrong), "conflict");
    }).pipe(
      Effect.provide(
        layer(policyLayer(), (input) =>
          Effect.succeed({ ...generated(input), fileName: "other.mjs" }),
        ),
      ),
    ),
  ),
);

it.effect("rejects revoked binding after the tool-free provider returns", () => {
  const generate: Generator = (input) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organization_project_bindings SET detached_at = '2026-01-02'
      WHERE binding_id = ${bindingId}`;
      return generated(input);
    });
  return withRepo((root, commit) =>
    Effect.gen(function* () {
      yield* seed(root, commit);
      const denied = yield* proposeOrganizationSingleFileArtifact(workId).pipe(Effect.flip);
      assert.equal(codeOf(denied), "forbidden");
    }).pipe(Effect.provide(layer(policyLayer(), generate))),
  );
});

it.effect("rejects work status changed during generation", () => {
  const generate: Generator = (input) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organization_work_items SET status = 'running' WHERE work_id = ${workId}`;
      return generated(input);
    });
  return withRepo((root, commit) =>
    Effect.gen(function* () {
      yield* seed(root, commit);
      const denied = yield* proposeOrganizationSingleFileArtifact(workId).pipe(Effect.flip);
      assert.equal(codeOf(denied), "conflict");
    }).pipe(Effect.provide(layer(policyLayer(), generate))),
  );
});

it.effect("rejects changed pinned source on the post-provider read", () =>
  withRepo((root, commit) =>
    Effect.gen(function* () {
      yield* seed(root, commit);
      const denied = yield* proposeOrganizationSingleFileArtifact(workId).pipe(Effect.flip);
      assert.equal(codeOf(denied), "conflict");
    }).pipe(
      Effect.provide(layer(policyLayer(), (input) => Effect.succeed(generated(input)), true)),
    ),
  ),
);

it.effect("rejects source whose current Project scope changes during generation", () => {
  const generate: Generator = (input) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organization_intake_sources SET project_id = NULL
      WHERE source_id = 'proposal-source'`;
      return generated(input);
    });
  return withRepo((root, commit) =>
    Effect.gen(function* () {
      yield* seed(root, commit);
      const denied = yield* proposeOrganizationSingleFileArtifact(workId).pipe(Effect.flip);
      assert.equal(codeOf(denied), "conflict");
    }).pipe(Effect.provide(layer(policyLayer(), generate))),
  );
});

it.effect("rejects a proposal with changed source digest", () =>
  withRepo((root, commit) =>
    Effect.gen(function* () {
      yield* seed(root, commit);
      const denied = yield* proposeOrganizationSingleFileArtifact(workId).pipe(Effect.flip);
      assert.equal(codeOf(denied), "conflict");
    }).pipe(
      Effect.provide(
        layer(policyLayer(), (input) =>
          Effect.succeed({ ...generated(input), baseDigest: "0".repeat(64) }),
        ),
      ),
    ),
  ),
);

it.effect("snapshots mutable policy and provider outputs before later reads", () => {
  const mutablePolicy = Layer.succeed(OrganizationSingleFileProposalPolicy, {
    select: () => {
      let reads = 0;
      return Effect.succeed({
        get fileName() {
          reads += 1;
          return reads === 1 ? "answer.mjs" : "other.mjs";
        },
        taskText: "Fix the scoped finding",
        modelSelection,
      });
    },
  });
  const generate: Generator = (input) => {
    let reads = 0;
    return Effect.succeed({
      get fileName() {
        reads += 1;
        return reads === 1 ? input.fileName : "other.mjs";
      },
      baseDigest: input.baseDigest,
      replacementContent: "export function solve(input) { return input.value * 2; }\n",
      rationale: "Fixture",
    });
  };
  return withRepo((root, commit) =>
    Effect.gen(function* () {
      yield* seed(root, commit);
      const result = yield* proposeOrganizationSingleFileArtifact(workId);
      assert.equal(
        decodeOrganizationSingleFileArtifact(result.artifactBytes).relativePath,
        "answer.mjs",
      );
    }).pipe(Effect.provide(layer(mutablePolicy, generate))),
  );
});
