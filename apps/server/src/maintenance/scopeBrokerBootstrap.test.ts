// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Isolated native coordinator fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import { afterEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import type { ForkUpdateStatus } from "@t3tools/contracts";
import { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import { AGENT_IDLE_WINDOW_MS } from "@t3tools/shared/forkMaintenanceAdmission";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { bootstrapManagedScopeBroker } from "./scopeBrokerBootstrap.ts";
import { maintenanceCommand } from "../cli/maintenance.ts";
import {
  issueOperatorToken,
  OPERATOR_TOKEN_HEADER,
  OPERATOR_ROUTE_PREFIX,
} from "./operatorAuth.ts";
import { serveOrganizationScopeLaunchBroker } from "../organizations/OrganizationScopeLaunchBroker.ts";
import {
  organizationLaunchSuspendMarkerPath,
  quiesceOrganizationLaunchBroker,
} from "../organizations/OrganizationScopeLaunchBrokerProtocol.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function fixture(nativeIdentity = false) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-scope-bootstrap-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  await NodeFSP.mkdir(home, { mode: 0o700 });
  const namespace = NodePath.join(root, "coordinator");
  const store = nativeIdentity
    ? await CoordinatorStore.open(namespace)
    : await CoordinatorStore.open(namespace, async (pid) =>
        pid === process.pid ? "fixture-owner" : null,
      );
  const now = Date.now();
  await store.register(
    { id: "managed", label: "Cloud", kind: "service", homes: [home], updateTarget: true },
    now,
  );
  await store.confirmBootstrap();
  await store.observe("managed", [], now - AGENT_IDLE_WINDOW_MS);
  await store.observe("managed", [], now);
  const census = await store.status(now);
  const controller: ForkUpdateStatus = {
    coordinatorId: census.coordinatorId,
    phase: "idle",
    policy: { channel: "nightly", automaticInstallation: false, pinnedBuild: null },
    currentBuild: {
      version: "1.0.0",
      commit: "a".repeat(40),
      channel: "stable",
      artifactSha256: "a".repeat(64),
    },
    targetBuild: null,
    blockers: [],
    recoveryOptions: [],
    transactionId: null,
    automationReviewRequired: true,
  };
  const ensure = vi.fn(async (_home: string) => {});
  const controllerStatus = vi.fn(async (_home: string) => ({
    ok: true as const,
    status: controller,
  }));
  const ports = {
    platform: "linux" as NodeJS.Platform,
    canonicalHome: NodeFSP.realpath,
    controllerStatus,
    open: async (_namespace: string | undefined) => store,
    ensure,
    now: () => now,
  };
  return { home, namespace, store, now, controller, ports, input: { home, namespace } };
}

