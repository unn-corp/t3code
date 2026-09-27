// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Disposable Git fixture and versioned evidence assertions.
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
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrganizationTentativeFindingId } from "../../../../packages/contracts/src/organizationIntake.ts";
import {
  OrganizationWorkAttemptId,
  OrganizationWorkId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  coordinateOrganizationGitCandidate,
  OrganizationGitCandidateCoordinatorAuthority,
} from "./OrganizationGitCandidateCoordinator.ts";
import {
  completeOrganizationGitIntegration,
  OrganizationGitIntegrationCompletionAuthority,
  OrganizationGitIntegrationCompletionError,
} from "./OrganizationGitIntegrationCompletion.ts";
import {
  coordinateOrganizationGitIntegration,
  OrganizationGitIntegrationAuthority,
  OrganizationGitIntegrationCoordinatorError,
} from "./OrganizationGitIntegrationCoordinator.ts";
import {
  OrganizationGitCandidateIntentStoreWithAuthority,
  OrganizationGitCandidateRetentionAuthority,
} from "./OrganizationGitCandidateIntentStore.ts";
import { OrganizationPatchSourceReaderLive } from "./OrganizationPatchSourceReader.ts";
import {
  isOrganizationScopedSandboxAvailable,
  prepareOrganizationScopedSandbox,
  type PreparedOrganizationScopedSandbox,
} from "./OrganizationScopedSandboxHost.ts";
import { decodeOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import { OrganizationSingleFileApprovalPolicy } from "./OrganizationSingleFileApprovalCoordinator.ts";
import { decideOrganizationWorkApprovalForSession } from "./OrganizationWorkApprovalRpc.ts";
import { OrganizationSingleFileApprovalRevisionGuardLive } from "./OrganizationSingleFileApprovalRevision.ts";
import {
  OrganizationSingleFileAttemptError,
  OrganizationSingleFileAttemptHost,
  OrganizationSingleFileAttemptPolicy,
  OrganizationSingleFileAttemptScopeVerifierFromHost,
  runOrganizationSingleFileAttempt,
} from "./OrganizationSingleFileAttemptCoordinator.ts";
import {
  OrganizationSingleFileProposalPolicy,
  proposeOrganizationSingleFileArtifact,
} from "./OrganizationSingleFileProposalCoordinator.ts";
import {
  OrganizationSingleFileQAHost,
  OrganizationSingleFileQAPolicy,
  runOrganizationSingleFileQA,
} from "./OrganizationSingleFileQACoordinator.ts";
import { evaluateOrganizationSingleFileQA } from "./OrganizationSingleFileQAEvaluator.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import {
  OrganizationWorkApprovalCaptureAuthority,
  OrganizationWorkApprovalReceiptStore,
  OrganizationWorkApprovalReceiptStoreWithAuthority,
  OrganizationWorkApprovalVerifierFromReceipts,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreWithAuthority,
  OrganizationWorkArtifactVerifierFromStore,
} from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkIntegrationReceiptStore,
  OrganizationWorkIntegrationReceiptStoreLive,
} from "./OrganizationWorkIntegrationReceiptStore.ts";
import { OrganizationWorkLaunchPlannerLive } from "./OrganizationWorkLaunchPlanner.ts";
import {
  OrganizationWorkQAReceiptCaptureAuthority,
  OrganizationWorkQAReceiptStore,
  OrganizationWorkQAReceiptStoreWithAuthority,
  OrganizationWorkEvaluationVerifierFromQAReceipts,
} from "./OrganizationWorkQAReceiptStore.ts";
import {
  OrganizationWorkScopeStore,
  OrganizationWorkScopeStoreLayer,
  type OrganizationWorkScopeIdentity,
} from "./OrganizationWorkScopeStore.ts";
import {
  OrganizationWorkReviewStore,
  OrganizationWorkReviewStoreWithEvidence,
} from "./OrganizationWorkReviewStore.ts";
import {
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";

const organizationId = OrganizationId.make("vertical-org");
const projectId = ProjectId.make("vertical-project");
const bindingId = OrganizationBindingId.make("vertical-binding");
const findingId = OrganizationTentativeFindingId.make("vertical-finding");
const workId = OrganizationWorkId.make("vertical-work");
const attemptId = OrganizationWorkAttemptId.make("vertical-attempt");
const workflowId = OrganizationWorkflowId.make("vertical-workflow");
const workerSubject = "fixture-worker";
const reviewerSubject = "fixture-independent-reviewer";
const approverSubject = "fixture-interactive-human";
const integratorSubject = "fixture-independent-integrator";
const targetRef = "refs/heads/release";
const integrationRequest = { attemptId, targetRef, integratorSubject } as const;
const modelSelection = createModelSelection(ProviderInstanceId.make("claude"), "fixture-model");
const step = OrganizationWorkflowStepId.make;
const transition = (id: string, from: string, to: string) => ({
  id: OrganizationWorkflowTransitionId.make(id),
  fromStepId: step(from),
  toStepId: step(to),
  maxTraversals: null,
});
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
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
  }).trimEnd();
