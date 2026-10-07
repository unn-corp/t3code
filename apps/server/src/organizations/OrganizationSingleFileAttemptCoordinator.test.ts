// @effect-diagnostics nodeBuiltinImport:off - Disposable Git fixture invokes fixed system binaries without scripts.
import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { OrganizationTentativeFindingId } from "../../../../packages/contracts/src/organizationIntake.ts";
import {
  OrganizationWorkAttemptId,
  OrganizationWorkId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { buildOrganizationPatchArtifact } from "./OrganizationPatchArtifactBuilder.ts";
import {
  OrganizationPatchSourceReader,
  OrganizationPatchSourceReaderLive,
} from "./OrganizationPatchSourceReader.ts";
import {
  isOrganizationScopedSandboxAvailable,
  prepareOrganizationScopedSandbox,
  type PreparedOrganizationScopedSandbox,
} from "./OrganizationScopedSandboxHost.ts";
import {
  OrganizationSingleFileAttemptError,
  OrganizationSingleFileAttemptHost,
  OrganizationSingleFileAttemptPolicy,
  OrganizationSingleFileAttemptPolicyDisabled,
  OrganizationSingleFileAttemptScopeVerifierFromHost,
  runOrganizationSingleFileAttempt,
} from "./OrganizationSingleFileAttemptCoordinator.ts";
import type { OrganizationSingleFileProposalResult } from "./OrganizationSingleFileProposalCoordinator.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreWithAuthority,
  OrganizationWorkArtifactVerifierFromStore,
} from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkLaunchPlanner,
  type OrganizationWorkLaunchPlan,
} from "./OrganizationWorkLaunchPlanner.ts";
import {
  OrganizationWorkScopeStore,
  OrganizationWorkScopeError,
  OrganizationWorkScopeStoreLayer,
  type OrganizationWorkScopeIdentity,
} from "./OrganizationWorkScopeStore.ts";
import {
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkEvaluationVerifierDisabled,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";

const organizationId = OrganizationId.make("attempt-bridge-org");
const projectId = ProjectId.make("attempt-bridge-project");
const bindingId = OrganizationBindingId.make("attempt-bridge-binding");
const findingId = OrganizationTentativeFindingId.make("attempt-bridge-finding");
const secondFindingId = OrganizationTentativeFindingId.make("attempt-bridge-finding-2");
const workId = OrganizationWorkId.make("attempt-bridge-work");
const secondWorkId = OrganizationWorkId.make("attempt-bridge-work-2");
const attemptId = OrganizationWorkAttemptId.make("attempt-bridge-attempt");
const secondAttemptId = OrganizationWorkAttemptId.make("attempt-bridge-attempt-2");
const date = "2026-01-01T00:00:00.000Z";
const workerSubject = "scoped-worker-fixture";
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const codeOf = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
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
          const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-attempt-"));
          git(dir, "init", "-q");
          await NodeFSP.writeFile(
            NodePath.join(dir, "answer.mjs"),
            "export function solve(input) { return input.value; }\n",
          );
          git(dir, "add", "--", "answer.mjs");
          git(
            dir,
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
          return dir;
        }),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      return yield* use(root, git(root, "rev-parse", "HEAD"));
    }),
  );

const plan = (root: string, commit: string): OrganizationWorkLaunchPlan => ({
  workId,
  organizationId,
  projectId,
  bindingId,
  bindingVersion: date,
  scope: null,
  publishedRevision: 1,
  workflowId: "fixture-workflow",
  workflowVersion: 1,
  baseCommit: commit,
  projectRoot: root,
  nextAttemptNumber: 1,
  worktreeName: "fixture-worktree",
  branchName: "fixture-branch",
});

