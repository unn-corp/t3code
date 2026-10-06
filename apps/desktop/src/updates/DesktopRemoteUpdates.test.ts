import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopTelemetryCancelDesktopUpdate,
  DesktopTelemetryCommitDesktopUpdate,
  DesktopTelemetryRequestDesktopUpdate,
  DesktopUpdateStatusReport,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopRemoteUpdates from "./DesktopRemoteUpdates.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { idleStatus, makeHarness, stagedStatus } from "./updatesTestHarness.ts";

// The remote flow hops between fibers and runPromise-driven handlers, so settling needs real microtask turns.
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i += 1) {
    yield* Effect.yieldNow;
    yield* Effect.promise(() => Promise.resolve());
  }
});

const request = (requestId: string): DesktopTelemetryRequestDesktopUpdate => ({
  version: 1,
  type: "requestDesktopUpdate",
  requestId,
});
const commit = (requestId: string): DesktopTelemetryCommitDesktopUpdate => ({
  version: 1,
  type: "commitDesktopUpdate",
  requestId,
});

function runRemoteUpdatesTest(
  harness: ReturnType<typeof makeHarness>,
  body: (context: {
    readonly reports: DesktopUpdateStatusReport[];
    readonly requests: Queue.Queue<DesktopTelemetryRequestDesktopUpdate>;
    readonly commits: Queue.Queue<DesktopTelemetryCommitDesktopUpdate>;
    readonly cancellations: Queue.Queue<DesktopTelemetryCancelDesktopUpdate>;
  }) => Effect.Effect<void, never, DesktopUpdates.DesktopUpdates>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<DesktopTelemetryRequestDesktopUpdate>();
      const commits = yield* Queue.unbounded<DesktopTelemetryCommitDesktopUpdate>();
      const cancellations = yield* Queue.unbounded<DesktopTelemetryCancelDesktopUpdate>();
      const reports: DesktopUpdateStatusReport[] = [];
      const publisher = DesktopTelemetryPublisher.DesktopTelemetryPublisher.of({
        latest: Effect.succeedNone,
        changes: Stream.empty,
        encoded: Stream.empty,
        handleControlForSource: () => Effect.void,
        removeControlSource: () => Effect.void,
        publishUpdateReport: (report) =>
          Effect.sync(() => {
            reports.push(report);
          }),
        updateRequests: Stream.fromQueue(requests),
        updateCommits: Stream.fromQueue(commits),
        updateCancellations: Stream.fromQueue(cancellations),
        maintenanceRequests: Stream.empty,
        publishMaintenanceReport: () => Effect.void,
      });
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* DesktopRemoteUpdates.listen.pipe(
        Effect.provideService(DesktopTelemetryPublisher.DesktopTelemetryPublisher, publisher),
      );
      yield* settle;
      yield* body({ reports, requests, commits, cancellations });
    }),
  ).pipe(Effect.provide(harness.layer));
}

const terminalReports = (reports: DesktopUpdateStatusReport[]) =>
  reports.filter((report) => report.outcome !== undefined);

describe("DesktopRemoteUpdates", () => {
  it.effect(
    "prepares a staged update, and installs it only when the client commits, through the controller",
    () => {
      const harness = makeHarness({ afterCheck: stagedStatus() });
      return runRemoteUpdatesTest(harness, ({ reports, requests, commits }) =>
        Effect.gen(function* () {
          yield* Queue.offer(requests, request("req-1"));
          yield* settle;
          assert.equal(harness.checks(), 1);
          const terminals = terminalReports(reports);
          assert.equal(terminals.length, 1);
          assert.equal(terminals[0]?.outcome, "ready-to-install");
          assert.equal(terminals[0]?.requestId, "req-1");
          // Preparing never installs.
          assert.deepEqual(harness.installs, []);

          yield* Queue.offer(commits, commit("req-1"));
          yield* settle;
          assert.deepEqual(harness.installs, ["b".repeat(64)]);
          const statuses = reports
            .filter((report) => report.requestId === "req-1")
            .map((report) => report.state.status);
          assert.include(statuses, "downloaded");
        }),
      );
    },
  );

  it.effect("reports the controller's reason when it refuses the install at commit", () => {
    const harness = makeHarness({
      afterCheck: stagedStatus(),
      installFailure: "Installation is blocked: an agent is running.",
    });
    return runRemoteUpdatesTest(harness, ({ reports, requests, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-1"));
        yield* settle;
        yield* Queue.offer(commits, commit("req-1"));
        yield* settle;
        const failed = terminalReports(reports).find((report) => report.outcome === "failed");
        assert.equal(failed?.requestId, "req-1");
        assert.include(failed?.reason ?? "", "an agent is running");
      }),
    );
  });

  it.effect(
    "reports a build that cannot install as a failed commit without reaching an installer",
    () => {
      const harness = makeHarness({
        afterCheck: stagedStatus({
          installable: false,
          blockers: [
            { participantId: "x", reason: "idle-window", label: "Waiting for five quiet minutes." },
          ],
        }),
      });
      return runRemoteUpdatesTest(harness, ({ reports, requests, commits }) =>
        Effect.gen(function* () {
          yield* Queue.offer(requests, request("req-1"));
          yield* settle;
          yield* Queue.offer(commits, commit("req-1"));
          yield* settle;
          assert.deepEqual(harness.installs, []);
          assert.equal(terminalReports(reports).at(-1)?.outcome, "failed");
        }),
      );
    },
  );

  it.effect("reports up-to-date when the controller finds nothing newer", () => {
    const harness = makeHarness({ afterCheck: idleStatus() });
    return runRemoteUpdatesTest(harness, ({ reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-1"));
        yield* settle;
        assert.equal(terminalReports(reports).at(-1)?.outcome, "up-to-date");
        assert.deepEqual(harness.installs, []);
      }),
    );
  });

  it.effect("fails the run when updates are disabled on this installation", () => {
    const harness = makeHarness({
      disabledReason: "Updates are only available in packaged production builds.",
    });
    return runRemoteUpdatesTest(harness, ({ reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-1"));
        yield* settle;
        const terminal = terminalReports(reports).at(-1);
        assert.equal(terminal?.outcome, "failed");
        assert.include(terminal?.reason ?? "", "packaged production builds");
        assert.equal(harness.checks(), 0);
      }),
    );
  });

  it.effect("ignores a commit for a request that was never prepared", () => {
    const harness = makeHarness({ initial: stagedStatus() });
    return runRemoteUpdatesTest(harness, ({ reports, commits }) =>
      Effect.gen(function* () {
        yield* Queue.offer(commits, commit("unknown"));
        yield* settle;
        assert.deepEqual(harness.installs, []);
        assert.equal(terminalReports(reports).at(-1)?.outcome, "failed");
      }),
    );
  });

  it.effect("does not start a request that was cancelled before it began", () => {
    const harness = makeHarness({ afterCheck: stagedStatus() });
    return runRemoteUpdatesTest(harness, ({ requests, cancellations }) =>
      Effect.gen(function* () {
        yield* Queue.offer(cancellations, {
          version: 1,
          type: "cancelDesktopUpdate",
          requestId: "req-1",
        });
        yield* settle;
        yield* Queue.offer(requests, request("req-1"));
        yield* settle;
        assert.equal(harness.checks(), 0);
      }),
    );
  });
});
