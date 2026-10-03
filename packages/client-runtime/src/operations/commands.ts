import { canExecuteTeamSource } from "../state/teamExecution.ts";
import type { TeamThreadSource } from "@t3tools/contracts/teamProjects";
import { LOCAL_TEAM_METHODS } from "@t3tools/contracts/teamProjects";
import {
  CommandId,
  OrchestrationDispatchCommandError,
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

type CommandType = ClientOrchestrationCommand["type"];
type CommandOf<T extends CommandType> = Extract<ClientOrchestrationCommand, { readonly type: T }>;
type CommandInput<T extends CommandType> = Omit<
  CommandOf<T>,
  "type" | "commandId" | "createdAt"
> & {
  readonly commandId?: CommandId;
  readonly teamSource?: TeamThreadSource;
} & ("createdAt" extends keyof CommandOf<T>
    ? {
        readonly createdAt?: CommandOf<T>["createdAt"];
      }
    : {});

export type CreateProjectInput = CommandInput<"project.create">;
export type UpdateProjectInput = CommandInput<"project.meta.update">;
export type DeleteProjectInput = CommandInput<"project.delete">;
export type TeamPublicationChoice = {
  readonly projectId: import("@t3tools/contracts").ProjectId;
  readonly generation: string;
  readonly shared: boolean;
};
export type CreateThreadInput = CommandInput<"thread.create"> & {
  readonly teamPublication?: TeamPublicationChoice;
};
export type DeleteThreadInput = CommandInput<"thread.delete">;
export type ArchiveThreadInput = CommandInput<"thread.archive">;
export type UnarchiveThreadInput = CommandInput<"thread.unarchive">;
export type SettleThreadInput = CommandInput<"thread.settle">;
export type UnsettleThreadInput = CommandInput<"thread.unsettle">;
export type SnoozeThreadInput = CommandInput<"thread.snooze">;
export type UnsnoozeThreadInput = CommandInput<"thread.unsnooze">;
export type PinThreadInput = CommandInput<"thread.pin">;
export type UnpinThreadInput = CommandInput<"thread.unpin">;
export type ReorderPinnedThreadInput = CommandInput<"thread.pin.reorder">;
export type SetThreadAutoSettleInput = CommandInput<"thread.auto-settle.set">;
export type ReorderActiveThreadInput = CommandInput<"thread.active.reorder">;
export type UpdateThreadMetadataInput = CommandInput<"thread.meta.update">;
export type LinkThreadPullRequestInput = CommandInput<"thread.pull-request.link">;
export type UnlinkThreadPullRequestInput = CommandInput<"thread.pull-request.unlink">;
export type SetThreadRuntimeModeInput = CommandInput<"thread.runtime-mode.set">;
export type SetThreadInteractionModeInput = CommandInput<"thread.interaction-mode.set">;
export type StartThreadTurnInput = CommandInput<"thread.turn.start"> & {
  readonly teamPublication?: TeamPublicationChoice;
};
export type InterruptThreadTurnInput = CommandInput<"thread.turn.interrupt">;
export type RespondToThreadApprovalInput = CommandInput<"thread.approval.respond">;
export type RespondToThreadUserInputInput = CommandInput<"thread.user-input.respond">;
export type DismissThreadUserInputInput = CommandInput<"thread.user-input.dismiss">;
export type RevertThreadCheckpointInput = CommandInput<"thread.checkpoint.revert"> & {
  readonly restoreFiles?: boolean;
};
export type StopThreadSessionInput = CommandInput<"thread.session.stop">;

export type CreateSideThreadInput = CommandInput<"sidethread.create">;
export type PostSideThreadMessageInput = CommandInput<"sidethread.message.post">;
export type ReactToSideThreadMessageInput = CommandInput<"sidethread.message.react">;
export type EditSideThreadMessageInput = CommandInput<"sidethread.message.edit">;
export type MarkSideThreadReadInput = CommandInput<"sidethread.mark-read">;
export type ArchiveSideThreadInput = CommandInput<"sidethread.archive">;
export type UnarchiveSideThreadInput = CommandInput<"sidethread.unarchive">;

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;
type CommandEffect = Effect.Effect<
  EnvironmentRpcSuccess<DispatchTag>,
  EnvironmentRpcFailure<DispatchTag> | EnvironmentRpcUnavailableError,
  Crypto.Crypto | EnvironmentSupervisor
>;

function commandId(input: { readonly commandId?: CommandId }) {
  return Effect.gen(function* () {
    if (input.commandId !== undefined) {
      return input.commandId;
    }
    const crypto = yield* Crypto.Crypto;
    return yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make));
  });
}