it("provisions only the broker for the same verified idle native managed home", async () => {
  const f = await fixture();
  await bootstrapManagedScopeBroker(f.input, f.ports);
  expect(f.ports.ensure).toHaveBeenCalledExactlyOnceWith(f.home);
  expect(f.ports.controllerStatus).toHaveBeenCalledTimes(2);
  const after = await f.store.status(f.now);
  expect(after.coordinatorId).toBe(f.controller.coordinatorId);
  expect(after.fence).toBeNull();
  expect(after.participants.map((p) => p.id)).toEqual(["managed"]);
  await expect(NodeFSP.stat(NodePath.join(f.home, "userdata"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["active-agents", "unknown-participant", "commands"] as const)(
  "does not provision while the real coordinator reports %s",
  async (reason) => {
    const f = await fixture();
    await f.store.observe(
      "managed",
      [{ participantId: "managed", reason, label: "Work or unknown activity" }],
      f.now,
    );
    await expect(bootstrapManagedScopeBroker(f.input, f.ports)).rejects.toThrow("idle window");
    expect(f.ports.ensure).not.toHaveBeenCalled();
  },
);

it("retains the native idle window after a real work lease begins", async () => {
  const f = await fixture();
  const release = await f.store.beginWork("managed");
  try {
    await expect(bootstrapManagedScopeBroker(f.input, f.ports)).rejects.toThrow("idle window");
    expect(f.ports.ensure).not.toHaveBeenCalled();
  } finally {
    await release();
  }
});

it.each([
  "controller-work",
  "transaction",
  "installing",
  "countdown",
  "unreadable",
  "other-coordinator",
])("does not provision when authenticated status is %s", async (condition) => {
  const f = await fixture();
  let controller = f.controller;
  if (condition === "controller-work")
    controller = {
      ...controller,
      blockers: [{ participantId: "managed", reason: "active-agents", label: "Provider turn" }],
    };
  if (condition === "transaction")
    controller = { ...controller, transactionId: "update-in-progress" };
  if (condition === "installing") controller = { ...controller, phase: "installing" };
  if (condition === "countdown")
    controller = {
      ...controller,
      countdown: {
        startedAt: f.now,
        installsAt: f.now + 1000,
        targetArtifactSha256: "b".repeat(64),
      },
    };
  if (condition === "unreadable") controller = {} as ForkUpdateStatus;
  if (condition === "other-coordinator")
    controller = { ...controller, coordinatorId: "another-device" };
  f.ports.controllerStatus.mockResolvedValue({ ok: true, status: controller });
  await expect(bootstrapManagedScopeBroker(f.input, f.ports)).rejects.toThrow();
  expect(f.ports.ensure).not.toHaveBeenCalled();
});

it("does not provision when native authentication or status cannot be read", async () => {
  const f = await fixture();
  f.ports.controllerStatus.mockRejectedValue(new Error("Native controller authentication refused"));
  await expect(bootstrapManagedScopeBroker(f.input, f.ports)).rejects.toThrow(
    "authentication refused",
  );
  expect(f.ports.ensure).not.toHaveBeenCalled();
});

it("does not provision against another home or an active native fence", async () => {
  const f = await fixture();
  const other = NodePath.join(NodePath.dirname(f.home), "other");
  await NodeFSP.mkdir(other);
  await expect(bootstrapManagedScopeBroker({ ...f.input, home: other }, f.ports)).rejects.toThrow(
    "does not belong",
  );
  const originalStatus = f.store.status.bind(f.store);
  vi.spyOn(f.store, "status").mockImplementation(async (now) => ({
    ...(await originalStatus(now)),
    fence: { transactionId: "held", since: now, holderAlive: true },
  }));
  await expect(bootstrapManagedScopeBroker(f.input, f.ports)).rejects.toThrow("idle window");
  expect(f.ports.ensure).not.toHaveBeenCalled();
});

it("reports work arriving during provisioning without granting update admission", async () => {
  const f = await fixture();
  f.ports.ensure.mockImplementation(async () => {
    await f.store.observe(
      "managed",
      [{ participantId: "managed", reason: "active-agents", label: "New provider turn" }],
      f.now,
    );
  });
  await expect(bootstrapManagedScopeBroker(f.input, f.ports)).rejects.toThrow("idle window");
  expect((await f.store.status(f.now)).fence).toBeNull();
});

it("does not open a coordinator or start a broker on Windows", async () => {
  const f = await fixture();
  const open = vi.fn(f.ports.open);
  await expect(
    bootstrapManagedScopeBroker(f.input, { ...f.ports, platform: "win32", open }),
  ).rejects.toThrow("requires Linux");
  expect(open).not.toHaveBeenCalled();
  expect(f.ports.ensure).not.toHaveBeenCalled();
});

it.effect(
  "runs the public operator command against authenticated native status without an install request",
  () =>
    Effect.gen(function* () {
      if (HostProcessPlatform.defaultValue() !== "linux") {
        const home = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-scope-unsupported-")),
        );
        roots.push(home);
        const result = yield* Command.runWith(maintenanceCommand, { version: "0.0.0" })([
          "scope-broker",
          "--base-dir",
          home,
        ]).pipe(Effect.provide(NodeServices.layer), Effect.exit);
        expect(result).toMatchObject({ _tag: "Failure" });
        expect(String(result)).toContain("Organization launch broker requires Linux");
        expect(yield* Effect.promise(() => NodeFSP.readdir(home))).toEqual([]);
        return;
      }
      const resources = yield* Effect.promise(async () => {
        const f = await fixture(true);
        const token = await issueOperatorToken(f.home);
        const requests: string[] = [];
        const server = NodeHttp.createServer((request, response) => {
          requests.push(request.url ?? "");
          if (
            request.method !== "POST" ||
            request.url !== `${OPERATOR_ROUTE_PREFIX}status` ||
            request.headers[OPERATOR_TOKEN_HEADER] !== token
          ) {
            response.writeHead(403).end();
            return;
          }
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(f.controller));
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Fixture listener failed");
        const broker = await serveOrganizationScopeLaunchBroker(f.home);
        await NodeFSP.mkdir(NodePath.join(f.home, "userdata"));
        await NodeFSP.writeFile(
          NodePath.join(f.home, "userdata", "server-runtime.json"),
          JSON.stringify({ pid: process.pid, origin: `http://127.0.0.1:${address.port}` }),
        );
        vi.stubEnv("T3CODE_MAINTENANCE_NAMESPACE", f.namespace);
        return { f, requests, broker, server };
      });
      const { f, requests, broker, server } = resources;
      try {
        yield* Command.runWith(maintenanceCommand, { version: "0.0.0" })([
          "scope-broker",
          "--base-dir",
          f.home,
        ]).pipe(Effect.provide(NodeServices.layer));
        yield* Effect.promise(async () => {
          expect(requests).toEqual([
            `${OPERATOR_ROUTE_PREFIX}status`,
            `${OPERATOR_ROUTE_PREFIX}status`,
          ]);
          await NodeFSP.writeFile(organizationLaunchSuspendMarkerPath(f.home), "{}\n", {
            mode: 0o600,
          });
          await quiesceOrganizationLaunchBroker(f.home);
          expect((await f.store.status(f.now)).fence).toBeNull();
          await expect(
            NodeFSP.stat(NodePath.join(f.home, "userdata", "state.sqlite")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        });
      } finally {
        yield* Effect.promise(async () => {
          await broker.close();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        });
      }
    }),
);
