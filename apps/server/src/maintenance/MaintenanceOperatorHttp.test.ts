// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { ForkMaintenanceError, type ForkUpdateStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/unstable/http";
import * as Layer from "effect/Layer";
import { makeOperatorRoute } from "./MaintenanceOperatorHttp.ts";
import { callOperator, describeStatus, discoverOperatorTarget } from "./operatorClient.ts";
import {
  issueOperatorToken,
  operatorTokenMatches,
  operatorTokenPath,
  OPERATOR_ROUTE_PREFIX,
  OPERATOR_TOKEN_HEADER,
  readOperatorToken,
  revokeOperatorToken,
} from "./operatorAuth.ts";
import type { MaintenanceService } from "./MaintenanceService.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const status = (overrides: Partial<ForkUpdateStatus> = {}): ForkUpdateStatus => ({
  coordinatorId: "c",
  phase: "idle",
  policy: { channel: "stable", automaticInstallation: false, pinnedBuild: null },
  currentBuild: { version: "1.0.0", commit: "", channel: "stable", artifactSha256: "a".repeat(64) },
  targetBuild: null,
  blockers: [],
  recoveryOptions: [],
  transactionId: null,
  automationReviewRequired: false,
  ...overrides,
});

function service(calls: string[]): MaintenanceService["Service"] {
  return {
    status: Effect.sync(() => (calls.push("status"), status())),
    updatePolicy: (patch) =>
      Effect.sync(() => (calls.push(`policy:${JSON.stringify(patch)}`), status())),
    runAction: (input) =>
      input.action === "install" && input.targetArtifactSha256 === "stale"
        ? Effect.fail(
            new ForkMaintenanceError({
              reason: "The reviewed build is no longer the staged update.",
              blockers: [
                { participantId: "p", reason: "active-agents", label: "An agent is running" },
              ],
            }),
          )
        : Effect.sync(() => (calls.push(`action:${input.action}`), status({ phase: "checking" }))),
    recover: (request) => Effect.sync(() => (calls.push(`recover:${request.optionId}`), status())),
    recoverySupported: true,
  };
}
async function handlerFor(token: string, calls: string[]) {
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(makeOperatorRoute(token, service(calls))),
    { disableLogger: true },
  );
  const post = (
    operation: string,
    body: unknown,
    headers: Record<string, string> = { [OPERATOR_TOKEN_HEADER]: token },
  ) =>
    handler(
      new Request(`https://local.example${OPERATOR_ROUTE_PREFIX}${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { post, dispose };
}

describe("local operator credential", () => {
  it("is a random owner-only file under the home, replaced on every start and removed on exit", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-operator-"));
    roots.push(root);
    const first = await issueOperatorToken(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Windows permissions are ACLs, not POSIX mode bits.
    if (process.platform === "win32") {
      const probe = NodeChildProcess.spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$acl = Get-Acl -LiteralPath $env:T3_TEST_PRIVATE_PATH; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if (@($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid }).Count -ne 0 -or $acl.Access.Count -eq 0) { exit 3 }",
        ],
        { env: { ...process.env, T3_TEST_PRIVATE_PATH: operatorTokenPath(root) } },
      );
      expect(probe.status).toBe(0);
    } else expect((await NodeFSP.stat(operatorTokenPath(root))).mode & 0o077).toBe(0);
    expect(await readOperatorToken(root)).toBe(first);
    const second = await issueOperatorToken(root);
    expect(second).not.toBe(first);
    await revokeOperatorToken(root);
    expect(await readOperatorToken(root)).toBeNull();
  });

  it("compares in constant time and refuses a missing, short or wrong token", () => {
    expect(operatorTokenMatches("abc", "abc")).toBe(true);
    expect(operatorTokenMatches("abc", undefined)).toBe(false);
    expect(operatorTokenMatches("abc", "abd")).toBe(false);
    expect(operatorTokenMatches("abc", "abcd")).toBe(false);
  });
});

describe("operator HTTP route", () => {
  it("refuses a request without the operator credential before touching the controller", async () => {
    const calls: string[] = [];
    const { post, dispose } = await handlerFor("secret", calls);
    try {
      expect((await post("status", {}, {})).status).toBe(401);
      expect((await post("status", {}, { [OPERATOR_TOKEN_HEADER]: "wrong" })).status).toBe(401);
      expect(calls).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("lands every operation in the one controller service and returns its status", async () => {
    const calls: string[] = [];
    const { post, dispose } = await handlerFor("secret", calls);
    try {
      expect(await (await post("status", {})).json()).toMatchObject({ phase: "idle" });
      expect((await post("policy", { channel: "nightly", pinnedBuild: null })).status).toBe(200);
      expect((await post("action", { action: "check" })).status).toBe(200);
      expect(
        (
          await post("recover", {
            optionId: "o",
            transactionId: "t",
            restoreTimestamps: { h: "ts" },
            acknowledgeDataRestore: true,
          })
        ).status,
      ).toBe(200);
      expect(calls).toEqual([
        "status",
        'policy:{"channel":"nightly","pinnedBuild":null}',
        "action:check",
        "recover:o",
      ]);
    } finally {
      await dispose();
    }
  });

  it("reports the controller's own refusal and its blockers, and rejects malformed bodies and unknown operations", async () => {
    const calls: string[] = [];
    const { post, dispose } = await handlerFor("secret", calls);
    try {
      const refused = await post("action", { action: "install", targetArtifactSha256: "stale" });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error: {
          reason: "The reviewed build is no longer the staged update.",
          blockers: [{ participantId: "p", reason: "active-agents", label: "An agent is running" }],
        },
      });
      expect((await post("action", { action: "format-disk" })).status).toBe(400);
      expect((await post("recover", { optionId: "o" })).status).toBe(400);
      expect((await post("nothing", {})).status).toBe(404);
      expect(calls).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

describe("operator client", () => {
  it("finds only a live server for the home that holds the credential", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-operator-client-"));
    roots.push(root);
    await expect(discoverOperatorTarget(root)).rejects.toThrow("no operator credential");
    await issueOperatorToken(root);
    await expect(discoverOperatorTarget(root)).rejects.toThrow("is not running");
    await NodeFSP.mkdir(NodePath.join(root, "userdata"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, "userdata", "server-runtime.json"),
      JSON.stringify({ pid: process.pid, origin: "http://127.0.0.1:3773" }),
    );
    expect(await discoverOperatorTarget(root)).toMatchObject({ origin: "http://127.0.0.1:3773" });
    await NodeFSP.writeFile(
      NodePath.join(root, "userdata", "server-runtime.json"),
      JSON.stringify({ pid: 4_000_001, origin: "http://127.0.0.1:3773" }),
    );
    await expect(discoverOperatorTarget(root)).rejects.toThrow("is not running");
  });

  it("returns a refusal as data with the controller's blockers, and describes status for people", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: {
            reason: "Installation is blocked",
            blockers: [{ label: "An agent is running" }],
          },
        }),
        { status: 409 },
      )) as unknown as typeof fetch;
    expect(
      await callOperator(
        { origin: "http://x", token: "t" },
        "action",
        { action: "check" },
        fetchImpl,
      ),
    ).toEqual({
      ok: false,
      reason: "Installation is blocked",
      blockers: [{ label: "An agent is running" }],
    });
    const lines = describeStatus(
      status({
        phase: "waiting",
        targetBuild: {
          version: "1.0.1",
          commit: "",
          channel: "stable",
          artifactSha256: "b".repeat(64),
        },
        blockers: [
          {
            participantId: "p",
            reason: "idle-window",
            label: "Runtime must remain stopped for five minutes.",
          },
        ],
        affectedHomes: [
          { id: "h", label: "Windows" },
          { id: "w", label: "Ubuntu (WSL)" },
        ],
        automationReviewRequired: true,
        lastError: "Update check failed",
      }),
    );
    expect(lines.join("\n")).toContain("target 1.0.1");
    expect(lines).toContain("Replaces: Windows, Ubuntu (WSL)");
    expect(lines).toContain("Waiting: Runtime must remain stopped for five minutes.");
    expect(lines.join("\n")).toContain("acknowledge-review");
  });
});
