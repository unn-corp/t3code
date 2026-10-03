import { createTeamPresenceHeartbeat } from "@t3tools/client-runtime/state/teamPresenceHeartbeat";
import { Link } from "@tanstack/react-router";
import { randomUUID } from "../../lib/utils";
// Adapted from Campfire's SideThreadDrawer and sideThreadUiStore; see NOTICE.md.
import { create } from "zustand";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CommandId,
  SideThreadMessageId,
  MessageId,
  ThreadId,
  type ClientOrchestrationCommand,
  type EnvironmentId,
  type ProjectId,
  type SideThreadMessage,
} from "@t3tools/contracts";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { teamProjects, sharedProjectSourceScope } from "../../state/teamProjects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";

const QUICK_REACTIONS = ["Like", "Thanks", "Seen", "Celebrate"] as const;
export const discussionSourceKey = (
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
) => JSON.stringify([environmentId, projectId, threadId]);
const useDiscussionUi = create<{
  requestedThreadKey: string | null;
  requestOpen: (key: string) => void;
  close: () => void;
}>((set) => ({
  requestedThreadKey: null,
  requestOpen: (requestedThreadKey) => set({ requestedThreadKey }),
  close: () => set({ requestedThreadKey: null }),
}));

export function TeamDiscussionButton({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const links = useEnvironmentQuery(teamProjects.state({ environmentId, input: {} }));
  const project = links.data?.find((entry) => entry.link.projectId === projectId);
  const shared = useEnvironmentQuery(
    project && !["account-changed", "access-revoked", "root-changed"].includes(project.link.status)
      ? teamProjects.project({
          environmentId,
          sourceScope: sharedProjectSourceScope(project.link),
          input: { projectId },
        })
      : null,
  );
  const summary = shared.data?.find((entry) => entry.id === threadId)?.discussion;
  const readAt =
    summary?.readBy.find((entry) => entry.user.subject === project?.link.subject)?.lastReadAt ?? "";
  const unread =
    !!summary?.latestMessage &&
    summary.latestMessage.author.subject !== project?.link.subject &&
    summary.latestMessage.createdAt > readAt;
  const mentioned = summary?.latestMentions.some(
    (message) =>
      message.createdAt > readAt &&
      message.mentions.some((member) => member.subject === project?.link.subject),
  );
  const sourceKey = discussionSourceKey(environmentId, projectId, threadId);
  const open = useDiscussionUi((state) => state.requestedThreadKey === sourceKey);
  if (
    !project ||
    project.link.status === "account-changed" ||
    project.link.status === "access-revoked" ||
    project.link.status === "root-changed"
  )
    return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => useDiscussionUi.getState().requestOpen(sourceKey)}
      >
        Team discussion{mentioned ? " - mentioned you" : unread ? " - unread" : ""}
      </Button>
      {open && (
        <TeamDiscussionDrawer
          key={`${sourceKey}:${project.link.generation}`}
          environmentId={environmentId}
          projectId={projectId}
          threadId={threadId}
          subject={project.link.subject}
          sourceScope={sharedProjectSourceScope(project.link)}
          onClose={() => useDiscussionUi.getState().close()}
        />
      )}
    </>
  );
}
function TeamDiscussionDrawer({
  environmentId,
  projectId,
  threadId,
  subject,
  sourceScope,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  subject: string;
  sourceScope: string;
  onClose: () => void;
}) {
  const snapshot = useEnvironmentQuery(
    teamProjects.snapshot({ environmentId, sourceScope, input: { projectId, threadId } }),
  );
  const changes = useEnvironmentQuery(
    teamProjects.thread({ environmentId, sourceScope, input: { projectId, threadId } }),
  );
  const directory = useEnvironmentQuery(
    teamProjects.directory({ environmentId, sourceScope, input: { projectId } }),
  );
  const project = useEnvironmentQuery(
    teamProjects.project({ environmentId, sourceScope, input: { projectId } }),
  );
  const presence = useEnvironmentQuery(
    teamProjects.presence({ environmentId, sourceScope, input: { projectId } }),
  );
  const heartbeat = useAtomCommand(teamProjects.heartbeat, {
    reportFailure: false,
    reportDefect: false,
  });
  const discuss = useAtomCommand(teamProjects.discuss, { reportFailure: false });
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const presenceHeartbeat = useMemo(
    () =>
      createTeamPresenceHeartbeat({
        execute: async (focus) => {
          const result = await heartbeat({ environmentId, input: { projectId, focus } });
          if (result._tag === "Success") return null;
          const failure = squashAtomCommandFailure(result);
          return failure instanceof Error
            ? failure.message
            : "Presence heartbeat failed. Reconnect and retry.";
        },
        report: setHeartbeatError,
      }),
    [heartbeat, environmentId, projectId],
  );
  useEffect(() => {
    presenceHeartbeat.open();
    return () => presenceHeartbeat.close();
  }, [presenceHeartbeat]);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<SideThreadMessage | null>(null);
  const [editing, setEditing] = useState<SideThreadMessage | null>(null);
  const [quote, setQuote] = useState("");
  const [linked, setLinked] = useState("");
  const [mentionSubjects, setMentionSubjects] = useState<ReadonlyArray<string>>([]);
  const lastTyping = useRef(0);
  const lastMarked = useRef("");
  const sideThreadId = sideThreadIdForThread(threadId);
  const discussion = snapshot.data?.discussions.find((entry) => entry.id === sideThreadId);
  const writable = snapshot.data?.thread.source.access.discuss === true;
  const currentRead =
    discussion?.readBy?.find((entry) => entry.user.subject === subject)?.lastReadAt ?? "";
  const unread =
    discussion?.messages.filter(
      (message) => message.author.subject !== subject && message.createdAt > currentRead,
    ).length ?? 0;
  const refreshRevision = changes.data?.refreshRevision ?? 0;
  const refreshSnapshot = snapshot.refresh;
  const presenceReady = presence.data !== null && presence.error === null;
  const discussionUpdatedAt = discussion?.updatedAt;
  useEffect(() => {
    if (refreshRevision) refreshSnapshot();
  }, [refreshRevision, refreshSnapshot]);
  useEffect(() => {
    if (!presenceReady) return;
    void presenceHeartbeat.send({ threadId, typing: false });
    const timer = setInterval(() => void presenceHeartbeat.send({ threadId, typing: false }), 5000);
    return () => {
      clearInterval(timer);
      void heartbeat({
        environmentId,
        input: { projectId, focus: { threadId: null, typing: false } },
      });
    };
  }, [presenceReady, environmentId, projectId, threadId, heartbeat, presenceHeartbeat]);
  const send = useCallback(
    async (command: ClientOrchestrationCommand) => {
      const result = await discuss({ environmentId, input: { projectId, command } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "The discussion was not updated. Reconnect and retry.",
        );
        return false;
      }
      refreshSnapshot();
      return true;
    },
    [discuss, environmentId, projectId, refreshSnapshot],
  );
  useEffect(() => {
    if (
      !discussionUpdatedAt ||
      discussionUpdatedAt <= currentRead ||
      lastMarked.current === discussionUpdatedAt
    )
      return;
    lastMarked.current = discussionUpdatedAt;
    const createdAt = new Date().toISOString();
    void send({
      type: "sidethread.mark-read",
      commandId: CommandId.make(randomUUID()),
      threadId,
      sideThreadId,
      createdAt,
      lastReadAt: discussionUpdatedAt,
    });
  }, [discussionUpdatedAt, currentRead, send, threadId, sideThreadId, lastMarked]);
  const post = async () => {
    if (!writable || !text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const createdAt = new Date().toISOString();
      if (
        !discussion &&
        !(await send({
          type: "sidethread.create",
          commandId: CommandId.make(randomUUID()),
          threadId,
          sideThreadId,
          createdAt,
        }))
      )
        return;
      const command: ClientOrchestrationCommand = editing
        ? {
            type: "sidethread.message.edit",
            commandId: CommandId.make(randomUUID()),
            threadId,
            sideThreadId,
            messageId: editing.id,
            text: text.trim(),
            createdAt,
          }
        : {
            type: "sidethread.message.post",
            commandId: CommandId.make(randomUUID()),
            threadId,
            sideThreadId,
            messageId: SideThreadMessageId.make(randomUUID()),
            text: text.trim(),
            createdAt,
            ...(reply ? { replyToSideThreadMessageId: reply.id } : {}),
            ...(quote ? { quotedMessageId: MessageId.make(quote) } : {}),
            ...(linked
              ? { linkedRef: { kind: "agent-thread" as const, threadId: ThreadId.make(linked) } }
              : {}),
            mentions:
              directory.data?.members
                .filter((member) => mentionSubjects.includes(member.user.subject))
                .map((member) => member.user) ?? [],
          };
      if (await send(command)) {
        setText("");
        setReply(null);
        setEditing(null);
        setQuote("");
        setLinked("");
        setMentionSubjects([]);
      }
      void presenceHeartbeat.send({ threadId, typing: false });
    } finally {
      setBusy(false);
    }
  };
  const markAction = async (type: "sidethread.archive" | "sidethread.unarchive") =>
    send({
      type,
      commandId: CommandId.make(randomUUID()),
      threadId,
      sideThreadId,
      createdAt: new Date().toISOString(),
    });
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup className="flex w-full max-w-lg flex-col">
        <SheetHeader>
          <SheetTitle>Team discussion{unread ? ` (${unread} unread)` : ""}</SheetTitle>
          <SheetDescription>
            Project members discussing this shared conversation. Comments never become agent
            prompts.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6" data-slot="sheet-panel">
          <div className="flex flex-col gap-4 text-sm">
            <p className="text-xs text-muted-foreground">
              {presence.error || heartbeatError
                ? "Presence unavailable"
                : presence.data
                  ? presence.data.entries.map((entry) => entry.user.displayName).join(", ") ||
                    "No other active members"
                  : "Connecting presence..."}
            </p>
            {(presence.error || heartbeatError) && (
              <div>
                <p role="alert" className="text-destructive">
                  Presence unavailable: {presence.error ?? heartbeatError}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    presence.refresh();
                    if (presenceReady) void presenceHeartbeat.send({ threadId, typing: false });
                  }}
                >
                  Retry presence
                </Button>
              </div>
            )}
            {!presence.error &&
              !heartbeatError &&
              presence.data?.entries
                .filter(
                  (entry) =>
                    entry.typing && entry.threadId === threadId && entry.user.subject !== subject,
                )
                .map((entry) => (
                  <p key={entry.user.subject} className="text-xs text-muted-foreground">
                    {entry.user.displayName} is typing
                  </p>
                ))}
            {discussion?.archivedAt ? (
              <div className="flex items-center gap-2">
                <span>Discussion archived</span>
                {writable && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void markAction("sidethread.unarchive")}
                  >
                    Reopen discussion
                  </Button>
                )}
              </div>
            ) : discussion && writable ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void markAction("sidethread.archive")}
              >
                Archive discussion
              </Button>
            ) : null}
            {discussion?.messages.map((message) => (
              <article key={message.id} className="rounded border p-3">
                <div className="mb-2 text-xs text-muted-foreground">
                  {message.author.displayName} - {new Date(message.createdAt).toLocaleString()}
                  {message.editedAt ? " - edited" : ""}
                </div>
                {message.replyToSideThreadMessageId && (
                  <blockquote className="mb-2 border-l-2 pl-2 text-xs">
                    Reply to{" "}
                    {
                      discussion.messages.find(
                        (entry) => entry.id === message.replyToSideThreadMessageId,
                      )?.author.displayName
                    }
                    :{" "}
                    {discussion.messages
                      .find((entry) => entry.id === message.replyToSideThreadMessageId)
                      ?.text.slice(0, 300)}
                  </blockquote>
                )}
                {message.quotedMessageId && (
                  <blockquote className="mb-2 whitespace-pre-wrap border-l-2 pl-2 text-xs">
                    {snapshot.data?.messages
                      .find((entry) => entry.id === message.quotedMessageId)
                      ?.text.slice(0, 500) ?? "Quoted conversation message"}
                  </blockquote>
                )}
                <p className="whitespace-pre-wrap break-words">{message.text}</p>
                {message.linkedRef && (
                  <Link
                    className="mt-2 block text-xs underline"
                    to="/shared/$environmentId/$projectId/$sharedThreadId"
                    params={{
                      environmentId,
                      projectId,
                      sharedThreadId: message.linkedRef.threadId,
                    }}
                  >
                    Linked conversation:{" "}
                    {project.data?.find((entry) => entry.id === message.linkedRef?.threadId)
                      ?.title ?? "Shared conversation"}
                  </Link>
                )}
                {message.mentions?.length ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Mentioned: {message.mentions.map((member) => member.displayName).join(", ")}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1">
                  {(message.reactions ?? []).map((reaction) => (
                    <Button
                      key={reaction.emoji}
                      size="sm"
                      variant="outline"
                      disabled={!writable || !!discussion.archivedAt}
                      onClick={() =>
                        void send({
                          type: "sidethread.message.react",
                          commandId: CommandId.make(randomUUID()),
                          threadId,
                          sideThreadId,
                          messageId: message.id,
                          emoji: reaction.emoji,
                          createdAt: new Date().toISOString(),
                        })
                      }
                    >
                      {reaction.emoji} {reaction.users.length}
                    </Button>
                  ))}
                  {writable && !discussion.archivedAt && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setReply(message);
                          setEditing(null);
                        }}
                      >
                        Reply
                      </Button>
                      {message.author.subject === subject && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(message);
                            setText(message.text);
                            setReply(null);
                          }}
                        >
                          Edit
                        </Button>
                      )}
                      {QUICK_REACTIONS.filter(
                        (value) =>
                          !(message.reactions ?? []).some((entry) => entry.emoji === value),
                      ).map((emoji) => (
                        <Button
                          key={emoji}
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void send({
                              type: "sidethread.message.react",
                              commandId: CommandId.make(randomUUID()),
                              threadId,
                              sideThreadId,
                              messageId: message.id,
                              emoji,
                              createdAt: new Date().toISOString(),
                            })
                          }
                        >
                          {emoji}
                        </Button>
                      ))}
                    </>
                  )}
                </div>
              </article>
            ))}
            {!discussion && (
              <p className="text-muted-foreground">
                No discussion yet.
                {!writable
                  ? " Viewers can read discussions when contributors post."
                  : " Post the first comment to start one."}
              </p>
            )}
            {writable && !discussion?.archivedAt && (
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void post();
                }}
              >
                {(reply || editing) && (
                  <div className="flex items-center justify-between">
                    <span>
                      {editing
                        ? "Editing your comment"
                        : `Replying to ${reply?.author.displayName}`}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setReply(null);
                        setEditing(null);
                        setText("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
                <Textarea
                  aria-label="Discussion comment"
                  value={text}
                  maxLength={20000}
                  disabled={busy}
                  onChange={(event) => {
                    setText(event.target.value);
                    if (Date.now() - lastTyping.current >= 1000) {
                      lastTyping.current = Date.now();
                      void presenceHeartbeat.send({ threadId, typing: true });
                    }
                  }}
                />
                {!editing && (
                  <>
                    <select
                      aria-label="Quote conversation message"
                      className="rounded border bg-background p-1"
                      value={quote}
                      onChange={(event) => setQuote(event.target.value)}
                    >
                      <option value="">Quote a conversation message</option>
                      {snapshot.data?.messages.map((message) => (
                        <option key={message.id} value={message.id}>
                          {message.role}: {message.text.slice(0, 80)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Link shared conversation"
                      className="rounded border bg-background p-1"
                      value={linked}
                      onChange={(event) => setLinked(event.target.value)}
                    >
                      <option value="">Link a project conversation</option>
                      {project.data?.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.title}
                        </option>
                      ))}
                    </select>
                    <fieldset>
                      <legend className="text-xs text-muted-foreground">
                        Mention project members
                      </legend>
                      <div className="flex flex-wrap gap-2">
                        {directory.data?.members
                          .filter((member) => member.user.subject !== subject)
                          .map((member) => (
                            <label
                              key={member.user.subject}
                              className="flex items-center gap-1 text-xs"
                            >
                              <input
                                type="checkbox"
                                checked={mentionSubjects.includes(member.user.subject)}
                                onChange={(event) =>
                                  setMentionSubjects((current) =>
                                    event.target.checked
                                      ? [...current, member.user.subject].slice(0, 20)
                                      : current.filter((value) => value !== member.user.subject),
                                  )
                                }
                              />
                              {member.user.displayName}
                            </label>
                          ))}
                      </div>
                    </fieldset>
                  </>
                )}
                <Button type="submit" disabled={busy || !text.trim()}>
                  {busy ? "Posting..." : editing ? "Save edit" : "Post comment"}
                </Button>
              </form>
            )}
            {(error || snapshot.error || changes.error) && (
              <p role="alert" className="text-destructive">
                {error || snapshot.error || changes.error}
              </p>
            )}
          </div>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
