import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { TeamMembershipCommand } from "@t3tools/contracts/teamProjects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { teamProjects } from "../../state/teamProjects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function ProjectMembers({
  environmentId,
  projectId,
  sourceScope,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  sourceScope: string;
}) {
  return (
    <ProjectMembersSession
      key={`${environmentId}:${projectId}:${sourceScope}`}
      environmentId={environmentId}
      projectId={projectId}
      sourceScope={sourceScope}
    />
  );
}
function ProjectMembersSession({
  environmentId,
  projectId,
  sourceScope,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  sourceScope: string;
}) {
  const directory = useEnvironmentQuery(
    teamProjects.directory({ environmentId, sourceScope, input: { projectId } }),
  );
  const command = useAtomCommand(teamProjects.membership, {
    reportFailure: false,
    reportDefect: false,
  });
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"contributor" | "viewer">("contributor");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lifetime = useRef(0);
  useEffect(
    () => () => {
      ++lifetime.current;
    },
    [],
  );
  const execute = async (input: TeamMembershipCommand) => {
    const epoch = lifetime.current;
    setBusy(true);
    setError("");
    const result = await command({ environmentId, input: { projectId, command: input } });
    if (epoch !== lifetime.current) return;
    if (result._tag !== "Success") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error
          ? failure.message
          : "Membership was not changed. Refresh access and retry.",
      );
    } else setUserId("");
    directory.refresh();
    setBusy(false);
  };
  const data = directory.data;
  const manage = data?.canManageMembers === true;
  const available =
    data?.availableMembers?.filter(
      (user) => !data.members.some((member) => member.user.subject === user.subject),
    ) ?? [];
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-medium">Project members</h3>
      <p className="text-muted-foreground">
        The project creator and team owners manage access for existing teammates. Only team owners
        invite new people to the team. Contributors collaborate using local agents; viewers read
        shared conversations and files.
      </p>
      <Button
        className="self-start"
        variant="outline"
        size="sm"
        onClick={() => directory.refresh()}
      >
        Refresh project access
      </Button>
      {data?.members.map((member) => {
        const creator = member.user.subject === data.creatorId;
        return (
          <div key={member.user.subject} className="flex flex-wrap items-center gap-2">
            <span className="flex-1">
              {member.user.displayName}
              {creator ? " (project creator)" : ""}
            </span>
            {manage && !creator ? (
              <>
                <select
                  aria-label={`Role for ${member.user.displayName}`}
                  className="rounded border bg-background p-1"
                  disabled={busy}
                  value={member.role}
                  onChange={(event) => {
                    if (event.target.value === "contributor" || event.target.value === "viewer")
                      void execute({
                        action: "setRole",
                        userId: member.user.subject,
                        role: event.target.value,
                      });
                  }}
                >
                  {member.role === "owner" && (
                    <option value="owner" disabled>
                      owner (legacy)
                    </option>
                  )}
                  <option>contributor</option>
                  <option>viewer</option>
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void execute({ action: "removeMember", userId: member.user.subject })
                  }
                >
                  Remove
                </Button>
              </>
            ) : (
              <span>{member.role}</span>
            )}
          </div>
        );
      })}
      {manage && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (available.some((user) => user.subject === userId))
              void execute({ action: "addMember", userId, role });
          }}
        >
          <select
            aria-label="Existing teammate"
            className="min-w-40 flex-1 rounded border bg-background p-2"
            value={userId}
            disabled={busy}
            onChange={(event) => setUserId(event.target.value)}
          >
            <option value="">Select an existing teammate</option>
            {available.map((user) => (
              <option key={user.subject} value={user.subject}>
                {user.displayName}
              </option>
            ))}
          </select>
          <select
            aria-label="Project member role"
            className="rounded border bg-background p-1"
            value={role}
            disabled={busy}
            onChange={(event) =>
              setRole(event.target.value === "viewer" ? "viewer" : "contributor")
            }
          >
            <option>contributor</option>
            <option>viewer</option>
          </select>
          <Button
            type="submit"
            disabled={busy || !available.some((user) => user.subject === userId)}
          >
            Add to project
          </Button>
        </form>
      )}
      {data?.canInviteMembers === true &&
        data.invites.map((invite) => (
          <div key={invite.id} className="flex items-center justify-between gap-2">
            <span>Legacy project invitation: {invite.email}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void execute({ action: "cancelInvite", inviteId: invite.id })}
            >
              Cancel legacy invitation
            </Button>
          </div>
        ))}
      {(error || directory.error) && (
        <p role="alert" className="text-destructive">
          {error || directory.error}
        </p>
      )}
    </div>
  );
}
