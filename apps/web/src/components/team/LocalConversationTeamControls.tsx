import { TeamDiscussionButton } from "./TeamDiscussion";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LocalTeamProjectState } from "@t3tools/contracts/teamProjects";
import { useState } from "react";
import { teamProjects } from "../../state/teamProjects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "../ui/button";

export const useTeamConversationChoices = create(
  persist<{ choices: Record<string, boolean>; set: (key: string, shared: boolean) => void }>(
    (set) => ({
      choices: {},
      set: (key, shared) => set((state) => ({ choices: { ...state.choices, [key]: shared } })),
    }),
    { name: "t3-shared-conversation-choices-v1" },
  ),
);
export const teamConversationChoiceKey = (
  environmentId: EnvironmentId,
  link: LocalTeamProjectState["link"],
  threadId: ThreadId,
) =>
  JSON.stringify([
    environmentId,
    link.serviceUrl,
    link.sharedProjectId,
    link.id,
    link.generation,
    threadId,
  ]);
export function readTeamConversationChoice(
  environmentId: EnvironmentId,
  link: LocalTeamProjectState["link"],
  threadId: ThreadId,
  localOnly = false,
) {
  return (
    useTeamConversationChoices.getState().choices[
      teamConversationChoiceKey(environmentId, link, threadId)
    ] ?? !localOnly
  );
}
export function LocalConversationTeamControls({
  environmentId,
  projectId,
  threadId,
  isDraft,
  worktreePath,
  localOnly = false,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  isDraft: boolean;
  worktreePath: string | null;
  localOnly?: boolean;
}) {
  const links = useEnvironmentQuery(teamProjects.state({ environmentId, input: {} }));
  const project = links.data?.find((entry) => entry.link.projectId === projectId);
  const choiceKey = project ? teamConversationChoiceKey(environmentId, project.link, threadId) : "";
  const shared = useTeamConversationChoices((state) => state.choices[choiceKey] ?? !localOnly);
  const set = useTeamConversationChoices((state) => state.set);
  const control = useAtomCommand(teamProjects.control, { reportFailure: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [disclose, setDisclose] = useState(false);
  if (!project || project.link.status === "account-changed") return null;
  const publication = project.publications.find((entry) => entry.threadId === threadId);
  const intent = project.publicationIntents?.find((entry) => entry.threadId === threadId);
  const writable =
    project.link.role !== "viewer" &&
    project.link.status !== "access-revoked" &&
    project.link.status !== "root-changed";
  const publish = async (action: "publish" | "stop-publication") => {
    setBusy(true);
    setError("");
    const result = await control({ environmentId, input: { action, projectId, threadId } });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error
          ? failure.message
          : "Sharing is pending. Reconnect Teams and retry sharing; do not resend the agent message.",
      );
    }
    setBusy(false);
    setDisclose(false);
  };
  return (
    <div className="mb-2 rounded border bg-background p-2 text-xs">
      {isDraft ? (
        <>
          <label className="flex items-center gap-2">
            Conversation
            <select
              aria-label="Conversation sharing"
              className="rounded border bg-background p-1"
              value={worktreePath ? "local" : shared ? "shared" : "local"}
              disabled={!writable || !!worktreePath}
              onChange={(event) => set(choiceKey, event.target.value === "shared")}
            >
              <option value="shared">Shared with project members</option>
              <option value="local">Local only</option>
            </select>
          </label>
          {worktreePath && (
            <p className="mt-1 text-muted-foreground">
              Separate worktree conversations stay local. Use the project's shared checkout to
              collaborate.
            </p>
          )}
          <p className="mt-1 text-muted-foreground">
            Your selected provider runs locally. This choice does not start an agent.
          </p>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {publication
              ? publication.paused
                ? "Future sharing stopped"
                : `Shared conversation: ${publication.status}`
              : intent
                ? "Agent turn accepted locally; sharing pending"
                : "Local conversation"}
          </span>
          {publication && !publication.paused ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void publish("stop-publication")}
            >
              Stop future sharing
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !writable || !!worktreePath}
              onClick={() => setDisclose(true)}
            >
              {intent || publication ? "Retry sharing" : "Share conversation"}
            </Button>
          )}
        </div>
      )}
      {publication?.sharedThreadId && (
        <TeamDiscussionButton
          environmentId={environmentId}
          projectId={projectId}
          threadId={publication.sharedThreadId}
        />
      )}
      {disclose && (
        <div className="mt-2 flex flex-col gap-2">
          <p>
            Publish this conversation's current text and future updates to project members? Personal
            attachments, tools, checkpoints, and credentials are not published. Already shared
            history remains available when future sharing stops.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void publish("publish")}>
              Publish conversation
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDisclose(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {!writable && (
        <p className="mt-1 text-muted-foreground">
          Your project access does not permit starting or publishing agent work.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
