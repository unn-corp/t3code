// @effect-diagnostics nodeBuiltinImport:off - This Node-only server module uses synchronous host crypto for persistent IDs or hashes; replacing it would add Crypto service requirements through the persistence API.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreLive,
} from "./OrganizationWorkArtifactStore.ts";
import { decodeOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PRIVATE_REF_PREFIX = "refs/t3-organizations/candidates/";

export class OrganizationGitCandidateIntentError extends Schema.TaggedError<OrganizationGitCandidateIntentError>()(
  "OrganizationGitCandidateIntentError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationGitCandidateIntentError["code"], message: string) =>
  new OrganizationGitCandidateIntentError({ code, message });
const isIntentError = Schema.is(OrganizationGitCandidateIntentError);
const unavailable = () => failure("unavailable", "Candidate intent storage is unavailable.");

export interface OrganizationGitCandidateIntent {
  readonly attemptId: string;
  readonly workId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly baseCommit: string;
  readonly artifactRef: string;
  readonly artifactReceiptDigest: string;
  readonly reviewedArtifactDigest: string;
  readonly relativePath: string;
  readonly refName: string;
  readonly status: "prepared" | "retained";
  readonly resultCommit: string | null;
  readonly preparedAt: string;
  readonly retainedAt: string | null;
}

/** A trusted caller must prove the exact Git ref before reporting retention. */
export class OrganizationGitCandidateRetentionAuthority extends Context.Service<
  OrganizationGitCandidateRetentionAuthority,
  {
    readonly permits: (input: {
      readonly intent: OrganizationGitCandidateIntent;
      readonly resultCommit: string;
      readonly refName: string;
    }) => boolean;
  }
>()(
  "t3/organizations/OrganizationGitCandidateIntentStore/OrganizationGitCandidateRetentionAuthority",
) {}
export const OrganizationGitCandidateRetentionDisabled = Layer.succeed(
  OrganizationGitCandidateRetentionAuthority,
  { permits: () => false },
);

type IntentRow = {
  attempt_id: string;
  work_id: string;
  organization_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  base_commit: string;
  artifact_ref: string;
  artifact_receipt_digest: string;
  reviewed_artifact_digest: string;
  relative_path: string;
  ref_name: string;
  status: "prepared" | "retained";
  result_commit: string | null;
  prepared_at: string;
  retained_at: string | null;
};
type TargetRow = {
  attempt_id: string;
  work_id: string;
  organization_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  work_scope: string | null;
  code_revision: string;
  work_status: string;
  attempt_status: string;
  attempt_number: number;
  attempt_count: number;
  artifact_digest: string | null;
  artifact_ref: string | null;
  binding_organization_id: string | null;
  binding_project_id: string | null;
  binding_access: string | null;
  binding_scope: string | null;
  binding_version_now: string | null;
  binding_detached_at: string | null;
  lifecycle: string | null;
  project_id_present: string | null;
  project_deleted_at: string | null;
};
const decodeRow = (row: IntentRow): OrganizationGitCandidateIntent => ({
  attemptId: row.attempt_id,
  workId: row.work_id,
  organizationId: row.organization_id,
  projectId: row.project_id,
  bindingId: row.binding_id,
  bindingVersion: row.binding_version,
  baseCommit: row.base_commit,
  artifactRef: row.artifact_ref,
  artifactReceiptDigest: row.artifact_receipt_digest,
  reviewedArtifactDigest: row.reviewed_artifact_digest,
  relativePath: row.relative_path,
  refName: row.ref_name,
  status: row.status,
  resultCommit: row.result_commit,
  preparedAt: row.prepared_at,
  retainedAt: row.retained_at,
});
const samePrepared = (
  saved: OrganizationGitCandidateIntent,
  expected: Omit<
    OrganizationGitCandidateIntent,
    "status" | "resultCommit" | "preparedAt" | "retainedAt"
  >,
) =>
  saved.attemptId === expected.attemptId &&
  saved.workId === expected.workId &&
  saved.organizationId === expected.organizationId &&
  saved.projectId === expected.projectId &&
  saved.bindingId === expected.bindingId &&
  saved.bindingVersion === expected.bindingVersion &&
  saved.baseCommit === expected.baseCommit &&
  saved.artifactRef === expected.artifactRef &&
  saved.artifactReceiptDigest === expected.artifactReceiptDigest &&
  saved.reviewedArtifactDigest === expected.reviewedArtifactDigest &&
  saved.relativePath === expected.relativePath &&
  saved.refName === expected.refName;

export interface OrganizationGitCandidateIntentStoreShape {
  readonly prepare: (
    attemptId: string,
  ) => Effect.Effect<OrganizationGitCandidateIntent, OrganizationGitCandidateIntentError>;
  readonly markRetained: (
    attemptId: string,
    resultCommit: string,
    refName: string,
  ) => Effect.Effect<OrganizationGitCandidateIntent, OrganizationGitCandidateIntentError>;
  readonly get: (
    attemptId: string,
  ) => Effect.Effect<OrganizationGitCandidateIntent | null, OrganizationGitCandidateIntentError>;
  readonly listPrepared: (
    limit: number,
  ) => Effect.Effect<
    readonly OrganizationGitCandidateIntent[],
    OrganizationGitCandidateIntentError
  >;
}
export class OrganizationGitCandidateIntentStore extends Context.Service<
  OrganizationGitCandidateIntentStore,
  OrganizationGitCandidateIntentStoreShape
>()("t3/organizations/OrganizationGitCandidateIntentStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* OrganizationWorkArtifactStore;
  const authority = yield* OrganizationGitCandidateRetentionAuthority;
  const rowFor = (attemptId: string) =>
    sql<IntentRow>`SELECT * FROM organization_git_candidate_intents WHERE attempt_id = ${attemptId}`;
  const transaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error): OrganizationGitCandidateIntentError =>
          isIntentError(error) ? error : unavailable(),
        ),
      );
  const get: OrganizationGitCandidateIntentStoreShape["get"] = (attemptId) =>
    rowFor(attemptId).pipe(
      Effect.map((rows) => (rows[0] ? decodeRow(rows[0]) : null)),
      Effect.mapError(() => unavailable()),
    );
  const prepare: OrganizationGitCandidateIntentStoreShape["prepare"] = (attemptId) => {
    if (typeof attemptId !== "string" || attemptId.length < 1 || attemptId.length > 256)
      return Effect.fail(failure("invalid", "Attempt ID is invalid."));
    return transaction(
      Effect.gen(function* () {
        const target = (yield* sql<TargetRow>`SELECT
          a.attempt_id, a.work_id, a.status AS attempt_status,
          a.number AS attempt_number, a.artifact_digest, a.artifact_ref,
          w.organization_id, w.project_id, w.binding_id, w.binding_version,
          w.scope AS work_scope, w.code_revision, w.status AS work_status,
          w.attempt_count,
          b.organization_id AS binding_organization_id,
          b.project_id AS binding_project_id, b.access AS binding_access,
          b.scope AS binding_scope, b.updated_at AS binding_version_now,
          b.detached_at AS binding_detached_at,
          o.lifecycle, pr.project_id AS project_id_present,
          pr.deleted_at AS project_deleted_at
          FROM organization_work_attempts a
          JOIN organization_work_items w ON w.work_id = a.work_id
          LEFT JOIN organization_project_bindings b ON b.binding_id = w.binding_id
          LEFT JOIN organizations o ON o.organization_id = w.organization_id
          LEFT JOIN projection_projects pr ON pr.project_id = w.project_id
          WHERE a.attempt_id = ${attemptId}`)[0];
        if (!target) return yield* failure("not_found", "Attempt was not found.");
        if (
          target.attempt_status !== "submitted" ||
          target.work_status !== "blocked" ||
          target.attempt_number !== target.attempt_count ||
          target.lifecycle !== "active" ||
          target.binding_organization_id !== target.organization_id ||
          target.binding_project_id !== target.project_id ||
          target.binding_access !== "write" ||
          target.binding_detached_at !== null ||
          target.binding_version_now !== target.binding_version ||
          target.binding_scope !== target.work_scope ||
          target.project_id_present !== target.project_id ||
          target.project_deleted_at !== null ||
          !target.artifact_digest ||
          !target.artifact_ref ||
          !FULL_OID.test(target.code_revision)
        )
          return yield* failure("conflict", "Attempt or Project binding is no longer eligible.");
        const artifact = yield* artifacts
          .get(attemptId)
          .pipe(Effect.mapError((error) => failure(error.code, error.message)));
        if (
          !artifact ||
          artifact.attemptId !== attemptId ||
          artifact.workId !== target.work_id ||
          artifact.projectId !== target.project_id ||
          artifact.baseCodeRevision !== target.code_revision ||
          artifact.artifactDigest !== target.artifact_digest ||
          artifact.artifactRef !== target.artifact_ref
        )
          return yield* failure(
            "conflict",
            "Submitted artifact identity does not match the attempt.",
          );
        yield* artifacts
          .verifySubmitted(artifact)
          .pipe(Effect.mapError((error) => failure(error.code, error.message)));
        const canonical = yield* Effect.try({
          try: () => decodeOrganizationSingleFileArtifact(artifact.patchBytes),
          catch: () =>
            failure("invalid", "Submitted artifact is not canonical single-file evidence."),
        });
        if (canonical.baseCommit !== target.code_revision)
          return yield* failure(
            "conflict",
            "Artifact base commit differs from pinned work revision.",
          );
        const reviewedArtifactDigest = NodeCrypto.createHash("sha256")
          .update(artifact.patchBytes)
          .digest("hex");
        const expected = {
          attemptId,
          workId: target.work_id,
          organizationId: target.organization_id,
          projectId: target.project_id,
          bindingId: target.binding_id,
          bindingVersion: target.binding_version,
          baseCommit: target.code_revision,
          artifactRef: artifact.artifactRef,
          artifactReceiptDigest: artifact.artifactDigest,
          reviewedArtifactDigest,
          relativePath: canonical.relativePath,
          refName: `${PRIVATE_REF_PREFIX}${reviewedArtifactDigest}`,
        };
        const prior = (yield* rowFor(attemptId))[0];
        if (prior) {
          const saved = decodeRow(prior);
          if (!samePrepared(saved, expected))
            return yield* failure(
              "conflict",
              "Existing candidate intent differs from current evidence.",
            );
          return saved;
        }
        const time = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* sql`INSERT INTO organization_git_candidate_intents
          (attempt_id, work_id, organization_id, project_id, binding_id, binding_version,
           base_commit, artifact_ref, artifact_receipt_digest, reviewed_artifact_digest,
           relative_path, ref_name, status, result_commit, prepared_at, retained_at)
          VALUES (${attemptId}, ${expected.workId}, ${expected.organizationId},
            ${expected.projectId}, ${expected.bindingId}, ${expected.bindingVersion},
            ${expected.baseCommit}, ${expected.artifactRef}, ${expected.artifactReceiptDigest},
            ${expected.reviewedArtifactDigest}, ${expected.relativePath}, ${expected.refName},
            'prepared', NULL, ${time}, NULL)`;
        const inserted = (yield* rowFor(attemptId))[0];
        if (!inserted) return yield* unavailable();
        return decodeRow(inserted);
      }),
    );
  };
  const markRetained: OrganizationGitCandidateIntentStoreShape["markRetained"] = (
    attemptId,
    resultCommit,
    refName,
  ) => {
    if (
      typeof attemptId !== "string" ||
      attemptId.length < 1 ||
      attemptId.length > 256 ||
      typeof resultCommit !== "string" ||
      !FULL_OID.test(resultCommit) ||
      typeof refName !== "string" ||
      !refName.startsWith(PRIVATE_REF_PREFIX) ||
      !SHA256.test(refName.slice(PRIVATE_REF_PREFIX.length))
    )
      return Effect.fail(failure("invalid", "Retained candidate identity is invalid."));
    return transaction(
      Effect.gen(function* () {
        const row = (yield* rowFor(attemptId))[0];
        if (!row) return yield* failure("not_found", "Candidate intent was not found.");
        const saved = decodeRow(row);
        if (
          refName !== saved.refName ||
          resultCommit.length !== saved.baseCommit.length ||
          saved.refName !== `${PRIVATE_REF_PREFIX}${saved.reviewedArtifactDigest}`
        )
          return yield* failure("conflict", "Retained identity differs from the prepared intent.");
        if (!authority.permits({ intent: saved, resultCommit, refName }))
          return yield* failure("forbidden", "Candidate retention is not authorized.");
        if (saved.status === "retained") {
          if (saved.resultCommit !== resultCommit)
            return yield* failure("conflict", "Candidate was retained at a different commit.");
          return saved;
        }
        const time = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* sql`UPDATE organization_git_candidate_intents
          SET status = 'retained', result_commit = ${resultCommit}, retained_at = ${time}
          WHERE attempt_id = ${attemptId} AND status = 'prepared'`;
        const updated = (yield* rowFor(attemptId))[0];
        if (!updated || updated.status !== "retained" || updated.result_commit !== resultCommit)
          return yield* failure("conflict", "Candidate retention transition did not land.");
        return decodeRow(updated);
      }),
    );
  };
  const listPrepared: OrganizationGitCandidateIntentStoreShape["listPrepared"] = (limit) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return Effect.fail(failure("invalid", "Prepared intent limit must be from 1 to 100."));
    return sql<IntentRow>`SELECT * FROM organization_git_candidate_intents
      WHERE status = 'prepared' ORDER BY prepared_at, attempt_id LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map(decodeRow)),
      Effect.mapError(() => unavailable()),
    );
  };
  return {
    prepare,
    markRetained,
    get,
    listPrepared,
  } satisfies OrganizationGitCandidateIntentStoreShape;
});

export const OrganizationGitCandidateIntentStoreWithAuthority = Layer.effect(
  OrganizationGitCandidateIntentStore,
  make,
);
export const OrganizationGitCandidateIntentStoreLive = Layer.effect(
  OrganizationGitCandidateIntentStore,
  make.pipe(Effect.provide(OrganizationGitCandidateRetentionDisabled)),
);
/** Convenience layer with persisted artifact verification and no retention authority. */
export const OrganizationGitCandidateIntentStoreStandaloneLive =
  OrganizationGitCandidateIntentStoreLive.pipe(Layer.provide(OrganizationWorkArtifactStoreLive));
