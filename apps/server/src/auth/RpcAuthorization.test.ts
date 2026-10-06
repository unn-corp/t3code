import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  AuthTerminalOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { MaintenanceWorkHeld, WorkAdmission } from "../maintenance/WorkAdmission.ts";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
  rpcMethodNeedsWorkAdmission,
  rpcScopeAuthorizationLayer,
} from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates ACP Registry discovery from provisioning", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverSearchAcpRegistry)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareAcpRegistryAgent)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverUninstallAcpRegistryManagedBinary)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverAcceptAcpRegistryUrlAuth)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverListAcpRegistrySessions)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverImportAcpRegistrySession)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverLogoutAcpRegistry)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsChecks)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect("checks each RPC's declared scope before its handler runs", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            rpcScopeAuthorizationLayer([AuthOrchestrationReadScope]),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationOperateScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not lease terminal or provider-auth observers, while writes retain a lease", () =>
    (() => {
      const log: string[] = [];
      let fenced = false;
      let wrote = false;
      const admission = {
        acquire: Effect.suspend(() =>
          fenced
            ? Effect.fail(new MaintenanceWorkHeld({ cause: "fenced" }))
            : Effect.sync(() => {
                log.push("acquire");
                return () => Effect.sync(() => void log.push("release"));
              }),
        ),
        acquirePassive: Effect.succeed(() => Effect.void),
        check: Effect.suspend(() =>
          fenced
            ? Effect.fail(new MaintenanceWorkHeld({ cause: "fenced" }))
            : Effect.sync(() => void log.push("check")),
        ),
      };
      return Effect.gen(function* () {
        const writeStarted = yield* Deferred.make<void>();
        const finishWrite = yield* Deferred.make<void>();
        const subscriptionMethods = [
          WS_METHODS.subscribeTerminalEvents,
          WS_METHODS.subscribeTerminalMetadata,
          WS_METHODS.previewAutomationConnect,
          WS_METHODS.providerAuthSubscribe,
          WS_METHODS.terminalWrite,
        ] as const;
        const subscriptionGroup = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (
              tag,
            ): tag is Exclude<
              keyof typeof RPC_REQUIRED_SCOPES,
              (typeof subscriptionMethods)[number]
            > => !(subscriptionMethods as ReadonlyArray<string>).includes(tag),
          ),
        );
        const eventSeen = yield* Deferred.make<void>();
        const metadataSeen = yield* Deferred.make<void>();
        const authSeen = yield* Deferred.make<void>();
        const hostConnected = yield* Deferred.make<void>();
        const client = yield* RpcTest.makeClient(subscriptionGroup).pipe(
          Effect.provide(
            Layer.mergeAll(
              subscriptionGroup.toLayerHandler(WS_METHODS.subscribeTerminalEvents, () =>
                Stream.concat(
                  Stream.succeed({
                    type: "output" as const,
                    threadId: "thread-1",
                    terminalId: "default",
                    data: "ready",
                  }).pipe(Stream.tap(() => Deferred.succeed(eventSeen, undefined))),
                  Stream.never,
                ),
              ),
              subscriptionGroup.toLayerHandler(WS_METHODS.subscribeTerminalMetadata, () =>
                Stream.concat(
                  Stream.succeed({
                    type: "remove" as const,
                    threadId: "thread-1",
                    terminalId: "default",
                  }).pipe(Stream.tap(() => Deferred.succeed(metadataSeen, undefined))),
                  Stream.never,
                ),
              ),
              subscriptionGroup.toLayerHandler(WS_METHODS.providerAuthSubscribe, () =>
                Stream.concat(
                  Stream.succeed({
                    instanceId: ProviderInstanceId.make("codex"),
                    phase: "idle" as const,
                    flowId: null,
                    authorizationUrl: null,
                    expiresAt: null,
                    message: null,
                  }).pipe(Stream.tap(() => Deferred.succeed(authSeen, undefined))),
                  Stream.never,
                ),
              ),
              subscriptionGroup.toLayerHandler(WS_METHODS.previewAutomationConnect, () =>
                Stream.concat(
                  Stream.succeed({
                    type: "connected" as const,
                    connectionId: "desktop-connection",
                  }).pipe(Stream.tap(() => Deferred.succeed(hostConnected, undefined))),
                  Stream.never,
                ),
              ),
              subscriptionGroup.toLayerHandler(WS_METHODS.terminalWrite, () =>
                Effect.gen(function* () {
                  wrote = true;
                  yield* Deferred.succeed(writeStarted, undefined);
                  yield* Deferred.await(finishWrite);
                }),
              ),
              rpcScopeAuthorizationLayer([AuthTerminalOperateScope, AuthOrchestrationOperateScope]),
            ),
          ),
        );

        const eventFiber = yield* Stream.runDrain(
          client[WS_METHODS.subscribeTerminalEvents]({}),
        ).pipe(Effect.forkChild);
        const metadataFiber = yield* Stream.runDrain(
          client[WS_METHODS.subscribeTerminalMetadata]({}),
        ).pipe(Effect.forkChild);
        const authFiber = yield* Stream.runDrain(
          client[WS_METHODS.providerAuthSubscribe]({
            instanceId: ProviderInstanceId.make("codex"),
          }),
        ).pipe(Effect.forkChild);
        const connectFiber = yield* Stream.runDrain(
          client[WS_METHODS.previewAutomationConnect]({
            clientId: "desktop-client",
            environmentId: EnvironmentId.make("desktop-environment"),
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(eventSeen);
        yield* Deferred.await(metadataSeen);
        yield* Deferred.await(authSeen);
        yield* Deferred.await(hostConnected);
        expect(rpcMethodNeedsWorkAdmission(WS_METHODS.subscribeTerminalEvents)).toBe(false);
        expect(rpcMethodNeedsWorkAdmission(WS_METHODS.subscribeTerminalMetadata)).toBe(false);
        expect(rpcMethodNeedsWorkAdmission(WS_METHODS.providerAuthSubscribe)).toBe(false);
        expect(rpcMethodNeedsWorkAdmission(WS_METHODS.previewAutomationConnect)).toBe(false);
        expect(log.filter((entry) => entry === "check")).toHaveLength(4);
        expect(log).not.toContain("acquire");

        const terminalWrite = yield* Effect.forkChild(
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hello\n",
          }),
        );
        yield* Deferred.await(writeStarted);
        expect(wrote).toBe(true);
        expect(rpcMethodNeedsWorkAdmission(WS_METHODS.terminalWrite)).toBe(true);
        expect(log).toEqual(["check", "check", "check", "check", "acquire"]);

        fenced = true;
        const denied = yield* Stream.runCollect(
          client[WS_METHODS.subscribeTerminalEvents]({}),
        ).pipe(Effect.flip);
        expect(denied).toMatchObject({ _tag: "ForkMaintenanceError" });
        const deniedAuth = yield* Stream.runCollect(
          client[WS_METHODS.providerAuthSubscribe]({
            instanceId: ProviderInstanceId.make("codex"),
          }),
        ).pipe(Effect.flip);
        expect(deniedAuth).toMatchObject({ _tag: "ForkMaintenanceError" });
        const deniedConnect = yield* Stream.runCollect(
          client[WS_METHODS.previewAutomationConnect]({
            clientId: "desktop-client",
            environmentId: EnvironmentId.make("desktop-environment"),
          }),
        ).pipe(Effect.flip);
        expect(deniedConnect).toMatchObject({ _tag: "ForkMaintenanceError" });
        const deniedWrite = yield* client[WS_METHODS.terminalWrite]({
          threadId: "thread-1",
          terminalId: "default",
          data: "echo blocked\n",
        }).pipe(Effect.flip);
        expect(deniedWrite).toMatchObject({ _tag: "ForkMaintenanceError" });
        yield* Deferred.succeed(finishWrite, undefined);
        yield* Fiber.join(terminalWrite);
        expect(log).toEqual(["check", "check", "check", "check", "acquire", "release"]);
        yield* Fiber.interrupt(eventFiber);
        yield* Fiber.interrupt(metadataFiber);
        yield* Fiber.interrupt(authFiber);
        yield* Fiber.interrupt(connectFiber);
      }).pipe(Effect.provideService(WorkAdmission, admission), Effect.scoped);
    })(),
  );
});
