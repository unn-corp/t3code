import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const TEAM_PUBLICATION_MAX_BYTES = 512 * 1024;
export const TEAM_PUBLICATION_MAX_CHANGES = 64;
export const TeamOpaqueId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
export const TeamSourceKey = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const TeamPublicationDisplay = Schema.Struct({
  provider: Schema.Literals(["codex", "claude", "cursor", "grok", "hermes", "opencode", "other"]),
  model: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9 ._:+-]{0,199}$/)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type TeamPublicationDisplay = typeof TeamPublicationDisplay.Type;
const Title = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.isPattern(/\S/),
);

/** Only this projection crosses from a member's runtime into the shared project. */
export const TeamPublicationMessage = Schema.Struct({
  kind: Schema.Literal("message"),
  key: TeamSourceKey,
  turnKey: TeamSourceKey,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(120000)),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type TeamPublicationMessage = typeof TeamPublicationMessage.Type;
export const TeamPublicationChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    title: Title,
    display: TeamPublicationDisplay,
    createdAt: IsoDateTime,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("metadata"),
    title: Schema.optional(Title),
    display: Schema.optional(TeamPublicationDisplay),
    updatedAt: IsoDateTime,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  TeamPublicationMessage,
  Schema.Struct({
    kind: Schema.Literal("status"),
    status: Schema.Literals(["idle", "working", "waiting", "completed", "failed", "stopped"]),
    updatedAt: IsoDateTime,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("archive"),
    archived: Schema.Boolean,
    updatedAt: IsoDateTime,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type TeamPublicationChange = typeof TeamPublicationChange.Type;

// A random capability is generated and retained by the publishing personal
// server. The cloud retains its hash. IDs and an account session do not suffice.
export const TeamPublicationRegister = Schema.Struct({
  publicationId: TeamOpaqueId,
  installationId: TeamOpaqueId,
  capability: TeamSourceKey,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type TeamPublicationRegister = typeof TeamPublicationRegister.Type;
export const TeamPublicationBatch = Schema.Struct({
  ...TeamPublicationRegister.fields,
  fromRevision: NonNegativeInt,
  changes: Schema.Array(TeamPublicationChange).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(TEAM_PUBLICATION_MAX_CHANGES),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type TeamPublicationBatch = typeof TeamPublicationBatch.Type;
export const TeamPublicationAck = Schema.Struct({
  threadId: ThreadId,
  revision: NonNegativeInt,
  sequence: NonNegativeInt,
});
export type TeamPublicationAck = typeof TeamPublicationAck.Type;
export class TeamPublicationError extends Schema.TaggedError<TeamPublicationError>()(
  "TeamPublicationError",
  {
    reason: Schema.Literals([
      "access",
      "publisher",
      "conflict",
      "order",
      "limit",
      "reset_required",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}
export const TEAM_PUBLICATION_METHODS = {
  register: "teams.publication.register",
  publish: "teams.publication.publish",
} as const;