function timestampedCommandMetadata(input: {
  readonly commandId?: CommandId;
  readonly createdAt?: string;
}) {
  return Effect.all({
    commandId: commandId(input),
    createdAt:
      input.createdAt === undefined
        ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
        : Effect.succeed(input.createdAt),
  });
}

function dispatch(
  command: ClientOrchestrationCommand & { readonly teamSource?: TeamThreadSource },
) {
  const { teamSource, ...localCommand } = command;
  if (
    teamSource &&
    (!("threadId" in localCommand) || !canExecuteTeamSource(teamSource, localCommand.threadId))
  )
    return Effect.fail(
      new OrchestrationDispatchCommandError({
        message:
          "This shared conversation is read-only. Continue with your own agent in a local thread.",
      }),
    );
  return request(ORCHESTRATION_WS_METHODS.dispatchCommand, localCommand);
}

const saveNewThreadSharing = Effect.fn("EnvironmentCommands.saveNewThreadSharing")(
  function* (input: {
    readonly commandId: import("@t3tools/contracts").CommandId;
    readonly threadId: import("@t3tools/contracts").ThreadId;
    readonly projectId: import("@t3tools/contracts").ProjectId;
    readonly worktreePath: string | null;
    readonly teamSource?: TeamThreadSource;
    readonly teamPublication?: TeamPublicationChoice;
  }) {
    if (input.teamSource && !canExecuteTeamSource(input.teamSource, input.threadId))
      return yield* new OrchestrationDispatchCommandError({
        message: "Shared conversations cannot run local agent commands.",
      });
    let choice = input.teamPublication;
    if (!choice) {
      const projects = yield* request(LOCAL_TEAM_METHODS.state, {});
      const link = projects.find((project) => project.link.projectId === input.projectId)?.link;
      if (link)
        choice = {
          projectId: link.projectId,
          generation: link.generation,
          shared: input.worktreePath === null,
        };
    }
    if (choice && input.worktreePath !== null) choice = { ...choice, shared: false };
    if (choice)
      yield* request(LOCAL_TEAM_METHODS.control, {
        action: "intent",
        commandId: input.commandId,
        threadId: input.threadId,
        ...choice,
      });
  },
  (effect) =>
    effect.pipe(
      Effect.mapError(
        () =>
          new OrchestrationDispatchCommandError({
            message:
              "Could not save the shared conversation choice. Refresh your Teams connection before starting work.",
          }),
      ),
    ),
);

export const createProject: (input: CreateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createProject",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "project.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const updateProject: (input: UpdateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.meta.update",
    commandId: yield* commandId(input),
  });
});

export const deleteProject: (input: DeleteProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.delete",
    commandId: yield* commandId(input),
  });
});

export const createThread: (input: CreateThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createThread",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  yield* saveNewThreadSharing({ ...input, commandId: metadata.commandId });
  const { teamPublication: _teamPublication, ...localInput } = input;
  return yield* dispatch({
    ...localInput,
    type: "thread.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const deleteThread: (input: DeleteThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.delete",
    commandId: yield* commandId(input),
  });
});

export const archiveThread: (input: ArchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.archiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.archive",
    commandId: yield* commandId(input),
  });
});

export const unarchiveThread: (input: UnarchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unarchiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unarchive",
    commandId: yield* commandId(input),
  });
});

export const settleThread: (input: SettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.settleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.settle",
    commandId: yield* commandId(input),
  });
});

export const unsettleThread: (input: UnsettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsettleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsettle",
    commandId: yield* commandId(input),
  });
});

