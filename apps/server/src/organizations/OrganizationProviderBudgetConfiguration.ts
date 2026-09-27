// @effect-diagnostics globalDate:off globalDateInEffect:off - Revision timestamps use the server wall clock.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export type OrganizationProviderBudgetScope =
  | { readonly kind: "global" }
  | { readonly kind: "organization"; readonly organizationId: string }
  | { readonly kind: "project"; readonly projectId: string };

export interface OrganizationProviderBudgetLimits {
  readonly maxConcurrent: number;
  readonly maxDailyCalls: number;
  readonly maxDailyEstimatedTokens: number;
}

export interface OrganizationProviderBudgetConfigurationRecord extends OrganizationProviderBudgetLimits {
  readonly scope: OrganizationProviderBudgetScope;
  /** Opaque compare-and-swap token. The first write to a missing scope expects null. */
  readonly revision: string;
}

export interface OrganizationProviderBudgetConfigurationUpdate {
  readonly scope: OrganizationProviderBudgetScope;
  readonly expectedRevision: string | null;
  readonly limits: OrganizationProviderBudgetLimits;
}

export class OrganizationProviderBudgetConfigurationError extends Schema.TaggedError<OrganizationProviderBudgetConfigurationError>()(
  "OrganizationProviderBudgetConfigurationError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationProviderBudgetConfigurationError["code"], message: string) =>
  new OrganizationProviderBudgetConfigurationError({ code, message });
const isConfigurationError = Schema.is(OrganizationProviderBudgetConfigurationError);
const unavailable = () => failure("unavailable", "Provider budget configuration is unavailable.");

/** Supply only from a trusted, authenticated human request boundary. Model code receives no authority. */
export class OrganizationProviderBudgetConfigurationAuthority extends Context.Service<
  OrganizationProviderBudgetConfigurationAuthority,
  {
    readonly authenticatedHumanId: string | null;
    readonly permitsRead: (scope: OrganizationProviderBudgetScope) => boolean;
    /** Host administration is required to raise or lower the shared global ceiling. */
    readonly permitsGlobalUpdate: (
      update: OrganizationProviderBudgetConfigurationUpdate,
    ) => boolean;
    readonly permitsScopedUpdate: (
      update: OrganizationProviderBudgetConfigurationUpdate,
    ) => boolean;
  }
>()(
  "t3/organizations/OrganizationProviderBudgetConfiguration/OrganizationProviderBudgetConfigurationAuthority",
) {}
export const OrganizationProviderBudgetConfigurationDisabled = Layer.succeed(
  OrganizationProviderBudgetConfigurationAuthority,
  {
    authenticatedHumanId: null,
    permitsRead: () => false,
    permitsGlobalUpdate: () => false,
    permitsScopedUpdate: () => false,
  },
);

type ScopeKey = { readonly kind: "global" | "organization" | "project"; readonly id: string };
type LimitRow = {
  scope_kind: ScopeKey["kind"];
  scope_id: string;
  max_concurrent: number;
  max_daily_calls: number;
  max_daily_estimated_tokens: number;
  updated_at: string;
};
const validId = (id: unknown): id is string =>
  typeof id === "string" &&
  id.trim().length > 0 &&
  !id.includes("\0") &&
  Buffer.byteLength(id, "utf8") <= 256;
const scopeKey = (scope: unknown): ScopeKey | null => {
  if (typeof scope !== "object" || scope === null || !("kind" in scope)) return null;
  if (scope.kind === "global" && Object.keys(scope).length === 1)
    return { kind: "global", id: "*" };
  if (
    scope.kind === "organization" &&
    Object.keys(scope).length === 2 &&
    "organizationId" in scope &&
    validId(scope.organizationId)
  )
    return { kind: "organization", id: scope.organizationId };
  if (
    scope.kind === "project" &&
    Object.keys(scope).length === 2 &&
    "projectId" in scope &&
    validId(scope.projectId)
  )
    return { kind: "project", id: scope.projectId };
  return null;
};
const validLimit = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const validLimits = (limits: unknown): limits is OrganizationProviderBudgetLimits =>
  typeof limits === "object" &&
  limits !== null &&
  "maxConcurrent" in limits &&
  validLimit(limits.maxConcurrent, 64) &&
  "maxDailyCalls" in limits &&
  validLimit(limits.maxDailyCalls, 10_000) &&
  "maxDailyEstimatedTokens" in limits &&
  validLimit(limits.maxDailyEstimatedTokens, 1_000_000_000);
const validRevision = (revision: unknown): revision is string | null =>
  revision === null ||
  (typeof revision === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(revision) &&
    Number.isFinite(Date.parse(revision)) &&
    new Date(revision).toISOString() === revision);
const nextRevision = (previous: string | null) =>
  new Date(Math.max(Date.now(), previous === null ? 0 : Date.parse(previous) + 1)).toISOString();
const decode = (row: LimitRow): OrganizationProviderBudgetConfigurationRecord => ({
  scope:
    row.scope_kind === "global"
      ? { kind: "global" }
      : row.scope_kind === "organization"
        ? { kind: "organization", organizationId: row.scope_id }
        : { kind: "project", projectId: row.scope_id },
  maxConcurrent: row.max_concurrent,
  maxDailyCalls: row.max_daily_calls,
  maxDailyEstimatedTokens: row.max_daily_estimated_tokens,
  revision: row.updated_at,
});

export interface OrganizationProviderBudgetConfigurationShape {
  readonly get: (
    scope: OrganizationProviderBudgetScope,
  ) => Effect.Effect<
    OrganizationProviderBudgetConfigurationRecord | null,
    OrganizationProviderBudgetConfigurationError
  >;
  readonly update: (
    update: OrganizationProviderBudgetConfigurationUpdate,
  ) => Effect.Effect<
    OrganizationProviderBudgetConfigurationRecord,
    OrganizationProviderBudgetConfigurationError
  >;
}
export class OrganizationProviderBudgetConfiguration extends Context.Service<
  OrganizationProviderBudgetConfiguration,
  OrganizationProviderBudgetConfigurationShape
>()("t3/organizations/OrganizationProviderBudgetConfiguration") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* OrganizationProviderBudgetConfigurationAuthority;
  const humanId = authority.authenticatedHumanId;
  const rowFor = (key: ScopeKey) => sql<LimitRow>`SELECT * FROM organization_provider_budget_limits
    WHERE scope_kind = ${key.kind} AND scope_id = ${key.id}`;
  const human = () => validId(humanId);
  const get: OrganizationProviderBudgetConfigurationShape["get"] = (scope) => {
    const key = scopeKey(scope);
    if (!key) return Effect.fail(failure("invalid", "Provider budget scope is invalid."));
    if (!human() || !authority.permitsRead(scope))
      return Effect.fail(
        failure("forbidden", "Provider budget configuration read is not authorized."),
      );
    return rowFor(key).pipe(
      Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
      Effect.mapError(() => unavailable()),
    );
  };
  const update: OrganizationProviderBudgetConfigurationShape["update"] = (input) => {
    const key = scopeKey(input?.scope);
    if (!key || !validRevision(input?.expectedRevision) || !validLimits(input?.limits))
      return Effect.fail(failure("invalid", "Provider budget configuration update is invalid."));
    const scope: OrganizationProviderBudgetScope =
      key.kind === "global"
        ? { kind: "global" }
        : key.kind === "organization"
          ? { kind: "organization", organizationId: key.id }
          : { kind: "project", projectId: key.id };
    const proposed: OrganizationProviderBudgetConfigurationUpdate = {
      scope: Object.freeze(scope),
      expectedRevision: input.expectedRevision,
      limits: Object.freeze({
        maxConcurrent: input.limits.maxConcurrent,
        maxDailyCalls: input.limits.maxDailyCalls,
        maxDailyEstimatedTokens: input.limits.maxDailyEstimatedTokens,
      }),
    };
    if (
      !human() ||
      !(key.kind === "global"
        ? authority.permitsGlobalUpdate(proposed)
        : authority.permitsScopedUpdate(proposed))
    )
      return Effect.fail(
        failure("forbidden", "Provider budget configuration update is not authorized."),
      );
    const limits = proposed.limits;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          // Acquire SQLite's write lock before reading the revision or scope existence.
          const locked = yield* sql<{ scope_id: string }>`UPDATE organization_provider_budget_limits
        SET updated_at = updated_at WHERE scope_kind = 'global' AND scope_id = '*'
        RETURNING scope_id`;
          if (!locked[0])
            return yield* failure("unavailable", "Global provider budget is unavailable.");
          const exists =
            key.kind === "global"
              ? true
              : key.kind === "organization"
                ? (yield* sql<{ present: number }>`SELECT EXISTS (
            SELECT 1 FROM organizations WHERE organization_id = ${key.id}
          ) AS present`)[0]?.present === 1
                : (yield* sql<{ present: number }>`SELECT EXISTS (
            SELECT 1 FROM projection_projects WHERE project_id = ${key.id}
              AND deleted_at IS NULL
          ) AS present`)[0]?.present === 1;
          if (!exists) return yield* failure("not_found", "Provider budget scope does not exist.");
          const prior = (yield* rowFor(key))[0];
          if ((prior?.updated_at ?? null) !== proposed.expectedRevision)
            return yield* failure("conflict", "Provider budget revision is stale.");
          const revision = nextRevision(prior?.updated_at ?? null);
          let changed: LimitRow;
          if (prior) {
            const updated = yield* sql<LimitRow>`UPDATE organization_provider_budget_limits
          SET max_concurrent = ${limits.maxConcurrent},
            max_daily_calls = ${limits.maxDailyCalls},
            max_daily_estimated_tokens = ${limits.maxDailyEstimatedTokens},
            updated_at = ${revision}
          WHERE scope_kind = ${key.kind} AND scope_id = ${key.id}
            AND updated_at = ${prior.updated_at} RETURNING *`;
            if (!updated[0])
              return yield* failure("conflict", "Provider budget revision is stale.");
            changed = updated[0];
          } else {
            const inserted = yield* sql<LimitRow>`INSERT INTO organization_provider_budget_limits
          (scope_kind, scope_id, max_concurrent, max_daily_calls,
            max_daily_estimated_tokens, updated_at)
          VALUES (${key.kind}, ${key.id}, ${limits.maxConcurrent},
            ${limits.maxDailyCalls}, ${limits.maxDailyEstimatedTokens}, ${revision})
          RETURNING *`;
            changed = inserted[0]!;
          }
          yield* sql`INSERT INTO organization_provider_budget_audit
        (scope_kind, scope_id, actor_id, previous_revision, applied_revision,
          previous_max_concurrent, previous_max_daily_calls,
          previous_max_daily_estimated_tokens, max_concurrent, max_daily_calls,
          max_daily_estimated_tokens, created_at)
        VALUES (${key.kind}, ${key.id}, ${humanId}, ${prior?.updated_at ?? null}, ${revision},
          ${prior?.max_concurrent ?? null}, ${prior?.max_daily_calls ?? null},
          ${prior?.max_daily_estimated_tokens ?? null}, ${limits.maxConcurrent},
          ${limits.maxDailyCalls}, ${limits.maxDailyEstimatedTokens}, ${revision})`;
          return decode(changed);
        }),
      )
      .pipe(
        Effect.mapError((error): OrganizationProviderBudgetConfigurationError =>
          isConfigurationError(error) ? error : unavailable(),
        ),
      );
  };
  return { get, update } satisfies OrganizationProviderBudgetConfigurationShape;
});

export const OrganizationProviderBudgetConfigurationWithAuthority = Layer.effect(
  OrganizationProviderBudgetConfiguration,
  make,
);
export const OrganizationProviderBudgetConfigurationLive =
  OrganizationProviderBudgetConfigurationWithAuthority.pipe(
    Layer.provide(OrganizationProviderBudgetConfigurationDisabled),
  );
