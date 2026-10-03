// @effect-diagnostics nodeBuiltinImport:off - Unique paths isolate the in-process host latch.
import * as NodeAssert from "node:assert";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { OrganizationSandboxInput } from "./OrganizationSandboxHost.ts";
import { createOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import { OrganizationSingleFileAttemptHost } from "./OrganizationSingleFileAttemptCoordinator.ts";
import { OrganizationSingleFileQAHost } from "./OrganizationSingleFileQACoordinator.ts";
import {
  organizationSingleFileAttemptBrokerHost,
  organizationSingleFileQABrokerHost,
} from "./OrganizationScopedBrokerHosts.ts";

const baseDir = () => NodePath.join(NodeOS.tmpdir(), `t3-broker-host-${NodeCrypto.randomUUID()}`);
const sandboxResult = {
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  outputLimitExceeded: false,
} as const;
const sandboxInput = (attemptId: string, reservedUnitName: string) => ({
  attemptId,
  reservedUnitName,
  argv: ["/usr/bin/node", "--check", "/workspace/replacement.mjs"] as const,
  files: { "replacement.mjs": "export const answer = 42;" },
});
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const qaInput = () => {
  const source = Buffer.from("export function solve(input) { return input.value; }\n");
  const artifact = createOrganizationSingleFileArtifact({
    relativePath: "answer.mjs",
    baseCommit: "a".repeat(40),
    baseBlobOid: "b".repeat(40),
    baseMode: "100644",
    baseSha256: sha256(source),
    baseBytes: source,
    replacementBytes: source,
  });
  return {
    reviewedArtifactBytes: artifact,
    reviewedArtifactSha256: sha256(artifact),
    plan: {
      version: 1 as const,
      exportName: "solve",
      cases: [{ input: { value: 2 }, expected: 2 }],
    },
  };
};

const makeBroker = () => {
  const journal = new Map<string, { unitName: string; phase: string }>();
  let reserveCalls = 0;
  let failReserve = false;
  let failPrepare = false;
  let failStop = false;
  const broker = {
    status: async () =>
      [...journal].map(([operationId, item]) => ({
        operationId,
        unitName: item.unitName,
        phase: item.phase,
        identity: null,
      })),
    reserve: async (operationId: string, unitName: string) => {
      reserveCalls++;
      journal.set(operationId, { unitName, phase: "reserved" });
      if (failReserve) throw new Error("reserve reply was lost");
    },
    prepare: async (
      operationId: string,
      input: OrganizationSandboxInput & { readonly reservedUnitName?: string },
    ) => {
      if (failPrepare) throw new Error("preparation may have dispatched");
      const current = journal.get(operationId)!;
      current.phase = "prepared";
      const finish = async () => {
        if (failStop) throw new Error("stop confirmation was lost");
        current.phase = "stopped";
        return sandboxResult;
      };
      return {
        unitName: input.reservedUnitName ?? current.unitName,
        invocationId: "a".repeat(32),
        controlGroup: `/test/${current.unitName}`,
        sandboxPid: 123,
        pidNamespace: 456,
        workDirectory: "/workspace",
        start: async () => {
          current.phase = "started";
        },
        wait: finish,
        stop: finish,
        discard: finish,
      };
    },
  };
  return {
    broker,
    journal,
    get reserveCalls() {
      return reserveCalls;
    },
    set failReserve(value: boolean) {
      failReserve = value;
    },
    set failPrepare(value: boolean) {
      failPrepare = value;
    },
    set failStop(value: boolean) {
      failStop = value;
    },
  };
};

const host = (key: string, broker: ReturnType<typeof makeBroker>["broker"]) =>
  OrganizationSingleFileAttemptHost.pipe(
    Effect.provide(organizationSingleFileAttemptBrokerHost(key, broker)),
  );

it.effect(
  "serializes worker scopes across host instances until exact terminal acknowledgement",
  () =>
    Effect.gen(function* () {
      const key = baseDir();
      const mock = makeBroker();
      const first = yield* host(key, mock.broker);
      const second = yield* host(key, mock.broker);
      const qa = yield* OrganizationSingleFileQAHost.pipe(
        Effect.provide(organizationSingleFileQABrokerHost(key, mock.broker)),
      );
      yield* Effect.promise(() =>
        first.reserve("attempt-a", "t3-org-sandbox-" + "a".repeat(32) + ".scope"),
      );
      yield* Effect.promise(() =>
        NodeAssert.rejects(
          second.reserve("attempt-b", "t3-org-sandbox-" + "b".repeat(32) + ".scope"),
          /still unresolved/,
        ),
      );
      NodeAssert.strict.equal(mock.reserveCalls, 1);
      yield* Effect.promise(() =>
        NodeAssert.rejects(
          qa.evaluate("attempt-a", qaInput()),
          /Scoped QA sandbox could not be prepared/,
        ),
      );
      NodeAssert.strict.equal(mock.reserveCalls, 1);
      const prepared = yield* Effect.promise(() =>
        first.prepare(sandboxInput("attempt-a", "t3-org-sandbox-" + "a".repeat(32) + ".scope")),
      );
      yield* Effect.promise(() => prepared.wait());
      yield* Effect.promise(() =>
        second.reserve("attempt-b", "t3-org-sandbox-" + "b".repeat(32) + ".scope"),
      );
      NodeAssert.strict.equal(mock.reserveCalls, 2);
    }),
);

it.effect("holds the latch when a reserve or stop reply may have been lost", () =>
  Effect.gen(function* () {
    const reserveKey = baseDir();
    const reserveMock = makeBroker();
    reserveMock.failReserve = true;
    const reserveHost = yield* host(reserveKey, reserveMock.broker);
    yield* Effect.promise(() =>
      NodeAssert.rejects(
        reserveHost.reserve("attempt-a", "t3-org-sandbox-" + "a".repeat(32) + ".scope"),
        /reserve reply was lost/,
      ),
    );
    yield* Effect.promise(() =>
      NodeAssert.rejects(
        reserveHost.reserve("attempt-b", "t3-org-sandbox-" + "b".repeat(32) + ".scope"),
        /still unresolved/,
      ),
    );

    const stopKey = baseDir();
    const stopMock = makeBroker();
    const stopHost = yield* host(stopKey, stopMock.broker);
    yield* Effect.promise(() =>
      stopHost.reserve("attempt-c", "t3-org-sandbox-" + "c".repeat(32) + ".scope"),
    );
    const prepared = yield* Effect.promise(() =>
      stopHost.prepare(sandboxInput("attempt-c", "t3-org-sandbox-" + "c".repeat(32) + ".scope")),
    );
    stopMock.failStop = true;
    yield* Effect.promise(() => NodeAssert.rejects(prepared.stop(), /stop confirmation was lost/));
    yield* Effect.promise(() =>
      NodeAssert.rejects(
        stopHost.reserve("attempt-d", "t3-org-sandbox-" + "d".repeat(32) + ".scope"),
        /still unresolved/,
      ),
    );

    const prepareKey = baseDir();
    const prepareMock = makeBroker();
    prepareMock.failPrepare = true;
    const prepareHost = yield* host(prepareKey, prepareMock.broker);
    yield* Effect.promise(() =>
      prepareHost.reserve("attempt-e", "t3-org-sandbox-" + "e".repeat(32) + ".scope"),
    );
    yield* Effect.promise(() =>
      NodeAssert.rejects(
        prepareHost.prepare(
          sandboxInput("attempt-e", "t3-org-sandbox-" + "e".repeat(32) + ".scope"),
        ),
        /preparation may have dispatched/,
      ),
    );
    yield* Effect.promise(() =>
      NodeAssert.rejects(
        prepareHost.reserve("attempt-f", "t3-org-sandbox-" + "f".repeat(32) + ".scope"),
        /still unresolved/,
      ),
    );
  }),
);

it.effect("refuses a previously unresolved broker journal entry before reservation", () =>
  Effect.gen(function* () {
    const mock = makeBroker();
    mock.journal.set("older-attempt", {
      unitName: "t3-org-sandbox-" + "e".repeat(32) + ".scope",
      phase: "started",
    });
    const attemptHost = yield* host(baseDir(), mock.broker);
    yield* Effect.promise(() =>
      NodeAssert.rejects(
        attemptHost.reserve("attempt-a", "t3-org-sandbox-" + "a".repeat(32) + ".scope"),
        /journal has an unresolved scoped launch/,
      ),
    );
    NodeAssert.strict.equal(mock.reserveCalls, 0);
  }),
);
