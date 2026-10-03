import { make as makePresence } from "./TeamPresence.ts";
import type { PresenceHeartbeatInput } from "@t3tools/contracts/teamPresence";
import { AuthSessionId } from "@t3tools/contracts";
import * as Semaphore from "effect/Semaphore";
import * as PubSub from "effect/PubSub";
import { makeTeamRepository } from "./TeamRepository.ts";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  OrchestrationCommand,
  DEFAULT_SERVER_SETTINGS,
  ClientOrchestrationCommand,
  type CollaborationUser,
  type ServerConfig as WireServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { APP_VERSION } from "../appVersion.ts";
import { ServerConfig, deriveServerPaths } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TeamDenied, TeamSpaces } from "./TeamSpaces.ts";
import type { TeamPrincipal } from "./TeamAuthentication.ts";
import { makeTeamPublications } from "./TeamPublications.ts";

const denied = (reason = "project_access_denied") => new TeamDenied({ reason });
const projectPattern = /^[a-f0-9]{32}$/;
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const encodeClientCommand = Schema.encodeEffect(Schema.fromJsonString(ClientOrchestrationCommand));
const makeRuntime = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const sql = yield* SqlClient.SqlClient;
  const requireThread = Effect.fn("TeamNative.requireThread")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    allowArchived = false,
  ) {
    const rows = yield* sql<{ projectId: string; archivedAt: string | null }>`
      SELECT project_id AS "projectId",archived_at AS "archivedAt"
      FROM projection_threads WHERE thread_id=${threadId} AND deleted_at IS NULL`;
    if (rows[0]?.projectId !== projectId || (!allowArchived && rows[0].archivedAt !== null))
      return yield* denied();
  });
  const requireMessage = Effect.fn("TeamNative.requireMessage")(function* (
    threadId: ThreadId,
    messageId: string,
  ) {
    const rows =
      yield* sql`SELECT 1 FROM projection_thread_messages WHERE thread_id=${threadId} AND message_id=${messageId} LIMIT 1`;
    if (!rows.length) return yield* denied();
  });
  const requireDiscussionMessage = Effect.fn("TeamNative.requireDiscussionMessage")(function* (
    threadId: ThreadId,
    messageId: string,
    author?: string,
  ) {
    const rows = yield* sql<{
      author: string;
    }>`SELECT json_extract(message.value,'$.author.subject') AS author
      FROM projection_thread_discussions discussion, json_each(discussion.side_threads_json) side,
        json_each(side.value,'$.messages') message
      WHERE discussion.thread_id=${threadId} AND json_extract(side.value,'$.id')=${sideThreadIdForThread(threadId)}
        AND json_extract(message.value,'$.id')=${messageId} LIMIT 1`;
    if (!rows[0] || (author !== undefined && rows[0].author !== author)) return yield* denied();
  });
  return {
    engine,
    query,
    sql,
    requireThread,
    requireMessage,
    requireDiscussionMessage,
    fileChanges: yield* PubSub.sliding<number>(1),
    presence: yield* makePresence(),
  };
});
class NativeProjectRuntime extends Context.Service<
  NativeProjectRuntime,
  Effect.Success<typeof makeRuntime>
>()("t3/team/TeamNativeProjects/NativeProjectRuntime") {}

