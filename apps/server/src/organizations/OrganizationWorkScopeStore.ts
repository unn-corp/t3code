import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface OrganizationWorkScopeIdentity {
  readonly unitName: string;
  readonly invocationId: string;
  readonly controlGroup: string;
  readonly sandboxPid: number;
  readonly pidNamespace: number;
}

export type OrganizationWorkScopeState =
  | "prepared"
  | "start-requested"
  | "token-released"
  | "started"
  | "stop-requested"
  | "verified-stopped";

export interface OrganizationWorkScopeRecord extends OrganizationWorkScopeIdentity {
  readonly attemptId: string;
  readonly state: OrganizationWorkScopeState;
  readonly preparedAt: string;
  readonly startRequestedAt: string | null;
  readonly tokenReleasedAt: string | null;
  readonly startedAt: string | null;
  readonly stopRequestedAt: string | null;
  readonly verifiedStoppedAt: string | null;
}

export interface OrganizationUnscopedAttempt {
  readonly attemptId: string;
  readonly workId: string;
  readonly leaseUntil: string;
  readonly permitState: "active" | "released" | "expired" | null;
}

export interface OrganizationWorkScopePreparation {
  readonly attemptId: string;
  readonly preparationStartedAt: string;
  /** Null only for an unattached marker created before migration 078. */
  readonly unitName: string | null;
  /** Durable one-time fence written immediately before the OS preparation call. */
  readonly launchRequestedAt: string | null;
  /** Legacy rows cannot prove whether an OS launch was already attempted. */
  readonly launchState: "legacy-unknown" | "reserved" | "requested";
}

/** A trusted callback returns this only after its gate-token write has completed. */
export const OrganizationScopeTokenReleased = Symbol("OrganizationScopeTokenReleased");

export class OrganizationWorkScopeError extends Schema.TaggedError<OrganizationWorkScopeError>()(
  "OrganizationWorkScopeError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}

const scopeError = (code: OrganizationWorkScopeError["code"], message: string) =>
  new OrganizationWorkScopeError({ code, message });
const isScopeError = Schema.is(OrganizationWorkScopeError);
const conflict = (message: string) => scopeError("conflict", message);
const unavailable = () =>
  scopeError("unavailable", "Organization scope verification is unavailable.");
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** Only a server-owned OS verifier may supply this service. The live default denies. */
export interface OrganizationWorkScopeStopVerifierShape {
  readonly verifyStopped: (
    identity: OrganizationWorkScopeIdentity,
  ) => Effect.Effect<void, OrganizationWorkScopeError>;
}
export class OrganizationWorkScopeStopVerifier extends Context.Service<
  OrganizationWorkScopeStopVerifier,
  OrganizationWorkScopeStopVerifierShape
>()("t3/organizations/OrganizationWorkScopeStore/OrganizationWorkScopeStopVerifier") {}
export const OrganizationWorkScopeStopVerifierDisabled = Layer.succeed(
  OrganizationWorkScopeStopVerifier,
  { verifyStopped: () => Effect.fail(unavailable()) },
);

type ScopeRow = {
  attempt_id: string;
  unit_name: string;
  invocation_id: string;
  control_group: string;
  sandbox_pid: number;
  pid_namespace: number;
  prepared_at: string;
  start_requested_at: string | null;
  token_released_at: string | null;
  started_at: string | null;
  stop_requested_at: string | null;
  verified_stopped_at: string | null;
};
type GapRow = {
  attempt_id: string;
  work_id: string;
  lease_until: string;
  permit_state: "active" | "released" | "expired" | null;
};

const identityOf = (row: ScopeRow): OrganizationWorkScopeIdentity => ({
  unitName: row.unit_name,
  invocationId: row.invocation_id,
  controlGroup: row.control_group,
  sandboxPid: row.sandbox_pid,
  pidNamespace: row.pid_namespace,
});
const decode = (row: ScopeRow): OrganizationWorkScopeRecord => ({
  attemptId: row.attempt_id,
  ...identityOf(row),
  state: row.verified_stopped_at
    ? "verified-stopped"
    : row.stop_requested_at
      ? "stop-requested"
      : row.started_at
        ? "started"
        : row.token_released_at
          ? "token-released"
          : row.start_requested_at
            ? "start-requested"
            : "prepared",
  preparedAt: row.prepared_at,
  startRequestedAt: row.start_requested_at,
  tokenReleasedAt: row.token_released_at,
  startedAt: row.started_at,
  stopRequestedAt: row.stop_requested_at,
  verifiedStoppedAt: row.verified_stopped_at,
});

function validIdentity(identity: OrganizationWorkScopeIdentity): boolean {
  return (
    /^t3-org-sandbox-[a-f0-9]{32}\.scope$/.test(identity.unitName) &&
    /^[a-f0-9]{32}$/.test(identity.invocationId) &&
    identity.controlGroup.startsWith("/user.slice/") &&
    identity.controlGroup.endsWith(`/${identity.unitName}`) &&
    /^\/[A-Za-z0-9_./@-]+$/.test(identity.controlGroup) &&
    !identity.controlGroup.includes("..") &&
    Number.isSafeInteger(identity.sandboxPid) &&
    identity.sandboxPid > 0 &&
    Number.isSafeInteger(identity.pidNamespace) &&
    identity.pidNamespace > 0
  );
}
function sameIdentity(left: ScopeRow, right: OrganizationWorkScopeIdentity): boolean {
  return (
    left.unit_name === right.unitName &&
    left.invocation_id === right.invocationId &&
    left.control_group === right.controlGroup &&
    left.sandbox_pid === right.sandboxPid &&
    left.pid_namespace === right.pidNamespace
  );
}
function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw scopeError("invalid", "Limit must be 1-100.");
  return limit;
}

