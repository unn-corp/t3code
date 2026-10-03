import { LOCAL_PRESENCE_WS_METHODS } from "@t3tools/contracts/teamPresence";
import {
  LOCAL_TEAM_DIRECTORY_METHOD,
  LOCAL_TEAM_MEMBERS_METHOD,
  LOCAL_TEAM_ACCEPT_METHOD,
} from "@t3tools/contracts/teamProjects";
import {
  LOCAL_TEAM_METHODS,
  type TeamSharedProjectStreamItem,
  type TeamSharedThreadSummary,
  type TeamSharedThreadSnapshot,
  type TeamSharedThreadStreamItem,
} from "@t3tools/contracts/teamProjects";
import {
  LOCAL_TEAM_FILES_METHOD,
  LOCAL_TEAM_FILES_STATE_METHOD,
} from "@t3tools/contracts/teamFiles";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/unstable/reactivity";
import * as Stream from "effect/Stream";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Remote summaries remain read sources. They are never written into personal thread state. */
export function reduceSharedProject(
  threads: ReadonlyArray<TeamSharedThreadSummary>,
  item: TeamSharedProjectStreamItem,
): ReadonlyArray<TeamSharedThreadSummary> {
  switch (item.kind) {
    case "snapshot":
      return item.threads;
    case "thread-upserted": {
      const index = threads.findIndex((thread) => thread.id === item.thread.id);
      return index < 0
        ? [...threads, item.thread]
        : threads.map((thread, i) => (i === index ? item.thread : thread));
    }
    case "thread-removed":
      return threads.filter((thread) => thread.id !== item.threadId);
    case "synchronized":
      return threads;
  }
}

export interface SharedThreadReadState {
  readonly snapshot: TeamSharedThreadSnapshot | null;
  readonly refreshRevision: number;
}
export function reduceSharedThread(
  state: SharedThreadReadState,
  item: TeamSharedThreadStreamItem,
): SharedThreadReadState {
  if (item.kind === "snapshot") return { ...state, snapshot: item.snapshot };
  if (item.kind === "synchronized") return state;
  if (item.kind === "discussion-changed" || item.kind === "metadata-changed")
    return { ...state, refreshRevision: state.refreshRevision + 1 };
  if (!state.snapshot || item.sequence <= state.snapshot.snapshotSequence) return state;
  if (item.kind === "member-status")
    return {
      ...state,
      snapshot: { ...state.snapshot, snapshotSequence: item.sequence, memberStatus: item.status },
    };
  const previous = state.snapshot.messages.find((message) => message.id === item.message.id);
  const next =
    item.append && previous
      ? { ...item.message, text: previous.text + item.message.text }
      : item.message;
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      snapshotSequence: item.sequence,
      messages: previous
        ? state.snapshot.messages.map((message) => (message.id === next.id ? next : message))
        : [...state.snapshot.messages, next],
    },
  };
}

// Scope is local cache metadata, never a field sent to the cloud or personal RPC.
function partitionReads<Input, Result extends object>(
  create: () => (target: {
    readonly environmentId: import("@t3tools/contracts").EnvironmentId;
    readonly input: Input;
  }) => Result,
) {
  // Cache the atoms themselves. A weakly cached intermediate factory can be
  // collected while its atoms are still mounted, resetting every active read.
  const reads = Atom.family((key: string) => {
    const [, environmentId, input] = JSON.parse(key) as [
      string,
      import("@t3tools/contracts").EnvironmentId,
      Input,
    ];
    return create()({ environmentId, input });
  });
  return (target: {
    readonly environmentId: import("@t3tools/contracts").EnvironmentId;
    readonly input: Input;
    readonly sourceScope?: string;
  }) => reads(JSON.stringify([target.sourceScope ?? "", target.environmentId, target.input]));
}
export const sharedProjectSourceScope = (
  link: import("@t3tools/contracts/teamProjects").LocalTeamProjectLink,
) =>
  JSON.stringify([link.serviceUrl, link.sharedProjectId, link.subject, link.generation, link.id]);