const seed = (root: string, commit: string) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Fixture', ${root}, '[]', ${date}, ${date})`;
    yield* sql`INSERT INTO organizations
      (organization_id, title, mission, lifecycle, draft_revision, published_revision,
       architect_role_id, director_role_id, graph_json, layout_json, created_at, updated_at)
      VALUES (${organizationId}, 'Fixture', 'Syntax smoke', 'active', 1, 1,
        'architect', 'director', '{}', '{}', ${date}, ${date})`;
    yield* sql`INSERT INTO organization_project_bindings
      (binding_id, organization_id, project_id, access, capabilities_json, scope,
       detached_at, created_at, updated_at)
      VALUES (${bindingId}, ${organizationId}, ${projectId}, 'write',
        '["read-files","write-files","run-tests"]', NULL, NULL, ${date}, ${date})`;
    yield* sql`INSERT INTO organization_intake_sources
      (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
       credential_version, created_at, updated_at)
      VALUES ('attempt-bridge-source', ${organizationId}, ${projectId}, 'manual', 'Fixture source',
        'human', 1, 1, ${date}, ${date})`;
    yield* sql`INSERT INTO organization_intake_findings
      (finding_id, organization_id, source_id, dedup_key, title, summary,
       observation_ids_json, state, created_at, project_id)
      VALUES (${findingId}, ${organizationId}, 'attempt-bridge-source', 'fixture-finding',
        'Fixture finding', '', '[]', 'tentative', ${date}, ${projectId})`;
    yield* sql`INSERT INTO organization_work_items
      (work_id, request_id, request_json, organization_id, finding_id, project_id,
       binding_id, binding_version, scope, published_revision, workflow_id,
       workflow_version, code_revision, status, attempt_limit, attempt_count,
       creator_subject, created_at, updated_at)
      VALUES (${workId}, 'fixture-request', '{}', ${organizationId}, ${findingId}, ${projectId},
        ${bindingId}, ${date}, NULL, 1, 'fixture-workflow', 1, ${commit},
        'pending', 2, 0, 'creator', ${date}, ${date})`;
  });

const proposal = (p: OrganizationWorkLaunchPlan, replacement: string) =>
  Effect.gen(function* () {
    const reader = yield* OrganizationPatchSourceReader;
    const source = yield* reader.read(p, "answer.mjs");
    const output = {
      fileName: "answer.mjs",
      baseDigest: source.sha256,
      replacementContent: replacement,
      rationale: "Fixture replacement",
    };
    const artifactBytes = buildOrganizationPatchArtifact(source, output);
    return {
      plan: p,
      source,
      proposal: output,
      artifactBytes,
      artifactSha256: sha256(artifactBytes),
    } satisfies OrganizationSingleFileProposalResult;
  });

interface HostControls {
  readonly handles: Map<string, PreparedOrganizationScopedSandbox>;
  denyStopVerification: boolean;
  failWait: boolean;
  failStart: boolean;
  failStop: boolean;
  failDiscard: boolean;
  failAttach: boolean;
  failLaunchMarker: boolean;
  failAfterSubmit: boolean;
  failPrepareAfterHost: boolean;
  beforePrepare?: () => Promise<void>;
}
const makeHost = (controls: HostControls) =>
  Layer.succeed(OrganizationSingleFileAttemptHost, {
    reserve: async () => undefined,
    prepare: async (input) => {
      await controls.beforePrepare?.();
      const handle = await prepareOrganizationScopedSandbox(input);
      controls.handles.set(handle.unitName, handle);
      if (controls.failPrepareAfterHost)
        throw new Error("Injected preparation failure after scope creation");
      return {
        ...handle,
        start: () =>
          controls.failStart ? Promise.reject(new Error("Injected gate failure")) : handle.start(),
        stop: () =>
          controls.failStop ? Promise.reject(new Error("Injected stop failure")) : handle.stop(),
        wait: () =>
          controls.failWait ? Promise.reject(new Error("Injected wait failure")) : handle.wait(),
        discard: () =>
          controls.failDiscard
            ? Promise.reject(new Error("Injected discard failure"))
            : handle.discard(),
      };
    },
    verifyStopped: (identity: OrganizationWorkScopeIdentity) =>
      Effect.tryPromise({
        try: async () => {
          if (controls.denyStopVerification) throw new Error("Injected verifier denial");
          const handle = controls.handles.get(identity.unitName);
          if (
            !handle ||
            handle.invocationId !== identity.invocationId ||
            handle.controlGroup !== identity.controlGroup ||
            handle.sandboxPid !== identity.sandboxPid ||
            handle.pidNamespace !== identity.pidNamespace
          )
            throw new Error("Saved scope identity mismatch");
          // This is the real host's cgroup and PID-namespace stop fence.
          await handle.wait();
        },
        catch: () =>
          new OrganizationSingleFileAttemptError({
            code: "unavailable",
            message: "Exact OS stop is unverified.",
          }),
      }),
  });

