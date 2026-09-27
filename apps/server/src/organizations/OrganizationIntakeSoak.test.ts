import * as NodePerfHooks from "node:perf_hooks";
import * as NodeTimersPromises from "node:timers/promises";
import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import { OrganizationIntakeSourceId } from "../../../../packages/contracts/src/organizationIntake.ts";
import { OrganizationProposalMutationId } from "../../../../packages/contracts/src/organizationProposals.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import { OrganizationIntakeStore, OrganizationIntakeStoreLive } from "./OrganizationIntakeStore.ts";
import {
  OrganizationCorrelationRecovery,
  OrganizationCorrelationRecoveryLive,
} from "./OrganizationCorrelationRecovery.ts";
import {
  OrganizationProposalStore,
  OrganizationProposalStoreLive,
} from "./OrganizationProposalStore.ts";

// Opt in because this measures real elapsed time. No server, provider, worker, or
// host process is started; the SQLite client is fresh and in memory.
const enabled = process.env.T3_ORGANIZATION_INTAKE_SOAK === "1";
const durationSeconds = 70;
const organizationId = OrganizationId.make("intake-soak-organization");
const projectId = ProjectId.make("intake-soak-project");
const sourceA = OrganizationIntakeSourceId.make("intake-soak-a");
const sourceB = OrganizationIntakeSourceId.make("intake-soak-b");
const subject = "intake-soak-fixture";
const manager = { subject, canManageSources: true } as const;
const authentication = { kind: "interactive-user", subject } as const;
const encodeAggregate = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const layer = it.layer(
  Layer.mergeAll(
    OrganizationStoreLive,
    OrganizationIntakeStoreLive,
    OrganizationCorrelationRecoveryLive,
    OrganizationProposalStoreLive,
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

layer("Organization intake queue soak", (it) => {
  it.effect.skipIf(!enabled)(
    "sustains bounded real-time fixture intake, correlation recovery, and proposal reconciliation",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const organizations = yield* OrganizationStore;
        const intake = yield* OrganizationIntakeStore;
        const recovery = yield* OrganizationCorrelationRecovery;
        const proposals = yield* OrganizationProposalStore;
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${projectId}, 'Soak fixture', '/tmp/t3-intake-soak-unused', '[]',
            '2026-01-01', '2026-01-01')`;
        const created = yield* organizations.create({
          organizationId,
          mutationId: "intake-soak-create",
          title: "Soak fixture",
          mission: "Observe fixture events",
          actor: "user",
        });
        const bound = yield* organizations.bindProject({
          organizationId,
          mutationId: "intake-soak-bind",
          baseRevision: created.draftRevision,
          actor: "user",
          bindingId: OrganizationBindingId.make("intake-soak-binding"),
          projectId,
          access: "proposal",
          capabilities: ["read-history", "propose-work"],
          scope: null,
        });
        yield* organizations.publish({
          organizationId,
          mutationId: "intake-soak-publish",
          baseRevision: bound.draftRevision,
          actor: "user",
        });
        for (const sourceId of [sourceA, sourceB]) {
          yield* intake.registerSource(
            {
              organizationId,
              sourceId,
              projectId,
              kind: "manual",
              name: sourceId,
              ingestSubject: subject,
            },
            manager,
          );
        }
        const mode = yield* proposals.setObservationMode(
          {
            organizationId,
            mutationId: OrganizationProposalMutationId.make("intake-soak-enable"),
            expectedVersion: 0,
            enabled: true,
          },
          { subject, interactive: true },
        );
        assert.equal(mode.effective, true);

        const correlationBacklog = sql<{ total: number }>`SELECT COUNT(*) AS total
          FROM organization_intake_correlation_jobs WHERE state IN ('pending', 'leased')`.pipe(
          Effect.map((rows) => rows[0]?.total ?? 0),
        );
        const proposalBacklog = sql<{ total: number }>`SELECT COUNT(*) AS total
          FROM organization_proposal_candidates WHERE state = 'pending'`.pipe(
          Effect.map((rows) => rows[0]?.total ?? 0),
        );
        const initialCorrelationBacklog = yield* correlationBacklog;
        const initialProposalBacklog = yield* proposalBacklog;
        const started = NodePerfHooks.performance.now();
        let peakRssBytes = process.memoryUsage().rss;
        let peakCorrelationBacklog = 0;
        let peakProposalBacklog = 0;
        let recorded = 0;
        let duplicate = 0;
        let recoveredLease = 0;
        let correlationRetries = 0;
        let correlationTerminal = 0;
        let proposalPasses = 0;
        let failures = 0;
        for (let second = 0; second < durationSeconds; second++) {
          for (const sourceId of [sourceA, sourceB]) {
            const eventId = `soak-${second}-${sourceId}`;
            const result = yield* intake.ingest(
              {
                organizationId,
                sourceId,
                projectId,
                externalEventId: eventId,
                dedupKey: eventId,
                occurredAt: "2026-01-01T00:00:00.000Z",
                title: `Fixture signal ${second}`,
                body: "Synthetic observation for isolated queue soak",
                attributes: { correlationKey: `fixture-correlation-${second}` },
              },
              authentication,
            );
            if (result.outcome === "recorded") recorded++;
            else duplicate++;
            if (second === 35 && sourceId === sourceA) {
              const expiredAt = DateTime.formatIso(
                DateTime.add(yield* DateTime.now, { hours: -1 }),
              );
              yield* sql`UPDATE organization_intake_correlation_jobs
                SET state = 'leased', attempts = 1, lease_token = 'crashed-fixture',
                  lease_expires_at = ${expiredAt}
                WHERE observation_id = ${result.observation.id}`;
            }
          }
          peakCorrelationBacklog = Math.max(peakCorrelationBacklog, yield* correlationBacklog);
          if (second % 5 === 4) {
            const cycle = yield* recovery.runOnce();
            correlationRetries += cycle.retried;
            correlationTerminal += cycle.terminal;
            peakProposalBacklog = Math.max(peakProposalBacklog, yield* proposalBacklog);
            const proposal = yield* proposals.reconcileOnce();
            proposalPasses++;
            peakProposalBacklog = Math.max(peakProposalBacklog, yield* proposalBacklog);
            failures += cycle.terminal + proposal.terminal;
          }
          peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
          yield* Effect.promise(() => NodeTimersPromises.setTimeout(1_000));
        }
        for (let drain = 0; drain < 10; drain++) {
          const cycle = yield* recovery.runOnce();
          correlationRetries += cycle.retried;
          correlationTerminal += cycle.terminal;
          yield* proposals.reconcileOnce();
          proposalPasses++;
          if (
            cycle.claimed === 0 &&
            (yield* correlationBacklog) === 0 &&
            (yield* proposalBacklog) === 0
          )
            break;
        }
        const elapsedSeconds = (NodePerfHooks.performance.now() - started) / 1_000;
        const observations =
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total
          FROM organization_intake_observations`)[0]?.total ?? 0;
        const completeJobs =
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total
          FROM organization_intake_correlation_jobs WHERE state = 'complete'`)[0]?.total ?? 0;
        const findings =
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total
          FROM organization_intake_findings`)[0]?.total ?? 0;
        const proposalCount =
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total
          FROM organization_work_proposals`)[0]?.total ?? 0;
        const attempts =
          (yield* sql<{ total: number }>`SELECT COUNT(*) AS total
          FROM organization_work_attempts`)[0]?.total ?? 0;
        const recovered = (yield* sql<{ attempts: number }>`SELECT attempts
          FROM organization_intake_correlation_jobs j
          JOIN organization_intake_observations o ON o.observation_id = j.observation_id
          WHERE o.external_event_id = ${`soak-35-${sourceA}`}`)[0];
        if (recovered?.attempts === 2) recoveredLease++;
        const finalCorrelationBacklog = yield* correlationBacklog;
        const finalProposalBacklog = yield* proposalBacklog;
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
        const aggregate = yield* encodeAggregate({
          elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
          observations,
          recorded,
          duplicate,
          completeJobs,
          findings,
          proposals: proposalCount,
          attempts,
          recoveredLease,
          correlationRetries,
          correlationTerminal,
          proposalPasses,
          failures,
          initialCorrelationBacklog,
          peakCorrelationBacklog,
          finalCorrelationBacklog,
          initialProposalBacklog,
          peakProposalBacklog,
          finalProposalBacklog,
          peakRssBytes,
        });
        process.stdout.write(`ORGANIZATION_INTAKE_SOAK ${aggregate}\n`);
        assert.ok(elapsedSeconds >= 65 && elapsedSeconds <= 100);
        assert.equal(observations, durationSeconds * 2);
        assert.equal(recorded, observations);
        assert.equal(duplicate, 0);
        assert.equal(completeJobs, observations);
        assert.equal(findings, durationSeconds);
        assert.equal(proposalCount, findings);
        assert.equal(recoveredLease, 1);
        assert.equal(finalCorrelationBacklog, 0);
        assert.equal(finalProposalBacklog, 0);
        assert.equal(failures, 0);
        assert.equal(attempts, 0);
      }),
    120_000,
  );
});