export function createTeamProjectAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const state = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "Shared project links",
    tag: LOCAL_TEAM_METHODS.subscribeState,
    idleTtlMs: 0,
  });
  // Refreshing is the caller's responsibility so successful mutations can also refresh files.
  return {
    state,
    readState: createEnvironmentRpcCommand(runtime, {
      label: "Current shared project links",
      tag: LOCAL_TEAM_METHODS.state,
    }),
    readSnapshot: createEnvironmentRpcCommand(runtime, {
      label: "Current shared conversation",
      tag: LOCAL_TEAM_METHODS.snapshot,
    }),
    presence: partitionReads(() =>
      createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "Project presence",
        tag: LOCAL_PRESENCE_WS_METHODS.subscribe,
        idleTtlMs: 0,
      }),
    ),
    heartbeat: createEnvironmentRpcCommand(runtime, {
      label: "Project presence",
      tag: LOCAL_PRESENCE_WS_METHODS.heartbeat,
    }),
    directory: partitionReads(() =>
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "Project members",
        tag: LOCAL_TEAM_DIRECTORY_METHOD,
        staleTimeMs: 0,
        idleTtlMs: 0,
      }),
    ),
    membership: createEnvironmentRpcCommand(runtime, {
      label: "Project membership",
      tag: LOCAL_TEAM_MEMBERS_METHOD,
    }),
    accept: createEnvironmentRpcCommand(runtime, {
      label: "Accept project invitation",
      tag: LOCAL_TEAM_ACCEPT_METHOD,
    }),
    filesState: partitionReads(() =>
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "Shared files",
        tag: LOCAL_TEAM_FILES_STATE_METHOD,
        staleTimeMs: 0,
        idleTtlMs: 0,
        refreshIntervalMs: 5000,
      }),
    ),
    control: createEnvironmentRpcCommand(runtime, {
      label: "Shared project",
      tag: LOCAL_TEAM_METHODS.control,
    }),
    files: createEnvironmentRpcCommand(runtime, {
      label: "Shared project files",
      tag: LOCAL_TEAM_FILES_METHOD,
    }),
    discuss: createEnvironmentRpcCommand(runtime, {
      label: "Project discussion",
      tag: LOCAL_TEAM_METHODS.discuss,
    }),
    snapshot: partitionReads(() =>
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "Shared conversation",
        tag: LOCAL_TEAM_METHODS.snapshot,
        staleTimeMs: 0,
        idleTtlMs: 0,
      }),
    ),
    project: partitionReads(() =>
      createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "Shared conversations",
        tag: LOCAL_TEAM_METHODS.subscribeProject,
        idleTtlMs: 0,
        transform: (stream) =>
          stream.pipe(
            Stream.scan([] as ReadonlyArray<TeamSharedThreadSummary>, reduceSharedProject),
          ),
      }),
    ),
    thread: partitionReads(() =>
      createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "Shared conversation changes",
        tag: LOCAL_TEAM_METHODS.subscribeThread,
        idleTtlMs: 0,
        transform: (stream) =>
          stream.pipe(
            Stream.scan(
              { snapshot: null, refreshRevision: 0 } as SharedThreadReadState,
              reduceSharedThread,
            ),
          ),
      }),
    ),
  };
}

export const sharedProjectBoundaryKey = (
  link: import("@t3tools/contracts/teamProjects").LocalTeamProjectLink,
) => JSON.stringify([link.serviceUrl, link.sharedProjectId, link.subject]);
export interface SharedProjectVisibility {
  readonly preferred: string;
  readonly ownedThreadIds: ReadonlySet<string>;
}
export function createSharedProjectVisibilitySelector() {
  let previousKey = "";
  let previous: ReadonlyMap<string, SharedProjectVisibility> = new Map();
  return (
    links: ReadonlyArray<{
      readonly environmentId: import("@t3tools/contracts").EnvironmentId;
      readonly state: import("@t3tools/contracts/teamProjects").LocalTeamProjectState;
    }>,
    primary: import("@t3tools/contracts").EnvironmentId | null,
  ) => {
    const next = new Map<
      string,
      { preferred: string; environmentId: string; ownedThreadIds: Set<string> }
    >();
    for (const { environmentId, state } of links) {
      if (["account-changed", "access-revoked", "root-changed"].includes(state.link.status))
        continue;
      const key = sharedProjectBoundaryKey(state.link);
      const existing = next.get(key);
      const ownedThreadIds = existing?.ownedThreadIds ?? new Set<string>();
      for (const publication of state.publications)
        if (publication.sharedThreadId) ownedThreadIds.add(publication.sharedThreadId);
      if (!existing || environmentId === primary)
        next.set(key, {
          preferred: JSON.stringify([environmentId, state.link.projectId]),
          environmentId,
          ownedThreadIds,
        });
    }
    const identity = JSON.stringify(
      [...next].map(([key, entry]) => [key, entry.preferred, [...entry.ownedThreadIds].sort()]),
    );
    if (identity === previousKey) return previous;
    previousKey = identity;
    previous = next;
    return previous;
  };
}
