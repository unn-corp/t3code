import * as NodeCrypto from "node:crypto";
import {
  OrganizationObservation,
  OrganizationObservationId,
} from "../../../../packages/contracts/src/organizationIntake.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  ORGANIZATION_INTAKE_CORRELATION_SUBJECT,
  OrganizationCorrelationCoordinator,
  OrganizationCorrelationCoordinatorIntakeLive,
  type OrganizationCorrelationCoordinatorResult,
} from "./OrganizationCorrelationCoordinator.ts";

const BATCH_SIZE = 32;
const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 60;
const POLL_INTERVAL = "5 seconds";
type Claimed = { observation_id: string; attempts: number };
type ObservationRow = {
  observation_id: string;
  organization_id: string;
  source_id: string;
  project_id: string | null;
  external_event_id: string;
  dedup_key: string;
  occurred_at: string;
  received_at: string;
  title: string;
  body: string;
  attributes_json: string;
};
type JobRow = {
  state: string;
  attempts: number;
  outcome: string | null;
  last_error_code: string | null;
};
const AttributesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const terminalError = (code: string) =>
  code === "forbidden" || code === "not_found" || code === "conflict" || code === "invalid";
const errorCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : "unavailable";

export interface OrganizationCorrelationRecoveryShape {
  /** Process at most 32 due observations. Safe to repeat after process restart. */
  readonly runOnce: () => Effect.Effect<
    { claimed: number; completed: number; retried: number; terminal: number },
    SqlError
  >;
  /** Settle a successful immediate HTTP or WebSocket correlation. */
  readonly markFromResult: (
    observationId: OrganizationObservationId,
    result: OrganizationCorrelationCoordinatorResult,
  ) => Effect.Effect<void, SqlError>;
}
export class OrganizationCorrelationRecovery extends Context.Service<
  OrganizationCorrelationRecovery,
  OrganizationCorrelationRecoveryShape
