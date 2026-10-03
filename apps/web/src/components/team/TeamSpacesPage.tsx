import { useAuth, useClerk } from "@clerk/react";
import { createTeamClient, createTeamSessionTokenGetter } from "@t3tools/client-runtime/teamSpaces";
import type {
  TeamCommand,
  TeamSnapshot,
  TeamSpace,
  TeamDirectory,
  TeamRosterCommand,
  TeamProjectMemberSelections,
} from "@t3tools/contracts/teamSpaces";
import type { TeamMemberDirectory } from "@t3tools/contracts/teamProjects";
import { TeamRoster } from "./TeamRoster";
import { ProjectMemberSelection } from "./ProjectMemberSelection";
import * as Schema from "effect/Schema";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { isElectron } from "../../env";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

const TeamAuthShell = lazy(() =>
  isElectron
    ? import("../clerk/ElectronManagedAuthShell")
    : import("../clerk/BrowserManagedAuthShell"),
);
const Config = Schema.Struct({
  enabled: Schema.Boolean,
  publishableKey: Schema.optionalKey(Schema.String),
});
const decodeConfig = Schema.decodeUnknownSync(Config);
export function TeamSpacesPage() {
  const [config, setConfig] = useState<typeof Config.Type>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(resolvePrimaryEnvironmentHttpUrl("/api/team/config"), {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Team service is unavailable.");
        setConfig(decodeConfig(await response.json()));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : "Team service is unavailable.");
      });
    return () => controller.abort();
  }, []);
  if (error)
    return (
      <main className="p-6" role="alert">
        {error}
      </main>
    );
  if (!config) return <main className="p-6">Loading team projects...</main>;
  if (!config.enabled || !config.publishableKey)
    return (
      <main className="p-6">
        Team projects require a configured Clerk application and allowed client origins.
      </main>
    );
  if (isElectron && import.meta.env.VITE_CLERK_PUBLISHABLE_KEY !== config.publishableKey)
    return (
      <main className="p-6">
        This desktop build requires the same Clerk application as the team service. Open team
        projects in your browser or configure the desktop build for that application.
      </main>
    );
  if (hasCloudPublicConfig() && import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) {
    if (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY !== config.publishableKey)
      return (
        <main className="p-6">
          Team projects and Cloud Connect must use the same Clerk application in this client.
        </main>
      );
    return <TeamSpacesContent />;
  }
  return (
    <Suspense fallback={<main className="p-6">Loading sign-in...</main>}>
      <TeamAuthShell publishableKey={config.publishableKey} managedRelay={false}>
        <TeamSpacesContent />
      </TeamAuthShell>
    </Suspense>
  );
}

function TeamSpacesContent() {
  const { userId, sessionId } = useAuth();
  return <TeamSpacesSession key={`${userId ?? "signed-out"}:${sessionId ?? "no-session"}`} />;
}

