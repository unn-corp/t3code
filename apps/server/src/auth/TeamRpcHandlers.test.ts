// @effect-diagnostics nodeBuiltinImport:off - execute the real personal RPC handler table with isolated service effects.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import {
  LOCAL_TEAM_METHODS,
  LOCAL_TEAM_DIRECTORY_METHOD,
  LOCAL_TEAM_MEMBERS_METHOD,
  LOCAL_TEAM_ACCEPT_METHOD,
} from "@t3tools/contracts/teamProjects";
import {
  LOCAL_TEAM_FILES_METHOD,
  LOCAL_TEAM_FILES_STATE_METHOD,
} from "@t3tools/contracts/teamFiles";
import { LOCAL_PRESENCE_WS_METHODS } from "@t3tools/contracts/teamPresence";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

const source = NodeFS.readFileSync(new URL("../ws.ts", import.meta.url), "utf8");
const start = source.indexOf("        [LOCAL_TEAM_FILES_METHOD]: (input) =>");
const end = source.indexOf(
  "        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>",
  start,
);
if (start < 0 || end < 0) throw new Error("Native personal RPC handlers were not found.");
const handlerSource = source.slice(start, end);
const boundaryStart = source.indexOf("      const authorizationError =");
const boundaryEnd = source.indexOf("      const toDispatchCommandError =", boundaryStart);
if (boundaryStart < 0 || boundaryEnd < 0)
  throw new Error("Personal RPC authorization boundary was not found.");
const boundarySource = NodeModule.stripTypeScriptTypes(source.slice(boundaryStart, boundaryEnd));

const makeHandlers = (scopes: readonly string[], calls: string[]) => {
  const effect = (name: string) =>
    Effect.sync(() => {
      calls.push(name);
      return { state: null };
    });
  const localTeams = {
    filesControl: () => effect("filesControl"),
    heartbeat: () => effect("heartbeat"),
    directory: () => effect("directory"),
    membership: () => effect("membership"),
    acceptInvitation: () => effect("acceptInvitation"),
    control: () => effect("control"),
    snapshot: () => effect("snapshot"),
    discuss: () => effect("discuss"),
    state: effect("state"),
    subscribeState: Stream.fromEffect(effect("subscribeState")),
    subscribePresence: () => Stream.fromEffect(effect("subscribePresence")),
    subscribeProject: () => Stream.fromEffect(effect("subscribeProject")),
    subscribeThread: () => Stream.fromEffect(effect("subscribeThread")),
  };
  const boundary = new Function(
    "currentSession",
    "EnvironmentAuthorizationError",
    "Effect",
    "Stream",
    "requiredScopeForRpcMethod",
    "instrumentRpcEffect",
    "instrumentRpcStream",
    "instrumentRpcStreamEffect",
    `${boundarySource}
return {observeRpcEffect,observeRpcStream};`,
  )(
    { scopes },
    EnvironmentAuthorizationError,
    Effect,
    Stream,
    requiredScopeForRpcMethod,
    (_method: string, operation: unknown) => operation,
    (_method: string, operation: unknown) => operation,
    (_method: string, operation: unknown) => operation,
  ) as {
    observeRpcEffect: (
      method: string,
      operation: Effect.Effect<unknown>,
      trace?: unknown,
      payload?: unknown,
    ) => Effect.Effect<unknown, EnvironmentAuthorizationError>;
    observeRpcStream: (
      method: string,
      stream: Stream.Stream<unknown>,
    ) => Stream.Stream<unknown, EnvironmentAuthorizationError>;
  };
  // Execute the actual table and scope boundary; only tracing and service effects are replaced.
  return new Function(
    "LOCAL_TEAM_FILES_METHOD",
    "LOCAL_TEAM_FILES_STATE_METHOD",
    "LOCAL_PRESENCE_WS_METHODS",
    "LOCAL_TEAM_DIRECTORY_METHOD",
    "LOCAL_TEAM_MEMBERS_METHOD",
    "LOCAL_TEAM_ACCEPT_METHOD",
    "LOCAL_TEAM_METHODS",
    "localTeams",
    "observeRpcEffect",
    "observeRpcStream",
    `return {${handlerSource}}`,
  )(
    LOCAL_TEAM_FILES_METHOD,
    LOCAL_TEAM_FILES_STATE_METHOD,
    LOCAL_PRESENCE_WS_METHODS,
    LOCAL_TEAM_DIRECTORY_METHOD,
    LOCAL_TEAM_MEMBERS_METHOD,
    LOCAL_TEAM_ACCEPT_METHOD,
    LOCAL_TEAM_METHODS,
    localTeams,
    boundary.observeRpcEffect,
    boundary.observeRpcStream,
  ) as Record<
    string,
    (
      input?: unknown,
    ) =>
      | Effect.Effect<unknown, EnvironmentAuthorizationError>
      | Stream.Stream<unknown, EnvironmentAuthorizationError>
  >;
};
const effectMethods = [
  LOCAL_TEAM_FILES_METHOD,
  LOCAL_TEAM_FILES_STATE_METHOD,
  LOCAL_PRESENCE_WS_METHODS.heartbeat,
  LOCAL_TEAM_DIRECTORY_METHOD,
  LOCAL_TEAM_MEMBERS_METHOD,
  LOCAL_TEAM_ACCEPT_METHOD,
  LOCAL_TEAM_METHODS.state,
  LOCAL_TEAM_METHODS.control,
  LOCAL_TEAM_METHODS.snapshot,
  LOCAL_TEAM_METHODS.discuss,
];
const streamMethods = [
  LOCAL_PRESENCE_WS_METHODS.subscribe,
  LOCAL_TEAM_METHODS.subscribeState,
  LOCAL_TEAM_METHODS.subscribeProject,
  LOCAL_TEAM_METHODS.subscribeThread,
];
const input = {
  action: "link",
  projectId: "project",
  threadId: "thread",
  command: {},
  generation: "current",
  token: "synthetic",
  focus: null,
};
const runEffect = (
  handlers: ReturnType<typeof makeHandlers>,
  method: string,
  payload: unknown = input,
) => handlers[method]!(payload) as Effect.Effect<unknown, EnvironmentAuthorizationError>;