export interface OrganizationWorkScopeStoreShape {
  /** Commit before host preparation so an unreturned scope cannot lose its permit. */
  readonly markPreparing: (
    attemptId: string,
    unitName: string,
  ) => Effect.Effect<OrganizationWorkScopePreparation, OrganizationWorkScopeError>;
  readonly markLaunchRequested: (
    attemptId: string,
    unitName: string,
    options?: { readonly requireFresh?: boolean },
  ) => Effect.Effect<OrganizationWorkScopePreparation, OrganizationWorkScopeError>;
  readonly getPreparation: (
    attemptId: string,
  ) => Effect.Effect<OrganizationWorkScopePreparation | null, OrganizationWorkScopeError>;
  readonly attachPrepared: (input: {
    readonly attemptId: string;
    readonly identity: OrganizationWorkScopeIdentity;
  }) => Effect.Effect<OrganizationWorkScopeRecord, OrganizationWorkScopeError>;
  readonly requestStart: (
    attemptId: string,
  ) => Effect.Effect<OrganizationWorkScopeRecord, OrganizationWorkScopeError>;
  /** Holds a SQLite write lock until the actual FD4/FD5 write completes.
   * The callback must await stream completion, not merely queue Writable.end().
   */
  readonly startWithFence: (
    attemptId: string,
    releaseToken: () =>
      | Promise<typeof OrganizationScopeTokenReleased>
      | typeof OrganizationScopeTokenReleased,
  ) => Effect.Effect<OrganizationWorkScopeRecord, OrganizationWorkScopeError>;
  readonly recordStarted: (
    attemptId: string,
  ) => Effect.Effect<OrganizationWorkScopeRecord, OrganizationWorkScopeError>;
  readonly requestStop: (
    attemptId: string,
  ) => Effect.Effect<OrganizationWorkScopeRecord, OrganizationWorkScopeError>;
  readonly recordStopped: (
    attemptId: string,
  ) => Effect.Effect<OrganizationWorkScopeRecord, OrganizationWorkScopeError>;
  readonly get: (
    attemptId: string,
  ) => Effect.Effect<OrganizationWorkScopeRecord | null, OrganizationWorkScopeError>;
  readonly listOpenScopes: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<OrganizationWorkScopeRecord>, OrganizationWorkScopeError>;
  readonly listUnscopedRunning: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<OrganizationUnscopedAttempt>, OrganizationWorkScopeError>;
}
export class OrganizationWorkScopeStore extends Context.Service<
  OrganizationWorkScopeStore,
  OrganizationWorkScopeStoreShape
