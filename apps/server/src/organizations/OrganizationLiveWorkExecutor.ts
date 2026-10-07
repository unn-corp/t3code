// @effect-diagnostics globalDate:off globalDateInEffect:off - Failure receipts use UTC ISO timestamps.
import {
  OrganizationWorkError,
  OrganizationWorkId,
  type OrganizationWorkDetail,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { withAutomationWork } from "../maintenance/WorkAdmission.ts";
import { OrganizationProviderBudgetError } from "./OrganizationProviderBudget.ts";
import {
  coordinateOrganizationGitCandidate,
  OrganizationGitCandidateCoordinatorAuthority,
} from "./OrganizationGitCandidateCoordinator.ts";
import {
  completeOrganizationGitIntegration,
  OrganizationGitIntegrationCompletionAuthority,
} from "./OrganizationGitIntegrationCompletion.ts";
import {
  coordinateOrganizationGitIntegration,
  OrganizationGitIntegrationAuthority,
} from "./OrganizationGitIntegrationCoordinator.ts";
import { runOrganizationSingleFileAttempt } from "./OrganizationSingleFileAttemptCoordinator.ts";
import { runOrganizationSingleFileQA } from "./OrganizationSingleFileQACoordinator.ts";
import { OrganizationLiveWorkDrainDeferred } from "./OrganizationLiveWorkDrain.ts";
import { OrganizationLiveWorkEmergencyDeferred } from "./OrganizationLiveWorkEmergencyStop.ts";
import { proposeOrganizationSingleFileArtifactWithBudget } from "./OrganizationSingleFileProductionPolicies.ts";
import {
  OrganizationWorkIntentActivationReadiness,
  readOrganizationWorkIntentActivationByWorkId,
} from "./OrganizationWorkIntentActivation.ts";
import { OrganizationWorkStore } from "./OrganizationWorkStore.ts";

const BATCH_SIZE = 4;
const POLL_INTERVAL = "15 seconds";

export interface OrganizationLiveWorkRuntimeStatus {
  readonly ready: boolean;
  readonly reason: string;
}

export class OrganizationLiveWorkRuntimeReadiness extends Context.Service<
  OrganizationLiveWorkRuntimeReadiness,
  { readonly status: () => OrganizationLiveWorkRuntimeStatus }
>()("t3/organizations/OrganizationLiveWorkExecutor/OrganizationLiveWorkRuntimeReadiness") {}

/** Production startup must replace this only after broker ownership and recovery are verified. */
export const OrganizationLiveWorkRuntimeReadinessDisabled = Layer.succeed(
  OrganizationLiveWorkRuntimeReadiness,
  { status: () => ({ ready: false, reason: "scoped_broker_and_recovery_not_verified" }) },
);

export const readOrganizationLiveWorkRuntimeStatus = Effect.gen(function* () {
  const readiness = yield* OrganizationLiveWorkRuntimeReadiness;
  return readiness.status();
});
export type OrganizationLiveWorkPhase = "attempt" | "qa" | "integration";
export type OrganizationLiveWorkFailureCode =
  | "budget_exhausted"
  | "budget_denied"
  | "provider_unavailable"
  | "authority_changed"
  | "qa_rejected"
  | "qa_unavailable"
  | "integration_conflict"
  | "integration_unavailable"
  | "attempt_unavailable"
  | "invalid_artifact"
  | "unexpected_failure";
const recoverableFailure = (code: OrganizationLiveWorkFailureCode) =>
  code === "budget_exhausted" || code === "integration_unavailable";

export interface OrganizationLiveWorkFailure {
  readonly workId: OrganizationWorkId;
  readonly phase: OrganizationLiveWorkPhase;
  readonly code: OrganizationLiveWorkFailureCode;
  readonly recordedAt: string;
}

/** Bounded read model for the organization activity view; no provider response is stored. */
export const listOrganizationLiveWorkFailures = (organizationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      work_id: string;
      phase: OrganizationLiveWorkPhase;
      error_code: OrganizationLiveWorkFailureCode;
      recorded_at: string;
    }>`SELECT f.work_id, f.phase, f.error_code, f.recorded_at
      FROM organization_live_work_failures f
      JOIN organization_work_items w ON w.work_id = f.work_id
      JOIN organization_work_intent_activations a ON a.work_id = f.work_id
      WHERE w.organization_id = ${organizationId} AND a.organization_id = ${organizationId}
        AND w.status NOT IN ('succeeded', 'canceled')
      ORDER BY f.recorded_at DESC, f.work_id DESC LIMIT 100`;
    return rows.map((row) => ({
      workId: OrganizationWorkId.make(row.work_id),
      phase: row.phase,
      code: row.error_code,
      occurredAt: row.recorded_at,
    }));
  });