export const snoozeThread: (input: SnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.snoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.snooze",
    commandId: yield* commandId(input),
  });
});

export const unsnoozeThread: (input: UnsnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsnoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsnooze",
    commandId: yield* commandId(input),
  });
});

export const pinThread: (input: PinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.pinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin",
    commandId: yield* commandId(input),
  });
});

export const unpinThread: (input: UnpinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unpinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unpin",
    commandId: yield* commandId(input),
  });
});

export const setThreadAutoSettle: (input: SetThreadAutoSettleInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setThreadAutoSettle",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.auto-settle.set",
    commandId: yield* commandId(input),
  });
});

export const reorderPinnedThread: (input: ReorderPinnedThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderPinnedThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin.reorder",
    commandId: yield* commandId(input),
  });
});

export const reorderActiveThread: (input: ReorderActiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderActiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.active.reorder",
    commandId: yield* commandId(input),
  });
});

export const updateThreadMetadata: (input: UpdateThreadMetadataInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateThreadMetadata",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.meta.update",
    commandId: yield* commandId(input),
  });
});

export const linkThreadPullRequest: (input: LinkThreadPullRequestInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.linkThreadPullRequest")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "thread.pull-request.link",
      commandId: yield* commandId(input),
    });
  });

export const unlinkThreadPullRequest: (input: UnlinkThreadPullRequestInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.unlinkThreadPullRequest")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "thread.pull-request.unlink",
      commandId: yield* commandId(input),
    });
  });

export const setThreadRuntimeMode: (input: SetThreadRuntimeModeInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setThreadRuntimeMode",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.runtime-mode.set",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const setThreadInteractionMode: (input: SetThreadInteractionModeInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.setThreadInteractionMode")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.interaction-mode.set",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const startThreadTurn: (input: StartThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.startThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  const { teamPublication, ...localInput } = input;
  if (input.bootstrap?.createThread)
    yield* saveNewThreadSharing({
      commandId: metadata.commandId,
      threadId: input.threadId,
      projectId: input.bootstrap.createThread.projectId,
      worktreePath: input.bootstrap.prepareWorktree
        ? "pending-worktree"
        : input.bootstrap.createThread.worktreePath,
      ...(input.teamSource ? { teamSource: input.teamSource } : {}),
      ...(teamPublication ? { teamPublication } : {}),
    });
  return yield* dispatch({
    ...localInput,
    type: "thread.turn.start",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const interruptThreadTurn: (input: InterruptThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.interruptThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.interrupt",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const respondToThreadApproval: (input: RespondToThreadApprovalInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadApproval")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.approval.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const respondToThreadUserInput: (input: RespondToThreadUserInputInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadUserInput")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.user-input.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const dismissThreadUserInput: (input: DismissThreadUserInputInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.dismissThreadUserInput")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.user-input.dismiss",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const revertThreadCheckpoint: (input: RevertThreadCheckpointInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.revertThreadCheckpoint")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    const { restoreFiles, ...command } = input;
    return yield* dispatch({
      ...command,
      type: restoreFiles === false ? "thread.conversation.revert" : "thread.checkpoint.revert",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const stopThreadSession: (input: StopThreadSessionInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.stopThreadSession",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.session.stop",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const createSideThread: (input: CreateSideThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createSideThread",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "sidethread.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const postSideThreadMessage: (input: PostSideThreadMessageInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.postSideThreadMessage")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "sidethread.message.post",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const reactToSideThreadMessage: (input: ReactToSideThreadMessageInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.reactToSideThreadMessage")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "sidethread.message.react",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const editSideThreadMessage: (input: EditSideThreadMessageInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.editSideThreadMessage")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "sidethread.message.edit",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const markSideThreadRead: (input: MarkSideThreadReadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.markSideThreadRead",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "sidethread.mark-read",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const archiveSideThread: (input: ArchiveSideThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.archiveSideThread",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "sidethread.archive",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const unarchiveSideThread: (input: UnarchiveSideThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unarchiveSideThread",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "sidethread.unarchive",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});
