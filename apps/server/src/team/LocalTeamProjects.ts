import type { PresenceHeartbeatInput } from "@t3tools/contracts/teamPresence";
// @effect-diagnostics nodeBuiltinImport:off - isolated checkout staging is a native filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import { CommandId } from "@t3tools/contracts";
import {
  TeamFileError,
  type LocalTeamFilesControl,
  type LocalTeamFilesResult,
} from "@t3tools/contracts/teamFiles";
import { makeLocalTeamFiles, fileIO, uploadRepository, openCheckout } from "./LocalTeamFiles.ts";
import {
  preflightRepository,
  checkedRoot,
  fileError,
  validateDestination,
  normalizeCheckoutDestination,
  restrictedGit,
  installCheckout,
} from "./TeamGit.ts";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import {
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationThreadDetailWindow,
} from "@t3tools/contracts";
import {
  LocalTeamProjectError,
  type LocalTeamProjectControl,
  type TeamMembershipCommand,
  type TeamSharedProjectStreamItem,
  type TeamSharedThreadStreamItem,
} from "@t3tools/contracts/teamProjects";
import { TeamPublicationError } from "@t3tools/contracts/teamPublication";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { LocalTeamAccount, LocalTeamAccountError } from "./LocalTeamAccount.ts";
import { LocalTeamProjectStore, type LocalTeamLinkRow } from "./LocalTeamProjectStore.ts";
import {
  TeamProjectTransport,
  localTeamError,
  type TeamProjectConnection,
  type TeamProjectCredential,
} from "./TeamProjectTransport.ts";
import {
  memberReportedStatus,
  sharedMessage,
  sharedSnapshot,
  sharedSummary,
} from "./TeamSharedView.ts";

const isTeamFileError = Schema.is(TeamFileError);
const isLocalProjectError = Schema.is(LocalTeamProjectError);
const isAccountError = Schema.is(LocalTeamAccountError);
const isPublicationError = Schema.is(TeamPublicationError);

const sanitize = (error: unknown): LocalTeamProjectError => {
  if (isLocalProjectError(error)) return error;
  if (isAccountError(error))
    return localTeamError(error.reason === "network" ? "network" : "changed");
  if (isPublicationError(error))
    return localTeamError(
      error.reason === "access" || error.reason === "publisher"
        ? "access"
        : error.reason === "unavailable"
          ? "network"
          : "reset_required",
    );
  return localTeamError("network");
};
const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const failure = cause.reasons.find((reason) => reason._tag === "Fail");
      return Effect.fail(sanitize(failure?._tag === "Fail" ? failure.error : undefined));
    }),
  );
const matches = (row: LocalTeamLinkRow, credential: TeamProjectCredential) =>
  row.service_url === credential.serviceUrl &&
  row.issuer === credential.issuer &&
  row.client_id === credential.clientId &&
  row.subject === credential.subject &&
  row.generation === credential.generation;