const makeLayer = (p: OrganizationWorkLaunchPlan, controls: HostControls, allowPolicy = true) => {
  const host = makeHost(controls);
  const artifactStore = OrganizationWorkArtifactStoreWithAuthority.pipe(
    Layer.provide(Layer.succeed(OrganizationWorkArtifactCaptureAuthority, { permits: () => true })),
  );
  const artifactVerifier = OrganizationWorkArtifactVerifierFromStore.pipe(
    Layer.provideMerge(artifactStore),
  );
  const workBase = OrganizationWorkStoreLayer.pipe(
    Layer.provideMerge(artifactVerifier),
    Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
    Layer.provide(OrganizationWorkApprovalVerifierDisabled),
    Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
    Layer.provide(
      Layer.succeed(OrganizationWorkExecutionAuthority, {
        permits: (action, principal, target) =>
          ["claim", "submit", "cancel", "recover"].includes(action) &&
          principal.subject === workerSubject &&
          target.organizationId === organizationId &&
          target.projectId === projectId &&
          target.bindingId === bindingId &&
          (target.workId === workId || target.workId === secondWorkId),
      }),
    ),
  );
  const work = controls.failAfterSubmit
    ? Layer.effect(
        OrganizationWorkStore,
        Effect.gen(function* () {
          const base = yield* OrganizationWorkStore;
          return {
            ...base,
            submitAttempt: (input, principal) =>
              base.submitAttempt(input, principal).pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new OrganizationSingleFileAttemptError({
                      code: "unavailable",
                      message: "Injected response loss after submit commit.",
                    }),
                  ),
                ),
              ),
          } as OrganizationWorkStore["Service"];
        }),
      ).pipe(Layer.provide(workBase))
    : workBase;
  const stopVerifier = OrganizationSingleFileAttemptScopeVerifierFromHost.pipe(
    Layer.provideMerge(host),
  );
  const scopeBase = OrganizationWorkScopeStoreLayer.pipe(Layer.provideMerge(stopVerifier));
  const scope = controls.failLaunchMarker
    ? Layer.effect(
        OrganizationWorkScopeStore,
        Effect.gen(function* () {
          const base = yield* OrganizationWorkScopeStore;
          return {
            ...base,
            markLaunchRequested: () =>
              Effect.fail(
                new OrganizationWorkScopeError({
                  code: "unavailable",
                  message: "Injected launch marker failure.",
                }),
              ),
          } as OrganizationWorkScopeStore["Service"];
        }),
      ).pipe(Layer.provide(scopeBase))
    : controls.failAttach
      ? Layer.effect(
          OrganizationWorkScopeStore,
          Effect.gen(function* () {
            const base = yield* OrganizationWorkScopeStore;
            return {
              ...base,
              attachPrepared: () =>
                Effect.fail(
                  new OrganizationWorkScopeError({
                    code: "unavailable",
                    message: "Injected attach failure.",
                  }),
                ),
            } as OrganizationWorkScopeStore["Service"];
          }),
        ).pipe(Layer.provide(scopeBase))
      : scopeBase;
  const policy = allowPolicy
    ? Layer.succeed(OrganizationSingleFileAttemptPolicy, {
        select: () => Effect.succeed({ attemptId, workerSubject }),
      })
    : OrganizationSingleFileAttemptPolicyDisabled;
  return Layer.mergeAll(
    host,
    scope,
    artifactStore,
    work,
    OrganizationPatchSourceReaderLive,
    Layer.succeed(OrganizationWorkLaunchPlanner, { plan: () => Effect.succeed(p) }),
    policy,
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
};

const controls = (): HostControls => ({
  handles: new Map(),
  denyStopVerification: false,
  failWait: false,
  failStart: false,
  failStop: false,
  failDiscard: false,
  failAttach: false,
  failLaunchMarker: false,
  failAfterSubmit: false,
  failPrepareAfterHost: false,
});
const available = isOrganizationScopedSandboxAvailable();

