// @effect-diagnostics globalDate:off globalDateInEffect:off - Durable leases use the server wall clock and explicit UTC ISO values.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE = ["reserved", "dispatched", "uncertain"] as const;
const LEASE_MS = 5 * 60 * 1000;

export class OrganizationProviderBudgetError extends Schema.TaggedError<OrganizationProviderBudgetError>()(
  "OrganizationProviderBudgetError",
  {
    code: Schema.Literals([
      "invalid",
      "not_found",
      "conflict",
      "forbidden",
      "exhausted",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationProviderBudgetError["code"], message: string) =>
  new OrganizationProviderBudgetError({ code, message });
const isBudgetError = Schema.is(OrganizationProviderBudgetError);
const unavailable = () => failure("unavailable", "Organization provider admission is unavailable.");

export interface OrganizationProviderBudgetReserveInput {
  readonly requestId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly estimatedTokens: number;
}
export interface OrganizationProviderBudgetMeasuredUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
export interface OrganizationProviderBudgetReconcileInput {
  readonly requestId: string;
  /** A trusted reconciler must establish whether dispatch happened. */
  readonly disposition: "completed" | "not-dispatched";
  readonly measuredUsage?: OrganizationProviderBudgetMeasuredUsage | undefined;
}
export type OrganizationProviderBudgetState =
  | "reserved"
  | "dispatched"
  | "uncertain"
  | "released"
  | "reconciled";
export interface OrganizationProviderBudgetRecord extends OrganizationProviderBudgetReserveInput {
  readonly dayUtc: string;
  readonly state: OrganizationProviderBudgetState;
  readonly leaseUntil: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dispatchedAt: string | null;
  readonly reconciledAt: string | null;
  readonly disposition: "completed" | "not-dispatched" | null;
  readonly measuredUsage: OrganizationProviderBudgetMeasuredUsage | null;
  readonly usageOverrun: boolean;
}
export interface OrganizationProviderBudgetTotalsInput {
  readonly scopeKind: "global" | "organization" | "project";
  readonly scopeId: string;
  readonly dayUtc: string;
}
export interface OrganizationProviderBudgetTotals {
  readonly activeRequests: number;
  readonly dailyAllocatedCalls: number;
  /** Daily allocation, including completed calls; released never-dispatched calls are excluded. */
  readonly allocatedEstimatedTokens: number;
  readonly activeReservedEstimatedTokens: number;
  readonly measuredInputTokens: number;
  readonly measuredOutputTokens: number;
  /** Dispatched, uncertain, or completed calls for which measured usage was never supplied. */
  readonly unknownUsageCalls: number;
  readonly usageOverrunCalls: number;
}

/** All mutations deny by default. The injected producer must be scoped to one server-owned call. */
export class OrganizationProviderBudgetAuthority extends Context.Service<
  OrganizationProviderBudgetAuthority,
  {
    readonly permitsReserve: (input: OrganizationProviderBudgetReserveInput) => boolean;
    readonly permitsTransition: (
      action: "dispatch" | "expire" | "release",
      record: OrganizationProviderBudgetRecord,
    ) => boolean;
    /** Reconciliation authority must establish the requested outcome from trusted evidence. */
    readonly permitsReconcile: (
      input: OrganizationProviderBudgetReconcileInput,
      record: OrganizationProviderBudgetRecord,
    ) => boolean;
  }
>()("t3/organizations/OrganizationProviderBudget/OrganizationProviderBudgetAuthority") {}
export const OrganizationProviderBudgetDisabled = Layer.succeed(
  OrganizationProviderBudgetAuthority,
  { permitsReserve: () => false, permitsTransition: () => false, permitsReconcile: () => false },
);

type BudgetRow = {
  request_id: string;
  organization_id: string;
  project_id: string;
  provider_instance_id: string;
  model_id: string;
  estimated_tokens: number;
  day_utc: string;
  state: OrganizationProviderBudgetState;
  lease_until: string;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  reconciled_at: string | null;
  disposition: "completed" | "not-dispatched" | null;
  measured_input_tokens: number | null;
  measured_output_tokens: number | null;
};
type LimitRow = {
  scope_kind: "global" | "organization" | "project";
  scope_id: string;
  max_concurrent: number;
  max_daily_calls: number;
  max_daily_estimated_tokens: number;
};
const decode = (row: BudgetRow): OrganizationProviderBudgetRecord => {
  const measuredUsage =
    row.measured_input_tokens === null || row.measured_output_tokens === null
      ? null
      : { inputTokens: row.measured_input_tokens, outputTokens: row.measured_output_tokens };
  return {
    requestId: row.request_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    providerInstanceId: row.provider_instance_id,
    modelId: row.model_id,
    estimatedTokens: row.estimated_tokens,
    dayUtc: row.day_utc,
    state: row.state,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
    reconciledAt: row.reconciled_at,
    disposition: row.disposition,
    measuredUsage,
    usageOverrun:
      measuredUsage !== null &&
      measuredUsage.inputTokens + measuredUsage.outputTokens > row.estimated_tokens,
  };
};
const sameRequest = (row: BudgetRow, input: OrganizationProviderBudgetReserveInput) =>
  row.request_id === input.requestId &&
  row.organization_id === input.organizationId &&
  row.project_id === input.projectId &&
  row.provider_instance_id === input.providerInstanceId &&
  row.model_id === input.modelId &&
  row.estimated_tokens === input.estimatedTokens;
const now = () => new Date().toISOString();
const validText = (value: unknown, maxBytes: number): value is string =>
  typeof value === "string" &&
  Boolean(value.trim()) &&
  !value.includes("\0") &&
  Buffer.byteLength(value, "utf8") <= maxBytes;
const validMeasured = (value: unknown): value is OrganizationProviderBudgetMeasuredUsage =>
  typeof value === "object" &&
  value !== null &&
  "inputTokens" in value &&
  "outputTokens" in value &&
  Number.isSafeInteger(value.inputTokens) &&
  Number.isSafeInteger(value.outputTokens) &&
  (value.inputTokens as number) >= 0 &&
  (value.inputTokens as number) <= 1_000_000_000 &&
  (value.outputTokens as number) >= 0 &&
  (value.outputTokens as number) <= 1_000_000_000;

export interface OrganizationProviderBudgetShape {
  readonly reserve: (
    input: OrganizationProviderBudgetReserveInput,
  ) => Effect.Effect<OrganizationProviderBudgetRecord, OrganizationProviderBudgetError>;
  readonly markDispatched: (
    requestId: string,
  ) => Effect.Effect<OrganizationProviderBudgetRecord, OrganizationProviderBudgetError>;
  readonly markUncertain: (
    requestId: string,
  ) => Effect.Effect<OrganizationProviderBudgetRecord, OrganizationProviderBudgetError>;
  readonly release: (
    requestId: string,
  ) => Effect.Effect<OrganizationProviderBudgetRecord, OrganizationProviderBudgetError>;
  readonly reconcile: (
    input: OrganizationProviderBudgetReconcileInput,
  ) => Effect.Effect<OrganizationProviderBudgetRecord, OrganizationProviderBudgetError>;
  readonly get: (
    requestId: string,
  ) => Effect.Effect<OrganizationProviderBudgetRecord | null, OrganizationProviderBudgetError>;
  readonly getTotals: (
    input: OrganizationProviderBudgetTotalsInput,
  ) => Effect.Effect<OrganizationProviderBudgetTotals, OrganizationProviderBudgetError>;
}
export class OrganizationProviderBudget extends Context.Service<
  OrganizationProviderBudget,
  OrganizationProviderBudgetShape
>()("t3/organizations/OrganizationProviderBudget") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* OrganizationProviderBudgetAuthority;
  const rowFor = (requestId: string) => sql<BudgetRow>`SELECT *
    FROM organization_provider_budget_admissions WHERE request_id = ${requestId}`;
  const transaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error): OrganizationProviderBudgetError =>
          isBudgetError(error) ? error : unavailable(),
        ),
      );
  const get: OrganizationProviderBudgetShape["get"] = (requestId) => {
    if (!REQUEST_ID.test(requestId))
      return Effect.fail(failure("invalid", "Request ID is invalid."));
    return rowFor(requestId).pipe(
      Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
      Effect.mapError(() => unavailable()),
    );
  };
  const usageFor = (input: OrganizationProviderBudgetTotalsInput) =>
    sql<{
      active_requests: number;
      daily_allocated_calls: number;
      allocated_estimated_tokens: number;
      active_reserved_estimated_tokens: number;
      measured_input_tokens: number;
      measured_output_tokens: number;
      unknown_usage_calls: number;
      usage_overrun_calls: number;
    }>`SELECT
      COALESCE(SUM(CASE WHEN state IN ('reserved','dispatched','uncertain')
        THEN 1 ELSE 0 END), 0) AS active_requests,
      COALESCE(SUM(CASE WHEN day_utc = ${input.dayUtc} AND state != 'released'
        THEN 1 ELSE 0 END), 0) AS daily_allocated_calls,
      COALESCE(SUM(CASE WHEN day_utc = ${input.dayUtc} AND state != 'released'
        THEN estimated_tokens ELSE 0 END), 0) AS allocated_estimated_tokens,
      COALESCE(SUM(CASE WHEN day_utc = ${input.dayUtc}
          AND state IN ('reserved','dispatched','uncertain')
        THEN estimated_tokens ELSE 0 END), 0) AS active_reserved_estimated_tokens,
      COALESCE(SUM(CASE WHEN day_utc = ${input.dayUtc}
        THEN COALESCE(measured_input_tokens, 0) ELSE 0 END), 0) AS measured_input_tokens,
      COALESCE(SUM(CASE WHEN day_utc = ${input.dayUtc}
        THEN COALESCE(measured_output_tokens, 0) ELSE 0 END), 0) AS measured_output_tokens,
      COALESCE(SUM(CASE WHEN day_utc = ${input.dayUtc}
          AND state IN ('dispatched','uncertain','reconciled')
          AND measured_input_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknown_usage_calls,
      COALESCE(SUM(CASE WHEN day_utc = ${input.dayUtc} AND state = 'reconciled'
          AND measured_input_tokens + measured_output_tokens > estimated_tokens
        THEN 1 ELSE 0 END), 0) AS usage_overrun_calls
      FROM organization_provider_budget_admissions
      WHERE ${input.scopeKind} = 'global'
        OR (${input.scopeKind} = 'organization' AND organization_id = ${input.scopeId})
        OR (${input.scopeKind} = 'project' AND project_id = ${input.scopeId})`;
  const getTotals: OrganizationProviderBudgetShape["getTotals"] = (input) => {
    if (
      !["global", "organization", "project"].includes(input.scopeKind) ||
      !DAY.test(input.dayUtc) ||
      (input.scopeKind === "global" ? input.scopeId !== "*" : !validText(input.scopeId, 256))
    )
      return Effect.fail(failure("invalid", "Budget totals scope or UTC day is invalid."));
    return usageFor(input).pipe(
      Effect.map((rows) => {
        const row = rows[0]!;
        return {
          activeRequests: row.active_requests,
          dailyAllocatedCalls: row.daily_allocated_calls,
          allocatedEstimatedTokens: row.allocated_estimated_tokens,
          activeReservedEstimatedTokens: row.active_reserved_estimated_tokens,
          measuredInputTokens: row.measured_input_tokens,
          measuredOutputTokens: row.measured_output_tokens,
          unknownUsageCalls: row.unknown_usage_calls,
          usageOverrunCalls: row.usage_overrun_calls,
        } satisfies OrganizationProviderBudgetTotals;
      }),
      Effect.mapError(() => unavailable()),
    );
  };
  const requireRecord = (requestId: string) =>
    Effect.gen(function* () {
      const row = (yield* rowFor(requestId))[0];
      if (!row) return yield* failure("not_found", "Provider request was not found.");
      return row;
    });
  const requireAuthority = (action: "dispatch" | "expire" | "release", row: BudgetRow) =>
    authority.permitsTransition(action, decode(row))
      ? Effect.void
      : Effect.fail(failure("forbidden", "Provider budget transition is not authorized."));
  const limitsFor = (organizationId: string, projectId: string) =>
    sql<LimitRow>`SELECT scope_kind, scope_id, max_concurrent, max_daily_calls,
      max_daily_estimated_tokens FROM organization_provider_budget_limits
      WHERE (scope_kind = 'global' AND scope_id = '*')
        OR (scope_kind = 'organization' AND scope_id = ${organizationId})
        OR (scope_kind = 'project' AND scope_id = ${projectId})`;
  const reserve: OrganizationProviderBudgetShape["reserve"] = (callerInput) => {
    const input = { ...callerInput };
    if (
      typeof input.requestId !== "string" ||
      !REQUEST_ID.test(input.requestId) ||
      !validText(input.organizationId, 256) ||
      !validText(input.projectId, 256) ||
      !validText(input.providerInstanceId, 128) ||
      !validText(input.modelId, 256) ||
      !Number.isSafeInteger(input.estimatedTokens) ||
      input.estimatedTokens < 1 ||
      input.estimatedTokens > 1_000_000
    )
      return Effect.fail(failure("invalid", "Provider reservation fields are invalid."));
    if (!authority.permitsReserve(input))
      return Effect.fail(failure("forbidden", "Provider reservation is not authorized."));
    return transaction(
      Effect.gen(function* () {
        // Acquire SQLite's write lock before every capacity read.
        const locked = yield* sql<{ scope_id: string }>`UPDATE organization_provider_budget_limits
        SET updated_at = updated_at WHERE scope_kind = 'global' AND scope_id = '*'
        RETURNING scope_id`;
        if (!locked[0]) return yield* failure("forbidden", "Global provider budget is disabled.");
        const prior = (yield* rowFor(input.requestId))[0];
        if (prior) {
          if (!sameRequest(prior, input))
            return yield* failure("conflict", "Provider request ID was reused with new operands.");
          return decode(prior);
        }
        const eligible = (yield* sql<{ present: number }>`SELECT EXISTS (
        SELECT 1 FROM organizations o
        JOIN organization_project_bindings b ON b.organization_id = o.organization_id
        JOIN projection_projects p ON p.project_id = b.project_id
        WHERE o.organization_id = ${input.organizationId}
          AND p.project_id = ${input.projectId}
          AND o.lifecycle = 'active' AND p.deleted_at IS NULL
          AND b.detached_at IS NULL
      ) AS present`)[0];
        if (eligible?.present !== 1)
          return yield* failure("forbidden", "Current Organization Project scope is unavailable.");
        const limits = yield* limitsFor(input.organizationId, input.projectId);
        if (limits.length !== 3)
          return yield* failure("forbidden", "All provider budget scopes must be configured.");
        const timestamp = now();
        const dayUtc = timestamp.slice(0, 10);
        for (const limit of limits) {
          const totals = (yield* usageFor({
            scopeKind: limit.scope_kind,
            scopeId: limit.scope_id,
            dayUtc,
          }))[0]!;
          if (
            totals.usage_overrun_calls > 0 ||
            totals.active_requests >= limit.max_concurrent ||
            totals.daily_allocated_calls >= limit.max_daily_calls ||
            totals.allocated_estimated_tokens + input.estimatedTokens >
              limit.max_daily_estimated_tokens
          )
            return yield* failure("exhausted", "Provider budget capacity is exhausted.");
        }
        const leaseUntil = new Date(Date.parse(timestamp) + LEASE_MS).toISOString();
        yield* sql`INSERT INTO organization_provider_budget_admissions
        (request_id, organization_id, project_id, provider_instance_id, model_id,
         estimated_tokens, day_utc, state, lease_until, created_at, updated_at,
         dispatched_at, reconciled_at, disposition, measured_input_tokens,
         measured_output_tokens)
        VALUES (${input.requestId}, ${input.organizationId}, ${input.projectId},
          ${input.providerInstanceId}, ${input.modelId}, ${input.estimatedTokens},
          ${dayUtc}, 'reserved', ${leaseUntil}, ${timestamp}, ${timestamp},
          NULL, NULL, NULL, NULL, NULL)`;
        return decode((yield* rowFor(input.requestId))[0]!);
      }),
    );
  };
  const transition = (requestId: string, action: "dispatch" | "expire" | "release") => {
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
      return Effect.fail(failure("invalid", "Request ID is invalid."));
    return transaction(
      Effect.gen(function* () {
        const row = yield* requireRecord(requestId);
        yield* requireAuthority(action, row);
        if (action === "dispatch") {
          if (row.state === "dispatched")
            return yield* failure("conflict", "Provider request was already dispatched.");
          if (row.state !== "reserved" || row.lease_until <= now())
            return yield* failure("conflict", "Reservation is not dispatchable.");
          const time = now();
          yield* sql`UPDATE organization_provider_budget_admissions
          SET state = 'dispatched', dispatched_at = ${time}, updated_at = ${time}
          WHERE request_id = ${requestId} AND state = 'reserved'`;
        } else if (action === "expire") {
          if (row.state === "uncertain") return decode(row);
          if (!ACTIVE.includes(row.state as (typeof ACTIVE)[number]) || row.lease_until > now())
            return yield* failure("conflict", "Provider lease is not eligible for uncertainty.");
          const time = now();
          yield* sql`UPDATE organization_provider_budget_admissions
          SET state = 'uncertain', updated_at = ${time}
          WHERE request_id = ${requestId} AND state IN ('reserved','dispatched')`;
        } else {
          if (row.state === "released") return decode(row);
          if (row.state !== "reserved")
            return yield* failure(
              "conflict",
              "Only a never-dispatched reservation can be released.",
            );
          const time = now();
          yield* sql`UPDATE organization_provider_budget_admissions
          SET state = 'released', disposition = 'not-dispatched',
            reconciled_at = ${time}, updated_at = ${time}
          WHERE request_id = ${requestId} AND state = 'reserved'`;
        }
        return decode((yield* rowFor(requestId))[0]!);
      }),
    );
  };
  const reconcile: OrganizationProviderBudgetShape["reconcile"] = (callerInput) => {
    const input = {
      requestId: callerInput.requestId,
      disposition: callerInput.disposition,
      measuredUsage:
        callerInput.measuredUsage === undefined
          ? undefined
          : {
              inputTokens: callerInput.measuredUsage.inputTokens,
              outputTokens: callerInput.measuredUsage.outputTokens,
            },
    };
    if (
      typeof input.requestId !== "string" ||
      !REQUEST_ID.test(input.requestId) ||
      (input.disposition !== "completed" && input.disposition !== "not-dispatched") ||
      (input.measuredUsage !== undefined && !validMeasured(input.measuredUsage)) ||
      (input.disposition === "not-dispatched" && input.measuredUsage !== undefined)
    )
      return Effect.fail(failure("invalid", "Reconciliation result is invalid."));
    return transaction(
      Effect.gen(function* () {
        const row = yield* requireRecord(input.requestId);
        if (!authority.permitsReconcile(input, decode(row)))
          return yield* failure("forbidden", "Provider reconciliation is not authorized.");
        if (row.state === "reconciled" || row.state === "released") {
          const saved = decode(row);
          const measured = input.measuredUsage ?? null;
          if (
            saved.disposition !== input.disposition ||
            (saved.measuredUsage?.inputTokens ?? null) !== (measured?.inputTokens ?? null) ||
            (saved.measuredUsage?.outputTokens ?? null) !== (measured?.outputTokens ?? null)
          )
            return yield* failure("conflict", "Reconciliation retry differs from saved outcome.");
          return saved;
        }
        if (input.disposition === "completed" && row.state === "reserved")
          return yield* failure(
            "conflict",
            "Completed use requires a dispatched or uncertain call.",
          );
        if (!ACTIVE.includes(row.state as (typeof ACTIVE)[number]))
          return yield* failure("conflict", "Provider request cannot be reconciled.");
        const time = now();
        const state = input.disposition === "completed" ? "reconciled" : "released";
        yield* sql`UPDATE organization_provider_budget_admissions
        SET state = ${state}, disposition = ${input.disposition},
          reconciled_at = ${time}, updated_at = ${time},
          measured_input_tokens = ${input.measuredUsage?.inputTokens ?? null},
          measured_output_tokens = ${input.measuredUsage?.outputTokens ?? null}
        WHERE request_id = ${input.requestId}
          AND state IN ('reserved','dispatched','uncertain')`;
        return decode((yield* rowFor(input.requestId))[0]!);
      }),
    );
  };
  return {
    reserve,
    markDispatched: (id) => transition(id, "dispatch"),
    markUncertain: (id) => transition(id, "expire"),
    release: (id) => transition(id, "release"),
    reconcile,
    get,
    getTotals,
  } satisfies OrganizationProviderBudgetShape;
});

export const OrganizationProviderBudgetWithAuthority = Layer.effect(
  OrganizationProviderBudget,
  make,
);
/** Production remains default-deny until a scoped provider coordinator is reviewed. */
export const OrganizationProviderBudgetLive = OrganizationProviderBudgetWithAuthority.pipe(
  Layer.provide(OrganizationProviderBudgetDisabled),
);
