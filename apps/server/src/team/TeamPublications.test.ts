import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import {
  ClientOrchestrationCommand,
  CommandId,
  ProjectId,
  ThreadId,
  type CollaborationUser,
} from "@t3tools/contracts";
import {
  TeamPublicationBatch,
  type TeamPublicationChange,
} from "@t3tools/contracts/teamPublication";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { TeamSpaces } from "./TeamSpaces.ts";
import { TeamNativeProjects } from "./TeamNativeProjects.ts";
import { makeTeamPublications, publicationHash } from "./TeamPublications.ts";
import type { TeamPrincipal } from "./TeamAuthentication.ts";
import { nativeThreadStream } from "./nativeStreams.ts";

const decodeBatchOption = Schema.decodeUnknownOption(TeamPublicationBatch);
const decodeClientOption = Schema.decodeUnknownOption(ClientOrchestrationCommand);

const principal = (userId: string): TeamPrincipal => ({
  userId,
  displayName: `Trusted ${userId}`,
  verifiedEmails: [`${userId}@example.test`],
  expiresAt: 1e12,
});
const owner = principal("owner");
const contributor = principal("contributor");
const viewer = principal("viewer");
const resolveUser = (subject: string): Effect.Effect<CollaborationUser> =>
  Effect.succeed({ subject, displayName: `Trusted ${subject}` });
const basics = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer);
const layers = TeamNativeProjects.layer.pipe(
  Layer.provideMerge(TeamSpaces.layer),
  Layer.provideMerge(
    Layer.unwrap(
      Effect.gen(function* () {
        return makeSqlitePersistenceLive((yield* ServerConfig).dbPath);
      }),
    ),
  ),
  Layer.provideMerge(
    ServerConfig.layerTest("/untrusted-host-root", { prefix: "t3-publication-test-" }),
  ),
  Layer.provideMerge(basics),
);
const registration = {
  publicationId: "1".repeat(32),
  installationId: "2".repeat(32),
  capability: "3".repeat(64),
};
const time = "1970-01-01T00:00:00.000Z";
const create: TeamPublicationChange = {
  kind: "create",
  title: "Published local thread",
  display: { provider: "codex", model: "example-model" },
  createdAt: time,
};
const user: TeamPublicationChange = {
  kind: "message",
  key: publicationHash("local-message"),
  turnKey: publicationHash("local-turn"),
  role: "user",
  text: "Safe chat text",
  streaming: false,
  createdAt: time,
  updatedAt: time,
};
const seed = Effect.gen(function* () {
  const spaces = yield* TeamSpaces;
  const projects = yield* TeamNativeProjects;
  const { spaceId } = yield* spaces.execute(
    owner,
    { action: "create", name: "Shared project" },
    true,
  );
  for (const [person, role] of [
    [contributor, "contributor"],
    [viewer, "viewer"],
  ] as const) {
    const invite = yield* spaces.execute(owner, {
      action: "invite",
      spaceId,
      email: person.verifiedEmails[0]!,
      role,
    });
    yield* spaces.execute(person, { action: "accept", token: invite.token! });
  }
  return {
    spaces,
    projects,
    spaceId,
    connection: yield* projects.connect(owner, spaceId, resolveUser),
  };
});