it.effect.skipIf(!available)(
  "submits a real verified scoped syntax smoke without independent QA",
  () =>
    withRepo((root, commit) => {
      const p = plan(root, commit);
      const host = controls();
      return Effect.gen(function* () {
        yield* seed(root, commit);
        const input = yield* proposal(
          p,
          "export function solve(input) { return input.value * 2; }\n",
        );
        const result = yield* runOrganizationSingleFileAttempt(input);
        assert.equal(result.status, "submitted");
        assert.match(Buffer.from(result.syntaxEvidenceBytes).toString(), /node-check-syntax-only/);
        const detail = yield* (yield* OrganizationWorkStore).getWork(workId);
        assert.equal(detail.work.status, "blocked");
        assert.equal(detail.attempts[0]?.status, "submitted");
        const saved = yield* (yield* OrganizationWorkArtifactStore).get(attemptId);
        assert.equal(saved?.artifactDigest, result.artifactDigest);
        assert.deepEqual(saved?.patchBytes, input.artifactBytes);
        assert.equal(
          (yield* (yield* OrganizationWorkScopeStore).get(attemptId))?.state,
          "verified-stopped",
        );
        const sql = yield* SqlClient.SqlClient;
        const permit = (yield* sql<{
          state: string;
        }>`SELECT state FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0];
        assert.equal(permit?.state, "released");
      }).pipe(Effect.provide(makeLayer(p, host)));
    }),
);

it.effect.skipIf(!available)(
  "syntax failure cancels only after verified stop and releases permit",
  () =>
    withRepo((root, commit) => {
      const p = plan(root, commit);
      return Effect.gen(function* () {
        yield* seed(root, commit);
        const input = yield* proposal(p, "export function broken( {\n");
        const result = yield* runOrganizationSingleFileAttempt(input);
        assert.equal(result.status, "canceled");
        assert.match(Buffer.from(result.syntaxEvidenceBytes).toString(), /"exitCode":1/);
        assert.equal(
          (yield* (yield* OrganizationWorkStore).getWork(workId)).work.status,
          "canceled",
        );
        assert.equal(
          (yield* (yield* OrganizationWorkScopeStore).get(attemptId))?.state,
          "verified-stopped",
        );
        assert.equal(yield* (yield* OrganizationWorkArtifactStore).get(attemptId), null);
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql<{
            state: string;
          }>`SELECT state FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]
            ?.state,
          "released",
        );
      }).pipe(Effect.provide(makeLayer(p, controls())));
    }),
);

it.effect.skipIf(!available)("stale binding refuses claim before caller code can start", () =>
  withRepo((root, commit) => {
    const p = plan(root, commit);
    return Effect.gen(function* () {
      yield* seed(root, commit);
      const input = yield* proposal(p, "export const value = 1;\n");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organization_project_bindings SET detached_at = ${date} WHERE binding_id = ${bindingId}`;
      const result = yield* Effect.flip(runOrganizationSingleFileAttempt(input));
      assert.equal(codeOf(result), "forbidden");
      assert.equal(
        (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM organization_work_attempts`)[0]?.n,
        0,
      );
    }).pipe(Effect.provide(makeLayer(p, controls())));
  }),
);

it.effect("tampered proposal bytes are rejected before claim or host preparation", () =>
  withRepo((root, commit) => {
    const p = plan(root, commit);
    const host = controls();
    return Effect.gen(function* () {
      yield* seed(root, commit);
      const input = yield* proposal(p, "export const value = 1;\n");
      input.artifactBytes[12] = 0;
      const error = yield* Effect.flip(runOrganizationSingleFileAttempt(input));
      assert.equal(codeOf(error), "invalid");
      assert.equal(host.handles.size, 0);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM organization_work_attempts`)[0]?.n,
        0,
      );
    }).pipe(Effect.provide(makeLayer(p, host)));
  }),
);

it.effect(
  "commits the launch marker before the host call and holds the permit on host failure",
  () =>
    withRepo((root, commit) => {
      const p = plan(root, commit);
      const host = controls();
      let hostEntered = false;
      let enteredResolve!: () => void;
      let failResolve!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      const failHost = new Promise<void>((resolve) => {
        failResolve = resolve;
      });
      return Effect.gen(function* () {
        yield* seed(root, commit);
        const input = yield* proposal(p, "export const value = 1;\n");
        const scopes = yield* OrganizationWorkScopeStore;
        host.beforePrepare = async () => {
          hostEntered = true;
          enteredResolve();
          await failHost;
          throw new Error("Injected host failure after launch marker");
        };
        const running = yield* Effect.forkChild(runOrganizationSingleFileAttempt(input));
        yield* Effect.promise(() => entered);
        const markerAtHostCall = yield* scopes.getPreparation(attemptId);
        failResolve();
        assert.ok(markerAtHostCall?.launchRequestedAt);
        assert.match(markerAtHostCall.unitName ?? "", /^t3-org-sandbox-[a-f0-9]{32}\.scope$/);
        const error = yield* Fiber.join(running).pipe(Effect.flip);
        assert.equal(codeOf(error), "unavailable");
        assert.equal(hostEntered, true);
        assert.equal(host.handles.size, 0);
        assert.ok((yield* scopes.getPreparation(attemptId))?.launchRequestedAt);
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql<{ state: string }>`SELECT state
        FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]?.state,
          "active",
        );
        assert.ok(
          yield* sql`UPDATE organization_work_resource_permits SET state = 'released'
        WHERE attempt_id = ${attemptId}`.pipe(Effect.flip),
        );
      }).pipe(Effect.provide(makeLayer(p, host)));
    }),
);

