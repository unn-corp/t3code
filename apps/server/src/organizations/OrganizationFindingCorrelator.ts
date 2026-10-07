// @effect-diagnostics nodeBuiltinImport:off - This Node-only server module uses synchronous host crypto for persistent IDs or hashes; replacing it would add Crypto service requirements through the persistence API.
import * as NodeCrypto from "node:crypto";
import {
  OrganizationCorrelationInput,
  OrganizationCorrelationResult,
  type OrganizationCorrelationResult as CorrelationResult,
  type OrganizationCorrelationInput as CorrelationInput,
} from "../../../../packages/contracts/src/organizationCorrelation.ts";
import {
  OrganizationIntakeError,
  OrganizationIntakeSourceId,
  OrganizationObservationId,
  OrganizationTentativeFinding,
  OrganizationTentativeFindingId,
} from "../../../../packages/contracts/src/organizationIntake.ts";
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Created from a server-owned correlation policy, never from event attributes. */
export interface OrganizationCorrelationPrincipal {
  readonly subject: string;
}
export interface OrganizationFindingCorrelationAuthorityShape {
  readonly permits: (
    principal: OrganizationCorrelationPrincipal,
    target: CorrelationInput,
  ) => boolean;
}
export class OrganizationFindingCorrelationAuthority extends Context.Service<
  OrganizationFindingCorrelationAuthority,
  OrganizationFindingCorrelationAuthorityShape
>()("t3/organizations/OrganizationFindingCorrelator/OrganizationFindingCorrelationAuthority") {}
export const OrganizationFindingCorrelationDisabled = Layer.succeed(
  OrganizationFindingCorrelationAuthority,
  { permits: () => false },
);

type ObservationRow = {
  observation_id: string;
  source_id: string;
  project_id: string | null;
  source_project_id: string | null;
  source_enabled: number | null;
  adapter: string | null;
  dedup_key: string;
};
type FindingRow = {
  finding_id: string;
  organization_id: string;
  source_id: string;
  project_id: string | null;
  dedup_key: string;
  title: string;
  summary: string;
  observation_ids_json: string;
  evidence_json: string | null;
  created_at: string;
};
const invalid = (message: string) => new OrganizationIntakeError({ code: "invalid", message });
const forbidden = (message: string) => new OrganizationIntakeError({ code: "forbidden", message });
const unavailable = () =>
  new OrganizationIntakeError({
    code: "unavailable",
    message: "Organization finding correlation is unavailable.",
  });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const PartsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const EvidenceIdsJson = Schema.fromJsonString(Schema.Array(OrganizationObservationId));
const EvidenceRefsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      observationId: OrganizationObservationId,
      sourceId: OrganizationIntakeSourceId,
      projectId: Schema.NullOr(ProjectId),
    }),
  ),
);
const hash = (parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256")
    .update(Schema.encodeSync(PartsJson)([...parts]))
    .digest("hex");
const decodeFinding = (row: FindingRow) =>
  Effect.gen(function* () {
    const observationIds = yield* Schema.decodeUnknownEffect(EvidenceIdsJson)(
      row.observation_ids_json,
    );
    const evidence =
      row.evidence_json === null
        ? observationIds.map((observationId) => ({
            observationId,
            sourceId: OrganizationIntakeSourceId.make(row.source_id),
            projectId: null,
          }))
        : yield* Schema.decodeUnknownEffect(EvidenceRefsJson)(row.evidence_json);
    return yield* Schema.decodeUnknownEffect(OrganizationTentativeFinding)({
      id: row.finding_id,
      organizationId: row.organization_id,
      sourceId: row.source_id,
      projectId: row.project_id,
      dedupKey: row.dedup_key,
      title: row.title,
      summary: row.summary,
      observationIds,
      evidence,
      state: "tentative",
      createdAt: row.created_at,
    });
  });

export interface OrganizationFindingCorrelatorShape {
  readonly correlate: (
    input: CorrelationInput,
    principal: OrganizationCorrelationPrincipal,
  ) => Effect.Effect<CorrelationResult, OrganizationIntakeError>;
}
export class OrganizationFindingCorrelator extends Context.Service<
  OrganizationFindingCorrelator,
  OrganizationFindingCorrelatorShape
>()("t3/organizations/OrganizationFindingCorrelator") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* OrganizationFindingCorrelationAuthority;
  const correlate: OrganizationFindingCorrelatorShape["correlate"] = (rawInput, principal) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(OrganizationCorrelationInput)(
            rawInput,
          ).pipe(Effect.mapError(() => invalid("Correlation target is invalid.")));
          if (!principal.subject.trim() || !authority.permits(principal, input))
            return yield* forbidden("Finding correlation requires server policy authority.");
          const organization = (yield* sql<{
            lifecycle: string;
          }>`SELECT lifecycle FROM organizations
        WHERE organization_id = ${input.organizationId}`)[0];
          if (!organization || organization.lifecycle === "archived")
            return yield* forbidden("Archived or missing Organization cannot correlate findings.");
          const binding = (yield* sql<{ binding_id: string }>`SELECT b.binding_id
        FROM organization_project_bindings b
        JOIN projection_projects p ON p.project_id = b.project_id
        WHERE b.organization_id = ${input.organizationId} AND b.project_id = ${input.projectId}
          AND b.detached_at IS NULL AND p.deleted_at IS NULL`)[0];
          if (!binding)
            return yield* forbidden("Project is not currently bound to this Organization.");
          // Only explicit structured keys count. Projectless observations make the
          // routing ambiguous and never inherit the requested Project from the call.
          const rows = yield* sql<ObservationRow>`SELECT o.observation_id, o.source_id,
        o.project_id, o.dedup_key, json_extract(o.attributes_json, '$.adapter') AS adapter,
        s.project_id AS source_project_id, s.enabled AS source_enabled
        FROM organization_intake_observations o
        LEFT JOIN organization_intake_sources s ON s.source_id = o.source_id
        WHERE o.organization_id = ${input.organizationId}
          AND (o.project_id = ${input.projectId} OR o.project_id IS NULL)
          AND json_extract(o.attributes_json, '$.correlationKey') = ${input.correlationKey}
        ORDER BY o.observation_id LIMIT 33`;
          const evidenceCount = rows.length;
          const outcome = (kind: CorrelationResult["outcome"]): CorrelationResult => ({
            outcome: kind,
            finding: null,
            evidenceCount,
          });
          if (
            rows.length > 32 ||
            rows.some(
              (row) =>
                row.project_id === null ||
                row.source_enabled !== 1 ||
                (row.source_project_id !== null && row.source_project_id !== input.projectId),
            )
          )
            return yield* Schema.decodeUnknownEffect(OrganizationCorrelationResult)(
              outcome("ambiguous"),
            );
          // Multiple source credentials may relay the same upstream issue or email.
          // They are distinct registry sources, but not independent evidence.
          const upstreamIdentities = new Set(
            rows.map((row) =>
              row.adapter === "github-issue-relay"
                ? `github-issue:${input.correlationKey}`
                : row.adapter === "plain-text-email-relay"
                  ? `email-message:${row.dedup_key}`
                  : `source:${row.source_id}`,
            ),
          );
          if (
            rows.length < 2 ||
            new Set(rows.map((row) => row.source_id)).size < 2 ||
            upstreamIdentities.size < 2
          )
            return yield* Schema.decodeUnknownEffect(OrganizationCorrelationResult)(
              outcome("insufficient"),
            );
          const dedupKey = `correlation-v1:${hash([
            input.organizationId,
            input.projectId,
            input.correlationKey,
          ])}`;
          const existing = (yield* sql<FindingRow>`SELECT * FROM organization_intake_findings
        WHERE organization_id = ${input.organizationId} AND dedup_key = ${dedupKey}`)[0];
          const evidence = rows.map((row) => ({
            observationId: OrganizationObservationId.make(row.observation_id),
            sourceId: OrganizationIntakeSourceId.make(row.source_id),
            projectId: ProjectId.make(input.projectId),
          }));
          const observationIds = evidence.map((ref) => ref.observationId);
          if (existing) {
            if (existing.project_id !== input.projectId || existing.evidence_json === null)
              return yield* Schema.decodeUnknownEffect(OrganizationCorrelationResult)(
                outcome("ambiguous"),
              );
            const prior = yield* Schema.decodeUnknownEffect(EvidenceRefsJson)(
              existing.evidence_json,
            );
            if (
              prior.length !== evidence.length ||
              prior.some(
                (ref, index) =>
                  ref.observationId !== evidence[index]?.observationId ||
                  ref.sourceId !== evidence[index]?.sourceId ||
                  ref.projectId !== input.projectId,
              )
            )
              return yield* Schema.decodeUnknownEffect(OrganizationCorrelationResult)(
                outcome("ambiguous"),
              );
            return yield* Schema.decodeUnknownEffect(OrganizationCorrelationResult)({
              outcome: "duplicate",
              finding: yield* decodeFinding(existing),
              evidenceCount,
            });
          }
          const anchorSourceId = evidence[0]!.sourceId;
          const findingId = OrganizationTentativeFindingId.make(
            `tentative-finding:${hash([input.organizationId, anchorSourceId, dedupKey])}`,
          );
          const observationIdsJson = yield* Schema.encodeEffect(EvidenceIdsJson)(observationIds);
          const evidenceJson = yield* Schema.encodeEffect(EvidenceRefsJson)(evidence);
          const createdAt = yield* now;
          yield* sql`INSERT INTO organization_intake_findings
        (finding_id, organization_id, source_id, project_id, dedup_key, title, summary,
          observation_ids_json, evidence_json, state, created_at)
        VALUES (${findingId}, ${input.organizationId}, ${anchorSourceId}, ${input.projectId},
          ${dedupKey}, 'Related observations',
          'Observations from distinct registered sources share an explicit correlation key. Review provenance before action.',
          ${observationIdsJson}, ${evidenceJson}, 'tentative', ${createdAt})`;
          const inserted = (yield* sql<FindingRow>`SELECT * FROM organization_intake_findings
        WHERE finding_id = ${findingId}`)[0]!;
          return yield* Schema.decodeUnknownEffect(OrganizationCorrelationResult)({
            outcome: "created",
            finding: yield* decodeFinding(inserted),
            evidenceCount,
          });
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(OrganizationIntakeError)(cause) ? cause : unavailable(),
        ),
      );
  return { correlate } satisfies OrganizationFindingCorrelatorShape;
});

export const OrganizationFindingCorrelatorLayer = Layer.effect(OrganizationFindingCorrelator, make);
/** No automatic correlation runs until a server policy is explicitly provided. */
export const OrganizationFindingCorrelatorLive = OrganizationFindingCorrelatorLayer.pipe(
  Layer.provide(OrganizationFindingCorrelationDisabled),
);
