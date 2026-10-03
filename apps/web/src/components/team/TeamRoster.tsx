import { useState } from "react";
import type { TeamDirectory, TeamRosterCommand } from "@t3tools/contracts/teamSpaces";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function TeamRoster({
  directory,
  busy,
  execute,
}: {
  directory: TeamDirectory;
  busy: boolean;
  execute: (command: TeamRosterCommand) => Promise<unknown>;
}) {
  const [email, setEmail] = useState("");
  const owners = directory.members.filter((member) => member.role === "owner").length;
  return (
    <div className="flex flex-col gap-3">
      <p>Team role: {directory.role ?? "Not a team member"}</p>
      {!directory.role && (
        <p>
          An owner must invite your verified sign-in email. After accepting the email invitation,
          sign in to T3 to join.
        </p>
      )}
      {directory.members.length > 0 && (
        <>
          <h3 className="font-medium">Team members</h3>
          {directory.members.map((member) => {
            const finalOwner = member.role === "owner" && owners === 1;
            return (
              <div key={member.user.subject} className="flex flex-wrap items-center gap-2">
                <span className="flex-1">{member.user.displayName}</span>
                {directory.canInviteMembers ? (
                  <>
                    <select
                      aria-label={`Team role for ${member.user.displayName}`}
                      className="rounded border bg-background p-1"
                      value={member.role}
                      disabled={busy || finalOwner}
                      onChange={(event) =>
                        void execute({
                          action: "setRole",
                          userId: member.user.subject,
                          role: event.target.value === "owner" ? "owner" : "member",
                        })
                      }
                    >
                      <option value="owner">owner</option>
                      <option value="member">member</option>
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || finalOwner}
                      onClick={() =>
                        void execute({ action: "removeMember", userId: member.user.subject })
                      }
                    >
                      Remove from team
                    </Button>
                    {finalOwner && (
                      <span className="text-xs text-muted-foreground">Last team owner</span>
                    )}
                  </>
                ) : (
                  <span>{member.role}</span>
                )}
              </div>
            );
          })}
        </>
      )}
      {directory.canInviteMembers && (
        <>
          <h3 className="font-medium">Invite someone to the team</h3>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void execute({ action: "invite", email: email.trim() });
            }}
          >
            <Input
              aria-label="Team invite email"
              type="email"
              placeholder="Verified sign-in email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              required
            />
            <Button type="submit" disabled={busy || !email.trim()}>
              Invite member
            </Button>
          </form>
          <p className="text-muted-foreground">
            Clerk emails a single-use invitation that expires after seven days. The invited person
            signs in with that verified email to join. Assign projects after the person joins.
          </p>
          {directory.invites.map((invite) => (
            <div key={invite.id} className="flex flex-wrap items-center gap-2">
              <span className="flex-1">
                {invite.email} - expires {new Date(invite.expiresAt).toLocaleDateString()}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void execute({ action: "cancelInvite", inviteId: invite.id })}
              >
                Cancel team invitation
              </Button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