it.effect("a failed prelaunch marker never calls the host or records launch", () =>
  withRepo((root, commit) => {
    const p = plan(root, commit);
    const host = controls();
    host.failLaunchMarker = true;
    let hostEntered = false;
    host.beforePrepare = async () => {
      hostEntered = true;
    };
    return Effect.gen(function* () {
      yield* seed(root, commit);
      const input = yield* proposal(p, "export const value = 1;\n");
      const error = yield* runOrganizationSingleFileAttempt(input).pipe(Effect.flip);
      assert.equal(codeOf(error), "unavailable");
      assert.equal(hostEntered, false);
      assert.equal(host.handles.size, 0);
      const preparation = yield* (yield* OrganizationWorkScopeStore).getPreparation(attemptId);
      assert.ok(preparation?.unitName);
      assert.equal(preparation.launchRequestedAt, null);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state
        FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]?.state,
        "active",
      );
    }).pipe(Effect.provide(makeLayer(p, host)));
  }),
);

it.effect.skipIf(!available)("unverified stop keeps the active permit for recovery", () =>
  withRepo((root, commit) => {
    const p = plan(root, commit);
    const host = controls();
    host.denyStopVerification = true;
    return Effect.gen(function* () {
      yield* seed(root, commit);
      const input = yield* proposal(p, "export const value = 1;\n");
      yield* Effect.flip(runOrganizationSingleFileAttempt(input));
      const scope = yield* (yield* OrganizationWorkScopeStore).get(attemptId);
      assert.equal(scope?.state, "stop-requested");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]
          ?.state,
        "active",
      );
      assert.equal((yield* (yield* OrganizationWorkStore).getWork(workId)).work.status, "running");
    }).pipe(Effect.provide(makeLayer(p, host)));
  }),
);

it.effect.skipIf(!available)("a failed host stop never releases a claimed permit", () =>
  withRepo((root, commit) => {
    const p = plan(root, commit);
    const host = controls();
    host.failWait = true;
    host.failStop = true;
    return Effect.gen(function* () {
      yield* seed(root, commit);
      const input = yield* proposal(p, "export const value = 1;\n");
      yield* Effect.flip(runOrganizationSingleFileAttempt(input));
      const scope = yield* (yield* OrganizationWorkScopeStore).get(attemptId);
      assert.equal(scope?.state, "stop-requested");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]
          ?.state,
        "active",
      );
      // Clean the disposable OS fixture without certifying its persisted stop.
      const actual = [...host.handles.values()][0];
      assert.ok(actual);
      yield* Effect.promise(() => actual.stop());
    }).pipe(Effect.provide(makeLayer(p, host)));
  }),
);

it.effect.skipIf(!available)("failed start gate stops scope before canceling the attempt", () =>
  withRepo((root, commit) => {
    const p = plan(root, commit);
    const host = controls();
    host.failStart = true;
    return Effect.gen(function* () {
      yield* seed(root, commit);
      const input = yield* proposal(p, "export const value = 1;\n");
      yield* Effect.flip(runOrganizationSingleFileAttempt(input));
      assert.equal(
        (yield* (yield* OrganizationWorkScopeStore).get(attemptId))?.state,
        "verified-stopped",
      );
      assert.equal((yield* (yield* OrganizationWorkStore).getWork(workId)).work.status, "canceled");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]
          ?.state,
        "released",
      );
    }).pipe(Effect.provide(makeLayer(p, host)));
  }),
);