function TeamSpacesSession() {
  const { isLoaded, isSignedIn, sessionId, userId } = useAuth();
  const clerk = useClerk();
  const client = useMemo(
    () =>
      createTeamClient(
        resolvePrimaryEnvironmentHttpUrl("/"),
        createTeamSessionTokenGetter({
          userId,
          sessionId,
          session: clerk.session,
          currentSession: () => clerk.session,
        }),
      ),
    [clerk, sessionId, userId],
  );
  const [spaces, setSpaces] = useState<ReadonlyArray<TeamSpace>>([]);
  const [directory, setDirectory] = useState<TeamDirectory | null>(null);
  const [projectDirectory, setProjectDirectory] = useState<TeamMemberDirectory | null>(null);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<TeamSnapshot>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [inviteNotice, setInviteNotice] = useState("");
  const [name, setName] = useState("");
  const [members, setMembers] = useState<TeamProjectMemberSelections>([]);
  const [newMember, setNewMember] = useState("");
  const [memberRole, setMemberRole] = useState<"contributor" | "viewer">("contributor");
  const [message, setMessage] = useState("");
  const [connection, setConnection] = useState("Connecting...");
  const epoch = useRef(0);
  const sessionLifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    sessionLifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, [sessionId, userId]);
  const reads = useRef(new Set<AbortController>());
  const intent = useRef<{ fingerprint: string; requestId: string } | null>(null);
  useEffect(
    () => () => {
      ++epoch.current;
      for (const controller of reads.current) controller.abort();
    },
    [],
  );
  const selectSpace = useCallback((spaceId: string) => {
    ++epoch.current;
    setPending(false);
    setSnapshot(undefined);
    setProjectDirectory(null);
    setInviteNotice("");
    setNewMember("");
    setSelected(spaceId);
  }, []);
  const refreshAccess = useCallback(async () => {
    const current = epoch.current;
    const controller = new AbortController();
    reads.current.add(controller);
    const signal = sessionLifetime.current
      ? AbortSignal.any([controller.signal, sessionLifetime.current.signal])
      : controller.signal;
    setDirectory(null);
    setSpaces([]);
    setProjectDirectory(null);
    setMembers([]);
    setInviteNotice("");
    try {
      const [roster, projects] = await Promise.all([
        client.teamDirectory(signal),
        client.list(signal),
      ]);
      if (current !== epoch.current || signal.aborted) return;
      setDirectory(roster);
      setSpaces(projects.spaces);
      if (selected && !projects.spaces.some((space) => space.id === selected)) selectSpace("");
      else if (selected) {
        const next = await client.memberDirectory(selected, signal);
        if (current === epoch.current && !signal.aborted) setProjectDirectory(next);
      }
    } finally {
      reads.current.delete(controller);
    }
  }, [client, selected, selectSpace]);
  useEffect(() => {
    if (!isSignedIn || !userId) return;
    const current = epoch.current;
    void refreshAccess().catch((cause: unknown) => {
      if (current === epoch.current)
        setError(cause instanceof Error ? cause.message : "Could not load team access.");
    });
  }, [client, isSignedIn, userId, refreshAccess]);
  useEffect(() => {
    if (!selected || !isSignedIn || !userId) return;
    let cancelled = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const signal = sessionLifetime.current
      ? AbortSignal.any([controller.signal, sessionLifetime.current.signal])
      : controller.signal;
    let read = 0;
    const refresh = async () => {
      const version = ++read;
      const current = epoch.current;
      const [result, access] = await Promise.all([
        client.snapshot(selected, 0, signal),
        client.memberDirectory(selected, signal),
      ]);
      if (!cancelled && version === read && current === epoch.current) {
        setSnapshot(result);
        setProjectDirectory(access);
      }
    };
    const connect = async () => {
      try {
        const grant = await client.ticket(selected, signal);
        if (cancelled) return;
        socket = new WebSocket(client.websocketUrl(grant.ticket));
        socket.addEventListener("open", () => {
          if (!cancelled) setConnection("Live");
        });
        socket.addEventListener("message", () => {
          void refresh().catch((cause: unknown) => {
            if (!cancelled) {
              setSnapshot(undefined);
              setProjectDirectory(null);
              setError(String(cause));
            }
          });
        });
        socket.addEventListener("close", () => {
          if (cancelled) return;
          setConnection("Reconnecting...");
          setSnapshot(undefined);
          setProjectDirectory(null);
          retry = setTimeout(() => {
            void connect();
          }, 1500);
        });
        await refresh();
      } catch (cause) {
        if (!cancelled) {
          setSnapshot(undefined);
          setProjectDirectory(null);
          setError(String(cause));
          setConnection("Disconnected");
        }
      }
    };
    setSnapshot(undefined);
    setProjectDirectory(null);
    setConnection("Connecting...");
    void connect();
    return () => {
      cancelled = true;
      controller.abort();
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [client, selected, isSignedIn, userId]);
  async function execute(command: TeamCommand | TeamRosterCommand, roster = false) {
    const current = epoch.current;
    const signal = sessionLifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setPending(true);
    setError("");
    setInviteNotice("");
    try {
      const result = roster
        ? await client.teamCommand(command as TeamRosterCommand, signal)
        : await client.command(command as TeamCommand, signal);
      if (current !== epoch.current) return;
      await refreshAccess();
      if (current !== epoch.current) return;
      if (roster && command.action === "invite" && !result.token)
        setInviteNotice(
          "Invitation email sent. The recipient can sign in to T3 after accepting it.",
        );
      if (
        !roster &&
        command.action === "create" &&
        "spaceId" in result &&
        typeof result.spaceId === "string"
      )
        selectSpace(result.spaceId);
      if (command.action === "message") setMessage("");
      if (selected) {
        const next = await client.snapshot(selected, 0, signal);
        if (current === epoch.current) setSnapshot(next);
      }
    } catch (cause) {
      if (current === epoch.current) {
        setProjectDirectory(null);
        setError(cause instanceof Error ? cause.message : "Team request failed.");
      }
    } finally {
      if (current === epoch.current) setPending(false);
    }
  }
  const fingerprint = JSON.stringify({ name: name.trim(), members, userId });
  useEffect(() => {
    if (intent.current?.fingerprint !== fingerprint) intent.current = null;
  }, [fingerprint]);
  const available =
    projectDirectory?.availableMembers?.filter(
      (user) => !projectDirectory.members.some((member) => member.user.subject === user.subject),
    ) ?? [];
  if (!isLoaded) return <main className="p-6">Loading sign-in...</main>;
  if (!isSignedIn)
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4">
        <h1 className="text-xl font-semibold">Team projects</h1>
        <Button
          onClick={() =>
            clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron))
          }
        >
          Sign in with Clerk
        </Button>
      </main>
    );
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Team projects</h1>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            sessionLifetime.current?.abort();
            ++epoch.current;
            setDirectory(null);
            setSpaces([]);
            setSnapshot(undefined);
            setProjectDirectory(null);
            setMembers([]);
            setInviteNotice("");
            void clerk.signOut();
          }}
        >
          Sign out
        </Button>
      </header>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button
        className="self-start"
        variant="outline"
        disabled={pending}
        onClick={() => {
          ++epoch.current;
          const current = epoch.current;
          void refreshAccess().catch((cause: unknown) => {
            if (current === epoch.current) setError(String(cause));
          });
        }}
      >
        Refresh team access
      </Button>
      {inviteNotice && <p role="status">{inviteNotice}</p>}
      {directory && (
        <TeamRoster
          directory={directory}
          busy={pending}

          execute={(command) => execute(command, true)}
        />
      )}
      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        <aside className="flex flex-col gap-3">
          <h2 className="font-semibold">Authorized projects</h2>
          {spaces.map((space) => (
            <Button
              key={space.id}
              variant={selected === space.id ? "default" : "outline"}
              onClick={() => selectSpace(space.id)}
            >
              {space.name} ({space.role})
            </Button>
          ))}
          {!spaces.length && <p>No authorized projects yet.</p>}
          {directory?.canCreateProjects && userId && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!intent.current || intent.current.fingerprint !== fingerprint)
                  intent.current = {
                    fingerprint,
                    requestId: randomUUID().replaceAll("-", ""),
                  };
                void execute({
                  action: "create",
                  name: name.trim(),
                  members,
                  requestId: intent.current.requestId,
                });
              }}
            >
              <Input
                aria-label="New project name"
                placeholder="Project name"
                value={name}
                maxLength={120}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
              <ProjectMemberSelection
                directory={directory}
                subject={userId}
                members={members}
                onChange={setMembers}
                disabled={pending}
              />
              <Button type="submit" disabled={pending || !name.trim()}>
                Create project
              </Button>
            </form>
          )}
        </aside>
        {snapshot && selected ? (
          <section className="flex min-w-0 flex-col gap-5">
            {userId &&
              projectDirectory &&
              userId !== projectDirectory.creatorId &&
              projectDirectory.members.some((member) => member.user.subject === userId) && (
                <Button
                  className="self-start"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void execute({ action: "removeMember", spaceId: selected, userId })
                  }
                >
                  Leave project
                </Button>
              )}
            <p className="text-sm text-muted-foreground">
              {snapshot.role} access. {connection}
            </p>
            <section className="flex flex-col gap-2">
              <h2 className="font-semibold">Project members</h2>
              <p className="text-muted-foreground">
                The project creator and team owners manage existing teammates' project access. Team
                invitations are managed above.
              </p>
              {projectDirectory?.members.map((member) => {
                const creator = member.user.subject === projectDirectory.creatorId;
                return (
                  <div key={member.user.subject} className="flex flex-wrap items-center gap-2">
                    <span className="flex-1">
                      {member.user.displayName}
                      {creator ? " (project creator)" : ""}
                    </span>
                    {projectDirectory.canManageMembers === true && !creator ? (
                      <>
                        <select
                          aria-label={`Role for ${member.user.displayName}`}
                          value={member.role}
                          disabled={pending}
                          onChange={(event) => {
                            if (
                              event.target.value === "contributor" ||
                              event.target.value === "viewer"
                            )
                              void execute({
                                action: "setRole",
                                spaceId: selected,
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
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            void execute({
                              action: "removeMember",
                              spaceId: selected,
                              userId: member.user.subject,
                            })
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
              {projectDirectory?.canManageMembers === true && (
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (available.some((user) => user.subject === newMember))
                      void execute({
                        action: "addMember",
                        spaceId: selected,
                        userId: newMember,
                        role: memberRole,
                      });
                  }}
                >
                  <select
                    aria-label="Existing teammate"
                    value={newMember}
                    disabled={pending}
                    onChange={(event) => setNewMember(event.target.value)}
                  >
                    <option value="">Select a teammate</option>
                    {available.map((user) => (
                      <option key={user.subject} value={user.subject}>
                        {user.displayName}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Project member role"
                    value={memberRole}
                    disabled={pending}
                    onChange={(event) =>
                      setMemberRole(event.target.value === "viewer" ? "viewer" : "contributor")
                    }
                  >
                    <option>contributor</option>
                    <option>viewer</option>
                  </select>
                  <Button
                    type="submit"
                    disabled={pending || !available.some((user) => user.subject === newMember)}
                  >
                    Add to project
                  </Button>
                </form>
              )}
              {projectDirectory?.canInviteMembers === true &&
                projectDirectory.invites.map((invite) => (
                  <div key={invite.id}>
                    {invite.email} (legacy project invitation)
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void execute({
                          action: "cancelInvite",
                          spaceId: selected,
                          inviteId: invite.id,
                        })
                      }
                    >
                      Cancel legacy invitation
                    </Button>
                  </div>
                ))}
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="font-semibold">Project activity</h2>
              <ol className="max-h-96 overflow-auto">
                {snapshot.events.map((event) => (
                  <li key={event.sequence} className="border-b py-2">
                    <div className="text-xs text-muted-foreground">
                      {event.actor}: {event.kind}
                    </div>
                    <p className="whitespace-pre-wrap break-words">{event.text}</p>
                  </li>
                ))}
              </ol>
              {snapshot.role !== "viewer" && (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void execute({ action: "message", spaceId: selected, text: message });
                  }}
                >
                  <Input
                    aria-label="Project message"
                    value={message}
                    maxLength={4000}
                    disabled={pending}
                    onChange={(event) => setMessage(event.target.value)}
                  />
                  <Button type="submit" disabled={pending || !message.trim()}>
                    Send
                  </Button>
                </form>
              )}
            </section>
          </section>
        ) : (
          <p>Select a team project to view its activity.</p>
        )}
      </div>
    </main>
  );
}
