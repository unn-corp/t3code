import { useRouter } from "@tanstack/react-router";
import { TeamDiscussionButton } from "./TeamDiscussion";
import { useEffect } from "react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { teamProjects, sharedProjectSourceScope } from "../../state/teamProjects";
import { useEnvironmentQuery } from "../../state/query";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useAtomCommand } from "../../state/use-atom-command";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";

export async function continueSharedConversation(options: {
  readonly isCurrent: () => Promise<boolean>;
  readonly createDraft: () => Promise<{ draftId: DraftId; threadId: ThreadId } | null>;
  readonly isDestinationCurrent: (draft: { draftId: DraftId; threadId: ThreadId }) => boolean;
  readonly writeQuote: (draft: { draftId: DraftId; threadId: ThreadId }) => void;
}) {
  if (!(await options.isCurrent())) return;
  const draft = await options.createDraft();
  if (!draft || !(await options.isCurrent()) || !options.isDestinationCurrent(draft)) return;
  options.writeQuote(draft);
}

function AuthorizedSharedChatView({
  environmentId,
  projectId,
  threadId,
  sourceScope,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  sourceScope: string;
}) {
  const snapshot = useEnvironmentQuery(
    teamProjects.snapshot({ environmentId, sourceScope, input: { projectId, threadId } }),
  );
  const stream = useEnvironmentQuery(
    teamProjects.thread({ environmentId, sourceScope, input: { projectId, threadId } }),
  );
  const createDraft = useNewThreadHandler();
  const router = useRouter();
  const readState = useAtomCommand(teamProjects.readState, {
    reportFailure: false,
    reportDefect: false,
  });
  const readSnapshot = useAtomCommand(teamProjects.readSnapshot, {
    reportFailure: false,
    reportDefect: false,
  });
  const links = useEnvironmentQuery(teamProjects.state({ environmentId, input: {} }));
  const current =
    stream.data?.snapshot &&
    (!snapshot.data || stream.data.snapshot.snapshotSequence >= snapshot.data.snapshotSequence)
      ? stream.data.snapshot
      : snapshot.data;
  const refreshRevision = stream.data?.refreshRevision ?? 0;
  const refreshSnapshot = snapshot.refresh;
  useEffect(() => {
    if (refreshRevision) refreshSnapshot();
  }, [refreshRevision, refreshSnapshot]);
  const continueLocally = async () => {
    const capturedHref = router.state.location.href;
    let navigationRequested = false;
    const captured = current;
    const capturedLink = links.data?.find((entry) => entry.link.projectId === projectId)?.link;
    if (!captured || !capturedLink || !captured.thread.source.access.discuss) return;
    const capturedSource = JSON.stringify(captured.thread.source);
    const isCurrent = async () => {
      if (!navigationRequested && router.state.location.href !== capturedHref) return false;
      const states = await readState({ environmentId, input: {} });
      if (!states || states._tag !== "Success") return false;
      const link = states.value.find((entry) => entry.link.projectId === projectId)?.link;
      if (
        !link ||
        sharedProjectSourceScope(link) !== sourceScope ||
        ["account-changed", "access-revoked", "root-changed"].includes(link.status)
      )
        return false;
      const snapshot = await readSnapshot({ environmentId, input: { projectId, threadId } });
      return (
        !!snapshot &&
        snapshot._tag === "Success" &&
        JSON.stringify(snapshot.value.thread.source) === capturedSource &&
        (navigationRequested || router.state.location.href === capturedHref)
      );
    };
    await continueSharedConversation({
      isCurrent,
      createDraft: () => {
        navigationRequested = true;
        return createDraft(scopeProjectRef(environmentId, projectId), {
          envMode: "local",
          teamLocalOnly: true,
          canCreate: isCurrent,
        });
      },
      isDestinationCurrent: (draft) => {
        const store = useComposerDraftStore.getState();
        const destination = store.getDraftSession(draft.draftId);
        const route = router.state.matches.at(-1)?.params;
        return (
          !!route &&
          "draftId" in route &&
          route.draftId === draft.draftId &&
          destination?.environmentId === environmentId &&
          destination.projectId === projectId &&
          destination.threadId === draft.threadId &&
          destination.teamLocalOnly === true &&
          !destination.promotedTo &&
          !store.getComposerDraft(draft.draftId)?.prompt.trim()
        );
      },
      writeQuote: (draft) =>
        useComposerDraftStore.getState().setPrompt(
          draft.draftId,
          `Context quoted from ${captured.thread.createdBy?.displayName ?? "a teammate"}'s conversation "${captured.thread.title}".\n\n${captured.messages
            .slice(-4)
            .map((message) => `${message.role}: ${message.text.slice(0, 4000)}`)
            .join("\n\n")}`,
        ),
    });
  };
  return (
    <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
        <div>
          <h1 className="text-base font-medium">
            {current?.thread.title ?? "Shared conversation"}
          </h1>
          <p className="text-xs text-muted-foreground">
            {current?.thread.createdBy?.displayName ?? "Team member"} -{" "}
            {current?.thread.display.provider} {current?.thread.display.model}
            {current?.memberStatus ? ` - ${current.memberStatus.status} (member reported)` : ""}
          </p>
        </div>
        {current?.thread.source.access.discuss && (
          <Button variant="outline" onClick={() => void continueLocally()}>
            Continue with my agent
          </Button>
        )}
      </header>
      <div className="px-4 py-2">
        <TeamDiscussionButton
          environmentId={environmentId}
          projectId={projectId}
          threadId={threadId}
        />
      </div>
      <p className="px-4 py-2 text-xs text-muted-foreground">
        Read-only teammate conversation. Coding agents run on their own machines.
      </p>
      {current ? (
        <MessagesTimeline contentFormat="plain-text" messages={current.messages} />
      ) : (
        <p className="p-4 text-sm">{snapshot.error ?? "Loading shared conversation..."}</p>
      )}
    </SidebarInset>
  );
}

export function SharedChatView(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const links = useEnvironmentQuery(
    teamProjects.state({ environmentId: props.environmentId, input: {} }),
  );
  const link = links.data?.find((entry) => entry.link.projectId === props.projectId)?.link;
  if (
    !link ||
    link.status === "account-changed" ||
    link.status === "access-revoked" ||
    link.status === "root-changed"
  )
    return (
      <SidebarInset className="p-4">
        <p>Reconnect this project's Teams account before viewing shared conversations.</p>
      </SidebarInset>
    );
  return (
    <AuthorizedSharedChatView
      key={`${link.id}:${link.generation}`}
      sourceScope={sharedProjectSourceScope(link)}
      {...props}
    />
  );
}