it.effect.skipIf(!available)("failed discard after claimed unattached scope retains permit", () =>
  withRepo((root, commit) => {
    const p = plan(root, commit);
    const host = controls();
    host.failAttach = true;
    host.failDiscard = true;
    return Effect.gen(function* () {
      yield* seed(root, commit);
      const input = yield* proposal(p, "export const value = 1;\n");
      yield* Effect.flip(runOrganizationSingleFileAttempt(input));
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]
          ?.state,
        "active",
      );
      assert.equal(yield* (yield* OrganizationWorkScopeStore).get(attemptId), null);
      const actual = [...host.handles.values()][0];
      assert.ok(actual);
      yield* Effect.promise(() => actual.discard());
    }).pipe(Effect.provide(makeLayer(p, host)));
  }),
);

it.effect.skipIf(!available)("lost submit response reconciles exact persisted receipt", () =>
  withRepo((root, commit) => {
    const p = plan(root, commit);
    const host = controls();
    host.failAfterSubmit = true;
    return Effect.gen(function* () {
      yield* seed(root, commit);
      const input = yield* proposal(p, "export const value = 1;\n");
      const result = yield* runOrganizationSingleFileAttempt(input);
      assert.equal(result.status, "submitted");
      assert.equal((yield* (yield* OrganizationWorkStore).getWork(workId)).work.status, "blocked");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]
          ?.state,
        "released",
      );
    }).pipe(Effect.provide(makeLayer(p, host)));
  }),
);

it.effect.skipIf(!available)(
  "preparation failure without returned scope identity keeps the running permit",
  () =>
    withRepo((root, commit) => {
      const p = plan(root, commit);
      const host = controls();
      host.failPrepareAfterHost = true;
      return Effect.gen(function* () {
        yield* seed(root, commit);
        const input = yield* proposal(p, "export const value = 1;\n");
        const error = yield* Effect.flip(runOrganizationSingleFileAttempt(input));
        assert.equal(codeOf(error), "unavailable");
        assert.match(error.message, /retains its resource permit/);
        assert.equal(
          (yield* (yield* OrganizationWorkStore).getWork(workId)).work.status,
          "running",
        );
        assert.equal(yield* (yield* OrganizationWorkScopeStore).get(attemptId), null);
        const sql = yield* SqlClient.SqlClient;
        const reservation = yield* (yield* OrganizationWorkScopeStore).getPreparation(attemptId);
        assert.ok(reservation?.unitName);
        assert.match(reservation.unitName, /^t3-org-sandbox-[a-f0-9]{32}\.scope$/);
        assert.equal(
          (yield* sql<{
            state: string;
          }>`SELECT state FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]
            ?.state,
          "active",
        );
        assert.equal(host.handles.size, 1);
        assert.equal([...host.handles.keys()][0], reservation.unitName);
        yield* sql`UPDATE organization_work_attempts SET lease_until = '1900-01-01'
          WHERE attempt_id = ${attemptId}`;
        yield* sql`UPDATE organization_work_resource_permits SET lease_until = '1900-01-01'
          WHERE attempt_id = ${attemptId}`;
        const recovery = yield* Effect.flip(
          (yield* OrganizationWorkStore).recoverExpired(
            { workId, transitionId: "prep-failed-recovery" },
            { subject: workerSubject },
          ),
        );
        assert.equal(recovery.code, "conflict");
        assert.equal(
          (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
            WHERE attempt_id = ${attemptId}`)[0]?.state,
          "active",
        );
        // Fixture-only cleanup of the unreturned OS handle. No database permit
        // is released, because the coordinator never received its identity.
        const actual = [...host.handles.values()][0];
        assert.ok(actual);
        yield* Effect.promise(() => actual.discard());
      }).pipe(Effect.provide(makeLayer(p, host)));
    }),
);