const withRepo = <A, E, R>(use: (root: string, commit: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const directory = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "t3-org-vertical-"),
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

const seed = (root: string, commit: string) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Fixture', ${root}, '[]', '2026-01-01', '2026-01-01')`;
    const orgs = yield* OrganizationStore;
    let state = yield* orgs.create({
      organizationId,
      mutationId: "vertical-create",
      title: "Vertical fixture",
      mission: "Review one file",
      actor: "user",
    });
    state = yield* orgs.bindProject({
      organizationId,
      mutationId: "vertical-bind",
      baseRevision: state.draftRevision,
      actor: "user",
      bindingId,
      projectId,
      access: "write",
      capabilities: ["read-files", "write-files", "run-tests"],
      scope: null,
    });
    const bindingVersion = state.bindings.find((binding) => binding.id === bindingId)!.updatedAt;
    const worker = OrganizationRoleId.make("vertical-worker");
    const qa = OrganizationRoleId.make("vertical-qa");
    for (const [roleId, kind] of [
      [worker, "engineering"],
      [qa, "qa"],
    ] as const) {
      state = yield* orgs.mutate({
        organizationId,
        mutationId: `vertical-${kind}`,
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
      mutationId: "vertical-workflow",
      baseRevision: state.draftRevision,
      actor: "user",
      change: {
        type: "upsert-workflow",
        workflow: {
          id: workflowId,
          title: "Review",
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
      mutationId: "vertical-publish",
      baseRevision: state.draftRevision,
      actor: "user",
    });
    // Fixture-only activation; the production Organization executor remains disabled.
    yield* sql`UPDATE organizations SET lifecycle = 'active' WHERE organization_id = ${organizationId}`;
    yield* sql`INSERT INTO organization_intake_sources
      (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
       credential_version, created_at, updated_at)
      VALUES ('vertical-source', ${organizationId}, ${projectId}, 'manual', 'Fixture source',
        'human', 1, 1, '2026-01-01', '2026-01-01')`;
    yield* sql`INSERT INTO organization_intake_findings
      (finding_id, organization_id, source_id, dedup_key, title, summary,
       observation_ids_json, state, created_at, project_id)
      VALUES (${findingId}, ${organizationId}, 'vertical-source', 'vertical-finding',
        'Incorrect doubling', 'Expected twice the input', '[]', 'tentative', '2026-01-01', ${projectId})`;
    yield* sql`INSERT INTO organization_work_items
      (work_id, request_id, request_json, organization_id, finding_id, project_id,
       binding_id, binding_version, scope, published_revision, workflow_id,
       workflow_version, code_revision, status, attempt_limit, attempt_count,
       creator_subject, created_at, updated_at)
      VALUES (${workId}, 'vertical-request', '{}', ${organizationId}, ${findingId}, ${projectId},
        ${bindingId}, ${bindingVersion}, NULL, ${published.publishedRevision}, ${workflowId}, 1, ${commit},
        'pending', 1, 0, 'creator', '2026-01-01', '2026-01-01')`;
  });

const makeLayer = () => {
  const handles = new Map<string, PreparedOrganizationScopedSandbox>();
  const host = Layer.succeed(OrganizationSingleFileAttemptHost, {
    reserve: async () => undefined,
    prepare: async (input) => {
      const handle = await prepareOrganizationScopedSandbox(input);
      handles.set(handle.unitName, handle);
      return handle;
    },
    verifyStopped: (identity: OrganizationWorkScopeIdentity) =>
      Effect.tryPromise({
        try: async () => {
          const handle = handles.get(identity.unitName);
          if (
            !handle ||
            handle.invocationId !== identity.invocationId ||
            handle.controlGroup !== identity.controlGroup ||
            handle.sandboxPid !== identity.sandboxPid ||
            handle.pidNamespace !== identity.pidNamespace
          )
            throw new Error("Saved scope identity changed");
          await handle.wait();
        },
        catch: () =>
          new OrganizationSingleFileAttemptError({
            code: "unavailable",
            message: "Exact OS stop could not be verified",
          }),
      }),
  });
  const artifact = OrganizationWorkArtifactStoreWithAuthority.pipe(
    Layer.provide(Layer.succeed(OrganizationWorkArtifactCaptureAuthority, { permits: () => true })),
  );
  const candidateIntent = OrganizationGitCandidateIntentStoreWithAuthority.pipe(
    Layer.provideMerge(artifact),
    Layer.provide(
      Layer.succeed(OrganizationGitCandidateRetentionAuthority, {
        permits: ({ intent }) =>
          intent.organizationId === organizationId && intent.projectId === projectId,
      }),
    ),
  );
  const qa = OrganizationWorkQAReceiptStoreWithAuthority.pipe(
    Layer.provide(
      Layer.succeed(OrganizationWorkQAReceiptCaptureAuthority, { permits: () => true }),
    ),
    Layer.provideMerge(artifact),
  );
  const approval = OrganizationWorkApprovalReceiptStoreWithAuthority.pipe(
    Layer.provide(
      Layer.succeed(OrganizationWorkApprovalCaptureAuthority, {
        permitsAuthenticatedHuman: (input, context) =>
          input.approvalSubject === approverSubject &&
          context.organizationId === organizationId &&
          context.projectId === projectId,
      }),
    ),
    Layer.provideMerge(qa),
  );
  const work = OrganizationWorkStoreLayer.pipe(
    Layer.provideMerge(
      OrganizationWorkArtifactVerifierFromStore.pipe(Layer.provideMerge(artifact)),
    ),
    Layer.provideMerge(
      OrganizationWorkEvaluationVerifierFromQAReceipts.pipe(Layer.provideMerge(qa)),
    ),
    Layer.provideMerge(
      OrganizationWorkApprovalVerifierFromReceipts.pipe(Layer.provideMerge(approval)),
    ),
    Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
    Layer.provide(
      Layer.succeed(OrganizationWorkExecutionAuthority, {
        permits: (action, principal, target) =>
          ((["claim", "submit", "cancel"].includes(action) &&
            principal.subject === workerSubject) ||
            (action === "evaluate" && principal.subject === reviewerSubject)) &&
          target.organizationId === organizationId &&
          target.projectId === projectId &&
          target.bindingId === bindingId &&
          target.workId === workId,
      }),
    ),
  );
  const scope = OrganizationWorkScopeStoreLayer.pipe(
    Layer.provideMerge(
      OrganizationSingleFileAttemptScopeVerifierFromHost.pipe(Layer.provideMerge(host)),
    ),
  );
  const planner = OrganizationWorkLaunchPlannerLive.pipe(
    Layer.provideMerge(work),
    Layer.provideMerge(
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        resolveCommit: (input: { readonly cwd: string; readonly revision: string }) =>
          Effect.sync(() => ({ commitSha: git(input.cwd, "rev-parse", input.revision) })),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
    ),
  );
  const text = Layer.succeed(TextGeneration, {
    generateCommitMessage: () => Effect.die("unused"),
    generatePrContent: () => Effect.die("unused"),
    generateBranchName: () => Effect.die("unused"),
    generateThreadTitle: () => Effect.die("unused"),
    generateOrganizationPatchProposal: (input) =>
      Effect.succeed({
        fileName: input.fileName,
        baseDigest: input.baseDigest,
        replacementContent: "export function solve(input) { return input.value * 2; }\n",
        rationale: "Fixture text-only proposal",
      }),
  });
  return Layer.mergeAll(
    OrganizationStoreLive,
    planner,
    work,
    scope,
    artifact,
    qa,
    Layer.succeed(OrganizationSingleFileQAHost, {
      evaluate: (_attemptId, input) => evaluateOrganizationSingleFileQA(input),
    }),
    approval,
    OrganizationWorkIntegrationReceiptStoreLive.pipe(Layer.provideMerge(approval)),
    OrganizationWorkReviewStoreWithEvidence.pipe(Layer.provideMerge(approval)),
    candidateIntent,
    Layer.succeed(OrganizationGitCandidateCoordinatorAuthority, {
      permitsAttempt: (savedAttemptId) => savedAttemptId === attemptId,
      permits: (intent) =>
        intent.organizationId === organizationId &&
        intent.projectId === projectId &&
        intent.workId === workId,
    }),
    Layer.succeed(OrganizationGitIntegrationAuthority, {
      permitsAttempt: (input) =>
        input.attemptId === attemptId &&
        input.targetRef === targetRef &&
        input.integratorSubject === integratorSubject,
      permits: (input, context) =>
        input.attemptId === attemptId &&
        input.targetRef === targetRef &&
        input.integratorSubject === integratorSubject &&
        context.organizationId === organizationId &&
        context.projectId === projectId &&
        context.bindingId === bindingId &&
        context.workId === workId &&
        context.approvalSubject === approverSubject,
    }),
    Layer.succeed(OrganizationGitIntegrationCompletionAuthority, {
      permitsAttempt: (input) =>
        input.attemptId === attemptId &&
        input.targetRef === targetRef &&
        input.integratorSubject === integratorSubject,
      permits: (input, context) =>
        input.attemptId === attemptId &&
        input.targetRef === targetRef &&
        input.integratorSubject === integratorSubject &&
        context.organizationId === organizationId &&
        context.projectId === projectId &&
        context.bindingId === bindingId &&
        context.workId === workId,
    }),
    host,
    OrganizationPatchSourceReaderLive,
    text,
    Layer.succeed(OrganizationSingleFileProposalPolicy, {
      select: (target) =>
        Effect.succeed({
          fileName: "answer.mjs",
          taskText: `Fix ${target.findingTitle}: ${target.findingSummary}`,
          modelSelection,
        }),
    }),
    Layer.succeed(OrganizationSingleFileAttemptPolicy, {
      select: () => Effect.succeed({ attemptId, workerSubject }),
    }),
    Layer.succeed(OrganizationSingleFileQAPolicy, {
      select: () =>
        Effect.succeed({
          reviewerSubject,
          plan: {
            version: 1 as const,
            exportName: "solve",
            cases: [
              { input: { value: 2 }, expected: 4 },
              { input: { value: 5 }, expected: 10 },
            ],
          },
        }),
    }),
    Layer.succeed(OrganizationSingleFileApprovalPolicy, {
      decide: () => Effect.succeed({ approvalSubject: approverSubject, approved: true }),
    }),
    OrganizationSingleFileApprovalRevisionGuardLive,
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
};

const available = isOrganizationScopedSandboxAvailable();

it.effect.skipIf(!available)(
  "runs proposal, scoped syntax, QA, human approval, Git CAS, and completion over one artifact",
  () =>
    withRepo((root, commit) =>
      Effect.gen(function* () {
        yield* seed(root, commit);
        // This branch is never checked out; only its ref is eligible for the CAS.
        git(root, "branch", "release", commit);
        const beforeIndex = git(root, "ls-files", "-s");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "answer.mjs"), "dirty checkout\n"),
        );
        const proposal = yield* proposeOrganizationSingleFileArtifact(workId);
        const attempt = yield* runOrganizationSingleFileAttempt(proposal);
        assert.equal(attempt.status, "submitted");
        const artifact = yield* (yield* OrganizationWorkArtifactStore).get(attemptId);
        assert.ok(artifact);
        yield* (yield* OrganizationWorkArtifactStore).verifySubmitted(artifact);
        assert.deepEqual(artifact.patchBytes, proposal.artifactBytes);
        assert.equal(artifact.artifactDigest, attempt.artifactDigest);
        assert.match(artifact.artifactDigest, /^[a-f0-9]{64}$/);
        assert.equal(
          (yield* (yield* OrganizationWorkScopeStore).get(attemptId))?.state,
          "verified-stopped",
        );
        const privateRef = `refs/t3-organizations/candidates/${sha256(proposal.artifactBytes)}`;
        // An existing ref to the base commit is not proof of the reviewed change.
        git(root, "update-ref", "--no-deref", privateRef, commit, "0".repeat(commit.length));
        const staleCandidate = yield* Effect.flip(coordinateOrganizationGitCandidate(attemptId));
        assert.equal(staleCandidate.code, "invalid");
        git(root, "update-ref", "--no-deref", "-d", privateRef, commit);
        const candidate = yield* coordinateOrganizationGitCandidate(attemptId);
        assert.equal(candidate.intent.status, "retained");
        assert.equal(candidate.intent.artifactReceiptDigest, artifact.artifactDigest);
        assert.equal(candidate.intent.reviewedArtifactDigest, sha256(proposal.artifactBytes));
        assert.equal(candidate.proof.reviewedArtifactDigest, sha256(proposal.artifactBytes));
        assert.equal(candidate.proof.baseCommit, commit);
        assert.equal(candidate.proof.relativePath, "answer.mjs");
        assert.equal(candidate.intent.resultCommit, candidate.proof.resultCommit);
        assert.equal(git(root, "rev-parse", privateRef), candidate.proof.resultCommit);
        assert.equal(git(root, "rev-parse", `${candidate.proof.resultCommit}^`), commit);
        assert.equal(
          git(
            root,
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            candidate.proof.resultCommit,
          ),
          "answer.mjs",
        );
        const canonical = decodeOrganizationSingleFileArtifact(proposal.artifactBytes);
        assert.equal(
          git(root, "show", `${candidate.proof.resultCommit}:answer.mjs`),
          Buffer.from(canonical.replacementBytes).toString("utf8").trimEnd(),
        );
        const reviewed = yield* runOrganizationSingleFileQA({ workId, attemptId });
        assert.equal(reviewed.work.status, "waiting-approval");
        const qa = yield* (yield* OrganizationWorkQAReceiptStore).get(attemptId);
        assert.ok(qa);
        yield* (yield* OrganizationWorkQAReceiptStore).verifyEvaluation(qa);
        assert.equal(qa.accepted, true);
        assert.equal(qa.artifactDigest, artifact.artifactDigest);
        assert.match(qa.receiptDigest, /^[a-f0-9]{64}$/);
        assert.equal(reviewed.attempts[0]?.qaEvidenceRef, qa.evidenceRef);
        const workReview = yield* (yield* OrganizationWorkReviewStore).get({
          organizationId,
          workId,
          attemptId,
        });
        const decision = {
          organizationId,
          workId,
          attemptId,
          requestId: "vertical-human-request",
          approved: true,
          reason: "Reviewed independent QA cases",
          artifactDigest: artifact.artifactDigest,
          qaReceiptDigest: qa.receiptDigest,
          baseCodeRevision: commit,
          bindingVersion: reviewed.work.bindingVersion,
          projectRootDigest: workReview.projectRootDigest,
        };
        const movedRoot = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const directory = await NodeFSP.mkdtemp(
              NodePath.join(NodeOS.tmpdir(), "t3-org-moved-root-"),
            );
            git(root, "clone", "-q", "--no-hardlinks", "--", root, directory);
            return directory;
          }),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        );
        assert.equal(git(movedRoot, "rev-parse", "HEAD"), commit);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_projects SET workspace_root = ${movedRoot}
          WHERE project_id = ${projectId}`;
        const movedBeforeFirstApproval = yield* decideOrganizationWorkApprovalForSession(
          { method: "browser-session-cookie", subject: approverSubject },
          decision,
        ).pipe(Effect.flip);
        assert.equal(movedBeforeFirstApproval.code, "conflict");
        yield* sql`UPDATE projection_projects SET workspace_root = ${root}
          WHERE project_id = ${projectId}`;
        const delegated = yield* decideOrganizationWorkApprovalForSession(
          { method: "bearer-access-token", subject: "delegated-agent" },
          decision,
        ).pipe(Effect.flip);
        assert.equal(delegated.code, "forbidden");
        const staleDigest = yield* decideOrganizationWorkApprovalForSession(
          { method: "browser-session-cookie", subject: approverSubject },
          { ...decision, artifactDigest: "0".repeat(64) },
        ).pipe(Effect.flip);
        assert.equal(staleDigest.code, "conflict");
        const approved = yield* decideOrganizationWorkApprovalForSession(
          { method: "browser-session-cookie", subject: approverSubject },
          decision,
        );
        assert.deepEqual(
          yield* decideOrganizationWorkApprovalForSession(
            { method: "browser-session-cookie", subject: approverSubject },
            decision,
          ),
          approved,
        );
        yield* sql`UPDATE projection_projects SET workspace_root = ${movedRoot}
          WHERE project_id = ${projectId}`;
        const movedRootReplay = yield* decideOrganizationWorkApprovalForSession(
          { method: "browser-session-cookie", subject: approverSubject },
          decision,
        ).pipe(Effect.flip);
        assert.equal(movedRootReplay.code, "conflict");
        yield* sql`UPDATE projection_projects SET workspace_root = ${root}
          WHERE project_id = ${projectId}`;
        const receipt = yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId);
        assert.ok(receipt);
        yield* (yield* OrganizationWorkApprovalReceiptStore).verifyApproval(receipt);
        assert.equal(receipt.approved, true);
        assert.equal(receipt.artifactDigest, artifact.artifactDigest);
        assert.equal(receipt.artifactDigest, candidate.intent.artifactReceiptDigest);
        assert.equal(receipt.qaReceiptDigest, qa.receiptDigest);
        assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/);
        assert.equal(approved.work.status, "blocked");
        assert.equal(approved.work.approvalEvidenceRef, receipt.evidenceRef);
        assert.equal(approved.attempts[0]?.status, "qa-accepted");
        assert.equal(git(root, "rev-parse", "HEAD"), commit);
        assert.equal(git(root, "ls-files", "-s"), beforeIndex);
        assert.equal(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "answer.mjs"), "utf8")),
          "dirty checkout\n",
        );
        assert.equal(git(root, "status", "--porcelain"), " M answer.mjs");
        assert.match(Buffer.from(artifact.evidenceBytes).toString(), /node-check-syntax-only/);
        assert.match(Buffer.from(qa.evidenceBytes).toString(), /policyPlanSha256/);
        assert.equal(sha256(receipt.evidenceBytes).length, 64);
        const interruptedCas = yield* coordinateOrganizationGitIntegration(integrationRequest, () =>
          Effect.fail(
            new OrganizationGitIntegrationCoordinatorError({
              code: "unavailable",
              message: "Fixture fault after Git CAS before SQLite acknowledgement",
            }),
          ),
        ).pipe(Effect.flip);
        assert.equal(interruptedCas.code, "unavailable");
        assert.equal(git(root, "rev-parse", targetRef), candidate.proof.resultCommit);
        const preparedIntent = (yield* sql<{ status: string }>`SELECT status
          FROM organization_git_integration_intents WHERE attempt_id = ${attemptId}`)[0];
        assert.equal(preparedIntent?.status, "prepared");
        assert.equal(
          (yield* (yield* OrganizationWorkStore).getWork(workId)).work.status,
          "blocked",
        );
        const applied = yield* coordinateOrganizationGitIntegration(integrationRequest);
        assert.equal(applied.appliedNow, false);
        assert.equal(applied.resultCommit, candidate.proof.resultCommit);
        assert.equal(applied.approvalReceiptDigest, receipt.receiptDigest);
        assert.equal(applied.reviewedArtifactDigest, sha256(proposal.artifactBytes));
        assert.equal(
          (yield* sql<{ status: string }>`SELECT status FROM organization_git_integration_intents
            WHERE attempt_id = ${attemptId}`)[0]?.status,
          "applied",
        );
        const interruptedCompletion = yield* completeOrganizationGitIntegration(
          integrationRequest,
          () =>
            Effect.fail(
              new OrganizationGitIntegrationCompletionError({
                code: "unavailable",
                message: "Fixture fault after receipt capture before work transition",
              }),
            ),
        ).pipe(Effect.flip);
        assert.equal(interruptedCompletion.code, "unavailable");
        assert.equal(
          (yield* (yield* OrganizationWorkStore).getWork(workId)).work.status,
          "blocked",
        );
        const completed = yield* completeOrganizationGitIntegration(integrationRequest);
        assert.equal(completed.status, "succeeded");
        assert.equal(completed.resultCommit, candidate.proof.resultCommit);
        assert.equal(completed.targetRef, targetRef);
        assert.deepEqual(yield* completeOrganizationGitIntegration(integrationRequest), completed);
        const integrationReceipt = yield* (yield* OrganizationWorkIntegrationReceiptStore).get(
          attemptId,
        );
        assert.ok(integrationReceipt);
        yield* (yield* OrganizationWorkIntegrationReceiptStore).verifyIntegration({
          attemptId,
          workId,
          projectId,
          baseCodeRevision: commit,
          resultCodeRevision: candidate.proof.resultCommit,
          artifactRef: artifact.artifactRef,
          artifactDigest: artifact.artifactDigest,
          workerSubject,
          qaSubject: reviewerSubject,
          approvalSubject: approverSubject,
          integratorSubject,
          receiptRef: completed.receiptRef,
        });
        assert.equal(integrationReceipt.receiptDigest, completed.receiptDigest);
        assert.equal(integrationReceipt.approvalReceiptDigest, receipt.receiptDigest);
        assert.equal(integrationReceipt.qaReceiptDigest, qa.receiptDigest);
        assert.equal(integrationReceipt.artifactDigest, artifact.artifactDigest);
        const integrationEvidence = JSON.parse(
          Buffer.from(integrationReceipt.evidenceBytes).toString("utf8"),
        );
        assert.equal(integrationEvidence.targetRef, targetRef);
        assert.equal(integrationEvidence.resultOid, candidate.proof.resultCommit);
        assert.equal(integrationEvidence.reviewedArtifactDigest, sha256(proposal.artifactBytes));
        assert.equal(integrationEvidence.approvalReceiptDigest, receipt.receiptDigest);
        const succeeded = yield* (yield* OrganizationWorkStore).getWork(workId);
        assert.equal(succeeded.work.status, "succeeded");
        assert.equal(succeeded.work.integrationReceiptRef, completed.receiptRef);
        assert.equal(succeeded.work.resultCodeRevision, candidate.proof.resultCommit);
        assert.equal(
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total
            FROM organization_work_integration_receipts WHERE attempt_id = ${attemptId}`)[0]?.total,
          1,
        );
        assert.equal(
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total
            FROM organization_work_transitions WHERE work_id = ${workId}
              AND action = 'integrate'`)[0]?.total,
          1,
        );
        assert.equal(git(root, "rev-parse", targetRef), candidate.proof.resultCommit);
        assert.equal(
          git(root, "show", `${targetRef}:answer.mjs`),
          Buffer.from(canonical.replacementBytes).toString("utf8").trimEnd(),
        );
        assert.equal(git(root, "rev-parse", "HEAD"), commit);
        assert.equal(git(root, "ls-files", "-s"), beforeIndex);
        assert.equal(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "answer.mjs"), "utf8")),
          "dirty checkout\n",
        );
        git(
          root,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--allow-empty",
          "-qm",
          "moved",
        );
        assert.notEqual(git(root, "rev-parse", "HEAD"), commit);
        const moved = yield* decideOrganizationWorkApprovalForSession(
          { method: "browser-session-cookie", subject: approverSubject },
          decision,
        ).pipe(Effect.flip);
        assert.equal(moved.code, "conflict");
      }).pipe(Effect.provide(makeLayer())),
    ),
);

it.effect.skipIf(!available)(
  "records an interactive rejection without enabling integration or moving the Project ref",
  () =>
    withRepo((root, commit) =>
      Effect.gen(function* () {
        yield* seed(root, commit);
        const proposal = yield* proposeOrganizationSingleFileArtifact(workId);
        yield* runOrganizationSingleFileAttempt(proposal);
        const reviewed = yield* runOrganizationSingleFileQA({ workId, attemptId });
        const qa = yield* (yield* OrganizationWorkQAReceiptStore).get(attemptId);
        const artifact = yield* (yield* OrganizationWorkArtifactStore).get(attemptId);
        assert.ok(qa && artifact);
        const workReview = yield* (yield* OrganizationWorkReviewStore).get({
          organizationId,
          workId,
          attemptId,
        });
        const rejected = yield* decideOrganizationWorkApprovalForSession(
          { method: "browser-session-cookie", subject: approverSubject },
          {
            organizationId,
            workId,
            attemptId,
            requestId: "vertical-reject-request",
            approved: false,
            reason: "Evidence does not meet release criteria",
            artifactDigest: artifact.artifactDigest,
            qaReceiptDigest: qa.receiptDigest,
            baseCodeRevision: commit,
            bindingVersion: reviewed.work.bindingVersion,
            projectRootDigest: workReview.projectRootDigest,
          },
        );
        assert.equal(rejected.work.status, "canceled");
        assert.equal(
          (yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId))?.approved,
          false,
        );
        assert.equal(git(root, "rev-parse", "HEAD"), commit);
      }).pipe(Effect.provide(makeLayer())),
    ),
);

it.effect(
  "refuses a prepared proposal after Project binding revocation without claiming an attempt",
  () =>
    withRepo((root, commit) =>
      Effect.gen(function* () {
        yield* seed(root, commit);
        const proposal = yield* proposeOrganizationSingleFileArtifact(workId);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE organization_project_bindings
        SET detached_at = '2026-01-02' WHERE binding_id = ${bindingId}`;
        const error = yield* Effect.flip(runOrganizationSingleFileAttempt(proposal));
        assert.equal(error.code, "forbidden");
        assert.equal(
          (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM organization_work_attempts`)[0]?.count,
          0,
        );
        assert.equal(git(root, "rev-parse", "HEAD"), commit);
      }).pipe(Effect.provide(makeLayer())),
    ),
);
