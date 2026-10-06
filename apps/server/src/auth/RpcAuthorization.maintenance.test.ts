import { WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  maintenanceActionNeedsAdministration,
  RPC_REQUIRED_SCOPES,
  rpcMethodNeedsWorkAdmission,
} from "./RpcAuthorization.ts";

describe("RPC device work admission", () => {
  it("holds every write outside the orchestrator: settings, files, terminals, uploads, git, schedules, previews", () => {
    for (const method of [
      WS_METHODS.serverUpdateSettings,
      WS_METHODS.projectsWriteFile,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalOpen,
      WS_METHODS.attachmentsCreateUploadUrl,
      WS_METHODS.gitRunStackedAction,
      WS_METHODS.scheduledTasksUpsert,
      WS_METHODS.scheduledTasksRunNow,
      WS_METHODS.previewOpen,
      WS_METHODS.serverUpsertKeybinding,
      WS_METHODS.projectCloneStart,
    ]) {
      expect(rpcMethodNeedsWorkAdmission(method), method).toBe(true);
    }
  });

  it("leaves reads and subscriptions alone so a fenced device can still be observed", () => {
    for (const method of [
      WS_METHODS.serverGetConfig,
      WS_METHODS.serverGetSettings,
      WS_METHODS.projectsReadFile,
      WS_METHODS.pullRequestsList,
      WS_METHODS.subscribeServerConfig,
      WS_METHODS.scheduledTasksList,
      WS_METHODS.serverGetMaintenanceStatus,
    ]) {
      expect(rpcMethodNeedsWorkAdmission(method), method).toBe(false);
    }
  });

  it("never queues the methods that observe, advance, or recover a transaction behind its own fence", () => {
    for (const method of [
      WS_METHODS.serverUpdateMaintenancePolicy,
      WS_METHODS.serverRunMaintenanceAction,
      WS_METHODS.serverRecoverMaintenance,
      WS_METHODS.serverUpdateServer,
      WS_METHODS.serverCommitDesktopUpdate,
    ]) {
      expect(rpcMethodNeedsWorkAdmission(method), method).toBe(false);
    }
  });

  it("derives admission from the scope table, so every declared method has a decision and new writes are covered by default", () => {
    const writes = Object.keys(RPC_REQUIRED_SCOPES).filter((method) =>
      rpcMethodNeedsWorkAdmission(method),
    );
    expect(writes.length).toBeGreaterThan(60);
    expect(() => rpcMethodNeedsWorkAdmission("not.a.method")).toThrow(
      "no declared authorization scope",
    );
  });

  it("requires destructive recovery to carry device administration authority, not ordinary operation", () => {
    expect(RPC_REQUIRED_SCOPES[WS_METHODS.serverRecoverMaintenance]).toBe("access:write");
    expect(RPC_REQUIRED_SCOPES[WS_METHODS.serverRunMaintenanceAction]).toBe(
      "orchestration:operate",
    );
    expect(RPC_REQUIRED_SCOPES[WS_METHODS.serverGetMaintenanceStatus]).toBe("orchestration:read");
  });

  it("treats lifting a safety hold as administration, but check, install and cancel as ordinary operation", () => {
    expect(maintenanceActionNeedsAdministration({ action: "confirm-bootstrap" })).toBe(true);
    expect(maintenanceActionNeedsAdministration({ action: "acknowledge-automation-review" })).toBe(
      true,
    );
    for (const input of [
      { action: "check" },
      { action: "install", targetArtifactSha256: "a" },
      { action: "cancel-countdown" },
    ] as const) {
      expect(maintenanceActionNeedsAdministration(input), input.action).toBe(false);
    }
  });
});