const classifyFailure = (
  phase: OrganizationLiveWorkPhase,
  error: unknown,
): OrganizationLiveWorkFailureCode => {
  if (!error || typeof error !== "object") return "unexpected_failure";
  const tagged = error as {
    readonly _tag?: unknown;
    readonly code?: unknown;
    readonly cause?: unknown;
  };
  if (tagged._tag === "OrganizationLiveWorkPhaseError" && tagged.code === "qa_rejected")
    return "qa_rejected";
  if (tagged._tag === "OrganizationLiveWorkPhaseError" && tagged.code === "attempt_unavailable")
    return "attempt_unavailable";
  if (tagged._tag === "OrganizationProviderBudgetError")
    return tagged.code === "exhausted" ? "budget_exhausted" : "budget_denied";
  if (tagged._tag === "TextGenerationError") {
    if (Schema.is(OrganizationProviderBudgetError)(tagged.cause))
      return tagged.cause.code === "exhausted" ? "budget_exhausted" : "budget_denied";
    return "provider_unavailable";
  }
  if (tagged.code === "forbidden" || (tagged.code === "conflict" && phase !== "integration"))
    return "authority_changed";
  if (tagged.code === "invalid") return "invalid_artifact";
  if (phase === "integration" && tagged.code === "conflict") return "integration_conflict";
  if (phase === "integration" && tagged.code === "unavailable") return "integration_unavailable";
  if (phase === "qa" && tagged.code === "unavailable") return "qa_unavailable";
  if (phase === "attempt" && tagged.code === "unavailable") return "attempt_unavailable";
  return "unexpected_failure";
};

class OrganizationLiveWorkPhaseError extends Error {
  readonly _tag = "OrganizationLiveWorkPhaseError";
  readonly code: "qa_rejected" | "attempt_unavailable";
  constructor(code: "qa_rejected" | "attempt_unavailable") {
    super(code);
    this.code = code;
  }
}

/** Durable state: budget exhaustion and transient integration are recoverable. */
export const recordOrganizationLiveWorkFailure = (
  workId: OrganizationWorkId,
  phase: OrganizationLiveWorkPhase,
  code: OrganizationLiveWorkFailureCode,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const recordedAt = new Date().toISOString();
    const terminal = recoverableFailure(code) ? 0 : 1;
    yield* sql`INSERT INTO organization_live_work_failures
      (work_id, phase, error_code, terminal, recorded_at)
      SELECT ${workId}, ${phase}, ${code}, ${terminal}, ${recordedAt}
      WHERE EXISTS (SELECT 1 FROM organization_work_intent_activations WHERE work_id = ${workId})
      ON CONFLICT(work_id) DO UPDATE SET phase = excluded.phase,
        error_code = excluded.error_code, terminal = excluded.terminal,
        recorded_at = excluded.recorded_at
      WHERE organization_live_work_failures.terminal = 0`;
  });

