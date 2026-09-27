import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import { OrganizationIntakeSourceId } from "../../../../packages/contracts/src/organizationIntake.ts";
import { OrganizationProposalMutationId } from "../../../../packages/contracts/src/organizationProposals.ts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import { OrganizationIntakeStore, OrganizationIntakeStoreLive } from "./OrganizationIntakeStore.ts";
import {
  OrganizationProposalStore,
  OrganizationProposalStoreLive,
} from "./OrganizationProposalStore.ts";

const principal = { subject: "proposal-user", interactive: true } as const;
const manager = { subject: principal.subject, canManageSources: true } as const;
const authentication = { kind: "interactive-user", subject: principal.subject } as const;
const layer = it.layer(
  Layer.mergeAll(
    OrganizationStoreLive,
    OrganizationIntakeStoreLive,
    OrganizationProposalStoreLive,
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);
const mutation = OrganizationProposalMutationId.make;

const prepare = (name: string, access: "read" | "proposal" = "proposal", publish = true) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const organizationId = OrganizationId.make(`proposal-org-${name}`);
    const projectId = ProjectId.make(`proposal-project-${name}`);
    const bindingId = OrganizationBindingId.make(`proposal-binding-${name}`);
    const sourceId = OrganizationIntakeSourceId.make(`proposal-source-${name}`);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, ${name}, ${`/tmp/${name}`}, '[]', '2026-01-01', '2026-01-01')`;
    const organizations = yield* OrganizationStore;
    const created = yield* organizations.create({
      organizationId,
      mutationId: `create-${name}`,
      title: name,
      mission: "Observe",
      actor: "user",
    });
    const bound = yield* organizations.bindProject({
      organizationId,
      mutationId: `bind-${name}`,
      baseRevision: created.draftRevision,
      actor: "user",
      bindingId,
      projectId,
      access,
      capabilities: access === "proposal" ? ["read-history", "propose-work"] : ["read-history"],
      scope: null,
    });
    if (publish)
      yield* organizations.publish({
        organizationId,
        mutationId: `publish-${name}`,
        baseRevision: bound.draftRevision,
        actor: "user",
      });
    const intake = yield* OrganizationIntakeStore;
    yield* intake.registerSource(
      {
        organizationId,
        sourceId,
        projectId,
        kind: "manual",
        name: `source-${name}`,
        ingestSubject: principal.subject,
      },
      manager,
    );
    return { organizationId, projectId, bindingId, sourceId };
  });
type Fixture = {
  organizationId: OrganizationId;
  projectId: ProjectId;
  bindingId: OrganizationBindingId;
  sourceId: OrganizationIntakeSourceId;
};
const finding = (
  fixture: Fixture,
  key: string,
  title = "Signal",
  summary = "Evidence needs human review",
) =>
  Effect.gen(function* () {
    const intake = yield* OrganizationIntakeStore;
    const observed = yield* intake.ingest(
      {
        organizationId: fixture.organizationId,
        sourceId: fixture.sourceId,
        projectId: fixture.projectId,
        externalEventId: `event-${key}`,
        dedupKey: `key-${key}`,
        occurredAt: "2026-01-01T00:00:00.000Z",
        title,
        body: summary,
        attributes: { correlationKey: key },
      },
      authentication,
    );
    return yield* intake.proposeFinding(
      {
        organizationId: fixture.organizationId,
        sourceId: fixture.sourceId,
        dedupKey: `finding-${key}`,
        title,
        summary,
        observationIds: [observed.observation.id],
      },
      manager,
    );
  });
const enable = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const store = yield* OrganizationProposalStore;
    return yield* store.setObservationMode(
      {
        organizationId,
        mutationId: mutation(`enable-${organizationId}`),
        expectedVersion: 0,
        enabled: true,
      },
      principal,
    );
  });

layer("Organization proposal triage", (it) => {
  it.effect("starts a fresh epoch on re-enable and skips mode-off candidates", () =>
    Effect.gen(function* () {
      const off = yield* prepare("off");
      const store = yield* OrganizationProposalStore;
      yield* enable(off.organizationId);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* finding(off, "before-disable");
      const disabled = yield* store.setObservationMode(
        {
          organizationId: off.organizationId,
          mutationId: mutation("disable-off"),
          expectedVersion: 1,
          enabled: false,
        },
        principal,
      );
      assert.equal(disabled.effective, false);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* finding(off, "while-disabled");
      assert.equal((yield* store.reconcileOnce()).seeded, 0);
      yield* TestClock.adjust(Duration.seconds(1));
      const enabled = yield* store.setObservationMode(
        {
          organizationId: off.organizationId,
          mutationId: mutation("reenable-off"),
          expectedVersion: 2,
          enabled: true,
        },
        principal,
      );
      assert.ok(enabled.enabledAt);
      assert.notEqual(enabled.enabledAt, disabled.enabledAt);
      assert.equal((yield* store.reconcileOnce()).seeded, 0);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* finding(off, "after-reenable");
      assert.equal((yield* store.reconcileOnce()).proposed, 1);
      assert.equal(
        (yield* store.list({
          organizationId: off.organizationId,
          afterProposalId: null,
          limit: 10,
        })).proposals.length,
        1,
      );
    }),
  );

  it.effect("requires explicit opt-in and excludes findings from before the enable epoch", () =>
    Effect.gen(function* () {
      const fixture = yield* prepare("epoch");
      const store = yield* OrganizationProposalStore;
      yield* finding(fixture, "old");
      assert.equal((yield* store.reconcileOnce()).seeded, 0);
      yield* TestClock.adjust(Duration.seconds(1));
      const mode = yield* enable(fixture.organizationId);
      assert.equal(mode.effective, true);
      assert.ok(mode.enabledAt);
      assert.equal((yield* store.reconcileOnce()).seeded, 0);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* finding(fixture, "new");
      assert.equal((yield* store.reconcileOnce()).proposed, 1);
      const page = yield* store.list({
        organizationId: fixture.organizationId,
        afterProposalId: null,
        limit: 10,
      });
      assert.equal(page.proposals.length, 1);
      assert.equal(page.proposals[0]?.evidence.length, 1);
    }),
  );

  it.effect("denies read-only bindings and unpublished Organizations", () =>
    Effect.gen(function* () {
      const read = yield* prepare("read", "read");
      yield* enable(read.organizationId);
      yield* finding(read, "read-only");
      const store = yield* OrganizationProposalStore;
      assert.equal((yield* store.reconcileOnce()).proposed, 0);
      const page = yield* store.list({
        organizationId: read.organizationId,
        afterProposalId: null,
        limit: 10,
      });
      assert.equal(page.proposals.length, 0);
      const unpublished = yield* prepare("unpublished", "proposal", false);
      const mode = yield* enable(unpublished.organizationId);
      assert.equal(mode.effective, false);
      yield* finding(unpublished, "unpublished");
      assert.equal((yield* store.reconcileOnce()).proposed, 0);
    }),
  );

  it.effect("does not spend a pass on disabled candidates before an enabled Organization", () =>
    Effect.gen(function* () {
      const disabledFixture = yield* prepare("fair-off", "read");
      const store = yield* OrganizationProposalStore;
      yield* enable(disabledFixture.organizationId);
      yield* TestClock.adjust(Duration.seconds(1));
      for (let index = 0; index < 10; index++) yield* finding(disabledFixture, `off-${index}`);
      assert.equal((yield* store.reconcileOnce()).deferred, 8);
      yield* store.setObservationMode(
        {
          organizationId: disabledFixture.organizationId,
          mutationId: mutation("fair-disable"),
          expectedVersion: 1,
          enabled: false,
        },
        principal,
      );
      const active = yield* prepare("fair-on");
      yield* enable(active.organizationId);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* finding(active, "visible");
      const pass = yield* store.reconcileOnce();
      assert.equal(pass.examined, 1);
      assert.equal(pass.proposed, 1);
    }),
  );

  it.effect("bounds per-Organization batches and keeps proposals stable over 13 clock hours", () =>
    Effect.gen(function* () {
      const fixture = yield* prepare("bounded");
      yield* enable(fixture.organizationId);
      yield* TestClock.adjust(Duration.seconds(1));
      const sql = yield* SqlClient.SqlClient;
      for (let index = 0; index < 10; index++) {
        const found = yield* finding(
          fixture,
          `batch-${index}`,
          `Incident token=secret-${index}`,
          "authorization: Bearer private-secret",
        );
        if (index === 0)
          yield* sql`UPDATE organization_intake_findings
          SET title = 'Incident token=raw-secret',
            summary = 'authorization: Bearer raw-bearer'
          WHERE finding_id = ${found.id}`;
      }
      const store = yield* OrganizationProposalStore;
      assert.equal((yield* store.reconcileOnce()).proposed, 8);
      assert.equal((yield* store.reconcileOnce()).proposed, 2);
      const first = yield* store.list({
        organizationId: fixture.organizationId,
        afterProposalId: null,
        limit: 3,
      });
      assert.equal(first.proposals.length, 3);
      assert.ok(first.nextCursor);
      const second = yield* store.list({
        organizationId: fixture.organizationId,
        afterProposalId: first.nextCursor,
        limit: 10,
      });
      assert.equal(second.proposals.length, 7);
      assert.equal(second.nextCursor, null);
      assert.equal(first.proposals[0]?.title.includes("secret-"), false);
      assert.equal(first.proposals[0]?.summary.includes("private-secret"), false);
      const all = [...first.proposals, ...second.proposals];
      assert.equal(
        all.some(
          (proposal) =>
            proposal.title.includes("raw-secret") || proposal.summary.includes("raw-bearer"),
        ),
        false,
      );
      yield* TestClock.adjust(Duration.hours(13));
      for (let index = 0; index < 24; index++) {
        const result = yield* store.reconcileOnce();
        assert.equal(result.proposed, 0);
      }
      const counts = yield* sql<{ proposals: number; attempts: number; work: number }>`
        SELECT (SELECT count(*) FROM organization_work_proposals
          WHERE organization_id = ${fixture.organizationId}) AS proposals,
          (SELECT sum(attempts) FROM organization_proposal_candidates c
            JOIN organization_intake_findings f ON f.finding_id = c.finding_id
            WHERE f.organization_id = ${fixture.organizationId}) AS attempts,
          (SELECT count(*) FROM organization_work_items
            WHERE organization_id = ${fixture.organizationId}) AS work`;
      assert.deepStrictEqual(counts, [{ proposals: 10, attempts: 0, work: 0 }]);
    }),
  );

  it.effect("records human decisions and reconsiders only at the chosen time", () =>
    Effect.gen(function* () {
      const fixture = yield* prepare("decision");
      yield* enable(fixture.organizationId);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* finding(fixture, "decision");
      const store = yield* OrganizationProposalStore;
      yield* store.reconcileOnce();
      const page = yield* store.list({
        organizationId: fixture.organizationId,
        afterProposalId: null,
        limit: 10,
      });
      const proposal = page.proposals[0]!;
      const reconsiderAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 2 }));
      const malformed = yield* Effect.flip(
        store.decide(
          {
            organizationId: fixture.organizationId,
            proposalId: proposal.id,
            mutationId: mutation("malformed-decision"),
            expectedVersion: proposal.version,
            decision: "defer",
            reason: null,
            reconsiderAt: "not-a-date",
          },
          principal,
        ),
      );
      assert.equal(malformed.code, "invalid");
      const offsetTime = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { hours: 4 }),
      ).replace("Z", "+02:00");
      const input = {
        organizationId: fixture.organizationId,
        proposalId: proposal.id,
        mutationId: mutation("defer-decision"),
        expectedVersion: proposal.version,
        decision: "defer" as const,
        reason: "Wait for more evidence. Bearer human-secret token=other-secret",
        reconsiderAt: offsetTime,
      };
      const deferred = yield* store.decide(input, principal);
      assert.equal(deferred.state, "deferred");
      assert.equal(deferred.reconsiderAfter, reconsiderAt);
      assert.equal(deferred.decisionReason?.includes("human-secret"), false);
      assert.equal(deferred.decisionReason?.includes("other-secret"), false);
      const sql = yield* SqlClient.SqlClient;
      const audit = yield* sql<{ snapshot_json: string }>`SELECT snapshot_json
        FROM organization_proposal_mutations WHERE mutation_id = ${input.mutationId}`;
      assert.equal(audit[0]?.snapshot_json.includes("human-secret"), false);
      assert.equal(audit[0]?.snapshot_json.includes("other-secret"), false);
      assert.equal((yield* store.decide(input, principal)).version, deferred.version);
      assert.equal((yield* store.reconcileOnce()).reconsidered, 0);
      yield* TestClock.adjust(Duration.hours(3));
      assert.equal((yield* store.reconcileOnce()).reconsidered, 1);
      assert.equal(
        (yield* store.list({
          organizationId: fixture.organizationId,
          afterProposalId: null,
          limit: 10,
        })).proposals[0]?.state,
        "proposed",
      );
    }),
  );

  it.effect("labels revoked evidence stale and blocks acknowledgement", () =>
    Effect.gen(function* () {
      const fixture = yield* prepare("revoked");
      yield* enable(fixture.organizationId);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* finding(fixture, "revoked");
      const store = yield* OrganizationProposalStore;
      yield* store.reconcileOnce();
      const intake = yield* OrganizationIntakeStore;
      yield* intake.setSourceEnabled(fixture.organizationId, fixture.sourceId, false, manager);
      const page = yield* store.list({
        organizationId: fixture.organizationId,
        afterProposalId: null,
        limit: 10,
      });
      const proposal = page.proposals[0]!;
      assert.equal(proposal.currentlyEligible, false);
      assert.equal(proposal.staleReason, "source-or-evidence-revoked");
      const denied = yield* Effect.flip(
        store.decide(
          {
            organizationId: fixture.organizationId,
            proposalId: proposal.id,
            mutationId: mutation("ack-revoked"),
            expectedVersion: proposal.version,
            decision: "acknowledge",
            reason: null,
            reconsiderAt: null,
          },
          principal,
        ),
      );
      assert.equal(denied.code, "forbidden");
      const rejected = yield* store.decide(
        {
          organizationId: fixture.organizationId,
          proposalId: proposal.id,
          mutationId: mutation("reject-revoked"),
          expectedVersion: proposal.version,
          decision: "reject",
          reason: "Source disabled",
          reconsiderAt: null,
        },
        principal,
      );
      assert.equal(rejected.state, "rejected");
    }),
  );
});
