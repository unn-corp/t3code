// @effect-diagnostics nodeBuiltinImport:off - Current Project root verification needs canonical host paths.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { buildOrganizationGitCandidate } from "./OrganizationGitCandidateBuilder.ts";
import {
  OrganizationGitCandidateIntentStore,
  type OrganizationGitCandidateIntent,
} from "./OrganizationGitCandidateIntentStore.ts";
import {
  inspectOrganizationGitCandidateRef,
  retainOrganizationGitCandidate,
} from "./OrganizationGitCandidateRetention.ts";
import {
  proveOrganizationGitResult,
  type OrganizationGitResultProof,
} from "./OrganizationGitResultProof.ts";
import { OrganizationWorkArtifactStore } from "./OrganizationWorkArtifactStore.ts";

export class OrganizationGitCandidateCoordinatorError extends Schema.TaggedError<OrganizationGitCandidateCoordinatorError>()(
  "OrganizationGitCandidateCoordinatorError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationGitCandidateCoordinatorError["code"], message: string) =>
  new OrganizationGitCandidateCoordinatorError({ code, message });
const isCoordinatorError = Schema.is(OrganizationGitCandidateCoordinatorError);
const unavailable = () => failure("unavailable", "Candidate coordination is unavailable.");

export interface OrganizationGitCandidateCoordinationResult {
  readonly intent: OrganizationGitCandidateIntent;
  readonly proof: OrganizationGitResultProof;
  readonly createdRef: boolean;
}

/** Mandatory server-owned authority checked before Git object or ref mutation. */
export class OrganizationGitCandidateCoordinatorAuthority extends Context.Service<
  OrganizationGitCandidateCoordinatorAuthority,
  {
    readonly permitsAttempt: (attemptId: string) => boolean;
    readonly permits: (intent: OrganizationGitCandidateIntent) => boolean;
  }
>()(
  "t3/organizations/OrganizationGitCandidateCoordinator/OrganizationGitCandidateCoordinatorAuthority",
) {}

type ProjectRow = { workspace_root: string; deleted_at: string | null };
const samePrepared = (
  left: OrganizationGitCandidateIntent,
  right: OrganizationGitCandidateIntent,
) =>
  left.attemptId === right.attemptId &&
  left.workId === right.workId &&
  left.organizationId === right.organizationId &&
  left.projectId === right.projectId &&
  left.bindingId === right.bindingId &&
  left.bindingVersion === right.bindingVersion &&
  left.baseCommit === right.baseCommit &&
  left.artifactRef === right.artifactRef &&
  left.artifactReceiptDigest === right.artifactReceiptDigest &&
  left.reviewedArtifactDigest === right.reviewedArtifactDigest &&
  left.relativePath === right.relativePath &&
  left.refName === right.refName;

/**
 * Disconnected coordinator. Optional callbacks are test-only interleaving/fault points;
 * no server runtime mounts this function.
 */
export function coordinateOrganizationGitCandidate(
  attemptId: string,
  afterRefRetained?: () => Effect.Effect<void, OrganizationGitCandidateCoordinatorError>,
  beforeRefRetained?: () => Effect.Effect<void, OrganizationGitCandidateCoordinatorError>,
): Effect.Effect<
  OrganizationGitCandidateCoordinationResult,
  OrganizationGitCandidateCoordinatorError,
  | SqlClient.SqlClient
  | OrganizationGitCandidateIntentStore
  | OrganizationWorkArtifactStore
  | OrganizationGitCandidateCoordinatorAuthority
> {
  if (typeof attemptId !== "string" || attemptId.length < 1 || attemptId.length > 256)
    return Effect.fail(failure("invalid", "Attempt ID is invalid."));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const intents = yield* OrganizationGitCandidateIntentStore;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const authority = yield* OrganizationGitCandidateCoordinatorAuthority;
    if (!authority.permitsAttempt(attemptId))
      return yield* failure("forbidden", "Candidate coordination is not authorized.");
    const prepared = yield* intents
      .prepare(attemptId)
      .pipe(Effect.mapError((error) => failure(error.code, error.message)));
    if (!authority.permits(prepared))
      return yield* failure("forbidden", "Candidate coordination is not authorized.");
    const artifact = yield* artifacts
      .get(attemptId)
      .pipe(Effect.mapError((error) => failure(error.code, error.message)));
    if (
      !artifact ||
      artifact.attemptId !== prepared.attemptId ||
      artifact.workId !== prepared.workId ||
      artifact.projectId !== prepared.projectId ||
      artifact.artifactRef !== prepared.artifactRef ||
      artifact.artifactDigest !== prepared.artifactReceiptDigest ||
      artifact.baseCodeRevision !== prepared.baseCommit ||
      NodeCrypto.createHash("sha256").update(artifact.patchBytes).digest("hex") !==
        prepared.reviewedArtifactDigest
    )
      return yield* failure("conflict", "Prepared artifact differs from persisted evidence.");
    const bytes = Uint8Array.from(artifact.patchBytes);
    const projectRoot = yield* sql<ProjectRow>`SELECT workspace_root, deleted_at
      FROM projection_projects WHERE project_id = ${prepared.projectId}`.pipe(
      Effect.mapError(() => unavailable()),
      Effect.flatMap((rows) => {
        const project = rows[0];
        if (!project || project.deleted_at !== null || !NodePath.isAbsolute(project.workspace_root))
          return Effect.fail(failure("conflict", "Current Project root is unavailable."));
        return Effect.succeed(project.workspace_root);
      }),
    );
    const canonicalRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(projectRoot),
      catch: () => failure("unavailable", "Current Project root could not be resolved."),
    });
    const inspect = () =>
      inspectOrganizationGitCandidateRef({
        projectRoot: canonicalRoot,
        reviewedArtifactBytes: bytes,
      }).pipe(Effect.mapError((error) => failure(error.code, error.message)));
    const prove = (resultCommit: string) =>
      proveOrganizationGitResult({
        projectRoot: canonicalRoot,
        baseCommit: prepared.baseCommit,
        resultCommit,
        reviewedArtifactBytes: bytes,
      }).pipe(Effect.mapError((error) => failure(error.code, error.message)));
    const inspected = yield* inspect();
    if (inspected.refName !== prepared.refName)
      return yield* failure("conflict", "Candidate ref differs from the prepared intent.");
    const built =
      inspected.status === "absent"
        ? yield* buildOrganizationGitCandidate({
            projectRoot: canonicalRoot,
            reviewedArtifactBytes: bytes,
          }).pipe(Effect.mapError((error) => failure(error.code, error.message)))
        : null;
    if (beforeRefRetained) yield* beforeRefRetained();
    // The conditional UPDATE acquires SQLite's write lock before final authority
    // checks. Binding revocation cannot commit until Git inspection/CAS and the
    // retained acknowledgement finish or this transaction rolls back.
    return yield* Effect.uninterruptible(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const locked = yield* sql<{ binding_id: string }>`UPDATE organization_project_bindings
            SET updated_at = updated_at
            WHERE binding_id = ${prepared.bindingId}
              AND organization_id = ${prepared.organizationId}
              AND project_id = ${prepared.projectId}
              AND access = 'write' AND detached_at IS NULL
              AND updated_at = ${prepared.bindingVersion}
              AND EXISTS (SELECT 1 FROM organizations o
                WHERE o.organization_id = ${prepared.organizationId} AND o.lifecycle = 'active')
              AND EXISTS (SELECT 1 FROM projection_projects pr
                WHERE pr.project_id = ${prepared.projectId} AND pr.deleted_at IS NULL
                  AND pr.workspace_root = ${projectRoot})
              AND EXISTS (SELECT 1 FROM organization_work_items w
                JOIN organization_work_attempts a ON a.work_id = w.work_id
                JOIN organization_git_candidate_intents i ON i.attempt_id = a.attempt_id
                WHERE a.attempt_id = ${attemptId}
                  AND a.status = 'submitted' AND w.status = 'blocked'
                  AND a.number = w.attempt_count
                  AND w.work_id = ${prepared.workId}
                  AND w.organization_id = ${prepared.organizationId}
                  AND w.project_id = ${prepared.projectId}
                  AND w.binding_id = organization_project_bindings.binding_id
                  AND w.binding_version = organization_project_bindings.updated_at
                  AND w.scope IS organization_project_bindings.scope
                  AND w.code_revision = ${prepared.baseCommit}
                  AND a.artifact_digest = ${prepared.artifactReceiptDigest}
                  AND a.artifact_ref = ${prepared.artifactRef}
                  AND i.work_id = w.work_id AND i.organization_id = w.organization_id
                  AND i.project_id = w.project_id AND i.binding_id = w.binding_id
                  AND i.binding_version = w.binding_version
                  AND i.base_commit = w.code_revision
                  AND i.artifact_ref = a.artifact_ref
                  AND i.artifact_receipt_digest = a.artifact_digest
                  AND i.reviewed_artifact_digest = ${prepared.reviewedArtifactDigest}
                  AND i.relative_path = ${prepared.relativePath}
                  AND i.ref_name = ${prepared.refName}
                  AND i.status IN ('prepared', 'retained'))
            RETURNING binding_id`.pipe(Effect.mapError(() => unavailable()));
            if (!locked[0])
              return yield* failure(
                "conflict",
                "Current Project authority no longer permits retention.",
              );
            const rechecked = yield* intents
              .prepare(attemptId)
              .pipe(Effect.mapError((error) => failure(error.code, error.message)));
            if (!samePrepared(prepared, rechecked))
              return yield* failure("conflict", "Candidate intent changed during construction.");
            if (!authority.permits(rechecked))
              return yield* failure("forbidden", "Candidate coordination is no longer authorized.");
            const currentRoot = yield* Effect.tryPromise({
              try: () => NodeFSP.realpath(projectRoot),
              catch: () => failure("unavailable", "Current Project root could not be resolved."),
            });
            if (currentRoot !== canonicalRoot)
              return yield* failure(
                "conflict",
                "Project root changed during candidate construction.",
              );
            const current = yield* inspect();
            if (current.refName !== prepared.refName)
              return yield* failure("conflict", "Candidate ref differs from the prepared intent.");
            let createdRef = false;
            let resultCommit: string;
            let proof: OrganizationGitResultProof;
            if (current.status === "present") {
              resultCommit = current.resultCommit;
              proof = yield* prove(resultCommit);
            } else {
              if (!built)
                return yield* failure(
                  "conflict",
                  "Previously inspected candidate ref disappeared.",
                );
              const retained = yield* retainOrganizationGitCandidate({
                projectRoot: canonicalRoot,
                baseCommit: prepared.baseCommit,
                resultCommit: built.resultCommit,
                reviewedArtifactBytes: bytes,
              }).pipe(
                Effect.mapError((error) => failure(error.code, error.message)),
                Effect.catchIf(
                  (error) => error.code === "conflict",
                  (error) =>
                    Effect.gen(function* () {
                      const winner = yield* inspect();
                      if (winner.status !== "present" || winner.refName !== prepared.refName)
                        return yield* error;
                      const winnerProof = yield* prove(winner.resultCommit);
                      return {
                        refName: winner.refName,
                        resultCommit: winner.resultCommit,
                        proof: winnerProof,
                        created: false,
                      };
                    }),
                ),
              );
              if (retained.refName !== prepared.refName)
                return yield* failure("conflict", "Retained ref differs from the prepared intent.");
              resultCommit = retained.resultCommit;
              proof = retained.proof;
              createdRef = retained.created;
            }
            if (afterRefRetained) yield* afterRefRetained();
            const intent = yield* intents
              .markRetained(attemptId, resultCommit, prepared.refName)
              .pipe(Effect.mapError((error) => failure(error.code, error.message)));
            return { intent, proof, createdRef };
          }),
        )
        .pipe(Effect.mapError((error) => (isCoordinatorError(error) ? error : unavailable()))),
    );
  });
}