export const clearRecoverableOrganizationLiveWorkFailure = (workId: OrganizationWorkId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM organization_live_work_failures
      WHERE work_id = ${workId} AND terminal = 0`;
  });

export const readOrganizationLiveWorkFailure = (workId: OrganizationWorkId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      work_id: string;
      phase: OrganizationLiveWorkPhase;
      error_code: OrganizationLiveWorkFailureCode;
      recorded_at: string;
    }>`
      SELECT work_id, phase, error_code, recorded_at
      FROM organization_live_work_failures WHERE work_id = ${workId}`;
    const row = rows[0];
    return row
      ? ({
          workId: OrganizationWorkId.make(row.work_id),
          phase: row.phase,
          code: row.error_code,
          recordedAt: row.recorded_at,
        } satisfies OrganizationLiveWorkFailure)
      : null;
  });

/** Keyset scan cannot admit a WorkStore row without its immutable activation row. */
export const listActivatedOrganizationWorkAfter = (cursor: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ work_id: string }>`SELECT a.work_id
      FROM organization_work_intent_activations a
      JOIN organization_work_items w ON w.work_id = a.work_id
      WHERE a.work_id > ${cursor ?? ""}
        AND NOT EXISTS (SELECT 1 FROM organization_live_work_failures f
          WHERE f.work_id = a.work_id AND f.terminal = 1)
        AND (w.status IN ('pending', 'retrying', 'waiting-approval') OR
          (w.status = 'blocked' AND EXISTS (
            SELECT 1 FROM organization_work_attempts attempt
            WHERE attempt.work_id = w.work_id AND attempt.number = w.attempt_count
              AND (attempt.status = 'submitted' OR
                (attempt.status = 'qa-accepted' AND w.approval_subject IS NOT NULL)))))
      ORDER BY a.work_id LIMIT ${BATCH_SIZE}`;
    return rows.map((row) => OrganizationWorkId.make(row.work_id));
  });

export interface OrganizationLiveWorkSnapshot {
  readonly workId: OrganizationWorkId;
  readonly status: OrganizationWorkDetail["work"]["status"];
  readonly attemptId: string | null;
  readonly attemptStatus: OrganizationWorkDetail["attempts"][number]["status"] | null;
  readonly approvalSubject: string | null;
}

export interface OrganizationLiveWorkSource<R = never> {
  readonly listAfter: (
    workId: string | null,
  ) => Effect.Effect<ReadonlyArray<OrganizationWorkId>, Error, R>;
  readonly read: (
    workId: OrganizationWorkId,
  ) => Effect.Effect<OrganizationLiveWorkSnapshot | null, Error, R>;
  readonly recordFailure: (
    workId: OrganizationWorkId,
    phase: OrganizationLiveWorkPhase,
    code: OrganizationLiveWorkFailureCode,
  ) => Effect.Effect<void, Error, R>;
  readonly clearRecoverableFailure: (workId: OrganizationWorkId) => Effect.Effect<void, Error, R>;
  readonly shouldDeferAuthorityFailure: (
    workId: OrganizationWorkId,
  ) => Effect.Effect<boolean, Error, R>;
}

export interface OrganizationLiveWorkActions<RA = never, RQ = RA, RI = RA> {
  readonly proposeAndAttempt: (workId: OrganizationWorkId) => Effect.Effect<void, Error, RA>;
  readonly candidateAndQA: (
    workId: OrganizationWorkId,
    attemptId: string,
  ) => Effect.Effect<void, Error, RQ>;
  readonly integrateAndComplete: (
    workId: OrganizationWorkId,
    attemptId: string,
  ) => Effect.Effect<void, Error, RI>;
}

export interface OrganizationLiveWorkRunResult {
  readonly workId: OrganizationWorkId;
  readonly phase: OrganizationLiveWorkPhase | "waiting" | "skipped";
  readonly outcome: "completed" | "failed" | "waiting" | "skipped";
}

/** One bounded pass. WorkStore status and immutable receipts are the durable resume cursor. */
export function makeOrganizationLiveWorkExecutor<RS, RA, RQ, RI>(
  source: OrganizationLiveWorkSource<RS>,
  actions: OrganizationLiveWorkActions<RA, RQ, RI>,
) {
  let cursor: string | null = null;
  const inFlight = new Set<string>();
  const failedInProcess = new Set<string>();
  const runPhase = <R>(
    workId: OrganizationWorkId,
    phase: OrganizationLiveWorkPhase,
    action: Effect.Effect<void, Error, R>,
  ) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(action);
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause);
        if (
          failure instanceof OrganizationLiveWorkDrainDeferred ||
          failure instanceof OrganizationLiveWorkEmergencyDeferred
        )
          return { workId, phase, outcome: "waiting" as const };
        const code = classifyFailure(phase, failure);
        if (code === "authority_changed") {
          const deferred = yield* source
            .shouldDeferAuthorityFailure(workId)
            .pipe(Effect.tapError(() => Effect.sync(() => failedInProcess.add(workId))));
          if (deferred) return { workId, phase, outcome: "waiting" as const };
        }
        if (!recoverableFailure(code)) failedInProcess.add(workId);
        yield* source
          .recordFailure(workId, phase, code)
          .pipe(Effect.tapError(() => Effect.sync(() => failedInProcess.add(workId))));
      } else {
        yield* source.clearRecoverableFailure(workId);
      }
      return {
        workId,
        phase,
        outcome: Exit.isSuccess(exit) ? ("completed" as const) : ("failed" as const),
      };
    });
  const runWork = (workId: OrganizationWorkId) =>
    Effect.gen(function* () {
      const snapshot = yield* source.read(workId);
      if (!snapshot || snapshot.workId !== workId)
        return { workId, phase: "skipped", outcome: "skipped" } as const;
      if (snapshot.status === "pending" || snapshot.status === "retrying") {
        return yield* runPhase(workId, "attempt", actions.proposeAndAttempt(workId));
      }
      if (snapshot.status === "blocked" && snapshot.attemptStatus === "submitted") {
        if (!snapshot.attemptId) return { workId, phase: "skipped", outcome: "skipped" } as const;
        return yield* runPhase(workId, "qa", actions.candidateAndQA(workId, snapshot.attemptId));
      }
      if (
        snapshot.status === "blocked" &&
        snapshot.attemptStatus === "qa-accepted" &&
        snapshot.approvalSubject
      ) {
        if (!snapshot.attemptId) return { workId, phase: "skipped", outcome: "skipped" } as const;
        return yield* runPhase(
          workId,
          "integration",
          actions.integrateAndComplete(workId, snapshot.attemptId),
        );
      }
      if (snapshot.status === "waiting-approval")
        return { workId, phase: "waiting", outcome: "waiting" } as const;
      // Running or recovering attempts belong to the broker recovery path. Never relaunch them.
      return { workId, phase: "skipped", outcome: "skipped" } as const;
    });
  const runOnce = () =>
    Effect.gen(function* () {
      let selected = yield* source.listAfter(cursor);
      if (selected.length === 0 && cursor !== null) {
        cursor = null;
        selected = yield* source.listAfter(null);
      }
      const results: OrganizationLiveWorkRunResult[] = [];
      for (const workId of selected.slice(0, BATCH_SIZE)) {
        cursor = workId;
        if (inFlight.has(workId) || failedInProcess.has(workId)) continue;
        inFlight.add(workId);
        const result = yield* Effect.exit(
          withAutomationWork(runWork(workId)).pipe(
            Effect.catchTag("MaintenanceWorkHeld", () =>
              Effect.succeed({ workId, phase: "skipped", outcome: "waiting" } as const),
            ),
          ),
        ).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(workId))));
        if (Exit.isSuccess(result)) results.push(result.value);
        else results.push({ workId, phase: "skipped", outcome: "failed" });
      }
      return results;
    });
  return { runOnce };
}

/** Runner wiring requires per-work actions; this layer grants no activation authority. */
export const makeOrganizationLiveWorkLoopLayer = <RA, RQ, RI>(
  actions: OrganizationLiveWorkActions<RA, RQ, RI>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const runtimeReadiness = yield* OrganizationLiveWorkRuntimeReadiness;
      const source = yield* makeOrganizationLiveWorkSource;
      const executor = makeOrganizationLiveWorkExecutor(source, actions);
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.suspend(() =>
            runtimeReadiness.status().ready ? executor.runOnce() : Effect.succeed([]),
          ).pipe(
            Effect.tap((results) =>
              Effect.forEach(
                results.filter((result) => result.outcome === "failed"),
                (result) =>
                  Effect.logWarning("Organization live work phase stopped", {
                    workId: result.workId,
                    phase: result.phase,
                  }),
                { discard: true },
              ),
            ),
            Effect.catch(() => Effect.logError("Organization live work scan is unavailable")),
            Effect.andThen(Effect.sleep(POLL_INTERVAL)),
          ),
        ),
      );
    }),
  );

/** Scan only persisted activated work, then revalidate the immutable selection before dispatch. */
export const makeOrganizationLiveWorkSource = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workStore = yield* OrganizationWorkStore;
  const readiness = yield* OrganizationWorkIntentActivationReadiness;
  const runtimeReadiness = yield* OrganizationLiveWorkRuntimeReadiness;
  return {
    listAfter: (cursor: string | null) =>
      listActivatedOrganizationWorkAfter(cursor).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    read: (workId: OrganizationWorkId) =>
      Effect.gen(function* () {
        if (!runtimeReadiness.status().ready) return null;
        const activation = yield* readOrganizationWorkIntentActivationByWorkId(workId).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (!activation || !readiness.permits(activation.organizationId, activation.intentId))
          return null;
        const current = (yield* sql<{ lifecycle: string }>`SELECT lifecycle FROM organizations
          WHERE organization_id = ${activation.organizationId}`)[0];
        if (current?.lifecycle !== "active") return null;
        const detail = yield* workStore.getWork(workId);
        if (detail.work.organizationId !== activation.organizationId) return null;
        const attempt = detail.attempts.at(-1);
        return {
          workId,
          status: detail.work.status,
          attemptId: attempt?.id ?? null,
          attemptStatus: attempt?.status ?? null,
          approvalSubject: detail.work.approvalSubject,
        } satisfies OrganizationLiveWorkSnapshot;
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    recordFailure: (
      workId: OrganizationWorkId,
      phase: OrganizationLiveWorkPhase,
      code: OrganizationLiveWorkFailureCode,
    ) =>
      recordOrganizationLiveWorkFailure(workId, phase, code).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    clearRecoverableFailure: (workId: OrganizationWorkId) =>
      clearRecoverableOrganizationLiveWorkFailure(workId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    shouldDeferAuthorityFailure: (workId: OrganizationWorkId) =>
      Effect.gen(function* () {
        if (!runtimeReadiness.status().ready) return true;
        const activation = yield* readOrganizationWorkIntentActivationByWorkId(workId).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (!activation || !readiness.permits(activation.organizationId, activation.intentId))
          return true;
        const rows = yield* sql<{ lifecycle: string }>`SELECT o.lifecycle
          FROM organization_work_intent_activations a
          JOIN organization_work_items w ON w.work_id = a.work_id
          JOIN organizations o ON o.organization_id = w.organization_id
          WHERE a.work_id = ${workId} AND a.organization_id = w.organization_id`;
        return rows[0]?.lifecycle === "paused";
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  } satisfies OrganizationLiveWorkSource;
});

/** Real coordinators recheck the selected work and persisted evidence at every phase. */
export const organizationLiveWorkActions = {
  proposeAndAttempt: (workId: OrganizationWorkId) =>
    Effect.gen(function* () {
      const proposal = yield* proposeOrganizationSingleFileArtifactWithBudget(workId);
      const attempt = yield* runOrganizationSingleFileAttempt(proposal);
      if (attempt.status !== "submitted")
        return yield* Effect.fail(new OrganizationLiveWorkPhaseError("attempt_unavailable"));
    }),
  candidateAndQA: (workId: OrganizationWorkId, attemptId: string) =>
    Effect.gen(function* () {
      const activation = yield* readOrganizationWorkIntentActivationByWorkId(workId);
      const readiness = yield* OrganizationWorkIntentActivationReadiness;
      const workStore = yield* OrganizationWorkStore;
      const detail = yield* workStore.getWork(workId);
      const attempt = detail.attempts.at(-1);
      if (
        !attempt ||
        attempt.id !== attemptId ||
        attempt.status !== "submitted" ||
        detail.work.status !== "blocked" ||
        activation.organizationId !== detail.work.organizationId ||
        !attempt.artifactRef ||
        !attempt.artifactDigest
      )
        return yield* new OrganizationWorkError({
          code: "conflict",
          message: "Submitted attempt changed before candidate or QA.",
        });
      if (!readiness.permits(activation.organizationId, activation.intentId))
        return yield* new OrganizationWorkError({
          code: "forbidden",
          message: "Project work execution is not ready.",
        });
      yield* coordinateOrganizationGitCandidate(attemptId).pipe(
        Effect.provideService(OrganizationGitCandidateCoordinatorAuthority, {
          permitsAttempt: (id) => id === attemptId,
          permits: (intent) =>
            intent.attemptId === attemptId &&
            intent.workId === workId &&
            intent.organizationId === activation.organizationId &&
            intent.projectId === detail.work.projectId &&
            intent.bindingId === detail.work.bindingId &&
            intent.bindingVersion === detail.work.bindingVersion &&
            intent.baseCommit === detail.work.codeRevision &&
            intent.artifactRef === attempt.artifactRef &&
            intent.artifactReceiptDigest === attempt.artifactDigest &&
            intent.relativePath === activation.selection.fileName,
        }),
      );
      const qa = yield* runOrganizationSingleFileQA({ workId, attemptId: attempt.id });
      if (qa.attempts.at(-1)?.status === "qa-rejected")
        return yield* Effect.fail(new OrganizationLiveWorkPhaseError("qa_rejected"));
    }),
  integrateAndComplete: (workId: OrganizationWorkId, attemptId: string) =>
    Effect.gen(function* () {
      const activation = yield* readOrganizationWorkIntentActivationByWorkId(workId);
      const readiness = yield* OrganizationWorkIntentActivationReadiness;
      const workStore = yield* OrganizationWorkStore;
      const detail = yield* workStore.getWork(workId);
      const attempt = detail.attempts.at(-1);
      if (
        !attempt ||
        attempt.id !== attemptId ||
        attempt.status !== "qa-accepted" ||
        detail.work.status !== "blocked" ||
        !detail.work.approvalSubject ||
        activation.organizationId !== detail.work.organizationId
      )
        return yield* new OrganizationWorkError({
          code: "conflict",
          message: "Approved attempt changed before integration.",
        });
      if (!readiness.permits(activation.organizationId, activation.intentId))
        return yield* new OrganizationWorkError({
          code: "forbidden",
          message: "Project work execution is not ready.",
        });
      const request = {
        attemptId,
        targetRef: activation.selection.targetRef,
        integratorSubject: `system:organization-integrator:${workId}`,
      };
      const integrated = yield* coordinateOrganizationGitIntegration(request).pipe(
        Effect.provideService(OrganizationGitIntegrationAuthority, {
          permitsAttempt: (input) =>
            input.attemptId === attemptId &&
            input.targetRef === activation.selection.targetRef &&
            input.integratorSubject === request.integratorSubject,
          permits: (input, context) =>
            input.attemptId === attemptId &&
            input.targetRef === activation.selection.targetRef &&
            input.integratorSubject === request.integratorSubject &&
            context.workId === workId &&
            context.organizationId === activation.organizationId &&
            context.projectId === detail.work.projectId &&
            context.bindingId === detail.work.bindingId &&
            context.approvalSubject === detail.work.approvalSubject &&
            context.baseCommit === detail.work.codeRevision,
        }),
      );
      yield* completeOrganizationGitIntegration(request).pipe(
        Effect.provideService(OrganizationGitIntegrationCompletionAuthority, {
          permitsAttempt: (input) =>
            input.attemptId === attemptId &&
            input.targetRef === activation.selection.targetRef &&
            input.integratorSubject === request.integratorSubject,
          permits: (input, context) =>
            input.attemptId === attemptId &&
            input.targetRef === activation.selection.targetRef &&
            input.integratorSubject === request.integratorSubject &&
            context.workId === workId &&
            context.organizationId === activation.organizationId &&
            context.projectId === detail.work.projectId &&
            context.bindingId === detail.work.bindingId &&
            context.baseCommit === integrated.baseCommit &&
            context.resultCommit === integrated.resultCommit &&
            context.approvalReceiptDigest === integrated.approvalReceiptDigest,
        }),
      );
    }),
} satisfies OrganizationLiveWorkActions<unknown>;
