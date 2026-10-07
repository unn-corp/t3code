import {
  OrganizationIntakeError,
  type OrganizationObservation,
  type OrganizationTentativeFinding,
} from "../../../../packages/contracts/src/organizationIntake.ts";
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  OrganizationFindingCorrelationAuthority,
  OrganizationFindingCorrelator,
  OrganizationFindingCorrelatorLayer,
  OrganizationFindingCorrelatorLive,
  type OrganizationCorrelationPrincipal,
} from "./OrganizationFindingCorrelator.ts";

export type OrganizationCorrelationCoordinatorResult = {
  readonly outcome: "created" | "duplicate" | "insufficient" | "ambiguous" | "skipped";
  readonly finding: OrganizationTentativeFinding | null;
  readonly evidenceCount: number;
  readonly reason: null | "missing-project" | "missing-correlation-key" | "invalid-correlation-key";
};
export interface OrganizationCorrelationCoordinatorShape {
  /** Call only after authenticated intake has persisted the normalized observation. */
  readonly onObservation: (
    observation: OrganizationObservation,
    principal: OrganizationCorrelationPrincipal,
  ) => Effect.Effect<OrganizationCorrelationCoordinatorResult, OrganizationIntakeError>;
}
export class OrganizationCorrelationCoordinator extends Context.Service<
  OrganizationCorrelationCoordinator,
  OrganizationCorrelationCoordinatorShape
>()("t3/organizations/OrganizationCorrelationCoordinator") {}

type PersistedObservation = {
  organization_id: string;
  source_id: string;
  project_id: string | null;
  attributes_json: string;
};
const AttributesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const intakeError = (code: OrganizationIntakeError["code"], message: string) =>
  new OrganizationIntakeError({ code, message });
const skipped = (reason: Exclude<OrganizationCorrelationCoordinatorResult["reason"], null>) => ({
  outcome: "skipped" as const,
  finding: null,
  evidenceCount: 0,
  reason,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const correlator = yield* OrganizationFindingCorrelator;
  const onObservation: OrganizationCorrelationCoordinatorShape["onObservation"] = (
    observation,
    principal,
  ) =>
    Effect.gen(function* () {
      if (!principal.subject.trim())
        return yield* intakeError("forbidden", "Authenticated intake principal is required.");
      const row = (yield* sql<PersistedObservation>`SELECT organization_id, source_id,
        project_id, attributes_json FROM organization_intake_observations
        WHERE observation_id = ${observation.id}`)[0];
      if (!row) return yield* intakeError("not_found", "Persisted observation was not found.");
      if (
        row.organization_id !== observation.organizationId ||
        row.source_id !== observation.sourceId ||
        row.project_id !== observation.projectId
      )
        return yield* intakeError(
          "conflict",
          "Observation identity does not match persisted intake.",
        );
      if (row.project_id === null) return skipped("missing-project");
      const attributes = yield* Schema.decodeUnknownEffect(AttributesJson)(
        row.attributes_json,
      ).pipe(
        Effect.mapError(() => intakeError("invalid", "Stored observation attributes are invalid.")),
      );
      const correlationKey = attributes.correlationKey;
      if (correlationKey === undefined || correlationKey.trim().length === 0)
        return skipped("missing-correlation-key");
      if (correlationKey.length > 160 || correlationKey !== correlationKey.trim())
        return skipped("invalid-correlation-key");
      const result = yield* correlator.correlate(
        {
          organizationId: observation.organizationId,
          projectId: ProjectId.make(row.project_id),
          correlationKey,
        },
        principal,
      );
      return { ...result, reason: null };
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(OrganizationIntakeError)(cause)
          ? cause
          : intakeError("unavailable", "Organization correlation coordination is unavailable."),
      ),
    );
  return { onObservation } satisfies OrganizationCorrelationCoordinatorShape;
});

export const OrganizationCorrelationCoordinatorLayer = Layer.effect(
  OrganizationCorrelationCoordinator,
  make,
);
/** No finding creation occurs until a reviewed correlation policy is provided. */
export const OrganizationCorrelationCoordinatorLive = OrganizationCorrelationCoordinatorLayer.pipe(
  Layer.provide(OrganizationFindingCorrelatorLive),
);

/** Server-owned intake may form tentative findings after authenticated persistence. */
export const ORGANIZATION_INTAKE_CORRELATION_SUBJECT = "organization-intake-service";
export const OrganizationCorrelationCoordinatorIntakeLive =
  OrganizationCorrelationCoordinatorLayer.pipe(
    Layer.provide(
      OrganizationFindingCorrelatorLayer.pipe(
        Layer.provide(
          Layer.succeed(OrganizationFindingCorrelationAuthority, {
            permits: (principal) => principal.subject === ORGANIZATION_INTAKE_CORRELATION_SUBJECT,
          }),
        ),
      ),
    ),
  );