>()("t3/organizations/OrganizationWorkScopeStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const verifier = yield* OrganizationWorkScopeStopVerifier;
  const transaction = <A, E>(
    effect: Effect.Effect<A, E, never>,
  ): Effect.Effect<A, OrganizationWorkScopeError> =>
    sql
      .withTransaction(effect)
      .pipe(Effect.mapError((error) => (isScopeError(error) ? error : unavailable())));
  const rowFor = (attemptId: string) =>
    sql<ScopeRow>`SELECT * FROM organization_work_scopes WHERE attempt_id = ${attemptId}`;
  const requiredRaw = Effect.fnUntraced(function* (attemptId: string) {
    const row = (yield* rowFor(attemptId))[0];
    if (!row) return yield* scopeError("not_found", "Organization work scope was not found.");
    return row;
  });
  const required = (attemptId: string) =>
    requiredRaw(attemptId).pipe(
      Effect.mapError((error) => (isScopeError(error) ? error : unavailable())),
    );

  const authorizeUnscopedPreparation = (attemptId: string, time: string) => sql<{
    attempt_id: string;
  }>`UPDATE organization_work_resource_permits
    SET work_id = work_id
    WHERE attempt_id = ${attemptId} AND state = 'active'
      AND julianday(lease_until) > julianday(${time})
      AND EXISTS (SELECT 1 FROM organization_work_attempts a
        JOIN organization_work_items w ON w.work_id = a.work_id
        JOIN organizations o ON o.organization_id = w.organization_id
        JOIN organization_project_bindings b ON b.binding_id = w.binding_id
        JOIN projection_projects project ON project.project_id = w.project_id
        WHERE a.attempt_id = organization_work_resource_permits.attempt_id
          AND a.status = 'running' AND w.status = 'running'
          AND a.number = w.attempt_count
          AND organization_work_resource_permits.work_id = w.work_id
          AND organization_work_resource_permits.organization_id = w.organization_id
          AND organization_work_resource_permits.project_id = w.project_id
          AND julianday(a.lease_until) > julianday(${time})
          AND o.lifecycle = 'active' AND project.deleted_at IS NULL
          AND b.detached_at IS NULL AND b.access = 'write'
          AND b.organization_id = w.organization_id AND b.project_id = w.project_id
          AND b.updated_at = w.binding_version AND b.scope IS w.scope
          AND NOT EXISTS (SELECT 1 FROM organization_work_scopes s
            WHERE s.attempt_id = a.attempt_id)
          AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
            WHERE value = 'read-files')
          AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
            WHERE value = 'write-files')
          AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
            WHERE value = 'run-tests'))
    RETURNING attempt_id`;

  const markPreparing: OrganizationWorkScopeStoreShape["markPreparing"] = (attemptId, unitName) => {
    if (
      typeof attemptId !== "string" ||
      !attemptId.trim() ||
      attemptId.length > 160 ||
      typeof unitName !== "string" ||
      !/^t3-org-sandbox-[a-f0-9]{32}\.scope$/.test(unitName)
    )
      return Effect.fail(scopeError("invalid", "Attempt or reserved scope unit is invalid."));
    return transaction(
      Effect.gen(function* () {
        const time = yield* now;
        // This conditional write acquires SQLite's policy lock. A concurrent
        // detach, pause, or permit release serializes before or after the marker.
        const authorized = yield* authorizeUnscopedPreparation(attemptId, time);
        if (authorized.length !== 1)
          return yield* conflict("Attempt or permit no longer authorizes scope preparation.");
        yield* sql`INSERT OR IGNORE INTO organization_work_scope_preparations
          (attempt_id, preparation_started_at, unit_name, launch_state)
          VALUES (${attemptId}, ${time}, ${unitName}, 'reserved')`;
        const row = (yield* sql<{
          attempt_id: string;
          preparation_started_at: string;
          unit_name: string | null;
          launch_requested_at: string | null;
          launch_state: OrganizationWorkScopePreparation["launchState"];
        }>`
          SELECT attempt_id, preparation_started_at, unit_name, launch_requested_at,
            launch_state
          FROM organization_work_scope_preparations WHERE attempt_id = ${attemptId}`)[0];
        if (!row || row.unit_name !== unitName)
          return yield* conflict("Attempt has a different or ambiguous reserved scope unit.");
        return {
          attemptId: row.attempt_id,
          preparationStartedAt: row.preparation_started_at,
          unitName: row.unit_name,
          launchRequestedAt: row.launch_requested_at,
          launchState: row.launch_state,
        };
      }),
    );
  };

  const markLaunchRequested: OrganizationWorkScopeStoreShape["markLaunchRequested"] = (
    attemptId,
    unitName,
    options,
  ) => {
    if (
      typeof attemptId !== "string" ||
      !attemptId.trim() ||
      attemptId.length > 160 ||
      typeof unitName !== "string" ||
      !/^t3-org-sandbox-[a-f0-9]{32}\.scope$/.test(unitName)
    )
      return Effect.fail(scopeError("invalid", "Attempt or reserved scope unit is invalid."));
    return transaction(
      Effect.gen(function* () {
        const time = yield* now;
        // Revalidate under SQLite's write lock immediately before the OS call.
        // An exact retry returns the original timestamp and never renews authority.
        const authorized = yield* authorizeUnscopedPreparation(attemptId, time);
        if (authorized.length !== 1)
          return yield* conflict("Attempt or permit no longer authorizes scope launch.");
        const prior = (yield* sql<{
          attempt_id: string;
          preparation_started_at: string;
          unit_name: string | null;
          launch_requested_at: string | null;
          launch_state: OrganizationWorkScopePreparation["launchState"];
        }>`SELECT attempt_id, preparation_started_at, unit_name, launch_requested_at,
          launch_state
        FROM organization_work_scope_preparations WHERE attempt_id = ${attemptId}`)[0];
        if (!prior || prior.unit_name !== unitName)
          return yield* conflict("Attempt has no matching reserved scope unit.");
        if (prior.launch_state === "legacy-unknown")
          return yield* conflict("Legacy preparation has unknown OS launch state.");
        if (prior.launch_requested_at !== null) {
          if (options?.requireFresh)
            return yield* conflict("Scope launch was already requested for this attempt.");
          return {
            attemptId: prior.attempt_id,
            preparationStartedAt: prior.preparation_started_at,
            unitName: prior.unit_name,
            launchRequestedAt: prior.launch_requested_at,
            launchState: prior.launch_state,
          };
        }
        const marked = yield* sql<{
          attempt_id: string;
          preparation_started_at: string;
          unit_name: string;
          launch_requested_at: string;
          launch_state: OrganizationWorkScopePreparation["launchState"];
        }>`UPDATE organization_work_scope_preparations
        SET launch_requested_at = ${time}, launch_state = 'requested'
        WHERE attempt_id = ${attemptId} AND unit_name = ${unitName}
          AND launch_requested_at IS NULL AND launch_state = 'reserved'
        RETURNING attempt_id, preparation_started_at, unit_name, launch_requested_at,
          launch_state`;
        const row = marked[0];
        if (!row) return yield* conflict("Scope launch request was already recorded.");
        return {
          attemptId: row.attempt_id,
          preparationStartedAt: row.preparation_started_at,
          unitName: row.unit_name,
          launchRequestedAt: row.launch_requested_at,
          launchState: row.launch_state,
        };
      }),
    );
  };

  const getPreparation: OrganizationWorkScopeStoreShape["getPreparation"] = (attemptId) =>
    sql<{
      attempt_id: string;
      preparation_started_at: string;
      unit_name: string | null;
      launch_requested_at: string | null;
      launch_state: OrganizationWorkScopePreparation["launchState"];
    }>`
      SELECT attempt_id, preparation_started_at, unit_name, launch_requested_at,
        launch_state
      FROM organization_work_scope_preparations WHERE attempt_id = ${attemptId}`.pipe(
      Effect.map((rows) =>
        rows[0]
          ? {
              attemptId: rows[0].attempt_id,
              preparationStartedAt: rows[0].preparation_started_at,
              unitName: rows[0].unit_name,
              launchRequestedAt: rows[0].launch_requested_at,
              launchState: rows[0].launch_state,
            }
          : null,
      ),
      Effect.mapError(() => unavailable()),
    );

  const attachPrepared: OrganizationWorkScopeStoreShape["attachPrepared"] = (input) => {
    // Capture caller-owned values before Effect evaluation. The OS host must be
    // prepared first, then this record committed before FD5 is released.
    const attemptId = input.attemptId;
    const identity = { ...input.identity };
    if (!attemptId || !validIdentity(identity))
      return Effect.fail(scopeError("invalid", "Scope identity is invalid."));
    return transaction(
      Effect.gen(function* () {
        const reservation = (yield* sql<{ unit_name: string | null }>`
          SELECT unit_name FROM organization_work_scope_preparations
          WHERE attempt_id = ${attemptId}`)[0];
        if (reservation && reservation.unit_name !== identity.unitName)
          return yield* conflict("Scope identity differs from its durable unit reservation.");
        const existing = (yield* rowFor(attemptId))[0];
        if (existing) {
          if (!sameIdentity(existing, identity))
            return yield* conflict("Attempt already has a different scope identity.");
          return decode(existing);
        }
        const time = yield* now;
        const inserted = yield* sql<ScopeRow>`INSERT OR IGNORE INTO organization_work_scopes
        (attempt_id, unit_name, invocation_id, control_group, sandbox_pid,
          pid_namespace, prepared_at)
        SELECT a.attempt_id, ${identity.unitName}, ${identity.invocationId},
          ${identity.controlGroup}, ${identity.sandboxPid}, ${identity.pidNamespace}, ${time}
        FROM organization_work_attempts a
        JOIN organization_work_items w ON w.work_id = a.work_id
        JOIN organization_work_resource_permits p ON p.attempt_id = a.attempt_id
        JOIN organizations o ON o.organization_id = w.organization_id
        JOIN organization_project_bindings b ON b.binding_id = w.binding_id
        JOIN projection_projects project ON project.project_id = w.project_id
        WHERE a.attempt_id = ${attemptId} AND a.status = 'running'
          AND w.status = 'running' AND a.number = w.attempt_count
          AND p.state = 'active' AND p.work_id = w.work_id
          AND p.organization_id = w.organization_id AND p.project_id = w.project_id
          AND julianday(a.lease_until) > julianday(${time})
          AND o.lifecycle = 'active' AND project.deleted_at IS NULL
          AND b.detached_at IS NULL AND b.access = 'write'
          AND b.organization_id = w.organization_id AND b.project_id = w.project_id
          AND b.updated_at = w.binding_version AND b.scope IS w.scope
          AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
            WHERE value = 'read-files')
          AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
            WHERE value = 'write-files')
          AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
            WHERE value = 'run-tests')
        RETURNING *`;
        if (inserted[0]) return decode(inserted[0]);
        const raced = (yield* rowFor(attemptId))[0];
        if (raced && sameIdentity(raced, identity)) return decode(raced);
        return yield* conflict(
          "Attempt is stale, unauthorized, or scope identity is already used.",
        );
      }),
    );
  };

  const requestStart: OrganizationWorkScopeStoreShape["requestStart"] = (attemptId) =>
    transaction(
      Effect.gen(function* () {
        const time = yield* now;
        const updated = yield* sql<ScopeRow>`UPDATE organization_work_scopes
        SET start_requested_at = COALESCE(start_requested_at, ${time})
        WHERE attempt_id = ${attemptId}
          AND stop_requested_at IS NULL AND verified_stopped_at IS NULL
          AND EXISTS (SELECT 1 FROM organization_work_attempts a
            JOIN organization_work_items w ON w.work_id = a.work_id
            JOIN organization_work_resource_permits p ON p.attempt_id = a.attempt_id
            JOIN organizations o ON o.organization_id = w.organization_id
            JOIN organization_project_bindings b ON b.binding_id = w.binding_id
            JOIN projection_projects project ON project.project_id = w.project_id
            WHERE a.attempt_id = organization_work_scopes.attempt_id
              AND a.status = 'running' AND w.status = 'running'
              AND a.number = w.attempt_count AND p.state = 'active'
              AND p.work_id = w.work_id
              AND p.organization_id = w.organization_id AND p.project_id = w.project_id
              AND julianday(a.lease_until) > julianday(${time})
              AND o.lifecycle = 'active' AND project.deleted_at IS NULL
              AND b.detached_at IS NULL AND b.access = 'write'
              AND b.organization_id = w.organization_id AND b.project_id = w.project_id
              AND b.updated_at = w.binding_version AND b.scope IS w.scope
              AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
                WHERE value = 'read-files')
              AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
                WHERE value = 'write-files')
              AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
                WHERE value = 'run-tests'))
        RETURNING *`;
        if (updated[0]) return decode(updated[0]);
        const row = yield* required(attemptId);
        if (row.stop_requested_at || row.verified_stopped_at)
          return yield* conflict("Scope stop was requested; start is fenced.");
        return yield* conflict("Attempt or permit no longer authorizes scope start.");
      }),
    );

  const startWithFence: OrganizationWorkScopeStoreShape["startWithFence"] = (
    attemptId,
    releaseToken,
  ) =>
    Effect.uninterruptible(
      transaction(
        Effect.gen(function* () {
          const row = yield* required(attemptId);
          if (row.stop_requested_at || row.verified_stopped_at)
            return yield* conflict("Scope stop was requested; token release is fenced.");
          if (row.token_released_at) return decode(row);
          if (!row.start_requested_at)
            return yield* conflict("Durable start intent must be recorded before token release.");
          const time = yield* now;
          // This conditional UPDATE acquires SQLite's write lock. requestStop cannot
          // commit between this recheck and the completed FD5 release callback.
          const locked = yield* sql<ScopeRow>`UPDATE organization_work_scopes
      SET start_requested_at = start_requested_at
      WHERE attempt_id = ${attemptId} AND start_requested_at IS NOT NULL
        AND token_released_at IS NULL AND stop_requested_at IS NULL
        AND verified_stopped_at IS NULL
        AND EXISTS (SELECT 1 FROM organization_work_attempts a
          JOIN organization_work_items w ON w.work_id = a.work_id
          JOIN organization_work_resource_permits p ON p.attempt_id = a.attempt_id
          JOIN organizations o ON o.organization_id = w.organization_id
          JOIN organization_project_bindings b ON b.binding_id = w.binding_id
          JOIN projection_projects project ON project.project_id = w.project_id
          WHERE a.attempt_id = organization_work_scopes.attempt_id
            AND a.status = 'running' AND w.status = 'running'
            AND a.number = w.attempt_count AND p.state = 'active'
            AND p.work_id = w.work_id
            AND p.organization_id = w.organization_id AND p.project_id = w.project_id
            AND julianday(a.lease_until) > julianday(${time})
            AND o.lifecycle = 'active' AND project.deleted_at IS NULL
            AND b.detached_at IS NULL AND b.access = 'write'
            AND b.organization_id = w.organization_id AND b.project_id = w.project_id
            AND b.updated_at = w.binding_version AND b.scope IS w.scope
            AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
              WHERE value = 'read-files')
            AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
              WHERE value = 'write-files')
            AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
              WHERE value = 'run-tests'))
      RETURNING *`;
          if (!locked[0])
            return yield* conflict("Attempt or permit no longer authorizes token release.");
          const released = yield* Effect.tryPromise({
            try: async () => await releaseToken(),
            catch: () => unavailable(),
          });
          if (released !== OrganizationScopeTokenReleased)
            return yield* conflict("Token release callback did not complete.");
          const updated = yield* sql<ScopeRow>`UPDATE organization_work_scopes
      SET token_released_at = ${time}
      WHERE attempt_id = ${attemptId} AND token_released_at IS NULL
        AND stop_requested_at IS NULL RETURNING *`;
          if (!updated[0]) return yield* conflict("Scope token release could not be recorded.");
          return decode(updated[0]);
        }),
      ),
    );

  const recordStarted: OrganizationWorkScopeStoreShape["recordStarted"] = (attemptId) =>
    transaction(
      Effect.gen(function* () {
        const time = yield* now;
        const updated = yield* sql<ScopeRow>`UPDATE organization_work_scopes
        SET started_at = ${time}
        WHERE attempt_id = ${attemptId} AND token_released_at IS NOT NULL
          AND started_at IS NULL AND stop_requested_at IS NULL
          AND verified_stopped_at IS NULL
        RETURNING *`;
        if (updated[0]) return decode(updated[0]);
        const row = yield* required(attemptId);
        if (row.started_at) return decode(row);
        return yield* conflict("Scope start was not requested or was already stopped.");
      }),
    );

  const requestStop: OrganizationWorkScopeStoreShape["requestStop"] = (attemptId) =>
    transaction(
      Effect.gen(function* () {
        const time = yield* now;
        // This only revokes start authority. It remains valid after lease expiry
        // or a permit release so crash recovery can always fence an attached host.
        const updated = yield* sql<ScopeRow>`UPDATE organization_work_scopes
        SET stop_requested_at = ${time}
        WHERE attempt_id = ${attemptId} AND stop_requested_at IS NULL
          AND verified_stopped_at IS NULL RETURNING *`;
        if (updated[0]) return decode(updated[0]);
        return decode(yield* required(attemptId));
      }),
    );

  const recordStopped: OrganizationWorkScopeStoreShape["recordStopped"] = (attemptId) =>
    Effect.gen(function* () {
      const row = yield* required(attemptId);
      if (row.verified_stopped_at) return decode(row);
      if (!row.stop_requested_at)
        return yield* conflict("Scope stop must be requested before verification.");
      // The injected verifier receives only the persisted immutable identity.
      // No caller-supplied string or boolean can act as a stop receipt.
      yield* verifier.verifyStopped(identityOf(row));
      return yield* transaction(
        Effect.gen(function* () {
          const time = yield* now;
          const updated = yield* sql<ScopeRow>`UPDATE organization_work_scopes
          SET verified_stopped_at = ${time}
          WHERE attempt_id = ${attemptId} AND stop_requested_at IS NOT NULL
            AND unit_name = ${row.unit_name} AND invocation_id = ${row.invocation_id}
            AND control_group = ${row.control_group}
            AND sandbox_pid = ${row.sandbox_pid} AND pid_namespace = ${row.pid_namespace}
            AND verified_stopped_at IS NULL RETURNING *`;
          if (updated[0]) return decode(updated[0]);
          const latest = yield* required(attemptId);
          if (!sameIdentity(latest, identityOf(row)))
            return yield* conflict("Scope identity changed during stop verification.");
          if (latest.verified_stopped_at) return decode(latest);
          return yield* conflict("Scope stop was not requested.");
        }),
      );
    });

  const get: OrganizationWorkScopeStoreShape["get"] = (attemptId) =>
    rowFor(attemptId).pipe(
      Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
      Effect.mapError(() => unavailable()),
    );
  const listOpenScopes: OrganizationWorkScopeStoreShape["listOpenScopes"] = (limit) =>
    Effect.try({
      try: () => boundedLimit(limit),
      catch: () => scopeError("invalid", "Limit must be 1-100."),
    }).pipe(
      Effect.flatMap(
        (bounded) => sql<ScopeRow>`SELECT * FROM organization_work_scopes
        WHERE verified_stopped_at IS NULL ORDER BY prepared_at, attempt_id LIMIT ${bounded}`,
      ),
      Effect.map((rows) => rows.map(decode)),
      Effect.mapError((error) => (isScopeError(error) ? error : unavailable())),
    );
  const listUnscopedRunning: OrganizationWorkScopeStoreShape["listUnscopedRunning"] = (limit) =>
    Effect.try({
      try: () => boundedLimit(limit),
      catch: () => scopeError("invalid", "Limit must be 1-100."),
    }).pipe(
      Effect.flatMap(
        (bounded) => sql<GapRow>`SELECT a.attempt_id, a.work_id, a.lease_until,
          p.state AS permit_state
        FROM organization_work_attempts a
        JOIN organization_work_items w ON w.work_id = a.work_id
        LEFT JOIN organization_work_resource_permits p ON p.attempt_id = a.attempt_id
        LEFT JOIN organization_work_scopes s ON s.attempt_id = a.attempt_id
        WHERE a.status = 'running' AND w.status = 'running'
          AND a.number = w.attempt_count AND s.attempt_id IS NULL
        ORDER BY a.started_at, a.attempt_id LIMIT ${bounded}`,
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          attemptId: row.attempt_id,
          workId: row.work_id,
          leaseUntil: row.lease_until,
          permitState: row.permit_state,
        })),
      ),
      Effect.mapError((error) => (isScopeError(error) ? error : unavailable())),
    );
  return {
    markPreparing,
    markLaunchRequested,
    getPreparation,
    attachPrepared,
    requestStart,
    startWithFence,
    recordStarted,
    requestStop,
    recordStopped,
    get,
    listOpenScopes,
    listUnscopedRunning,
  } satisfies OrganizationWorkScopeStoreShape;
});

export const OrganizationWorkScopeStoreLayer = Layer.effect(OrganizationWorkScopeStore, make);
/** Production remains deny-by-default until an OS verifier and executor are wired. */
export const OrganizationWorkScopeStoreLive = OrganizationWorkScopeStoreLayer.pipe(
  Layer.provideMerge(OrganizationWorkScopeStopVerifierDisabled),
);