export const makeLocalTeamProjects = (
  startWorkers = true,
  preflight = (root: string) => fileIO((signal) => preflightRepository(root, signal)),
) =>
  Effect.gen(function* () {
    const store = yield* LocalTeamProjectStore;
    const account = yield* LocalTeamAccount;
    const transport = yield* TeamProjectTransport;
    const query = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const fs = yield* FileSystem.FileSystem;
    const scope = yield* Effect.scope;
    const files = yield* makeLocalTeamFiles();
    const linkChanges = yield* PubSub.sliding<void>(1);
    const presenceConnections = new Map<string, Map<string, TeamProjectConnection>>();
    const writes = yield* Semaphore.make(1);
    const creations = yield* Semaphore.make(1);
    const withCreation = <A, E, R>(
      command: ClientOrchestrationCommand,
      operation: Effect.Effect<A, E, R>,
    ) => {
      const projectId =
        command.type === "thread.create"
          ? command.projectId
          : command.type === "thread.turn.start"
            ? command.bootstrap?.createThread?.projectId
            : undefined;
      if (!projectId) return operation;
      return Effect.gen(function* () {
        if (!(yield* store.link(projectId))) return yield* operation;
        // The engine queue can finish after its caller disconnects. Keep the creation
        // decision locked until dispatch settles, so a replacement cannot race acceptance.
        return yield* creations.withPermits(1)(Effect.uninterruptible(operation));
      });
    };
    const workers = new Map<
      string,
      {
        wake: Queue.Queue<void>;
        fiber: Fiber.Fiber<void, never>;
        projectId: string;
        threadIds: Set<string>;
      }
    >();
    // Ready before any snapshot is captured. Only wakeups are retained in memory;
    // the persisted source cursor is the replay queue.
    const events = yield* engine.subscribeDomainEvents;
    const closingLinks = new Set<string>();
    type SourceLease = Pick<
      LocalTeamLinkRow,
      "link_id" | "project_id" | "workspace_root" | "generation"
    >;
    const leases = new Map<Deferred.Deferred<never, LocalTeamProjectError>, SourceLease>();
    const invalidate = (
      matches: (row: SourceLease) => boolean,
      reason: LocalTeamProjectError["reason"],
    ) =>
      Effect.gen(function* () {
        for (const [receipt, row] of leases)
          if (matches(row)) yield* Deferred.fail(receipt, localTeamError(reason));
      });
    yield* account.identityChanges.pipe(
      Stream.runForEach((generation) =>
        invalidate((row) => row.generation !== generation, "changed"),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    );
    const checked = Effect.fnUntraced(function* (row: LocalTeamLinkRow) {
      if (closingLinks.has(row.link_id)) return yield* localTeamError("unlinked");
      const current = yield* store.link(ProjectId.make(row.project_id));
      if (current?.link_id !== row.link_id) return yield* localTeamError("unlinked");
      const project = yield* query.getProjectShellById(ProjectId.make(row.project_id));
      if (Option.isNone(project)) {
        yield* store.detach(row);
        return yield* localTeamError("unlinked");
      }
      const canonical = yield* fs
        .realPath(project.value.workspaceRoot)
        .pipe(Effect.mapError(() => localTeamError("root_changed")));
      if (project.value.workspaceRoot !== row.workspace_root || canonical !== row.canonical_root)
        return yield* localTeamError("root_changed");
      if ((yield* account.state).generation !== row.generation)
        return yield* localTeamError("changed");
      return current;
    });
    const lease = Effect.fnUntraced(function* (row: LocalTeamLinkRow) {
      const receipt = yield* Deferred.make<never, LocalTeamProjectError>();
      leases.set(receipt, row);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          leases.delete(receipt);
        }),
      );
      // Register first, then validate: unlink/deletion/account changes cannot
      // slip between a successful check and installing its cancellation hook.
      yield* checked(row);
      return Deferred.await(receipt);
    });
    type ReadFailure =
      | Effect.Error<ReturnType<typeof checked>>
      | Effect.Error<ReturnType<typeof store.publications>>;
    const withConnection = <A, E, R>(
      row: LocalTeamLinkRow,
      use: (
        connection: TeamProjectConnection,
        current: LocalTeamLinkRow,
        cancelled: Effect.Effect<never, LocalTeamProjectError>,
      ) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const cancelled = yield* lease(row);
        return yield* account
          .withCredential((credential) =>
            Effect.gen(function* () {
              if (!matches(row, credential)) return yield* localTeamError("changed");
              const current = yield* checked(row);
              const connection = yield* transport.open(credential, row.space_id);
              const config = (yield* connection.config).teamProject;
              if (
                !config ||
                config.projectId !== row.space_id ||
                config.member.subject !== row.subject
              )
                return yield* localTeamError("access");
              const active = { ...current, role: config.role };
              yield* store.role(row.link_id, config.role);
              return yield* use(connection, active, cancelled);
            }),
          )
          .pipe(Effect.raceFirst(cancelled));
      });
    const authorized = <A, E, R>(
      row: LocalTeamLinkRow,
      use: (
        connection: TeamProjectConnection,
        current: LocalTeamLinkRow,
        cancelled: Effect.Effect<never, LocalTeamProjectError>,
      ) => Effect.Effect<A, E, R>,
    ) => withConnection(row, use).pipe(safe);
    const transferCredential = <A, E, R>(
      use: (credential: TeamProjectCredential) => Effect.Effect<A, E, R>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const generation = (yield* account.state).generation;
          const cancelled = yield* Deferred.make<never, LocalTeamProjectError>();
          yield* account.identityChanges.pipe(
            Stream.runForEach((next) =>
              next === generation
                ? Effect.void
                : Deferred.fail(cancelled, localTeamError("changed")),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          return yield* account
            .withCredential((credential): Effect.Effect<A, E | LocalTeamProjectError, R> =>
              credential.generation === generation
                ? use(credential)
                : Effect.fail(localTeamError("changed")),
            )
            .pipe(Effect.raceFirst(Deferred.await(cancelled)));
        }),
      );
    const initialSource = Effect.fnUntraced(function* (
      projectId: ProjectId,
      workspaceRoot: string,
      credential: TeamProjectCredential,
    ) {
      const identity = yield* fileIO(() => checkedRoot(workspaceRoot));
      const canonical = yield* fs.realPath(workspaceRoot);
      const receipt = yield* Deferred.make<never, LocalTeamProjectError>();
      leases.set(receipt, {
        link_id: `initial:${projectId}`,
        project_id: projectId,
        workspace_root: workspaceRoot,
        generation: credential.generation,
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          leases.delete(receipt);
        }),
      );
      const check = Effect.fnUntraced(function* () {
        const current = yield* query.getProjectShellById(projectId);
        if (Option.isNone(current)) return yield* localTeamError("unlinked");
        if (current.value.workspaceRoot !== workspaceRoot)
          return yield* localTeamError("root_changed");
        const actual = yield* fileIO(() => checkedRoot(workspaceRoot)).pipe(
          Effect.mapError(() => localTeamError("root_changed")),
        );
        if (
          actual !== identity ||
          (yield* fs
            .realPath(workspaceRoot)
            .pipe(Effect.mapError(() => localTeamError("root_changed")))) !== canonical
        )
          return yield* localTeamError("root_changed");
        if ((yield* account.state).generation !== credential.generation)
          return yield* localTeamError("changed");
      });
      yield* check();
      return { canonical, check, cancelled: Deferred.await(receipt) };
    });
    const markFailure = (row: LocalTeamLinkRow, error: LocalTeamProjectError) =>
      store
        .status(
          row.link_id,
          error.reason === "changed"
            ? "account-changed"
            : error.reason === "access"
              ? "access-revoked"
              : error.reason === "root_changed"
                ? "root-changed"
                : error.reason === "reset_required" || error.reason === "limit"
                  ? "reset-required"
                  : "offline",
        )
        .pipe(Effect.ensuring(PubSub.publish(linkChanges, undefined)), Effect.ignore);
    const flushConnection = Effect.fnUntraced(function* (
      row: LocalTeamLinkRow,
      connection: TeamProjectConnection,
    ) {
      yield* checked(row);
      for (const mapping of yield* store.publications(row.link_id)) {
        if (mapping.status === "reset-required" || mapping.paused === 1) continue;
        if (row.role === "viewer") {
          yield* store.publicationStatus(mapping.publication_id, "access-revoked");
          continue;
        }
        yield* store.assertHistory(mapping);
        const registration = yield* store.registration(row, mapping);
        yield* connection.register(registration);
        // Yield fairly during long imports without constructing an unbounded batch.
        for (let page = 0; page < 64; page++) {
          yield* checked(row);
          const current = (yield* store.publications(row.link_id)).find(
            (item) => item.publication_id === mapping.publication_id,
          );
          if (!current) return yield* localTeamError("unlinked");
          if (current.paused === 1) break;
          yield* store.assertHistory(current);
          const pending = yield* store
            .next(current)
            .pipe(
              Effect.tapError((error) =>
                isLocalProjectError(error) &&
                (error.reason === "limit" || error.reason === "reset_required")
                  ? store.publicationStatus(current.publication_id, "reset-required")
                  : Effect.void,
              ),
            );
          if (!pending) {
            yield* store.publicationStatus(mapping.publication_id, "synced");
            break;
          }
          if (pending.changes.length === 0) continue;
          const receipt = yield* connection.publish({
            ...registration,
            fromRevision: pending.fromRevision,
            changes: pending.changes,
          });
          yield* checked(row);
          yield* store.acknowledge(current, pending, receipt.threadId, receipt.revision);
        }
      }
      const statuses = new Set(
        (yield* store.publications(row.link_id))
          .filter((item) => item.paused !== 1)
          .map((item) => item.status),
      );
      yield* store.status(
        row.link_id,
        statuses.has("reset-required")
          ? "reset-required"
          : statuses.has("access-revoked")
            ? "access-revoked"
            : statuses.has("syncing")
              ? "syncing"
              : "synced",
      );
      yield* PubSub.publish(linkChanges, undefined);
    }, safe);
    const flush = Effect.fnUntraced(function* (projectId: ProjectId) {
      const row = yield* store.link(projectId);
      if (!row) return yield* localTeamError("unlinked");
      yield* Effect.scoped(
        authorized(row, (connection, current) => flushConnection(current, connection)),
      ).pipe(Effect.tapError((error) => markFailure(row, error)));
    });
    const prepareIntents = Effect.fnUntraced(function* (row: LocalTeamLinkRow) {
      for (const item of yield* store.intents(row.link_id)) {
        const threadId = ThreadId.make(item.thread_id);
        const creation = yield* store.creationIntent(row.link_id, threadId);
        if (!creation || !(yield* store.acceptedCreation(creation.command_id, threadId))) continue;
        if ((yield* fileIO(() => checkedRoot(row.canonical_root))) !== creation.root_identity)
          return yield* localTeamError("root_changed");
        const thread = yield* query.getThreadShellById(threadId);
        if (Option.isNone(thread)) continue;
        yield* checked(row);
        if (thread.value.worktreePath !== null) {
          yield* store.intentError(row.link_id, threadId);
          continue;
        }
        if (row.role === "viewer") return yield* localTeamError("access");
        yield* store
          .prepare(row, threadId)
          .pipe(Effect.tapError(() => store.intentError(row.link_id, threadId)));
        yield* store.intent(row.link_id, threadId, false);
      }
      yield* PubSub.publish(linkChanges, undefined);
    }, safe);
    const start = Effect.fnUntraced(function* (row: LocalTeamLinkRow) {
      if (!startWorkers || workers.has(row.link_id)) return;
      const wake = yield* Queue.sliding<void>(1);
      const worker = Effect.gen(function* () {
        while (true) {
          const result = yield* Effect.scoped(
            authorized(row, (connection, current) =>
              Effect.gen(function* () {
                yield* files.run(current, connection).pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.forkScoped,
                );
                while (true) {
                  const config = (yield* connection.config).teamProject;
                  if (!config || config.projectId !== row.space_id)
                    return yield* localTeamError("access");
                  yield* store.role(row.link_id, config.role);
                  yield* writes.withPermits(1)(
                    prepareIntents({ ...current, role: config.role }).pipe(
                      Effect.andThen(
                        flushConnection({ ...current, role: config.role }, connection),
                      ),
                    ),
                  );
                  const pending = (yield* store.publications(row.link_id)).some(
                    (item) => item.paused !== 1 && item.status === "syncing",
                  );
                  if (!pending)
                    yield* Queue.take(wake).pipe(
                      Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.void }),
                    );
                  // One wakeup covers all events in a streaming burst.
                  yield* Effect.sleep("100 millis");
                }
              }),
            ),
          ).pipe(Effect.result);
          if (result._tag === "Failure") {
            yield* markFailure(row, result.failure);
            if (result.failure.reason === "unlinked") return;
            if (result.failure.reason !== "network") yield* Queue.take(wake);
            else yield* Effect.sleep("5 seconds");
          }
        }
      }).pipe(
        Effect.catchCause(() => store.status(row.link_id, "offline").pipe(Effect.ignore)),
        Effect.ensuring(
          Effect.sync(() => {
            workers.delete(row.link_id);
          }),
        ),
        Effect.forkIn(scope),
      );
      const fiber = yield* worker;
      workers.set(row.link_id, {
        wake,
        fiber,
        projectId: row.project_id,
        threadIds: new Set((yield* store.publications(row.link_id)).map((item) => item.thread_id)),
      });
    });
    yield* events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "project.deleted") {
            yield* invalidate((row) => row.project_id === event.aggregateId, "unlinked");
            const row = yield* store.link(ProjectId.make(event.aggregateId));
            if (row) yield* store.detach(row);
          } else if (
            event.type === "project.meta-updated" &&
            event.payload.workspaceRoot !== undefined
          ) {
            yield* invalidate(
              (row) =>
                row.project_id === event.aggregateId &&
                row.workspace_root !== event.payload.workspaceRoot,
              "root_changed",
            );
          }
          for (const worker of workers.values())
            if (event.aggregateId === worker.projectId || worker.threadIds.has(event.aggregateId))
              yield* Queue.offer(worker.wake, undefined);
        }),
      ),
      Effect.forkIn(scope),
    );
    const state = Effect.gen(function* () {
      const generation = (yield* account.state).generation;
      return yield* Effect.forEach(yield* store.links, (row) =>
        Effect.gen(function* () {
          if (generation !== row.generation) {
            yield* store.status(row.link_id, "account-changed");
            return yield* store.describe({ ...row, status: "account-changed" });
          }
          return yield* store.describe(row);
        }),
      );
    }).pipe(Effect.mapError(() => localTeamError("storage")));
    const control = Effect.fnUntraced(
      function* (input: LocalTeamProjectControl) {
        let row = yield* store.link(input.projectId);
        if (input.action === "unlink") {
          if (row) {
            const detachedLinkId = row.link_id;
            closingLinks.add(detachedLinkId);
            yield* invalidate((linked) => linked.link_id === detachedLinkId, "unlinked");
            const worker = workers.get(row.link_id);
            if (worker) {
              yield* Fiber.interrupt(worker.fiber);
              workers.delete(row.link_id);
            }
            yield* store.detach(row);
            closingLinks.delete(detachedLinkId);
          }
          return { state: null };
        }
        if (input.action === "stop-publication") {
          if (!row) return yield* localTeamError("unlinked");
          const mapping = (yield* store.publications(row.link_id)).find(
            (item) => item.thread_id === input.threadId,
          );
          if (mapping) yield* store.pause(mapping.publication_id, true);
          yield* store.intent(row.link_id, input.threadId, false);
          return { state: yield* store.describe(row) };
        }
        if (input.action === "intent") {
          if (!row) return yield* localTeamError("unlinked");
          yield* checked(row);
          if (row.generation !== input.generation || row.role === "viewer")
            return yield* localTeamError("access");
          const canonicalRoot = row.canonical_root;
          const rootIdentity = yield* fileIO(() => checkedRoot(canonicalRoot));
          const previous = yield* store.creationIntent(row.link_id, input.threadId);
          const thread = yield* query.getThreadShellById(input.threadId);
          if (previous) {
            if (previous.root_identity !== rootIdentity)
              return yield* localTeamError("root_changed");
            const accepted = yield* store.acceptedCreation(previous.command_id, input.threadId);
            if (accepted || Option.isSome(thread)) {
              if (
                previous.command_id !== input.commandId ||
                previous.shared !== (input.shared ? 1 : 0) ||
                !accepted ||
                Option.isNone(thread) ||
                thread.value.projectId !== input.projectId
              )
                return yield* localTeamError("invalid");
              // Receipt retries preserve the original decision, including a deliberate later pause.
              return { state: yield* store.describe(row) };
            }
            // No creation was accepted. A restored draft can retry Send with a fresh
            // command and choice; the creation lock also fences delayed older requests.
          }
          if (Option.isSome(thread)) return yield* localTeamError("invalid");
          yield* store.saveCreationIntent(
            row.link_id,
            input.threadId,
            input.commandId,
            input.shared,
            rootIdentity,
          );
          return { state: yield* store.describe(row) };
        }
        if (input.action === "link") {
          if (row) return yield* localTeamError("invalid");
          const project = yield* query.getProjectShellById(input.projectId);
          if (Option.isNone(project)) return yield* localTeamError("invalid");
          const canonicalRoot = yield* fs.realPath(project.value.workspaceRoot);
          row = yield* Effect.scoped(
            account.withCredential((credential) =>
              Effect.gen(function* () {
                const connection = yield* transport.open(credential, input.sharedProjectId);
                const config = (yield* connection.config).teamProject;
                if (
                  !config ||
                  config.projectId !== input.sharedProjectId ||
                  config.member.subject !== credential.subject
                )
                  return yield* localTeamError("access");
                return yield* store.create({
                  projectId: input.projectId,
                  sharedProjectId: input.sharedProjectId,
                  workspaceRoot: project.value.workspaceRoot,
                  canonicalRoot,
                  credential,
                  role: config.role,
                });
              }),
            ),
          );
        } else {
          if (!row) return yield* localTeamError("unlinked");
          const existing = row;
          yield* Effect.scoped(
            authorized(existing, (_connection, current) =>
              Effect.gen(function* () {
                if (current.role === "viewer") return yield* localTeamError("access");
                const thread = yield* query.getThreadShellById(input.threadId);
                if (Option.isNone(thread) || thread.value.worktreePath !== null)
                  return yield* localTeamError("invalid");
                const mapping = yield* store.prepare(current, input.threadId);
                yield* store.pause(mapping.publication_id, false);
              }),
            ),
          );
        }
        yield* start(row);
        const worker = workers.get(row.link_id);
        if (worker) {
          worker.threadIds = new Set(
            (yield* store.publications(row.link_id)).map((item) => item.thread_id),
          );
          yield* Queue.offer(worker.wake, undefined);
        }
        return { state: yield* store.describe(row) };
      },
      (operation, input) =>
        input.action === "unlink" ? operation : writes.withPermits(1)(operation),
      safe,
    );
    const rowFor = (projectId: ProjectId) =>
      store.link(projectId).pipe(
        Effect.flatMap((row) =>
          row ? Effect.succeed(row) : Effect.fail(localTeamError("unlinked")),
        ),
        safe,
      );
    const guard = Effect.fnUntraced(function* (command: OrchestrationCommand) {
      if (command.type !== "thread.create" && command.type !== "thread.turn.start") return;
      const projectId =
        command.type === "thread.create"
          ? command.projectId
          : (Option.getOrUndefined(yield* query.getThreadShellById(command.threadId))?.projectId ??
            command.bootstrap?.createThread?.projectId);
      if (!projectId) return;
      const row = yield* store.link(projectId);
      if (!row) return;
      yield* checked(row);
      if (command.type === "thread.create" || command.bootstrap?.createThread) {
        const creation = yield* store.creationIntent(row.link_id, command.threadId);
        if (creation && creation.command_id !== command.commandId)
          return yield* localTeamError("invalid");
        if (
          creation &&
          (yield* fileIO(() => checkedRoot(row.canonical_root))) !== creation.root_identity
        )
          return yield* localTeamError("root_changed");
      }
      if (row.role === "viewer" || row.status === "access-revoked")
        return yield* localTeamError("access");
      yield* Effect.scoped(
        authorized(row, (_connection, current) =>
          current.role === "viewer" ? Effect.fail(localTeamError("access")) : Effect.void,
        ),
      ).pipe(
        Effect.catch((error) =>
          error.reason === "network" ? markFailure(row, error) : Effect.fail(error),
        ),
      );
    }, safe);
    const snapshot = Effect.fnUntraced(function* (
      projectId: ProjectId,
      threadId: ThreadId,
      window?: OrchestrationThreadDetailWindow,
    ) {
      const row = yield* rowFor(projectId);
      return yield* Effect.scoped(
        authorized(row, (connection, current) =>
          Effect.gen(function* () {
            const value = yield* connection.snapshot(threadId, window ?? { turnLimit: 30 });
            if (value.thread.projectId !== row.space_id) return yield* localTeamError("access");
            yield* checked(row);
            return sharedSnapshot(current, yield* store.publications(row.link_id), value);
          }),
        ),
      );
    }, safe);
    const subscribeProject = (projectId: ProjectId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const row = yield* rowFor(projectId);
          return yield* authorized(row, (connection, current, cancelled) =>
            Effect.succeed(
              connection.shell({}).pipe(
                Stream.interruptWhen(cancelled),
                Stream.mapEffect((item): Effect.Effect<TeamSharedProjectStreamItem, ReadFailure> =>
                  Effect.gen(function* () {
                    yield* checked(row);
                    const mappings = yield* store.publications(row.link_id);
                    switch (item.kind) {
                      case "snapshot":
                        return {
                          kind: "snapshot",
                          sequence: item.snapshot.snapshotSequence,
                          threads: item.snapshot.threads
                            .filter((thread) => thread.projectId === row.space_id)
                            .map((thread) => sharedSummary(current, mappings, thread)),
                        };
                      case "thread-upserted":
                        if (item.thread.projectId !== row.space_id)
                          return yield* localTeamError("access");
                        return {
                          kind: "thread-upserted",
                          sequence: item.sequence,
                          thread: sharedSummary(current, mappings, item.thread),
                        };
                      case "thread-removed":
                        return item;
                      default:
                        return { kind: "synchronized" };
                    }
                  }),
                ),
              ),
            ),
          );
        }).pipe(safe),
      ).pipe(Stream.catchCause((cause) => Stream.fromEffect(safe(Effect.failCause(cause)))));
    const subscribeThread = (projectId: ProjectId, threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const row = yield* rowFor(projectId);
          return yield* authorized(row, (connection, current, cancelled) =>
            Effect.succeed(
              connection.thread({ threadId, turnLimit: 30 }).pipe(
                Stream.interruptWhen(cancelled),
                Stream.mapEffect((item): Effect.Effect<TeamSharedThreadStreamItem, ReadFailure> =>
                  Effect.gen(function* () {
                    yield* checked(row);
                    if (item.kind === "synchronized") return item;
                    if (item.kind === "snapshot") {
                      if (item.snapshot.thread.projectId !== row.space_id)
                        return yield* localTeamError("access");
                      return {
                        kind: "snapshot",
                        snapshot: sharedSnapshot(
                          current,
                          yield* store.publications(row.link_id),
                          item.snapshot,
                        ),
                      };
                    }
                    if (item.event.aggregateId !== threadId) return yield* localTeamError("access");
                    if (item.event.type === "thread.activity-appended") {
                      const status = memberReportedStatus(item.event.payload.activity);
                      if (status)
                        return { kind: "member-status", sequence: item.event.sequence, status };
                    }
                    if (item.event.type === "thread.message-sent") {
                      const message = item.event.payload;
                      return {
                        kind: "message",
                        sequence: item.event.sequence,
                        append: message.streaming,
                        message: sharedMessage({
                          id: message.messageId,
                          role: message.role,
                          text: message.text,
                          streaming: message.streaming,
                          ...(item.event.metadata.collaborationUser
                            ? { author: item.event.metadata.collaborationUser }
                            : {}),
                          createdAt: message.createdAt,
                          updatedAt: message.updatedAt,
                          turnId: message.turnId,
                          attachments: [],
                        }),
                      };
                    }
                    return {
                      kind: item.event.type.startsWith("sidethread.")
                        ? "discussion-changed"
                        : "metadata-changed",
                      sequence: item.event.sequence,
                    };
                  }),
                ),
              ),
            ),
          );
        }).pipe(safe),
      ).pipe(Stream.catchCause((cause) => Stream.fromEffect(safe(Effect.failCause(cause)))));
    const discuss = Effect.fnUntraced(function* (
      projectId: ProjectId,
      command: ClientOrchestrationCommand,
    ) {
      if (
        !command.type.startsWith("sidethread.") ||
        (command.type === "sidethread.message.post" && (command.attachments?.length ?? 0) > 0)
      )
        return yield* localTeamError("invalid");
      const row = yield* rowFor(projectId);
      return yield* Effect.scoped(authorized(row, (connection) => connection.discussion(command)));
    }, safe);
    const filesControl = Effect.fnUntraced(function* (
      input: LocalTeamFilesControl,
    ): Effect.fn.Return<LocalTeamFilesResult, LocalTeamProjectError | TeamFileError> {
      return yield* Effect.gen(function* () {
        if (input.action === "preview" || input.action === "share") {
          const project = yield* query.getProjectShellById(input.projectId);
          if (Option.isNone(project)) return yield* localTeamError("invalid");
          if (input.action === "preview") {
            const identity = yield* preflight(project.value.workspaceRoot);
            return {
              status: "disabled" as const,
              ...identity,
              policy: "tracked-and-explicitly-included" as const,
            };
          }
          const sharedProjectId = yield* Effect.scoped(
            transferCredential((credential) =>
              Effect.gen(function* () {
                // Register metadata/root cancellation before any verification or upload starts.
                const source = yield* initialSource(
                  input.projectId,
                  project.value.workspaceRoot,
                  credential,
                );
                return yield* Effect.gen(function* () {
                  const identity = yield* preflight(project.value.workspaceRoot);
                  yield* source.check();
                  if (
                    identity.branch !== input.expectedBranch ||
                    identity.commit !== input.expectedCommit ||
                    (yield* store.link(input.projectId))
                  )
                    return yield* localTeamError("invalid");
                  const created = yield* transport.create(
                    credential,
                    input.name,
                    input.members,
                    yield* store.reserveFileCreation(credential, input),
                  );
                  yield* source.check();
                  // Record the link before transfer. A failed initialization remains visible and retryable.
                  const row = yield* store.create({
                    projectId: input.projectId,
                    sharedProjectId: created.spaceId,
                    workspaceRoot: project.value.workspaceRoot,
                    canonicalRoot: source.canonical,
                    credential,
                    role: "owner",
                  });
                  yield* files.initializing(row);
                  const fileSourceCheck = source
                    .check()
                    .pipe(
                      Effect.mapError((error) =>
                        fileError(
                          isLocalProjectError(error) && error.reason === "root_changed"
                            ? "root_changed"
                            : isLocalProjectError(error)
                              ? "access"
                              : "unavailable",
                          "The source project changed while its initial transfer was running. Review its linkage before retrying.",
                        ),
                      ),
                    );
                  yield* withConnection(row, (connection) =>
                    uploadRepository(
                      {
                        ...connection,
                        repository: (command) =>
                          command.action === "abort"
                            ? connection.repository(command)
                            : fileSourceCheck.pipe(
                                Effect.andThen(connection.repository(command)),
                                Effect.tap(() => fileSourceCheck),
                              ),
                      },
                      row.workspace_root,
                      null,
                      {
                        branch: input.expectedBranch,
                        commit: input.expectedCommit,
                      },
                    ),
                  ).pipe(
                    Effect.mapError((error) =>
                      isLocalProjectError(error) ||
                      (isTeamFileError(error) &&
                        [
                          "invalid",
                          "limit",
                          "conflict",
                          "branch_changed",
                          "root_changed",
                          "unsupported_platform",
                        ].includes(error.reason))
                        ? error
                        : new TeamFileError({
                            reason: "initializing",
                            sharedProjectId: created.spaceId,
                            message:
                              "The shared project exists, but its initial transfer did not finish. Retry initialization from this linked checkout.",
                          }),
                    ),
                  );
                  yield* source.check();
                  yield* files.initialized(row);
                  yield* start(row);
                  return created.spaceId;
                }).pipe(Effect.raceFirst(source.cancelled));
              }),
            ),
          );
          return {
            projectId: input.projectId,
            sharedProjectId,
            status: "disabled" as const,
            policy: "tracked-and-explicitly-included" as const,
          };
        }
        if (input.action === "open" || input.action === "create") {
          const destination = normalizeCheckoutDestination(input.destination);
          const destinationIdentity = yield* fileIO(() => validateDestination(destination));
          return yield* Effect.scoped(
            transferCredential((credential) =>
              Effect.gen(function* () {
                const creationRequestId =
                  input.action === "create"
                    ? yield* store.reserveFileCreation(credential, input)
                    : undefined;
                const sharedProjectId =
                  input.action === "create"
                    ? (input.sharedProjectId ??
                      (yield* transport.create(
                        credential,
                        input.name,
                        input.members,
                        creationRequestId,
                      )).spaceId)
                    : input.sharedProjectId;
                const connection = yield* transport.open(credential, sharedProjectId);
                const config = (yield* connection.config).teamProject;
                if (!config) return yield* localTeamError("access");
                if (
                  input.action === "create" &&
                  !(yield* connection.repository({ action: "repository" })).repository
                ) {
                  if (config.role !== "owner") return yield* localTeamError("access");
                  const temp = yield* fileIO(() =>
                    NodeFSP.mkdtemp(
                      NodePath.join(NodePath.dirname(destination), ".t3-team-transfer-"),
                    ),
                  );
                  yield* Effect.acquireUseRelease(
                    Effect.succeed(temp),
                    (directory) =>
                      Effect.gen(function* () {
                        const checkout = NodePath.join(directory, "checkout");
                        yield* fileIO(() => NodeFSP.mkdir(checkout));
                        yield* fileIO((signal) =>
                          restrictedGit(
                            checkout,
                            ["init", "--template=", "--initial-branch", "main"],
                            signal,
                          ),
                        );
                        yield* uploadRepository(connection, checkout, null);
                        yield* connection.config;
                        yield* fileIO(() =>
                          installCheckout(checkout, destination, destinationIdentity),
                        );
                      }),
                    (directory) =>
                      fileIO(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
                        Effect.ignore,
                      ),
                  ).pipe(
                    Effect.mapError(
                      () =>
                        new TeamFileError({
                          reason: "initializing",
                          sharedProjectId,
                          message:
                            "The shared project exists, but initialization did not finish. Retry Create with this project and an empty destination.",
                        }),
                    ),
                  );
                } else yield* openCheckout(connection, destination);
                const projectId = ProjectId.make(NodeCrypto.randomUUID());
                yield* engine.dispatch({
                  type: "project.create",
                  commandId: CommandId.make(NodeCrypto.randomUUID()),
                  projectId,
                  title:
                    input.action === "create" ? input.name : NodePath.basename(destination),
                  workspaceRoot: destination,
                  createdAt: DateTime.formatIso(yield* DateTime.now),
                });
                const row = yield* store.create({
                  projectId,
                  sharedProjectId,
                  workspaceRoot: destination,
                  canonicalRoot: yield* fs.realPath(destination),
                  credential,
                  role: config.role,
                });
                yield* start(row);
                return {
                  projectId,
                  sharedProjectId,
                  status: "disabled" as const,
                  policy: "tracked-and-explicitly-included" as const,
                };
              }),
            ),
          );
        }
        const row = yield* rowFor(input.projectId);
        if (input.action === "state") {
          yield* checked(row);
          return yield* files.state(row);
        }
        if (input.action === "disable") return yield* files.disable(row);
        return yield* Effect.scoped(
          withConnection(row, (connection, current) => files.control(current, connection, input)),
        );
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          const failure = cause.reasons.find((reason) => reason._tag === "Fail");
          const error = failure?._tag === "Fail" ? failure.error : undefined;
          return Effect.fail(isTeamFileError(error) ? error : sanitize(error));
        }),
      );
    });
    const subscribePresence = (projectId: ProjectId, owner: string) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const row = yield* rowFor(projectId);
          return yield* authorized(row, (connection, _current, cancelled) =>
            Effect.gen(function* () {
              const connections =
                presenceConnections.get(row.link_id) ?? new Map<string, TeamProjectConnection>();
              if (
                !connections.has(owner) &&
                (connections.size >= 16 ||
                  (presenceConnections.size >= 128 && !presenceConnections.has(row.link_id)))
              )
                return yield* localTeamError("limit");
              connections.set(owner, connection);
              presenceConnections.set(row.link_id, connections);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  if (connections.get(owner) === connection) connections.delete(owner);
                  if (connections.size === 0) presenceConnections.delete(row.link_id);
                }),
              );
              return connection.presence.pipe(
                Stream.interruptWhen(cancelled),
                Stream.mapEffect((item) => checked(row).pipe(Effect.as(item))),
              );
            }),
          );
        }).pipe(safe),
      ).pipe(Stream.catchCause((cause) => Stream.fromEffect(safe(Effect.failCause(cause)))));
    const heartbeat = (projectId: ProjectId, focus: PresenceHeartbeatInput, owner: string) =>
      Effect.gen(function* () {
        const row = yield* rowFor(projectId);
        yield* checked(row);
        const connection = presenceConnections.get(row.link_id)?.get(owner);
        if (!connection) return yield* localTeamError("network");
        const result = yield* connection.heartbeat(focus);
        yield* checked(row);
        return result;
      }).pipe(safe);
    const creationReceipt = Effect.fnUntraced(function* (command: OrchestrationCommand) {
      const projectId =
        command.type === "thread.create"
          ? command.projectId
          : command.type === "thread.turn.start"
            ? command.bootstrap?.createThread?.projectId
            : undefined;
      if (!projectId || !("threadId" in command)) return null;
      const row = yield* store.link(projectId);
      if (!row) return null;
      yield* checked(row);
      const creation = yield* store.creationIntent(row.link_id, command.threadId);
      if (!creation) return null;
      if (creation.command_id !== command.commandId) return yield* localTeamError("invalid");
      if ((yield* fileIO(() => checkedRoot(row.canonical_root))) !== creation.root_identity)
        return yield* localTeamError("root_changed");
      const receipt = yield* store.acceptedCreation(command.commandId, command.threadId);
      if (!receipt) return null;
      const thread = yield* query.getThreadShellById(command.threadId);
      if (Option.isNone(thread) || thread.value.projectId !== projectId)
        return yield* localTeamError("invalid");
      yield* checked(row);
      return { sequence: receipt.result_sequence };
    }, safe);
    const afterReceipt = Effect.fnUntraced(
      function* (command: OrchestrationCommand) {
        const projectId =
          command.type === "thread.create"
            ? command.projectId
            : command.type === "thread.turn.start"
              ? command.bootstrap?.createThread?.projectId
              : undefined;
        if (!projectId) return;
        const row = yield* store.link(projectId);
        if (!row) return;
        yield* writes.withPermits(1)(prepareIntents(row));
        yield* start(row);
        const worker = workers.get(row.link_id);
        if (worker) {
          worker.threadIds = new Set(
            (yield* store.publications(row.link_id)).map((item) => item.thread_id),
          );
          yield* Queue.offer(worker.wake, undefined);
        }
      },
      safe,
      Effect.catchCause(() => Effect.void),
    );
    for (const row of yield* store.links) yield* start(row);
    return {
      state,
      subscribePresence,
      heartbeat,
      subscribeState: Stream.unwrap(
        PubSub.subscribe(linkChanges).pipe(
          Effect.map((subscription) =>
            Stream.concat(
              Stream.fromEffect(state),
              Stream.merge(Stream.fromSubscription(subscription), account.identityChanges).pipe(
                Stream.mapEffect(() => state),
              ),
            ),
          ),
        ),
      ),
      control: (input: LocalTeamProjectControl) =>
        (input.action === "intent"
          ? creations.withPermits(1)(control(input))
          : control(input)
        ).pipe(Effect.ensuring(PubSub.publish(linkChanges, undefined))),
      directory: (projectId: ProjectId) =>
        Effect.scoped(
          rowFor(projectId).pipe(
            Effect.flatMap((row) => authorized(row, (connection) => connection.directory)),
          ),
        ).pipe(safe),
      membership: (projectId: ProjectId, command: TeamMembershipCommand) =>
        Effect.scoped(
          rowFor(projectId).pipe(
            Effect.flatMap((row) =>
              authorized(row, (_connection, current) =>
                current.role !== "owner"
                  ? localTeamError("access")
                  : account.withCredential((credential) =>
                      transport.membership(credential, { ...command, spaceId: current.space_id }),
                    ),
              ),
            ),
          ),
        ).pipe(safe),
      acceptInvitation: (generation: string, token: string) =>
        transferCredential((credential) =>
          credential.generation !== generation
            ? localTeamError("changed")
            : transport.membership(credential, { action: "accept", token }),
        ).pipe(safe),
      guard,
      creationReceipt,
      withCreation,
      afterReceipt,
      flush,
      snapshot,
      subscribeProject,
      subscribeThread,
      discuss,
      filesControl: (input: LocalTeamFilesControl) =>
        filesControl(input).pipe(Effect.ensuring(PubSub.publish(linkChanges, undefined))),
    };
  });
export class LocalTeamProjects extends Context.Service<
  LocalTeamProjects,
  Effect.Success<ReturnType<typeof makeLocalTeamProjects>>
>()("t3/team/LocalTeamProjects") {
  static readonly layer = Layer.effect(this, makeLocalTeamProjects()).pipe(
    Layer.provide(LocalTeamProjectStore.layer),
    Layer.provide(TeamProjectTransport.layer),
  );
}
