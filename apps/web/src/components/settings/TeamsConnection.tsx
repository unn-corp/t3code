import { useState } from "react";
import { ensureLocalApi } from "../../localApi";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentSessionState } from "../../state/session";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useTeamAccess } from "../team/useTeamAccess";
import { TeamRoster } from "../team/TeamRoster";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function TeamsConnection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  return <TeamsConnectionAccount key={environmentId} environmentId={environmentId} />;
}
function TeamsConnectionAccount({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const access = useTeamAccess(environmentId);
  return <TeamsConnectionContent environmentId={environmentId} access={access} />;
}

export function TeamsConnectionContent({
  environmentId,
  access,
}: {
  readonly environmentId: EnvironmentId;
  readonly access: ReturnType<typeof useTeamAccess>;
}) {
  const { state, directory, spaces, busy, error, mutate, refresh, teamCommand } = access;
  const session = useEnvironmentSessionState(environmentId);
  const canManage =
    session.data?.authenticated === true && session.data.scopes?.includes(AuthAccessWriteScope);
  const [serviceUrl, setServiceUrl] = useState<{ generation: string; value: string } | null>(null);
  const pending = state?.flow?.status === "pending";
  const effectiveServiceUrl =
    serviceUrl && serviceUrl.generation === state?.generation
      ? serviceUrl.value
      : (state?.serviceUrl ?? "");
  return (
    <div className="flex flex-col gap-3 py-3 text-sm">
      <p className="text-muted-foreground">
        Connect this T3 environment to your Teams account. Coding agents and provider accounts run
        on each teammate's machine.
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate({ action: "start", serviceUrl: effectiveServiceUrl }, (result) => {
            if (result.action !== "state" || result.state.flow?.status !== "pending") return;
            const flow = result.state.flow;
            // Only this explicit sign-in action opens a browser. The approval link
            // remains available if the host cannot open it or a popup is blocked.
            void (async () => {
              await ensureLocalApi().shell.openExternal(
                flow.verificationUriComplete ?? flow.verificationUri,
              );
            })().catch(() => undefined);
          });
        }}
      >
        <details
          className="w-full"
          key={state?.generation ?? "loading"}
          open={!state?.serviceUrl || undefined}
        >
          <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
          <label className="mt-2 flex flex-col gap-1">
            Teams service URL
            <Input
              type="url"
              placeholder="https://teams.example.com"
              value={effectiveServiceUrl}
              onChange={(event) => {
                if (state)
                  setServiceUrl({ generation: state.generation, value: event.target.value });
              }}
              disabled={!canManage || busy || !!state?.account || pending}
            />
          </label>
          {!state?.serviceUrl && (
            <p className="mt-2 text-muted-foreground">
              Ask your team owner for the Teams service URL, or configure a default on this T3
              environment.
            </p>
          )}
        </details>
        {!state?.account && !pending && (
          <Button
            className="self-end"
            type="submit"
            disabled={!canManage || busy || !effectiveServiceUrl.trim()}
          >
            {busy ? "Connecting..." : "Sign in to Teams"}
          </Button>
        )}
      </form>
      {!canManage && (
        <p className="text-muted-foreground">
          Administrative access to this environment is required to connect, disconnect, or change
          Teams membership.
        </p>
      )}
      {pending && state?.flow && (
        <div className="flex flex-col gap-2 rounded-md border p-3" aria-live="polite">
          <p>
            Enter this code to approve sign-in:{" "}
            <strong className="font-mono">{state.flow.userCode}</strong>
          </p>
          <a
            className="break-all underline"
            href={state.flow.verificationUriComplete ?? state.flow.verificationUri}
            target="_blank"
            rel="noreferrer"
          >
            Open Teams sign-in
          </a>
          <p className="text-muted-foreground">
            Waiting for approval. Expires at {new Date(state.flow.expiresAt).toLocaleTimeString()}.
          </p>
          <Button
            className="self-start"
            variant="outline"
            disabled={!canManage || busy}
            onClick={() => {
              if (state.flow) void mutate({ action: "cancel", flowId: state.flow.id });
            }}
          >
            Cancel sign-in
          </Button>
        </div>
      )}
      {state?.account && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>Signed in as {state.account.displayName}</p>
            <Button
              variant="outline"
              disabled={!canManage || busy}
              onClick={() => void mutate({ action: "disconnect" })}
            >
              Disconnect Teams account
            </Button>
          </div>
          <Button
            className="self-start"
            variant="outline"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Refresh team access
          </Button>
          {directory && (
            <TeamRoster
              key={`${state.generation}:${access.revision}`}
              directory={directory}
              busy={busy || !canManage}

              execute={teamCommand}
            />
          )}
          <p className="font-medium">Authorized projects</p>
          {spaces.length ? (
            <ul className="divide-y rounded-md border">
              {spaces.map((space) => (
                <li key={space.id} className="flex justify-between gap-2 p-2">
                  <span>{space.name}</span>
                  <span className="text-muted-foreground">{space.role}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              No authorized projects to show. A project creator or team owner can add you to a
              project.
            </p>
          )}
        </>
      )}
      {state?.message && <p role="status">{state.message}</p>}
      {access.notice && <p role="status">{access.notice}</p>}
      {error && (
        <div role="alert">
          <p className="text-destructive">{error}</p>
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            Refresh connection
          </Button>
        </div>
      )}
    </div>
  );
}

export function TeamsConnectionsSettings() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironment();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const target =
    environments.find((environment) => environment.environmentId === selected) ??
    primary ??
    environments[0];
  return (
    <SettingsSection {...searchableSetting("teams-connection")}>
      {target ? (
        <>
          <label className="flex flex-col gap-1 py-2 text-sm">
            T3 environment
            <select
              className="rounded-md border bg-background p-2"
              value={target.environmentId}
              onChange={(event) => {
                const environment = environments.find(
                  (entry) => entry.environmentId === event.target.value,
                );
                if (environment) setSelected(environment.environmentId);
              }}
            >
              {environments.map((environment) => (
                <option key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </option>
              ))}
            </select>
          </label>
          <TeamsConnection key={target.environmentId} environmentId={target.environmentId} />
        </>
      ) : (
        <p className="py-3 text-sm text-muted-foreground">
          Connect to a T3 environment to manage Teams sign-in.
        </p>
      )}
    </SettingsSection>
  );
}
