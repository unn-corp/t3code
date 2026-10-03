import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import {
  sharedProjectBoundaryKey,
  sharedProjectVisibilityAtom,
  sharedProjectSourceScope,
} from "../../state/teamProjects";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { teamProjects } from "../../state/teamProjects";
import { useEnvironmentQuery } from "../../state/query";

export function SharedProjectThreads({
  environmentId,
  projectId,
  title,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title?: string | undefined;
}) {
  const links = useEnvironmentQuery(teamProjects.state({ environmentId, input: {} }));
  const visibility = useAtomValue(sharedProjectVisibilityAtom);
  const link = links.data?.find((entry) => entry.link.projectId === projectId)?.link;
  const preferred = link ? visibility.get(sharedProjectBoundaryKey(link)) : undefined;
  return preferred?.preferred === JSON.stringify([environmentId, projectId]) &&
    link &&
    link.status !== "account-changed" &&
    link.status !== "access-revoked" ? (
    <SharedProjectThreadList
      key={`${link.id}:${link.generation}`}
      environmentId={environmentId}
      projectId={projectId}
      owned={preferred.ownedThreadIds}
      subject={link.subject}
      title={title}
      sourceScope={sharedProjectSourceScope(link)}
    />
  ) : null;
}
function SharedProjectThreadList({
  environmentId,
  projectId,
  owned,
  subject,
  title,
  sourceScope,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  owned: ReadonlySet<string>;
  subject: string;
  sourceScope: string;
  title?: string | undefined;
}) {
  const shared = useEnvironmentQuery(
    teamProjects.project({ environmentId, sourceScope, input: { projectId } }),
  );
  const threads = useMemo(
    () =>
      shared.data?.filter(
        (thread) =>
          thread.source.executionRef === null &&
          !owned.has(thread.id) &&
          thread.archivedAt === null,
      ) ?? [],
    [shared.data, owned],
  );
  return (
    <div className="px-2 text-sm">
      {threads.length > 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {title ? `${title} - team conversations` : "Team conversations"}
        </p>
      )}
      {threads.map((thread) => (
        <Link
          key={thread.id}
          to="/shared/$environmentId/$projectId/$sharedThreadId"
          params={{ environmentId, projectId, sharedThreadId: thread.id }}
          className="flex flex-col rounded px-2 py-1.5 hover:bg-sidebar-row-hover"
        >
          <span className="truncate">
            {thread.title}
            {thread.discussion?.latestMessage &&
            thread.discussion.latestMessage.author.subject !== subject &&
            thread.discussion.latestMessage.createdAt >
              (thread.discussion.readBy.find((marker) => marker.user.subject === subject)
                ?.lastReadAt ?? "")
              ? " - unread discussion"
              : ""}
            {thread.discussion?.latestMentions.some(
              (message) =>
                message.mentions.some((member) => member.subject === subject) &&
                message.createdAt >
                  (thread.discussion?.readBy.find((marker) => marker.user.subject === subject)
                    ?.lastReadAt ?? ""),
            )
              ? " - mentioned you"
              : ""}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {thread.createdBy?.displayName ?? "Team member"} - {thread.display.provider}{" "}
            {thread.display.model}
          </span>
        </Link>
      ))}
      {shared.error && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Shared conversations unavailable. Reconnect Teams.
        </p>
      )}
    </div>
  );
}
