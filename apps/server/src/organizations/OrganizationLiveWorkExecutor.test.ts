// @effect-diagnostics preferSchemaOverJson:off - Fixture writes the versioned persisted selection JSON.
import { assert, it } from "@effect/vitest";
import {
  OrganizationWorkError,
  OrganizationWorkId,
  TextGenerationError,
  type OrganizationWorkDetail,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { MaintenanceWorkHeld, WorkAdmission } from "../maintenance/WorkAdmission.ts";
import { OrganizationProviderBudgetError } from "./OrganizationProviderBudget.ts";
import {
  clearRecoverableOrganizationLiveWorkFailure,
  listActivatedOrganizationWorkAfter,
  listOrganizationLiveWorkFailures,
  makeOrganizationLiveWorkExecutor,
  makeOrganizationLiveWorkSource,
  OrganizationLiveWorkRuntimeReadiness,
  OrganizationLiveWorkRuntimeReadinessDisabled,
  readOrganizationLiveWorkRuntimeStatus,
  readOrganizationLiveWorkFailure,
  recordOrganizationLiveWorkFailure,
  type OrganizationLiveWorkSnapshot,
} from "./OrganizationLiveWorkExecutor.ts";
import { OrganizationWorkIntentActivationReadiness } from "./OrganizationWorkIntentActivation.ts";
import { OrganizationWorkStore } from "./OrganizationWorkStore.ts";

const id = OrganizationWorkId.make;
const snapshot = (
  workId: string,
  status: OrganizationLiveWorkSnapshot["status"],
  attemptStatus: OrganizationLiveWorkSnapshot["attemptStatus"] = null,
  approvalSubject: string | null = null,
): OrganizationLiveWorkSnapshot => ({
  workId: id(workId),
  status,
  attemptId: attemptStatus ? `attempt:${workId}` : null,
  attemptStatus,
  approvalSubject,
});

it.effect("reports runtime unavailable until a reviewed startup grants readiness", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* readOrganizationLiveWorkRuntimeStatus, {
      ready: false,
      reason: "scoped_broker_and_recovery_not_verified",
    });
  }).pipe(Effect.provide(OrganizationLiveWorkRuntimeReadinessDisabled)),
);