it.effect(
  "binds publication ownership, rejects viewers and namespaces identities per publication and project",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projects, spaces, spaceId, connection } = yield* seed;
        const registered = yield* connection.publications.register(registration);
        const batch = { ...registration, fromRevision: 0, changes: [create, user] };
        const ack = yield* connection.publications.publish(batch);
        expect(ack.revision).toBe(2);
        expect(ack.threadId).toBe(registered.threadId);
        expect(yield* connection.publications.publish(batch)).toEqual(ack);
        const read = yield* connection.query.getSnapshot();
        expect(read.threads).toHaveLength(1);
        expect(read.threads[0]).toMatchObject({
          id: ack.threadId,
          projectId: spaceId,
          createdBy: { subject: "owner", displayName: "Trusted owner" },
          session: null,
          worktreePath: null,
        });
        expect(read.threads[0]?.messages[0]).toMatchObject({
          text: "Safe chat text",
          author: { subject: "owner", displayName: "Trusted owner" },
        });
        expect(read.threads[0]?.messages[0]?.id).not.toBe(user.kind === "message" ? user.key : "");
        const deniedPublisher = yield* projects.connect(contributor, spaceId, resolveUser);
        expect(yield* deniedPublisher.publications.publish(batch).pipe(Effect.flip)).toMatchObject({
          reason: "publisher",
        });
        expect(
          yield* connection.publications
            .register({ ...registration, capability: "4".repeat(64) })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "publisher" });
        expect(
          yield* connection.publications
            .register({ ...registration, installationId: "5".repeat(32) })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "publisher" });
        const readOnly = yield* projects.connect(viewer, spaceId, resolveUser);
        expect(
          yield* readOnly.publications
            .register({ ...registration, publicationId: "6".repeat(32) })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "access" });
        const nextRegistration = { ...registration, publicationId: "7".repeat(32) };
        yield* connection.publications.register(nextRegistration);
        const second = yield* connection.publications.publish({
          ...nextRegistration,
          fromRevision: 0,
          changes: [create, user],
        });
        expect(second.threadId).not.toBe(ack.threadId);
        const { spaceId: otherSpace } = yield* spaces.execute(
          owner,
          { action: "create", name: "Other" },
          true,
        );
        const other = yield* projects.connect(owner, otherSpace, resolveUser);
        yield* other.publications.register(registration);
        const third = yield* other.publications.publish(batch);
        expect(third.threadId).not.toBe(ack.threadId);
        const firstMessage = (yield* connection.query.getSnapshot()).threads[0]?.messages[0]?.id;
        const otherMessage = (yield* other.query.getSnapshot()).threads[0]?.messages[0]?.id;
        expect(firstMessage).not.toBe(otherMessage);
        const rows = yield* connection.sql<{
          capability_hash: string;
        }>`SELECT capability_hash FROM team_publications`;
        expect(rows.every((row) => row.capability_hash !== registration.capability)).toBe(true);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "recovers a lost acknowledgement and partial batch without duplicating messages or accepting a conflicting retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection, spaces } = yield* seed;
        yield* connection.publications.register(registration);
        let failAfterCommit = true;
        const interrupted = yield* makeTeamPublications({
          projectId: connection.projectId,
          member: connection.member,
          check: connection.check,
          withAuthority: spaces.withAuthority,
          engine: {
            ...connection.engine,
            dispatch: (command, options) =>
              connection.engine.dispatch(command, options).pipe(
                Effect.flatMap((receipt) => {
                  if (failAfterCommit) {
                    failAfterCommit = false;
                    return Effect.die("Simulated process loss after receipt");
                  }
                  return Effect.succeed(receipt);
                }),
              ),
          },
        }).pipe(Effect.provideService(SqlClient.SqlClient, connection.sql));
        const batch = { ...registration, fromRevision: 0, changes: [create, user] };
        expect(yield* interrupted.publish(batch).pipe(Effect.flip)).toMatchObject({
          reason: "unavailable",
        });
        expect((yield* connection.query.getSnapshot()).threads).toHaveLength(1);
        expect(
          yield* connection.publications
            .publish({ ...batch, changes: [create, { ...user, text: "Conflicting retry" }] })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "conflict" });
        const ack = yield* connection.publications.publish(batch);
        expect(ack.revision).toBe(2);
        expect((yield* connection.query.getSnapshot()).threads[0]?.messages).toHaveLength(1);
        expect(yield* connection.publications.publish(batch)).toEqual(ack);
        expect(
          yield* connection.publications
            .publish({ ...registration, fromRevision: 100, changes: [user] })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "order" });
        expect(
          yield* connection.publications
            .publish({ ...registration, fromRevision: 2, changes: [create] })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "order" });
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "publishes incremental assistant text and member status without provider commands or host data",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* seed;
        yield* connection.publications.register(registration);
        yield* connection.publications.publish({
          ...registration,
          fromRevision: 0,
          changes: [create, user],
        });
        const message = {
          kind: "message" as const,
          key: publicationHash("assistant"),
          turnKey: publicationHash("local-turn"),
          role: "assistant" as const,
          text: "First ",
          streaming: true,
          createdAt: time,
          updatedAt: time,
        };
        yield* connection.publications.publish({
          ...registration,
          fromRevision: 2,
          changes: [
            message,
            { ...message, text: "second" },
            { ...message, streaming: false, text: "" },
            { kind: "status", status: "completed", updatedAt: time },
          ],
        });
        const thread = (yield* connection.query.getSnapshot()).threads[0];
        expect(thread?.messages.map((item) => item.text)).toEqual(
          expect.arrayContaining(["Safe chat text", "First second"]),
        );
        expect(thread?.messages.find((message) => message.role === "assistant")?.streaming).toBe(
          false,
        );
        expect(thread?.session).toBeNull();
        expect(thread?.checkpoints).toEqual([]);
        expect(thread?.activities[0]).toMatchObject({
          kind: "shared.member-status",
          payload: { status: "completed", reportedBy: "owner" },
        });
        const events = yield* connection.sql<{
          event_type: string;
        }>`SELECT event_type FROM orchestration_events`;
        expect(events.map((event) => event.event_type)).not.toContain(
          "thread.turn-start-requested",
        );
        expect(
          decodeBatchOption({
            ...registration,
            fromRevision: 6,
            changes: [{ ...message, author: { subject: "forged" } }],
          })._tag,
        ).toBe("None");
        expect(
          decodeClientOption({
            type: "thread.publication.message",
            commandId: CommandId.make("forged"),
            threadId: ThreadId.make("forged"),
            projectId: ProjectId.make("forged"),
          })._tag,
        ).toBe("None");
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "generic native commands cannot bypass a publication capability and membership revocation stops writes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection, projects, spaces, spaceId } = yield* seed;
        const { threadId } = yield* connection.publications.register(registration);
        yield* connection.publications.publish({
          ...registration,
          fromRevision: 0,
          changes: [create, user],
        });
        const other = yield* projects.connect(contributor, spaceId, resolveUser);
        for (const actor of [connection, other]) {
          for (const command of [
            {
              type: "thread.meta.update" as const,
              commandId: CommandId.make("bypass-title"),
              threadId,
              title: "Hijacked",
            },
            {
              type: "thread.archive" as const,
              commandId: CommandId.make("bypass-archive"),
              threadId,
            },
            {
              type: "thread.unarchive" as const,
              commandId: CommandId.make("bypass-unarchive"),
              threadId,
            },
          ])
            expect(yield* actor.dispatch(command).pipe(Effect.flip)).toMatchObject({
              reason: "publication_capability_required",
            });
        }
        const memberRegistration = {
          ...registration,
          publicationId: "a".repeat(32),
          capability: "b".repeat(64),
        };
        yield* other.publications.register(memberRegistration);
        yield* spaces.execute(owner, {
          action: "removeMember",
          spaceId,
          userId: contributor.userId,
        });
        expect(
          yield* other.publications
            .publish({ ...memberRegistration, fromRevision: 0, changes: [create] })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "access" });
        expect((yield* connection.query.getSnapshot()).threads[0]?.title).toBe(
          "Published local thread",
        );
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "published chat stays readable through windowed native snapshots without a provider or turn-start reactor",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* seed;
        const { threadId } = yield* connection.publications.register(registration);
        const changes: Array<TeamPublicationChange> = [create];
        for (let index = 0; index < 3; index++) {
          const createdAt = `1970-01-01T00:00:0${index + 1}.000Z`;
          const turnKey = publicationHash(`turn-${index}`);
          changes.push({
            kind: "message",
            key: publicationHash(`user-${index}`),
            turnKey,
            role: "user",
            text: `Prompt ${index}`,
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          });
          changes.push({
            kind: "message",
            key: publicationHash(`assistant-${index}`),
            turnKey,
            role: "assistant",
            text: `Answer ${index}`,
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          });
        }
        yield* connection.publications.publish({ ...registration, fromRevision: 0, changes });
        const first = Option.getOrThrow(
          yield* connection.query.getThreadDetailSnapshot(threadId, { turnLimit: 1 }),
        );
        expect(first.thread.messages.map((message) => message.text).sort()).toEqual([
          "Answer 2",
          "Prompt 2",
        ]);
        expect(first.page?.hasMore).toBe(true);
        const second = Option.getOrThrow(
          yield* connection.query.getThreadDetailSnapshot(threadId, {
            turnLimit: 1,
            beforeCursor: first.page!.beforeCursor!,
          }),
        );
        expect(second.thread.messages.map((message) => message.text).sort()).toEqual([
          "Answer 1",
          "Prompt 1",
        ]);
        const third = Option.getOrThrow(
          yield* connection.query.getThreadDetailSnapshot(threadId, {
            turnLimit: 1,
            beforeCursor: second.page!.beforeCursor!,
          }),
        );
        expect(third.thread.messages.map((message) => message.text).sort()).toEqual([
          "Answer 0",
          "Prompt 0",
        ]);
        expect(third.page?.hasMore).toBe(false);
        const stream = yield* nativeThreadStream(connection, { threadId, turnLimit: 1 });
        const [snapshot] = yield* stream.pipe(Stream.take(1), Stream.runCollect);
        expect(snapshot?.kind).toBe("snapshot");
        if (snapshot?.kind === "snapshot")
          expect(snapshot.snapshot.thread.messages).toHaveLength(2);
        const events = yield* connection.sql<{
          event_type: string;
        }>`SELECT event_type FROM orchestration_events`;
        expect(
          events.some((event) =>
            [
              "thread.turn-start-requested",
              "thread.session-set",
              "thread.turn-diff-completed",
            ].includes(event.event_type),
          ),
        ).toBe(false);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect("keeps database check failures retryable before and during a reserved publication", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { connection, spaces } = yield* seed;
      let checks = 0;
      let failAt = 1;
      const publications = yield* makeTeamPublications({
        projectId: connection.projectId,
        member: connection.member,
        engine: connection.engine,
        withAuthority: spaces.withAuthority,
        check: (write) =>
          Effect.suspend(() =>
            ++checks === failAt
              ? Effect.fail(
                  new SqlError({ reason: new UnknownError({ cause: "private sentinel" }) }),
                )
              : connection.check(write),
          ),
      }).pipe(Effect.provideService(SqlClient.SqlClient, connection.sql));
      expect(yield* publications.register(registration).pipe(Effect.flip)).toMatchObject({
        reason: "unavailable",
      });
      failAt = 0;
      yield* publications.register(registration);
      const batch = { ...registration, fromRevision: 0, changes: [create, user] };
      failAt = checks + 3;
      expect(yield* publications.publish(batch).pipe(Effect.flip)).toMatchObject({
        reason: "unavailable",
      });
      expect((yield* connection.query.getSnapshot()).threads[0]?.messages).toHaveLength(0);
      failAt = 0;
      const ack = yield* publications.publish(batch);
      expect(ack.revision).toBe(2);
      expect((yield* connection.query.getSnapshot()).threads[0]?.messages).toHaveLength(1);
      expect(yield* publications.publish(batch)).toEqual(ack);
    }),
  ).pipe(Effect.provide(layers)),
);