it.effect("authorizes every actual native effect and stream before service effects", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const handlers = makeHandlers([], calls);
    for (const method of effectMethods) {
      const result = yield* runEffect(handlers, method).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.requiredScope).toBe(requiredScopeForRpcMethod(method));
    }
    for (const method of streamMethods) {
      const stream = handlers[method]!(input) as Stream.Stream<
        unknown,
        EnvironmentAuthorizationError
      >;
      const result = yield* Stream.runCollect(stream).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }
    expect(calls).toEqual([]);
    const authorized = makeHandlers(
      [AuthAccessReadScope, AuthAccessWriteScope, ...AuthStandardClientScopes],
      calls,
    );
    for (const method of effectMethods)
      expect((yield* runEffect(authorized, method).pipe(Effect.result))._tag).toBe("Success");
    for (const method of streamMethods)
      yield* Stream.runCollect(
        authorized[method]!(input) as Stream.Stream<unknown, EnvironmentAuthorizationError>,
      );
    expect(calls).toHaveLength(effectMethods.length + streamMethods.length);
  }),
);

it.effect(
  "permits standard conversation choices and publication without granting project administration",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const standard = makeHandlers(AuthStandardClientScopes, calls);
      for (const action of ["intent", "publish", "stop-publication"]) {
        for (const shared of [true, false])
          expect(
            (yield* runEffect(standard, LOCAL_TEAM_METHODS.control, {
              ...input,
              action,
              shared,
            }).pipe(Effect.result))._tag,
          ).toBe("Success");
      }
      const count = calls.length;
      for (const action of ["link", "unlink"])
        expect(
          (yield* runEffect(standard, LOCAL_TEAM_METHODS.control, { ...input, action }).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
      expect(calls).toHaveLength(count);
      const withoutScopes = makeHandlers([], calls);
      for (const shared of [true, false])
        expect(
          (yield* runEffect(withoutScopes, LOCAL_TEAM_METHODS.control, {
            ...input,
            action: "intent",
            shared,
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      expect(calls).toHaveLength(count);
      const reader = makeHandlers([AuthOrchestrationReadScope, AuthAccessReadScope], calls);
      for (const shared of [true, false])
        expect(
          (yield* runEffect(reader, LOCAL_TEAM_METHODS.control, {
            ...input,
            action: "intent",
            shared,
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      expect(calls).toHaveLength(count);
      expect(
        (yield* runEffect(reader, LOCAL_TEAM_FILES_STATE_METHOD).pipe(Effect.result))._tag,
      ).toBe("Success");
      expect((yield* runEffect(reader, LOCAL_TEAM_FILES_METHOD).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(calls).toHaveLength(count + 1);
    }),
);
