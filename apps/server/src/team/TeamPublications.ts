import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandIdConflictError,
} from "../orchestration/Errors.ts";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CollaborationUser,
  type OrchestrationCommand,
  type ProjectId,
} from "@t3tools/contracts";
import {
  TeamPublicationBatch,
  TeamPublicationRegister,
  TeamPublicationError,
  TEAM_PUBLICATION_MAX_BYTES,
  type TeamPublicationAck,
} from "@t3tools/contracts/teamPublication";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { TeamDenied, type TeamSpaces } from "./TeamSpaces.ts";

const isPublicationError = Schema.is(TeamPublicationError);
const decodeRegistration = Schema.decodeUnknownEffect(TeamPublicationRegister, {
  onExcessProperty: "error",
});
const decodeBatch = Schema.decodeUnknownEffect(TeamPublicationBatch, { onExcessProperty: "error" });
const isInvariantError = Schema.is(OrchestrationCommandInvariantError);
const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);
const isReceiptConflict = Schema.is(OrchestrationCommandIdConflictError);

export const publicationHash = (...parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const publicationThreadId = (projectId: string, publicationId: string) =>
  ThreadId.make(`shared:${publicationHash(projectId, publicationId, "thread")}`);
export const publicationRef = (
  projectId: string,
  publicationId: string,
  kind: string,
  key: string,
) => `shared:${publicationHash(projectId, publicationId, kind, key)}`;
const denied = (reason: TeamPublicationError["reason"]) =>
  new TeamPublicationError({
    reason,
    message: "Shared thread publication is unavailable or requires review.",
  });
const encodeBatch = Schema.encodeEffect(Schema.fromJsonString(TeamPublicationBatch));
type Publisher = {
  project_id: string;
  subject: string;
  installation_id: string;
  capability_hash: string;
  thread_id: string;
  revision: number;
  result_sequence: number;
};

/** This boundary is the sole writer of published agent history in a cloud runtime. */
export const makeTeamPublications = Effect.fnUntraced(function* (input: {
  projectId: ProjectId;
  member: CollaborationUser;
  engine: OrchestrationEngineShape;
  check: (write?: boolean) => Effect.Effect<unknown, TeamDenied | SqlError>;
  withAuthority: TeamSpaces["Service"]["withAuthority"];
}) {
  const sql = yield* SqlClient.SqlClient;
  const owner = Effect.fnUntraced(function* (registration: TeamPublicationRegister) {
    const rows =
      yield* sql<Publisher>`SELECT * FROM team_publications WHERE publication_id=${registration.publicationId}`;
    const value = rows[0];
    if (
      !value ||
      value.project_id !== input.projectId ||
      value.subject !== input.member.subject ||
      value.installation_id !== registration.installationId ||
      value.capability_hash !== publicationHash(registration.capability)
    )
      return yield* denied("publisher");
    return value;
  });
  const guard = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      input.withAuthority,
      Effect.uninterruptible,
      Effect.withTracerEnabled(false),
      Effect.catchCause((cause) => {
        const failure = cause.reasons.find((reason) => reason._tag === "Fail");
        return Effect.fail(
          failure?._tag === "Fail" && isPublicationError(failure.error)
            ? failure.error
            : denied("unavailable"),
        );
      }),
    );
  const register = Effect.fnUntraced(function* (value: TeamPublicationRegister) {
    yield* input
      .check(true)
      .pipe(
        Effect.mapError((error) => denied(error instanceof TeamDenied ? "access" : "unavailable")),
      );
    const registration = yield* decodeRegistration(value).pipe(
      Effect.mapError(() => denied("publisher")),
    );
    const threadId = publicationThreadId(input.projectId, registration.publicationId);
    yield* sql`INSERT INTO team_publications(publication_id,project_id,subject,installation_id,capability_hash,thread_id)
      VALUES(${registration.publicationId},${input.projectId},${input.member.subject},${registration.installationId},${publicationHash(registration.capability)},${threadId}) ON CONFLICT(publication_id) DO NOTHING`;
    const publisher = yield* owner(registration);
    return {
      threadId,
      revision: publisher.revision,
      sequence: publisher.result_sequence,
    } satisfies TeamPublicationAck;
  }, guard);
  const publish = Effect.fnUntraced(function* (value: TeamPublicationBatch) {
    yield* input
      .check(true)
      .pipe(
        Effect.mapError((error) => denied(error instanceof TeamDenied ? "access" : "unavailable")),
      );
    const batch = yield* decodeBatch(value).pipe(Effect.mapError(() => denied("limit")));
    const encoded = yield* encodeBatch(batch);
    if (Buffer.byteLength(encoded) > TEAM_PUBLICATION_MAX_BYTES) return yield* denied("limit");
    const publisher = yield* owner(batch);
    const threadId = ThreadId.make(publisher.thread_id);
    const digest = publicationHash(encoded);
    const toRevision = batch.fromRevision + batch.changes.length;
    const existing = (yield* sql<{
      digest: string;
      to_revision: number;
      result_sequence: number | null;
    }>`SELECT digest,to_revision,result_sequence FROM team_publication_batches WHERE publication_id=${batch.publicationId} AND from_revision=${batch.fromRevision}`)[0];
    if (existing) {
      if (existing.digest !== digest || existing.to_revision !== toRevision)
        return yield* denied("conflict");
      if (existing.result_sequence !== null)
        return {
          threadId,
          revision: existing.to_revision,
          sequence: existing.result_sequence,
        } satisfies TeamPublicationAck;
    }
    if (batch.fromRevision !== publisher.revision) return yield* denied("order");
    if (
      (batch.fromRevision === 0 && batch.changes[0]?.kind !== "create") ||
      batch.changes.some(
        (change, index) => change.kind === "create" && (batch.fromRevision !== 0 || index !== 0),
      ) ||
      batch.changes.some(
        (change) => change.kind === "message" && change.role === "user" && change.streaming,
      )
    )
      return yield* denied("order");
    // Reserve before dispatch: a crash after any receipt can only resume this
    // exact batch. Its command IDs recover partial application idempotently.
    yield* sql`INSERT INTO team_publication_batches(publication_id,from_revision,to_revision,digest)
      VALUES(${batch.publicationId},${batch.fromRevision},${toRevision},${digest}) ON CONFLICT(publication_id,from_revision) DO NOTHING`;
    let sequence = publisher.result_sequence;
    for (const [index, change] of batch.changes.entries()) {
      yield* input
        .check(true)
        .pipe(
          Effect.mapError((error) =>
            denied(error instanceof TeamDenied ? "access" : "unavailable"),
          ),
        );
      const commandId = CommandId.make(
        `publication:${batch.publicationId}:${batch.fromRevision + index}`,
      );
      const reference = (kind: string, key: string) =>
        publicationRef(input.projectId, batch.publicationId, kind, key);
      let command: OrchestrationCommand;
      switch (change.kind) {
        case "create":
          command = {
            type: "thread.create",
            commandId,
            threadId,
            projectId: input.projectId,
            title: change.title,
            modelSelection: {
              instanceId: ProviderInstanceId.make(change.display.provider),
              model: change.display.model,
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: change.createdAt,
          };
          break;
        case "metadata":
          command = {
            type: "thread.meta.update",
            commandId,
            threadId,
            title: change.title,
            ...(change.display
              ? {
                  modelSelection: {
                    instanceId: ProviderInstanceId.make(change.display.provider),
                    model: change.display.model,
                  },
                }
              : {}),
          };
          break;
        case "message": {
          yield* sql`INSERT INTO team_publication_messages(publication_id,message_key,ordinal)
            SELECT ${batch.publicationId},${change.key},COALESCE(MAX(ordinal),0)+1 FROM team_publication_messages WHERE publication_id=${batch.publicationId}
            ON CONFLICT(publication_id,message_key) DO NOTHING`;
          const ordinal = (yield* sql<{
            ordinal: number;
          }>`SELECT ordinal FROM team_publication_messages WHERE publication_id=${batch.publicationId} AND message_key=${change.key}`)[0]!
            .ordinal;
          const messageId = MessageId.make(
            `shared:${String(ordinal).padStart(16, "0")}:${publicationHash(input.projectId, batch.publicationId, "message", change.key)}`,
          );
          command = {
            type: "thread.publication.message",
            commandId,
            threadId,
            messageId,
            turnId: TurnId.make(reference("turn", change.turnKey)),
            role: change.role,
            text: change.text,
            streaming: change.streaming,
            createdAt: change.createdAt,
            updatedAt: change.updatedAt,
          };
          break;
        }
        case "status":
          command = {
            type: "thread.activity.append",
            commandId,
            threadId,
            createdAt: change.updatedAt,
            activity: {
              id: EventId.make(reference("activity", String(batch.fromRevision + index))),
              kind: "shared.member-status",
              tone: "info",
              summary: `Member reported: ${change.status}`,
              payload: { status: change.status, reportedBy: input.member.subject },
              turnId: null,
              createdAt: change.updatedAt,
            },
          };
          break;
        case "archive":
          command = {
            type: "thread.publication.archive",
            commandId,
            threadId,
            archived: change.archived,
            updatedAt: change.updatedAt,
          };
          break;
      }
      sequence = (yield* input.engine
        .dispatch(command, { collaborationUser: input.member })
        .pipe(
          Effect.mapError((error) =>
            isInvariantError(error) || isPreviouslyRejected(error) || isReceiptConflict(error)
              ? denied("reset_required")
              : denied("unavailable"),
          ),
        )).sequence;
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE team_publication_batches SET result_sequence=${sequence} WHERE publication_id=${batch.publicationId} AND from_revision=${batch.fromRevision}`;
        yield* sql`UPDATE team_publications SET revision=${toRevision},result_sequence=${sequence} WHERE publication_id=${batch.publicationId} AND revision=${batch.fromRevision}`;
      }),
    );
    return { threadId, revision: toRevision, sequence } satisfies TeamPublicationAck;
  }, guard);
  return { register, publish };
});