it.effect("defers paused Organization work and resumes its pending phase when active", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE organization_work_intent_activations
      (intent_id TEXT, organization_id TEXT, work_id TEXT, selection_json TEXT,
       activated_by TEXT, activated_at TEXT)`;
    yield* sql`CREATE TABLE organization_work_items
      (work_id TEXT, organization_id TEXT, finding_id TEXT, project_id TEXT,
       binding_id TEXT, binding_version TEXT, published_revision INTEGER,
       creator_subject TEXT, workflow_id TEXT)`;
    yield* sql`CREATE TABLE organization_work_intents
      (intent_id TEXT, organization_id TEXT, finding_id TEXT, project_id TEXT,
       binding_id TEXT, binding_version TEXT, published_revision INTEGER)`;
    yield* sql`CREATE TABLE organizations (organization_id TEXT, lifecycle TEXT)`;
    const selection = JSON.stringify({
      workflowId: "workflow",
      targetRef: "refs/heads/main",
      fileName: "answer.mjs",
      taskText: "Fix selected file",
      modelSelection: { instanceId: "codex", model: "gpt-5.1-codex" },
      qaPlan: { version: 1, exportName: "solve", cases: [{ input: 2, expected: 4 }] },
    });
    yield* sql`INSERT INTO organization_work_items VALUES
      ('paused-work', 'org', 'finding', 'project', 'binding', '2026-01-01T00:00:00.000Z',
       1, 'human', 'workflow')`;
    yield* sql`INSERT INTO organization_work_intents VALUES
      ('intent', 'org', 'finding', 'project', 'binding', '2026-01-01T00:00:00.000Z', 1)`;
    yield* sql`INSERT INTO organization_work_intent_activations VALUES
      ('intent', 'org', 'paused-work', ${selection}, 'human', '2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO organizations VALUES ('org', 'paused')`;
    const detail = {
      work: { id: id("paused-work"), organizationId: "org", status: "pending" },
      attempts: [],
    } as unknown as OrganizationWorkDetail;
    const source = yield* makeOrganizationLiveWorkSource.pipe(
      Effect.provideService(OrganizationLiveWorkRuntimeReadiness, {
        status: () => ({ ready: true, reason: "fixture" }),
      }),
      Effect.provideService(OrganizationWorkStore, {
        getWork: () => Effect.succeed(detail),
      } as unknown as OrganizationWorkStore["Service"]),
      Effect.provideService(OrganizationWorkIntentActivationReadiness, { permits: () => true }),
    );
    assert.equal(yield* source.read(id("paused-work")), null);
    yield* sql`UPDATE organizations SET lifecycle = 'active' WHERE organization_id = 'org'`;
    assert.equal((yield* source.read(id("paused-work")))?.status, "pending");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("scans only immutable activated work at resumable phases", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE organization_work_intent_activations
      (work_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL)`;
    yield* sql`CREATE TABLE organization_work_items (
      work_id TEXT PRIMARY KEY, status TEXT NOT NULL, attempt_count INTEGER NOT NULL,
      approval_subject TEXT, organization_id TEXT NOT NULL)`;
    yield* sql`CREATE TABLE organization_work_attempts (
      work_id TEXT NOT NULL, number INTEGER NOT NULL, status TEXT NOT NULL)`;
    yield* sql`CREATE TABLE organization_live_work_failures (
      work_id TEXT PRIMARY KEY, phase TEXT NOT NULL, error_code TEXT NOT NULL,
      terminal INTEGER NOT NULL, recorded_at TEXT NOT NULL)`;
    for (const [workId, status, attemptStatus, approvalSubject, activated] of [
      ["a", "pending", null, null, true],
      ["b", "pending", null, null, false],
      ["c", "blocked", "submitted", null, true],
      ["d", "blocked", "qa-accepted", null, true],
      ["e", "blocked", "qa-accepted", "human-reviewer", true],
      ["f", "running", "running", null, true],
      ["g", "waiting-approval", "qa-accepted", null, true],
    ] as const) {
      yield* sql`INSERT INTO organization_work_items VALUES
        (${workId}, ${status}, ${attemptStatus ? 1 : 0}, ${approvalSubject}, ${"org-one"})`;
      if (attemptStatus)
        yield* sql`INSERT INTO organization_work_attempts VALUES
          (${workId}, ${1}, ${attemptStatus})`;
      if (activated)
        yield* sql`INSERT INTO organization_work_intent_activations VALUES (${workId}, ${"org-one"})`;
    }
    assert.deepEqual(yield* listActivatedOrganizationWorkAfter(null), ["a", "c", "e", "g"]);
    assert.deepEqual(yield* listActivatedOrganizationWorkAfter("c"), ["e", "g"]);
    yield* recordOrganizationLiveWorkFailure(id("a"), "attempt", "provider_unavailable");
    assert.deepEqual(yield* listActivatedOrganizationWorkAfter(null), ["c", "e", "g"]);
    const failure = yield* readOrganizationLiveWorkFailure(id("a"));
    assert.equal(failure?.code, "provider_unavailable");
    assert.match(failure?.recordedAt ?? "", /^\d{4}-\d{2}-\d{2}T.*Z$/);
    const failures = yield* listOrganizationLiveWorkFailures("org-one");
    assert.deepEqual(
      failures.map(({ workId, phase, code }) => ({ workId, phase, code })),
      [{ workId: "a", phase: "attempt", code: "provider_unavailable" }],
    );
    assert.deepEqual(yield* listOrganizationLiveWorkFailures("org-two"), []);
    yield* recordOrganizationLiveWorkFailure(id("e"), "integration", "integration_unavailable");
    assert.deepEqual(yield* listActivatedOrganizationWorkAfter(null), ["c", "e", "g"]);
    yield* clearRecoverableOrganizationLiveWorkFailure(id("e"));
    assert.equal(yield* readOrganizationLiveWorkFailure(id("e")), null);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("dispatches only selected activated phases and stops at human approval", () =>
  Effect.gen(function* () {
    const activated = [id("a"), id("b"), id("c"), id("d"), id("e")];
    const states = new Map<string, OrganizationLiveWorkSnapshot>([
      ["a", snapshot("a", "pending")],
      ["b", snapshot("b", "blocked", "submitted")],
      ["c", snapshot("c", "waiting-approval", "qa-accepted")],
      ["d", snapshot("d", "blocked", "qa-accepted", "human-reviewer")],
      ["e", snapshot("e", "running", "running")],
      ["unactivated", snapshot("unactivated", "pending")],
    ]);
    const calls: string[] = [];
    const executor = makeOrganizationLiveWorkExecutor(
      {
        listAfter: (cursor) =>
          Effect.succeed(activated.filter((workId) => workId > (cursor ?? "")).slice(0, 4)),
        read: (workId) => Effect.succeed(states.get(workId) ?? null),
        recordFailure: () => Effect.void,
        clearRecoverableFailure: () => Effect.void,
        shouldDeferAuthorityFailure: () => Effect.succeed(false),
      },
      {
        proposeAndAttempt: (workId) =>
          Effect.sync(() => {
            calls.push(`attempt:${workId}`);
          }),
        candidateAndQA: (workId, attemptId) =>
          Effect.sync(() => {
            calls.push(`qa:${workId}:${attemptId}`);
          }),
        integrateAndComplete: (workId, attemptId) =>
          Effect.sync(() => {
            calls.push(`integration:${workId}:${attemptId}`);
          }),
      },
    );
    const first = yield* executor.runOnce();
    assert.deepEqual(
      first.map((result) => result.phase),
      ["attempt", "qa", "waiting", "integration"],
    );
    assert.deepEqual(calls, ["attempt:a", "qa:b:attempt:b", "integration:d:attempt:d"]);
    const second = yield* executor.runOnce();
    assert.deepEqual(
      second.map((result) => result.phase),
      ["skipped"],
    );
    assert.equal(calls.includes("attempt:unactivated"), false);
  }),
);

it.effect("keeps activated work pending while restored automation awaits review", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const executor = makeOrganizationLiveWorkExecutor(
      {
        listAfter: () => Effect.succeed([id("held-work")]),
        read: () => Effect.succeed(snapshot("held-work", "pending")),
        recordFailure: () => Effect.void,
        clearRecoverableFailure: () => Effect.void,
        shouldDeferAuthorityFailure: () => Effect.succeed(false),
      },
      {
        proposeAndAttempt: () => Effect.sync(() => void calls.push("attempt")),
        candidateAndQA: () => Effect.void,
        integrateAndComplete: () => Effect.void,
      },
    );
    const result = yield* executor.runOnce().pipe(
      Effect.provideService(WorkAdmission, {
        acquire: Effect.succeed(() => Effect.void),
        acquirePassive: Effect.succeed(() => Effect.void),
        check: Effect.void,
        checkAutomation: Effect.fail(new MaintenanceWorkHeld({ cause: "review required" })),
      }),
    );
    assert.deepEqual(
      result.map(({ outcome }) => outcome),
      ["waiting"],
    );
    assert.deepEqual(calls, []);
  }),
);

it.effect("holds one work in flight and persists a terminal phase failure", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const failures: string[] = [];
    const executor = makeOrganizationLiveWorkExecutor(
      {
        listAfter: () => Effect.succeed([id("one")]),
        read: () => Effect.succeed(snapshot("one", "pending")),
        recordFailure: (workId, phase, code) =>
          Effect.sync(() => {
            failures.push(`${workId}:${phase}:${code}`);
          }),
        clearRecoverableFailure: () => Effect.void,
        shouldDeferAuthorityFailure: () => Effect.succeed(false),
      },
      {
        proposeAndAttempt: () =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return yield* new OrganizationWorkError({
              code: "unavailable",
              message: "Provider call failed.",
            });
          }),
        candidateAndQA: () => Effect.void,
        integrateAndComplete: () => Effect.void,
      },
    );
    const firstFiber = yield* executor.runOnce().pipe(Effect.forkChild);
    yield* Deferred.await(started);
    assert.deepEqual(yield* executor.runOnce(), []);
    yield* Deferred.succeed(release, undefined);
    const first = yield* Fiber.join(firstFiber);
    assert.equal(first[0]?.phase, "attempt");
    assert.equal(first[0]?.outcome, "failed");
    assert.deepEqual(failures, ["one:attempt:attempt_unavailable"]);
    assert.deepEqual(yield* executor.runOnce(), []);
    assert.equal(calls, 1);
  }),
);

it.effect("records a sanitized budget exhaustion code without the provider message", () =>
  Effect.gen(function* () {
    const recorded: string[] = [];
    let capacityAvailable = false;
    let cleared = 0;
    const executor = makeOrganizationLiveWorkExecutor(
      {
        listAfter: () => Effect.succeed([id("budgeted")]),
        read: () => Effect.succeed(snapshot("budgeted", "pending")),
        recordFailure: (_workId, _phase, code) =>
          Effect.sync(() => {
            recorded.push(code);
          }),
        clearRecoverableFailure: () =>
          Effect.sync(() => {
            cleared++;
          }),
        shouldDeferAuthorityFailure: () => Effect.succeed(false),
      },
      {
        proposeAndAttempt: () =>
          capacityAvailable
            ? Effect.void
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateOrganizationPatchProposal",
                  detail: "Provider admission denied: secret raw response",
                  cause: new OrganizationProviderBudgetError({
                    code: "exhausted",
                    message: "secret raw response",
                  }),
                }),
              ),
        candidateAndQA: () => Effect.void,
        integrateAndComplete: () => Effect.void,
      },
    );
    assert.equal((yield* executor.runOnce())[0]?.outcome, "failed");
    assert.deepEqual(recorded, ["budget_exhausted"]);
    capacityAvailable = true;
    assert.equal((yield* executor.runOnce())[0]?.outcome, "completed");
    assert.equal(cleared, 1);
  }),
);

it.effect("defers a pause racing with dispatch without a terminal authority failure", () =>
  Effect.gen(function* () {
    let paused = true;
    let calls = 0;
    const failures: string[] = [];
    const executor = makeOrganizationLiveWorkExecutor(
      {
        listAfter: () => Effect.succeed([id("pause-race")]),
        read: () => Effect.succeed(snapshot("pause-race", "pending")),
        recordFailure: (_workId, _phase, code) =>
          Effect.sync(() => {
            failures.push(code);
          }),
        clearRecoverableFailure: () => Effect.void,
        shouldDeferAuthorityFailure: () => Effect.succeed(paused),
      },
      {
        proposeAndAttempt: () => {
          calls++;
          return paused
            ? Effect.fail(new OrganizationWorkError({ code: "forbidden", message: "Paused." }))
            : Effect.void;
        },
        candidateAndQA: () => Effect.void,
        integrateAndComplete: () => Effect.void,
      },
    );
    assert.equal((yield* executor.runOnce())[0]?.outcome, "waiting");
    assert.deepEqual(failures, []);
    paused = false;
    assert.equal((yield* executor.runOnce())[0]?.outcome, "completed");
    assert.equal(calls, 2);
  }),
);

it.effect("replays the same approved integration after CAS was applied before completion", () =>
  Effect.gen(function* () {
    let casApplied = false;
    let completionRecorded = false;
    const failures: string[] = [];
    const source = {
      listAfter: () => Effect.succeed([id("approved")]),
      read: () => Effect.succeed(snapshot("approved", "blocked", "qa-accepted", "human")),
      recordFailure: (_workId: OrganizationWorkId, _phase: string, code: string) =>
        Effect.sync(() => {
          failures.push(code);
        }),
      clearRecoverableFailure: () =>
        Effect.sync(() => {
          failures.length = 0;
        }),
      shouldDeferAuthorityFailure: () => Effect.succeed(false),
    };
    const actions = {
      proposeAndAttempt: () => Effect.void,
      candidateAndQA: () => Effect.void,
      integrateAndComplete: () =>
        Effect.gen(function* () {
          if (!casApplied) {
            casApplied = true;
            return yield* new OrganizationWorkError({
              code: "unavailable",
              message: "Completion receipt unavailable after CAS.",
            });
          }
          completionRecorded = true;
        }),
    };
    const first = makeOrganizationLiveWorkExecutor(source, actions);
    assert.equal((yield* first.runOnce())[0]?.outcome, "failed");
    assert.deepEqual(failures, ["integration_unavailable"]);
    const restarted = makeOrganizationLiveWorkExecutor(source, actions);
    assert.equal((yield* restarted.runOnce())[0]?.outcome, "completed");
    assert.equal(completionRecorded, true);
    assert.deepEqual(failures, []);
  }),
);
