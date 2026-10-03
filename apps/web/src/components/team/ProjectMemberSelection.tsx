import type { TeamDirectory, TeamProjectMemberSelections } from "@t3tools/contracts/teamSpaces";

export function ProjectMemberSelection({
  directory,
  subject,
  members,
  onChange,
  disabled,
}: {
  directory: TeamDirectory;
  subject: string;
  members: TeamProjectMemberSelections;
  onChange: (members: TeamProjectMemberSelections) => void;
  disabled: boolean;
}) {
  const available = directory.members.filter((entry) => entry.user.subject !== subject);
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="font-medium">Project access for existing teammates</legend>
      <p className="text-muted-foreground">
        Team owners can access all projects. Select other teammates to give them contributor or
        viewer access.
      </p>
      {available.map(({ user, role }) => {
        const selected = members.find((member) => member.userId === user.subject);
        return (
          <label key={user.subject} className="flex flex-wrap items-center gap-2">
            <span className="flex-1">
              {user.displayName}
              {role === "owner" ? " (team owner)" : ""}
            </span>
            <select
              aria-label={`Project access for ${user.displayName}`}
              className="rounded border bg-background p-1"
              value={selected?.role ?? "none"}
              onChange={(event) => {
                const next = members.filter((member) => member.userId !== user.subject);
                if (event.target.value === "contributor" || event.target.value === "viewer")
                  next.push({ userId: user.subject, role: event.target.value });
                onChange(next);
              }}
            >
              <option value="none">No explicit access</option>
              <option value="contributor">Contributor</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
        );
      })}
      {!available.length && (
        <p className="text-muted-foreground">
          No other team members yet. A team owner can invite people in Settings &gt; Connections
          &gt; Teams.
        </p>
      )}
    </fieldset>
  );
}
