import {
  SideThreadId,
  type CollaborationUser,
  type SideThreadShellSummary,
  type SideThread,
  type SideThreadMessage,
  type SideThreadReadMarker,
  type ThreadId,
} from "@t3tools/contracts";

const THREAD_SIDE_THREAD_PREFIX = "thread:";

/** One deterministic human discussion channel for every agent thread. */
export function sideThreadIdForThread(threadId: ThreadId): SideThreadId {
  return SideThreadId.make(`${THREAD_SIDE_THREAD_PREFIX}${threadId}`);
}

export function isSideThreadIdForThread(sideThreadId: SideThreadId, threadId: ThreadId): boolean {
  return sideThreadId === sideThreadIdForThread(threadId);
}

function laterMessage(
  current: SideThreadMessage | undefined,
  candidate: SideThreadMessage,
): SideThreadMessage {
  if (current === undefined) return candidate;
  return (candidate.updatedAt ?? candidate.createdAt) >= (current.updatedAt ?? current.createdAt)
    ? candidate
    : current;
}

/**
 * Collapse pre-thread-level SideThreads into the single canonical team discussion.
 *
 * Legacy Campfire builds created one SideThread per selected agent message. This
 * keeps every durable message/read marker while making the projection compatible
 * with the current one-discussion-per-agent-thread invariant.
 */
export function canonicalizeSideThreads(
  threadId: ThreadId,
  sideThreads: ReadonlyArray<SideThread>,
): ReadonlyArray<SideThread> {
  if (sideThreads.length === 0) return [];

  const canonicalId = sideThreadIdForThread(threadId);
  // Current discussions already follow event order. Preserve that order when
  // multiple posts share the same server timestamp; only legacy channels merge.
  if (sideThreads.length === 1 && sideThreads[0]?.id === canonicalId) return sideThreads;
  const ordered = [...sideThreads].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const primary = ordered.find((sideThread) => sideThread.id === canonicalId) ?? ordered[0]!;

  const messagesById = new Map<string, SideThreadMessage>();
  const readBySubject = new Map<string, SideThreadReadMarker>();
  for (const sideThread of ordered) {
    for (const message of sideThread.messages) {
      messagesById.set(message.id, laterMessage(messagesById.get(message.id), message));
    }
    for (const marker of sideThread.readBy ?? []) {
      const current = readBySubject.get(marker.user.subject);
      if (current === undefined || marker.lastReadAt >= current.lastReadAt) {
        readBySubject.set(marker.user.subject, marker);
      }
    }
  }

  const anchorMessageId =
    primary.anchorMessageId ??
    ordered.find((sideThread) => sideThread.anchorMessageId !== undefined)?.anchorMessageId;
  const archivedAt = ordered.every((sideThread) => sideThread.archivedAt !== null)
    ? ordered
        .map((sideThread) => sideThread.archivedAt!)
        .sort((left, right) => right.localeCompare(left))[0]!
    : null;
  const messages = [...messagesById.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const readBy = [...readBySubject.values()].sort((left, right) =>
    left.user.subject.localeCompare(right.user.subject),
  );

  return [
    {
      ...primary,
      id: canonicalId,
      ...(anchorMessageId === undefined ? {} : { anchorMessageId }),
      createdAt: ordered[0]!.createdAt,
      updatedAt: ordered
        .map((sideThread) => sideThread.updatedAt)
        .sort((left, right) => right.localeCompare(left))[0]!,
      archivedAt,
      messages,
      ...(readBy.length === 0 ? {} : { readBy }),
    },
  ];
}

export const summarizeSideThreads = (
  threadId: ThreadId,
  sideThreads: ReadonlyArray<SideThread>,
): SideThreadShellSummary | undefined => {
  const sideThread =
    sideThreads.find((candidate) => candidate.id === sideThreadIdForThread(threadId)) ??
    sideThreads[0];
  if (!sideThread) return undefined;

  const participants = new Map<string, CollaborationUser>();
  const addParticipant = (user: CollaborationUser) => participants.set(user.subject, user);
  addParticipant(sideThread.createdBy);
  for (const message of sideThread.messages) {
    addParticipant(message.author);
    for (const mention of message.mentions ?? []) addParticipant(mention);
    for (const reaction of message.reactions ?? []) {
      for (const user of reaction.users) addParticipant(user);
    }
  }
  for (const marker of sideThread.readBy ?? []) addParticipant(marker.user);

  const previewMessage = (message: SideThread["messages"][number]) => ({
    id: message.id,
    author: message.author,
    text: message.text.slice(0, 500),
    mentions: [...(message.mentions ?? [])],
    hasAttachments: (message.attachments?.length ?? 0) > 0,
    createdAt: message.createdAt,
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
  });
  const latestMentionBySubject = new Map<string, SideThread["messages"][number]>();
  for (const message of sideThread.messages) {
    for (const mention of message.mentions ?? []) {
      latestMentionBySubject.set(mention.subject, message);
    }
  }

  return {
    id: sideThread.id,
    ...(sideThread.anchorMessageId ? { anchorMessageId: sideThread.anchorMessageId } : {}),
    createdBy: sideThread.createdBy,
    updatedAt: sideThread.updatedAt,
    archivedAt: sideThread.archivedAt,
    messageCount: sideThread.messages.length,
    latestMessage: sideThread.messages.at(-1) ? previewMessage(sideThread.messages.at(-1)!) : null,
    latestMentions: [
      ...new Map(
        [...latestMentionBySubject.values()].map((message) => [message.id, message]),
      ).values(),
    ].map(previewMessage),
    participants: [...participants.values()],
    readBy: [...(sideThread.readBy ?? [])],
  };
};