export const makeTeamNativeProjects = Effect.gen(function* () {
  const spaces = yield* TeamSpaces;
  const transfers = yield* Semaphore.make(2);
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(config.stateDir, "team-native");
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
  yield* fs.chmod(root, 0o700);
  const serviceIdPath = path.join(root, "service-id");
  if (!(yield* fs.exists(serviceIdPath)))
    yield* fs.writeFileString(serviceIdPath, NodeCrypto.randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
  const serviceId = (yield* fs.readFileString(serviceIdPath)).trim();
  const runtimes = yield* LayerMap.make(
    (spaceId: string) =>
      Layer.unwrap(
        Effect.gen(function* () {
          const project = yield* spaces.project(spaceId);
          const baseDir = path.join(root, spaceId);
          yield* fs.makeDirectory(baseDir, { recursive: true, mode: 0o700 });
          yield* fs.chmod(baseDir, 0o700);
          const paths = yield* deriveServerPaths(baseDir, undefined);
          const nativeConfig = Layer.succeed(ServerConfig, {
            ...config,
            ...paths,
            baseDir,
            cwd: "/workspace",
          });
          // Fresh is essential: LayerMap shares its memo map across keys, while the
          // orchestration layer constants must bind to a different database per space.
          return Layer.effect(
            NativeProjectRuntime,
            Effect.gen(function* () {
              const runtime = yield* makeRuntime;
              yield* runtime.engine.dispatch(
                {
                  type: "project.create",
                  commandId: CommandId.make(`team-project:${spaceId}`),
                  projectId: ProjectId.make(spaceId),
                  title: project.name,
                  workspaceRoot: "/workspace",
                  createdAt: DateTime.formatIso(DateTime.makeUnsafe(project.createdAt)),
                },
                {
                  collaborationUser: {
                    subject: project.creator,
                    displayName: project.creator.slice(0, 200),
                  },
                },
              );
              return runtime;
            }),
          ).pipe(
            Layer.provide(OrchestrationLayerLive),
            Layer.provideMerge(makeSqlitePersistenceLive(paths.dbPath)),
            Layer.provide(nativeConfig),
            Layer.provide(
              Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
            ),
            Layer.fresh,
          );
        }),
      ),
    { idleTimeToLive: "30 seconds" },
  );

  const open = Effect.fn("TeamNativeProjects.open")(function* (spaceId: string) {
    if (!projectPattern.test(spaceId)) return yield* denied();
    return Context.get(yield* runtimes.contextEffect(spaceId), NativeProjectRuntime);
  });
  const connect = Effect.fn("TeamNativeProjects.connect")(function* (
    identity: TeamPrincipal,
    spaceId: string,
    resolveUser: (subject: string) => Effect.Effect<CollaborationUser>,
  ) {
    if (!projectPattern.test(spaceId)) return yield* denied();
    const version = spaces.accessVersion(spaceId, identity.userId);
    let dropPresence: Effect.Effect<void> = Effect.void;
    const check = Effect.fn("TeamNativeProjects.check")(
      function* (write = false) {
        if (identity.expiresAt <= (yield* Clock.currentTimeMillis))
          return yield* denied("session_expired");
        if (version !== spaces.accessVersion(spaceId, identity.userId)) return yield* denied();
        return yield* spaces.requireRole(identity.userId, spaceId, write);
      },
      (effect, _write?: boolean) => effect.pipe(Effect.tapError(() => dropPresence)),
    );
    yield* check();
    const runtime = yield* open(spaceId);
    const project = yield* spaces.project(spaceId);
    const projectId = ProjectId.make(spaceId);
    const member = { subject: identity.userId, displayName: identity.displayName };
    const connectionId = NodeCrypto.randomUUID();
    dropPresence = runtime.presence.drop(connectionId);
    yield* Effect.addFinalizer(() => runtime.presence.drop(connectionId));
    const heartbeat = (focus: PresenceHeartbeatInput) =>
      Effect.gen(function* () {
        yield* check();
        if (focus.threadId !== null) yield* runtime.requireThread(projectId, focus.threadId);
        return yield* runtime.presence.touch({
          connectionId,
          sessionId: AuthSessionId.make(identity.userId),
          user: member,
          focus,
        });
      });
    const wireConfig = Effect.gen(function* () {
      const role = yield* check();
      return {
        teamProject: {
          agentExecution: "local",
          projectId,
          member,
          role,
          capabilities: {
            threads: role !== "viewer",
            discussion: role !== "viewer",
            execution: false,
            attachments: false,
          },
        },
        environment: {
          environmentId: EnvironmentId.make(
            NodeCrypto.createHash("sha256")
              .update(`${serviceId}:${spaceId}:${identity.userId}`)
              .digest("hex"),
          ),
          label: project.name,
          platform: { os: "unknown", arch: "other", machine: "cloud" },
          serverVersion: APP_VERSION,
          capabilities: {
            repositoryIdentity: false,
            connectionProbe: true,
            attachmentUploads: false,
            questionAttachments: false,
          },
        },
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "team-session-unused",
        },
        cwd: "/workspace",
        keybindingsConfigPath: "/unavailable",
        keybindings: [],
        issues: [],
        providers: [],
        availableEditors: [],
        remoteOpenTargets: [],
        observability: {
          logsDirectoryPath: "/unavailable",
          localTracingEnabled: false,
          otlpTracesEnabled: false,
          otlpMetricsEnabled: false,
          otlpLogsEnabled: false,
        },
        settings: DEFAULT_SERVER_SETTINGS,
        shellResumeCompletionMarker: true,
        threadResumeCompletionMarker: true,
        threadSnapshotPagination: true,
      } satisfies WireServerConfig;
    });
    const dispatchAuthorized = Effect.fn("TeamNativeProjects.dispatchAuthorized")(
      function* (input: ClientOrchestrationCommand) {
        yield* check(input.type !== "sidethread.mark-read");
        if (input.commandId.startsWith("publication:")) return yield* denied("reserved_command_id");
        if (Buffer.byteLength(yield* encodeClientCommand(input)) > 32768)
          return yield* denied("command_too_large");
        const now = DateTime.formatIso(yield* DateTime.now);
        if (
          (input.type === "thread.meta.update" ||
            input.type === "thread.archive" ||
            input.type === "thread.unarchive") &&
          input.threadId.startsWith("shared:")
        )
          return yield* denied("publication_capability_required");
        switch (input.type) {
          case "thread.create":
            if (
              input.projectId !== projectId ||
              input.threadId.startsWith("shared:") ||
              input.branch !== null ||
              input.worktreePath !== null ||
              input.historyImport
            )
              return yield* denied("command_not_supported");
            break;
          case "thread.meta.update":
            if (
              input.title === undefined ||
              input.regenerateTitle !== undefined ||
              input.branch !== undefined ||
              input.expectedBranch !== undefined ||
              input.worktreePath !== undefined ||
              input.modelSelection !== undefined ||
              input.linkedPullRequest !== undefined
            )
              return yield* denied("command_not_supported");
            break;
          case "thread.archive":
          case "thread.unarchive":
          case "sidethread.create":
          case "sidethread.message.post":
          case "sidethread.message.edit":
          case "sidethread.message.react":
          case "sidethread.mark-read":
          case "sidethread.archive":
          case "sidethread.unarchive":
            break;
          default:
            return yield* denied("command_not_supported");
        }
        if (
          input.threadId.length > 256 ||
          ("title" in input && input.title !== undefined && input.title.length > 500)
        )
          return yield* denied("invalid_command");
        if (input.type !== "thread.create")
          yield* runtime.requireThread(
            projectId,
            input.threadId,
            input.type === "thread.unarchive" || input.type === "thread.archive",
          );
        if ("sideThreadId" in input && input.sideThreadId !== sideThreadIdForThread(input.threadId))
          return yield* denied();
        if (input.type === "sidethread.create" && input.anchorMessageId)
          yield* runtime.requireMessage(input.threadId, input.anchorMessageId);
        if (input.type === "sidethread.message.react" || input.type === "sidethread.message.edit")
          yield* runtime.requireDiscussionMessage(
            input.threadId,
            input.messageId,
            input.type === "sidethread.message.edit" ? member.subject : undefined,
          );
        const command = input;
        if (command.type === "sidethread.message.post") {
          if (command.attachments?.length) return yield* denied("attachments_not_supported");
          if (command.linkedRef)
            yield* runtime.requireThread(projectId, command.linkedRef.threadId);
          if (command.quotedMessageId)
            yield* runtime.requireMessage(command.threadId, command.quotedMessageId);
          if (command.replyToSideThreadMessageId)
            yield* runtime.requireDiscussionMessage(
              command.threadId,
              command.replyToSideThreadMessageId,
            );
          for (const mention of command.mentions ?? [])
            yield* spaces.requireRole(mention.subject, spaceId);
        }
        const normalized = yield* decodeCommand({
          ...command,
          ...("createdAt" in command ? { createdAt: now } : {}),
          ...(command.type === "sidethread.mark-read"
            ? { lastReadAt: command.lastReadAt > now ? now : command.lastReadAt }
            : {}),
        });
        // The permit remains held until the authoritative engine receipt arrives,
        // including when a disconnected client interrupts its request.
        yield* check(input.type !== "sidethread.mark-read");
        return yield* runtime.engine.dispatch(normalized, { collaborationUser: member });
      },
      spaces.withAuthority,
      Effect.uninterruptible,
    );
    const dispatch = Effect.fn("TeamNativeProjects.dispatch")(function* (
      input: ClientOrchestrationCommand,
    ) {
      if (input.type !== "sidethread.message.post") return yield* dispatchAuthorized(input);
      yield* check(true);
      // Profile lookups never hold the membership gate. Target membership is
      // checked again under that gate immediately before the durable write.
      const mentions = yield* Effect.forEach(
        input.mentions ?? [],
        (mention) =>
          Effect.gen(function* () {
            yield* spaces.requireRole(mention.subject, spaceId);
            return yield* resolveUser(mention.subject);
          }),
        { concurrency: 4 },
      );
      return yield* dispatchAuthorized({ ...input, mentions });
    });
    const publications = yield* makeTeamPublications({
      projectId,
      member,
      engine: runtime.engine,
      check,
      withAuthority: spaces.withAuthority,
    }).pipe(Effect.provideService(SqlClient.SqlClient, runtime.sql));
    const repository = yield* makeTeamRepository({
      transfers,
      stateDir: config.stateDir,
      spaceId,
      subject: identity.userId,
      check,
      withAuthority: spaces.withAuthority,
      changes: runtime.fileChanges,
    }).pipe(Effect.provideService(SqlClient.SqlClient, runtime.sql));
    const directory = Effect.gen(function* () {
      yield* check();
      const snapshot = yield* spaces.snapshot(identity.userId, spaceId);
      const members = yield* Effect.forEach(
        snapshot.members,
        (entry) =>
          resolveUser(entry.userId).pipe(Effect.map((user) => ({ user, role: entry.role }))),
        { concurrency: 4 },
      );
      const canManageMembers = yield* spaces.canManageMembers(identity.userId, spaceId);
      const canInviteMembers = (yield* spaces.rosterRole(identity.userId)) === "owner";
      const roster = canManageMembers ? yield* spaces.roster : [];
      const availableMembers = yield* Effect.forEach(roster, (entry) => resolveUser(entry.userId), {
        concurrency: 4,
      });
      yield* check();
      if ((yield* spaces.canManageMembers(identity.userId, spaceId)) !== canManageMembers)
        return yield* denied();
      return {
        creatorId: (yield* spaces.project(spaceId)).creator,
        role: snapshot.role,
        members,
        invites: snapshot.invites,
        canManageMembers,
        canInviteMembers,
        availableMembers,
      };
    });
    return {
      ...runtime,
      directory,
      heartbeat,
      presence: runtime.presence.snapshots,
      projectId,
      spaceId,
      member,
      check,
      dispatch,
      wireConfig,
      publications,
      repository,
    };
  });
  return { connect };
});
export class TeamNativeProjects extends Context.Service<
  TeamNativeProjects,
  Effect.Success<typeof makeTeamNativeProjects>
>()("t3/team/TeamNativeProjects") {
  static readonly layer = Layer.effect(this, makeTeamNativeProjects);
}
export type TeamNativeConnection = Effect.Success<
  ReturnType<TeamNativeProjects["Service"]["connect"]>
>;
