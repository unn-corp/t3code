import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { TeamMemberReportedStatus } from "@t3tools/contracts/teamProjects";
import {
  ProjectId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import type {
  TeamSharedMessage,
  TeamSharedThreadSnapshot,
  TeamSharedThreadSummary,
} from "@t3tools/contracts/teamProjects";
import {
  publicationDisplay,
  publicationText,
  type LocalTeamLinkRow,
  type LocalTeamPublicationRow,
} from "./LocalTeamProjectStore.ts";

const decodeMemberStatus = Schema.decodeUnknownOption(TeamMemberReportedStatus);

export const sharedSummary = (
  link: LocalTeamLinkRow,
  mappings: ReadonlyArray<LocalTeamPublicationRow>,
  thread: Pick<
    OrchestrationThreadShell,
    "id" | "title" | "modelSelection" | "createdBy" | "createdAt" | "updatedAt" | "archivedAt"
  > &
    Pick<Partial<OrchestrationThreadShell>, "teamDiscussion">,
): TeamSharedThreadSummary => {
  const owned = mappings.find((item) => item.shared_thread_id === thread.id);
  const projectId = ProjectId.make(link.project_id);
  const writable = link.role !== "viewer";
  return {
    id: thread.id,
    title: thread.title,
    display: publicationDisplay(thread.modelSelection),
    ...(thread.teamDiscussion ? { discussion: thread.teamDiscussion } : {}),
    createdBy: thread.createdBy ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    source: {
      displayProjectRef: { projectId },
      readSource: owned
        ? { kind: "local", threadId: ThreadId.make(owned.thread_id) }
        : { kind: "shared", sourceId: link.link_id, threadId: thread.id },
      executionRef: owned ? { projectId, threadId: ThreadId.make(owned.thread_id) } : null,
      discussionRef: { linkId: link.link_id, threadId: thread.id },
      assetSource: owned ? "local" : "unavailable",
      fileSource: owned ? "local" : "unavailable",
      contentFormat: owned ? "native" : "plain-text",
      access: {
        execute: !!owned && writable,
        publish: !!owned && writable,
        discuss: writable,
        markRead: true,
      },
    },
  };
};
export const sharedMessage = (message: OrchestrationMessage): TeamSharedMessage => ({
  id: message.id,
  role: message.role,
  text: publicationText(message.text),
  streaming: message.streaming,
  author: message.author ?? null,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});
export const memberReportedStatus = (activity: {
  kind: string;
  payload: unknown;
  createdAt: string;
}) =>
  activity.kind !== "shared.member-status"
    ? null
    : Option.getOrNull(
        decodeMemberStatus({
          ...(typeof activity.payload === "object" && activity.payload !== null
            ? activity.payload
            : {}),
          updatedAt: activity.createdAt,
        }),
      );
export const sharedSnapshot = (
  link: LocalTeamLinkRow,
  mappings: ReadonlyArray<LocalTeamPublicationRow>,
  snapshot: OrchestrationThreadDetailSnapshot,
): TeamSharedThreadSnapshot => ({
  snapshotSequence: snapshot.snapshotSequence,
  memberStatus:
    snapshot.thread.activities.map(memberReportedStatus).findLast((status) => status !== null) ??
    null,
  thread: sharedSummary(link, mappings, snapshot.thread),
  messages: snapshot.thread.messages.map(sharedMessage),
  discussions: (snapshot.thread.sideThreads ?? []).map((discussion) => ({
    id: discussion.id,
    createdBy: discussion.createdBy,
    createdAt: discussion.createdAt,
    updatedAt: discussion.updatedAt,
    archivedAt: discussion.archivedAt,
    ...(discussion.anchorMessageId ? { anchorMessageId: discussion.anchorMessageId } : {}),
    ...(discussion.readBy ? { readBy: discussion.readBy } : {}),
    messages: discussion.messages.map(({ attachments: _attachments, ...message }) => ({
      ...message,
      text: publicationText(message.text),
    })),
  })),
  ...(snapshot.page ? { page: snapshot.page } : {}),
});