it.effect.skipIf(!available)(
  "a claim recovered before its preparation marker cannot launch a reserved unit",
  () =>
    withRepo((root, commit) => {
      const p = plan(root, commit);
      const host = controls();
      return Effect.gen(function* () {
        yield* seed(root, commit);
        const work = yield* OrganizationWorkStore;
        const scopes = yield* OrganizationWorkScopeStore;
        yield* work.claimAttempt(
          { workId, attemptId, leaseSeconds: 120, transitionId: "claim-before-marker" },
          { subject: workerSubject },
        );
        assert.equal(yield* scopes.getPreparation(attemptId), null);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE organization_work_attempts SET lease_until = '1900-01-01'
          WHERE attempt_id = ${attemptId}`;
        yield* sql`UPDATE organization_work_resource_permits SET lease_until = '1900-01-01'
          WHERE attempt_id = ${attemptId}`;
        assert.equal(
          (yield* work.recoverExpired(
            { workId, transitionId: "recover-before-marker" },
            { subject: workerSubject },
          )).work.status,
          "recovering",
        );
        assert.equal(
          (yield* Effect.flip(
            scopes.markPreparing(
              attemptId,
              "t3-org-sandbox-00000000000000000000000000000001.scope",
            ),
          )).code,
          "conflict",
        );
        assert.equal(host.handles.size, 0);
      }).pipe(Effect.provide(makeLayer(p, host)));
    }),
);

it.effect.skipIf(!available)(
  "a second work claim hits the Project limit while the first host is preparing",
  () =>
    withRepo((root, commit) => {
      const p = plan(root, commit);
      const host = controls();
      let enteredResolve!: () => void;
      let releaseResolve!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      host.beforePrepare = async () => {
        enteredResolve();
        await release;
      };
      return Effect.gen(function* () {
        yield* seed(root, commit);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO organization_intake_findings
          (finding_id, organization_id, source_id, dedup_key, title, summary,
           observation_ids_json, state, created_at, project_id)
          VALUES (${secondFindingId}, ${organizationId}, 'attempt-bridge-source',
            'fixture-finding-2', 'Second finding', '', '[]', 'tentative', ${date}, ${projectId})`;
        yield* sql`INSERT INTO organization_work_items
          (work_id, request_id, request_json, organization_id, finding_id, project_id,
           binding_id, binding_version, scope, published_revision, workflow_id,
           workflow_version, code_revision, status, attempt_limit, attempt_count,
           creator_subject, created_at, updated_at)
          VALUES (${secondWorkId}, 'fixture-request-2', '{}', ${organizationId}, ${secondFindingId}, ${projectId},
            ${bindingId}, ${date}, NULL, 1, 'fixture-workflow', 1, ${commit},
            'pending', 1, 0, 'creator', ${date}, ${date})`;
        const input = yield* proposal(p, "export const value = 1;\n");
        const coordinating = yield* Effect.forkChild(runOrganizationSingleFileAttempt(input));
        yield* Effect.race(
          Effect.promise(() => entered),
          Fiber.join(coordinating).pipe(
            Effect.flatMap(() => Effect.die("Attempt finished before preparation gate.")),
          ),
        );
        assert.equal(host.handles.size, 0);
        const permitBefore = yield* sql<{
          state: string;
        }>`SELECT state FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`;
        assert.equal(permitBefore[0]?.state, "active");
        assert.ok(
          (yield* sql<{ attempt_id: string }>`SELECT attempt_id
          FROM organization_work_scope_preparations WHERE attempt_id = ${attemptId}`)[0],
        );
        const denied = yield* Effect.flip(
          (yield* OrganizationWorkStore).claimAttempt(
            {
              workId: secondWorkId,
              attemptId: secondAttemptId,
              transitionId: "second-work-claim",
              leaseSeconds: 120,
            },
            { subject: workerSubject },
          ),
        );
        assert.equal(denied.code, "conflict");
        assert.match(denied.message, /resource concurrency limit/);
        assert.equal(
          (yield* sql<{
            n: number;
          }>`SELECT COUNT(*) AS n FROM organization_work_resource_permits WHERE state = 'active'`)[0]
            ?.n,
          1,
        );
        releaseResolve();
        const result = yield* Fiber.join(coordinating);
        assert.equal(result.status, "submitted");
      }).pipe(Effect.provide(makeLayer(p, host)));
    }),
);
