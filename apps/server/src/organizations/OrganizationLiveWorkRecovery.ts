// @effect-diagnostics nodeBuiltinImport:off - Stable recovery transition IDs bind the exact attempt.
import * as NodeCrypto from "node:crypto";
import { OrganizationWorkError, OrganizationWorkId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { reconcileOrganizationWorkDrainsAfterRecovery } from "./OrganizationLiveWorkDrain.ts";
import { recordOrganizationLiveWorkFailure } from "./OrganizationLiveWorkExecutor.ts";
import {
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkArtifactVerifierDisabled,
  OrganizationWorkEvaluationVerifierDisabled,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";

const MAX_RECOVERY_ROWS = 128;
type RecoveryRow = {
  work_id: string;
  attempt_id: string;
  organization_id: string;
  project_id: string;
  binding_id: string;
  scope: string | null;
  work_status: "running" | "recovering";
  attempt_status: "running" | "expired";
  lease_until: string;
  scope_attempt_id: string | null;
  prep_attempt_id: string | null;
  verified_stopped_at: string | null;
  receipt_kind: "never-dispatched" | "verified-stopped-unattached" | null;
};

/** A claim with no preparation or scope predates any broker reservation. */
export const classifyOrganizationLiveWorkRecovery = (
  row: Pick<
    RecoveryRow,
    | "work_status"
    | "attempt_status"
    | "lease_until"
    | "scope_attempt_id"
    | "prep_attempt_id"
    | "verified_stopped_at"
    | "receipt_kind"
  >,
  now: string,
): "recover" | "lease_active" | "scope_unverified" | "attempt_changed" => {
  if (row.work_status === "running" && row.lease_until > now) return "lease_active";
  const neverPrepared = row.prep_attempt_id === null && row.scope_attempt_id === null;
  if (!neverPrepared && !row.verified_stopped_at && !row.receipt_kind) return "scope_unverified";
  if (
    (row.work_status === "running" && row.attempt_status !== "running") ||
    (row.work_status === "recovering" && row.attempt_status !== "expired")
  )
    return "attempt_changed";
  return "recover";
};

export interface OrganizationLiveWorkRecoveryReport {
  readonly recovered: readonly string[];
  readonly held: readonly { readonly workId: string; readonly reason: string }[];
}

/** Called only after exclusive broker ownership and OS scope reconciliation. */
export const reconcileOrganizationWorkAtStartup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const rows = yield* sql<RecoveryRow>`SELECT w.work_id, a.attempt_id,
    w.organization_id, w.project_id, w.binding_id, w.scope,
    w.status AS work_status, a.status AS attempt_status, a.lease_until,
    scope.attempt_id AS scope_attempt_id, prep.attempt_id AS prep_attempt_id,
    scope.verified_stopped_at, receipt.kind AS receipt_kind
    FROM organization_work_intent_activations activation
    JOIN organization_work_items w ON w.work_id = activation.work_id
    JOIN organization_work_attempts a ON a.work_id = w.work_id AND a.number = w.attempt_count
    LEFT JOIN organization_work_scopes scope ON scope.attempt_id = a.attempt_id
    LEFT JOIN organization_work_scope_preparations prep ON prep.attempt_id = a.attempt_id
    LEFT JOIN organization_work_scope_recovery_receipts receipt
      ON receipt.attempt_id = a.attempt_id AND receipt.operation_id = a.attempt_id
      AND receipt.unit_name = prep.unit_name AND scope.attempt_id IS NULL
    WHERE w.status IN ('running', 'recovering')
    ORDER BY w.work_id LIMIT ${MAX_RECOVERY_ROWS + 1}`;
  const recovered: string[] = [];
  const held: { workId: string; reason: string }[] = [];
  if (rows.length > MAX_RECOVERY_ROWS)
    held.push({ workId: rows[MAX_RECOVERY_ROWS]!.work_id, reason: "recovery_batch_limit" });
  for (const row of rows.slice(0, MAX_RECOVERY_ROWS)) {
    const decision = classifyOrganizationLiveWorkRecovery(row, now);
    if (decision !== "recover") {
      held.push({ workId: row.work_id, reason: decision });
      continue;
    }
    const workId = OrganizationWorkId.make(row.work_id);
    const subject = `system:organization-recovery:${NodeCrypto.createHash("sha256").update(row.work_id).digest("hex")}`;
    const authority = Layer.succeed(OrganizationWorkExecutionAuthority, {
      permits: (action, principal, target) =>
        action === "recover" &&
        principal.subject === subject &&
        target.workId === row.work_id &&
        target.organizationId === row.organization_id &&
        target.projectId === row.project_id &&
        target.bindingId === row.binding_id &&
        target.scope === row.scope,
    });
    const workLayer = OrganizationWorkStoreLayer.pipe(
      Layer.provide(authority),
      Layer.provide(OrganizationWorkArtifactVerifierDisabled),
      Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
      Layer.provide(OrganizationWorkApprovalVerifierDisabled),
      Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
    );
    const transitionId = (kind: string) =>
      `org-live-${kind}:${NodeCrypto.createHash("sha256").update(row.attempt_id).digest("hex")}`;
    const outcome = yield* Effect.result(
      Effect.gen(function* () {
        const work = yield* OrganizationWorkStore;
        const latest = yield* work.getWork(workId);
        if (latest.attempts.at(-1)?.id !== row.attempt_id)
          return yield* new OrganizationWorkError({
            code: "conflict",
            message: "Latest attempt changed during recovery.",
          });
        if (row.work_status === "running")
          yield* work.recoverExpired({ workId, transitionId: transitionId("expire") }, { subject });
        yield* work.resolveRecovery(
          {
            workId,
            attemptId: latest.attempts.at(-1)!.id,
            disposition: "uncertain",
            transitionId: transitionId("block"),
            evidenceRef: `org-recovery:${NodeCrypto.createHash("sha256")
              .update(
                `${row.attempt_id}:${row.prep_attempt_id ?? "never-prepared"}:${row.verified_stopped_at ?? row.receipt_kind ?? "none"}`,
              )
              .digest("hex")}`,
          },
          { subject },
        );
        yield* recordOrganizationLiveWorkFailure(workId, "attempt", "attempt_unavailable");
      }).pipe(Effect.provide(workLayer)),
    );
    if (Result.isSuccess(outcome)) recovered.push(row.work_id);
    else held.push({ workId: row.work_id, reason: "work_transition_failed" });
  }
  if (held.length === 0) {
    const drains = yield* reconcileOrganizationWorkDrainsAfterRecovery;
    held.push(...drains.held);
  }
  return { recovered, held } satisfies OrganizationLiveWorkRecoveryReport;
});