it.effect("reserves publication receipt IDs against generic same-account commands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { connection, projects, spaceId } = yield* seed;
      yield* connection.publications.register(registration);
      const ack = yield* connection.publications.publish({
        ...registration,
        fromRevision: 0,
        changes: [create],
      });
      const otherDevice = yield* projects.connect(owner, spaceId, resolveUser);
      const forged = {
        type: "sidethread.create" as const,
        commandId: CommandId.make(`publication:${registration.publicationId}:1`),
        threadId: ack.threadId,
        sideThreadId: sideThreadIdForThread(ack.threadId),
        createdAt: time,
      };
      expect(yield* otherDevice.dispatch(forged).pipe(Effect.flip)).toMatchObject({
        reason: "reserved_command_id",
      });
      yield* connection.publications.publish({ ...registration, fromRevision: 1, changes: [user] });
      const thread = (yield* connection.query.getSnapshot()).threads[0];
      expect(thread?.messages).toHaveLength(1);
      expect(thread?.sideThreads ?? []).toHaveLength(0);
    }),
  ).pipe(Effect.provide(layers)),
);

it.effect(
  "treats archive publication as idempotent state and resumes exact batches across repeated states",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* seed;
        yield* connection.publications.register(registration);
        const batch = {
          ...registration,
          fromRevision: 0,
          changes: [
            create,
            { kind: "archive" as const, archived: false, updatedAt: time },
            { kind: "archive" as const, archived: true, updatedAt: time },
            { kind: "archive" as const, archived: true, updatedAt: time },
            { kind: "archive" as const, archived: false, updatedAt: time },
          ],
        };
        const ack = yield* connection.publications.publish(batch);
        expect(ack.revision).toBe(5);
        expect(yield* connection.publications.publish(batch)).toEqual(ack);
        expect((yield* connection.query.getSnapshot()).threads[0]?.archivedAt).toBeNull();
        const bad = {
          ...registration,
          fromRevision: 5,
          changes: [{ kind: "metadata" as const, title: " ", updatedAt: time }],
        };
        expect(yield* connection.publications.publish(bad).pipe(Effect.flip)).toMatchObject({
          reason: "limit",
        });
        expect(
          yield* connection.sql`SELECT * FROM team_publication_batches WHERE from_revision=5`,
        ).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layers)),
);
