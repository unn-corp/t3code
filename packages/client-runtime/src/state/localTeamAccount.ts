import type {
  LocalTeamAccountState,
  LocalTeamAccountDisconnect,
  LocalTeamAccountProjects,
  LocalTeamDirectory,
  LocalTeamRosterResult,
  TeamRosterCommand,
} from "@t3tools/contracts/teamSpaces";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

export type LocalTeamAccountAction =
  | { readonly action: "state"; readonly signal?: AbortSignal }
  | { readonly action: "projects"; readonly signal?: AbortSignal }
  | { readonly action: "teamDirectory"; readonly signal?: AbortSignal }
  | {
      readonly action: "teamCommand";
      readonly generation: string;
      readonly command: TeamRosterCommand;
    }
  | { readonly action: "start"; readonly serviceUrl: string }
  | { readonly action: "cancel"; readonly flowId: string }
  | { readonly action: "disconnect" };

export type LocalTeamAccountResult =
  | { readonly action: "state"; readonly state: LocalTeamAccountState }
  | ({ readonly action: "disconnect" } & typeof LocalTeamAccountDisconnect.Type)
  | ({ readonly action: "projects" } & typeof LocalTeamAccountProjects.Type)
  | ({ readonly action: "teamDirectory" } & typeof LocalTeamDirectory.Type)
  | ({ readonly action: "teamCommand" } & typeof LocalTeamRosterResult.Type);

/** Teams credentials stay on the target T3 environment. Only its personal auth is used here. */
export const requestLocalTeamAccount = Effect.fn("requestLocalTeamAccount")(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly command: LocalTeamAccountAction;
}) {
  const command = input.command;
  const path =
    command.action === "projects"
      ? "/api/teams/projects"
      : command.action === "teamDirectory"
        ? "/api/teams/team-directory"
        : command.action === "teamCommand"
          ? "/api/teams/team-command"
          : `/api/teams/account${command.action === "state" ? "" : `/${command.action}`}`;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "teams",
    method:
      command.action === "state" ||
      command.action === "projects" ||
      command.action === "teamDirectory"
        ? "GET"
        : "POST",
    url: (base) => new URL(path, base).href,
    timeoutMs: 45000,
    request: ({ client, headers }) => {
      switch (command.action) {
        case "teamDirectory":
          return client.teamDirectory({ headers }).pipe(
            Effect.map((result): LocalTeamAccountResult => ({
              action: "teamDirectory",
              ...result,
            })),
          );
        case "teamCommand":
          return client
            .teamCommand({
              headers,
              payload: { generation: command.generation, command: command.command },
            })
            .pipe(
              Effect.map((result): LocalTeamAccountResult => ({
                action: "teamCommand",
                ...result,
              })),
            );
        case "state":
          return client
            .state({ headers })
            .pipe(
              Effect.map((state): LocalTeamAccountResult => ({ action: "state" as const, state })),
            );
        case "start":
          return client
            .start({ headers, payload: { serviceUrl: command.serviceUrl } })
            .pipe(
              Effect.map((state): LocalTeamAccountResult => ({ action: "state" as const, state })),
            );
        case "cancel":
          return client
            .cancel({ headers, payload: { flowId: command.flowId } })
            .pipe(
              Effect.map((state): LocalTeamAccountResult => ({ action: "state" as const, state })),
            );
        case "disconnect":
          return client.disconnect({ headers }).pipe(
            Effect.map((result): LocalTeamAccountResult => ({
              action: "disconnect" as const,
              ...result,
            })),
          );
        case "projects":
          return client.projects({ headers }).pipe(
            Effect.map((result): LocalTeamAccountResult => ({
              action: "projects" as const,
              ...result,
            })),
          );
      }
    },
  });
});

export const executeLocalTeamAccountCommand = Effect.fn("executeLocalTeamAccountCommand")(
  function* (command: LocalTeamAccountAction) {
    const supervisor = yield* EnvironmentSupervisor;
    const prepared =
      command.action === "state"
        ? yield* SubscriptionRef.changes(supervisor.prepared).pipe(
            Stream.filter(Option.isSome),
            Stream.map((value) => value.value),
            Stream.runHead,
            Effect.timeoutOrElse({
              duration: "45 seconds",
              orElse: () => Effect.succeed(Option.none<PreparedConnection>()),
            }),
          )
        : yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared))
      return yield* new RemoteEnvironmentAuthFetchError({
        message: "Connect to this T3 environment first.",
        cause: null,
      });
    return yield* requestLocalTeamAccount({
      prepared: prepared.value,
      signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
      command,
    });
  },
  (effect, command) => {
    const signal = "signal" in command ? command.signal : undefined;
    if (!signal) return effect;
    // A settings view may disappear before its selected environment finishes
    // preparing. Cancellation also releases the readiness subscription.
    return Effect.raceFirst(
      effect,
      Effect.callback<never>((resume) => {
        if (signal.aborted) {
          resume(Effect.interrupt);
          return;
        }
        const abort = () => resume(Effect.interrupt);
        signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      }),
    );
  },
);

export function createLocalTeamAccountCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "Teams account",
    execute: executeLocalTeamAccountCommand,
  });
}