>()("t3/organizations/OrganizationCorrelationRecovery") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const coordinator = yield* OrganizationCorrelationCoordinator;
  const markFromResult: OrganizationCorrelationRecoveryShape["markFromResult"] = (
    observationId,
    result,
  ) =>
    Effect.gen(function* () {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`UPDATE organization_intake_correlation_jobs
        SET state = 'complete', outcome = ${result.outcome}, lease_token = NULL,
          lease_expires_at = NULL, last_error_code = NULL, updated_at = ${updatedAt}
        WHERE observation_id = ${observationId} AND state IN ('pending', 'leased', 'terminal')`;
    });
  const claim = Effect.gen(function* () {
    const current = yield* DateTime.now;
    const currentIso = DateTime.formatIso(current);
    const leaseUntil = DateTime.formatIso(DateTime.add(current, { seconds: LEASE_SECONDS }));
    const token = NodeCrypto.randomUUID();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const due = (yield* sql<{ observation_id: string }>`
        SELECT observation_id FROM organization_intake_correlation_jobs
        WHERE (state = 'pending' AND next_attempt_at <= ${currentIso})
          OR (state = 'leased' AND lease_expires_at <= ${currentIso})
        ORDER BY next_attempt_at, observation_id LIMIT 1`)[0];
        if (!due) return null;
        const rows = yield* sql<Claimed>`UPDATE organization_intake_correlation_jobs
        SET state = 'leased', attempts = attempts + 1, lease_token = ${token},
          lease_expires_at = ${leaseUntil}, updated_at = ${currentIso}
        WHERE observation_id = ${due.observation_id}
          AND ((state = 'pending' AND next_attempt_at <= ${currentIso})
            OR (state = 'leased' AND lease_expires_at <= ${currentIso}))
        RETURNING observation_id, attempts`;
        return rows[0] ? { ...rows[0], token } : null;
      }),
    );
  });
  const process = (claimed: Claimed & { token: string }) =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const row = (yield* sql<ObservationRow>`SELECT * FROM organization_intake_observations
        WHERE observation_id = ${claimed.observation_id}`)[0];
        if (!row) return yield* Effect.fail({ code: "not_found" });
        const attributes = yield* Schema.decodeUnknownEffect(AttributesJson)(row.attributes_json);
        const observation = yield* Schema.decodeUnknownEffect(OrganizationObservation)({
          id: row.observation_id,
          organizationId: row.organization_id,
          sourceId: row.source_id,
          projectId: row.project_id,
          externalEventId: row.external_event_id,
          dedupKey: row.dedup_key,
          occurredAt: row.occurred_at,
          receivedAt: row.received_at,
          title: row.title,
          body: row.body,
          attributes,
          state: "observed",
        });
        return yield* coordinator.onObservation(observation, {
          subject: ORGANIZATION_INTAKE_CORRELATION_SUBJECT,
        });
      }).pipe(Effect.result);
      const current = yield* DateTime.now;
      const updatedAt = DateTime.formatIso(current);
      if (Result.isSuccess(result)) {
        yield* sql`UPDATE organization_intake_correlation_jobs
        SET state = 'complete', outcome = ${result.success.outcome}, lease_token = NULL,
          lease_expires_at = NULL, last_error_code = NULL, updated_at = ${updatedAt}
        WHERE observation_id = ${claimed.observation_id} AND state = 'leased'
          AND lease_token = ${claimed.token}`;
        return "completed" as const;
      }
      const code = errorCode(result.failure);
      if (terminalError(code) || claimed.attempts >= MAX_ATTEMPTS) {
        yield* sql`UPDATE organization_intake_correlation_jobs
        SET state = 'terminal', outcome = NULL, lease_token = NULL,
          lease_expires_at = NULL, last_error_code = ${code}, updated_at = ${updatedAt}
        WHERE observation_id = ${claimed.observation_id} AND state = 'leased'
          AND lease_token = ${claimed.token}`;
        return "terminal" as const;
      }
      const delaySeconds = Math.min(300, 5 * 2 ** (claimed.attempts - 1));
      const nextAttemptAt = DateTime.formatIso(DateTime.add(current, { seconds: delaySeconds }));
      yield* sql`UPDATE organization_intake_correlation_jobs
      SET state = 'pending', next_attempt_at = ${nextAttemptAt}, lease_token = NULL,
        lease_expires_at = NULL, last_error_code = ${code}, updated_at = ${updatedAt}
      WHERE observation_id = ${claimed.observation_id} AND state = 'leased'
        AND lease_token = ${claimed.token}`;
      return "retried" as const;
    });
  const runOnce: OrganizationCorrelationRecoveryShape["runOnce"] = () =>
    Effect.gen(function* () {
      const counts = { claimed: 0, completed: 0, retried: 0, terminal: 0 };
      for (let index = 0; index < BATCH_SIZE; index++) {
        const job = yield* claim;
        if (!job) break;
        counts.claimed++;
        const outcome = yield* process(job);
        counts[outcome]++;
      }
      return counts;
    });
  return { runOnce, markFromResult } satisfies OrganizationCorrelationRecoveryShape;
});

export const OrganizationCorrelationRecoveryLayer = Layer.effect(
  OrganizationCorrelationRecovery,
  make,
);
export const OrganizationCorrelationRecoveryLive = OrganizationCorrelationRecoveryLayer.pipe(
  Layer.provide(OrganizationCorrelationCoordinatorIntakeLive),
);
/** Mount after migrations; the scoped fiber stops with the owning server layer. */
export const OrganizationCorrelationRecoveryLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const recovery = yield* OrganizationCorrelationRecovery;
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* recovery.runOnce().pipe(Effect.ignoreCause({ log: true }));
        yield* Effect.sleep(POLL_INTERVAL);
      }),
    ).pipe(Effect.forkScoped);
  }),
);
