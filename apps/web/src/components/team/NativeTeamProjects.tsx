import { awaitTeamProjectReceipt } from "@t3tools/client-runtime/state/teamProjectActions";
import { randomUUID } from "../../lib/utils";
import { ProjectMembers } from "./ProjectMembers";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { LocalTeamFilesControl, LocalTeamFilesResult } from "@t3tools/contracts/teamFiles";
import type { LocalTeamProjectControl } from "@t3tools/contracts/teamProjects";
import type { TeamProjectMemberSelections } from "@t3tools/contracts/teamSpaces";
import { ProjectMemberSelection } from "./ProjectMemberSelection";
import { readLocalApi } from "../../localApi";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../../connection/useDesktopLocalBootstraps";
import { parseWslUncPath, resolveProjectPickerTarget } from "../../wslPaths";
import { useTeamAccess } from "./useTeamAccess";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { localTeamAccountCommand } from "../../state/localTeamAccount";
import { teamProjects, sharedProjectSourceScope } from "../../state/teamProjects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { TeamsConnectionContent } from "../settings/TeamsConnection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "../ui/dialog";

type ProjectAction = {
  action: "open" | "create" | "share";
  environmentId?: EnvironmentId;
  projectId?: ProjectId;
};
export const useTeamProjectDialog = create<{
  target: ProjectAction | null;
  open: (target: ProjectAction) => void;
  close: () => void;
}>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
function failureText(result: { cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"] }) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error
    ? error.message
    : "The shared project request failed. Check your connection and retry.";
}
export function NativeTeamProjectDialog() {
  const target = useTeamProjectDialog((state) => state.target);
  const close = useTeamProjectDialog((state) => state.close);
  const primary = usePrimaryEnvironmentId();
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="w-full sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {target?.action === "share"
              ? "Share this project"
              : target?.action === "create"
                ? "Create shared project"
                : "Open shared project"}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {target ? (
            <NativeTeamProjectForm
              key={JSON.stringify(target)}
              target={target}
              initialEnvironment={target.environmentId ?? primary}
              onComplete={close}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
function NativeTeamProjectForm({
  target,
  initialEnvironment,
  onComplete,
}: {
  target: ProjectAction;
  initialEnvironment: EnvironmentId | null;
  onComplete: () => void;
}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const bootstraps = useDesktopLocalBootstraps();
  const [environmentId, setEnvironmentId] = useState(initialEnvironment);
  const access = useTeamAccess(environmentId);
  const { state, directory, spaces } = access;
  const generation = directory ? (state?.generation ?? null) : null;
  const account = useAtomCommand(localTeamAccountCommand, { reportFailure: false });
  const files = useAtomCommand(teamProjects.files, { reportFailure: false });
  const { handleNewThread } = useHandleNewThread();
  const [selected, setSelected] = useState("");
  const [destination, setDestination] = useState("");
  const [name, setName] = useState("");
  const [members, setMembers] = useState<TeamProjectMemberSelections>([]);
  const [preview, setPreview] = useState<LocalTeamFilesResult | null>(null);
  const [submitting, setBusy] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const busy = submitting || pickingFolder;
  const environment = environments.find((item) => item.environmentId === environmentId);
  const desktopInstanceId =
    environment && isDesktopLocalConnectionTarget(environment.entry.target)
      ? (bootstraps.find((item) => item.httpBaseUrl === environment.displayUrl)?.id ?? null)
      : null;
  const canPickFolder =
    typeof window !== "undefined" &&
    !!window.desktopBridge &&
    (environmentId === primaryEnvironmentId || desktopInstanceId !== null);
  const [error, setError] = useState("");
  const lifetime = useRef(0);
  const intent = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const action = target.action;
  const sourceProjectId = target.projectId;
  useEffect(() => {
    ++lifetime.current;
    setSelected("");
    setMembers([]);
    setPreview(null);
    setError("");
    setBusy(false);
    setPickingFolder(false);
    return () => {
      ++lifetime.current;
    };
  }, [environmentId, generation, access.revision]);
  useEffect(() => {
    const epoch = lifetime.current;
    if (environmentId && generation && action === "share" && sourceProjectId)
      void files({ environmentId, input: { action: "preview", projectId: sourceProjectId } }).then(
        (result) => {
          if (epoch !== lifetime.current) return;
          if (result._tag === "Success") setPreview(result.value);
          else setError(failureText(result));
        },
      );
  }, [files, environmentId, generation, access.revision, action, sourceProjectId]);
  useEffect(() => {
    setDestination("");
    setPickingFolder(false);
  }, [environmentId]);
  const chooseFolder = async () => {
    if (!canPickFolder || busy || !environmentId) return;
    const epoch = lifetime.current;
    setPickingFolder(true);
    setError("");
    try {
      const wslConfiguration =
        (await window.desktopBridge?.getWslState().catch(() => null)) ?? null;
      if (epoch !== lifetime.current) return;
      const targetEnvironmentId = resolveProjectPickerTarget({
        browseEnvironmentId: environmentId,
        primaryEnvironmentId,
        desktopInstanceId,
        wslConfiguration,
      });
      const picked = await readLocalApi()?.dialogs.pickFolder({
        ...(destination ? { initialPath: destination } : {}),
        ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
      });
      if (epoch !== lifetime.current || !picked) return;
      if (parseWslUncPath(picked)) {
        setError("Select the matching WSL environment before choosing a Linux folder.");
        return;
      }
      setDestination(picked);
    } catch (cause) {
      if (epoch === lifetime.current)
        setError(cause instanceof Error ? cause.message : "The folder picker could not be opened.");
    } finally {
      if (epoch === lifetime.current) setPickingFolder(false);
    }
  };
  const fingerprint = JSON.stringify({
    environmentId,
    generation,
    action,
    sourceProjectId,
    name: name.trim(),
    destination: destination.trim(),
    members,
    branch: preview?.branch,
    commit: preview?.commit,
  });
  useEffect(() => {
    if (intent.current?.fingerprint !== fingerprint) intent.current = null;
  }, [fingerprint]);
  const submit = async () => {
    if (
      !environmentId ||
      !generation ||
      busy ||
      !directory ||
      (action !== "open" && !directory.canCreateProjects)
    )
      return;
    const epoch = lifetime.current;
    setBusy(true);
    setError("");
    try {
      if (!intent.current || intent.current.fingerprint !== fingerprint)
        intent.current = { fingerprint, requestId: randomUUID().replaceAll("-", "") };
      let input: LocalTeamFilesControl;
      const selection = { members, requestId: intent.current.requestId };
      if (action === "share") {
        if (!sourceProjectId || !preview?.branch) return;
        input = {
          action: "share",
          projectId: sourceProjectId,
          name: name.trim(),
          expectedBranch: preview.branch,
          expectedCommit: preview.commit ?? null,
          ...selection,
        };
      } else if (action === "open")
        input = { action: "open", sharedProjectId: selected, destination: destination.trim() };
      else
        input = {
          action: "create",
          name: name.trim(),
          destination: destination.trim(),
          ...selection,
        };
      const projectId = await awaitTeamProjectReceipt({
        generation,
        isCurrent: () => epoch === lifetime.current,
        currentGeneration: async () => {
          const current = await account({ environmentId, input: { action: "state" } });
          return current._tag === "Success" &&
            current.value.action === "state" &&
            current.value.state.account
            ? current.value.state.generation
            : null;
        },
        execute: async () => {
          const result = await files({ environmentId, input });
          if (result._tag === "Failure") throw new Error(failureText(result));
          return result.value;
        },
      });
      if (projectId) {
        onComplete();
        await handleNewThread(scopeProjectRef(environmentId, projectId));
      } else if (epoch === lifetime.current) {
        access.invalidate();
        setError("Your Teams account changed. Refresh team access before continuing.");
      }
    } catch (failure) {
      if (epoch === lifetime.current)
        setError(
          failure instanceof Error ? failure.message : "The shared project could not be opened.",
        );
    } finally {
      if (epoch === lifetime.current) setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        Shared files live on the Teams service. Your agents and provider accounts run on your own
        machine.
      </p>
      {action !== "share" && (
        <label>
          Local T3 environment
          <select
            className="mt-1 w-full rounded border bg-background p-2"
            value={environmentId ?? ""}
            disabled={busy}
            onChange={(event) => {
              ++lifetime.current;
              access.invalidate();
              setSelected("");
              setMembers([]);
              setEnvironmentId(
                environments.find((env) => env.environmentId === event.target.value)
                  ?.environmentId ?? null,
              );
            }}
          >
            {environments.map((env) => (
              <option key={env.environmentId} value={env.environmentId}>
                {env.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {environmentId && !state && !access.error && <p role="status">Loading team access...</p>}
      {environmentId && state && !state.account && (
        <TeamsConnectionContent environmentId={environmentId} access={access} />
      )}
      <Button
        className="self-start"
        variant="outline"
        disabled={busy || access.busy}
        onClick={() => void access.refresh()}
      >
        Refresh team access
      </Button>
      {generation && directory && (
        <>
          {action === "open" && (
            <>
              {!spaces.length && (
                <p>
                  No authorized projects yet. A project creator or team owner can add you to a
                  project.
                </p>
              )}
              {directory.canCreateProjects && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (environmentId)
                      useTeamProjectDialog.getState().open({ action: "create", environmentId });
                  }}
                >
                  Create a new shared project
                </Button>
              )}
              <label>
                Shared project
                <select
                  className="mt-1 w-full rounded border bg-background p-2"
                  value={selected}
                  disabled={busy}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  <option value="">Choose a project</option>
                  {spaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name} ({space.role})
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {action !== "open" &&
            (directory.canCreateProjects ? (
              <>
                <label>
                  Project name
                  <Input
                    value={name}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                </label>
                {state?.account && (
                  <ProjectMemberSelection
                    directory={directory}
                    subject={state.account.subject}
                    members={members}
                    onChange={setMembers}
                    disabled={busy}
                  />
                )}
              </>
            ) : (
              <p>
                Join the team before creating or sharing a project. Accept your team invitation in
                Open shared project or Settings &gt; Connections &gt; Teams.
              </p>
            ))}
          {(action === "open" || directory.canCreateProjects) && (
            <>
              {action !== "share" ? (
                <div className="flex flex-col gap-2">
                  <label htmlFor="team-checkout-directory">Local project folder</label>
                  <div className="flex gap-2">
                    <Input
                      id="team-checkout-directory"
                      value={destination}
                      disabled={busy}
                      readOnly={canPickFolder}
                      onClick={canPickFolder ? () => void chooseFolder() : undefined}
                      onChange={(event) => setDestination(event.target.value)}
                      placeholder={
                        canPickFolder ? "Choose a folder..." : "Absolute path on this environment"
                      }
                      required
                    />
                    {canPickFolder && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void chooseFolder()}
                      >
                        {pickingFolder ? "Choosing..." : "Browse..."}
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {canPickFolder
                      ? "Choose an empty folder, or create one in the folder picker."
                      : "Enter a new or empty folder on the selected T3 environment."}
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground">
                  This uploads the checked Git history and tracked files. Existing private
                  conversations stay local.{" "}
                  {preview?.excludedChanges
                    ? `${preview.excludedChanges} untracked or ignored changes are excluded.`
                    : "Untracked and ignored files need explicit inclusion."}
                </p>
              )}
              <Button
                disabled={
                  busy ||
                  access.busy ||
                  (action === "open"
                    ? !spaces.some((space) => space.id === selected) || !destination.trim()
                    : !name.trim() || (action === "share" ? !preview?.branch : !destination.trim()))
                }
                onClick={() => void submit()}
              >
                {busy
                  ? "Preparing shared project..."
                  : action === "share"
                    ? "Upload and share project"
                    : action === "create"
                      ? "Create shared project"
                      : "Open shared project"}
              </Button>
            </>
          )}
        </>
      )}
      {access.notice && <p role="status">{access.notice}</p>}
      {(error || access.error) && (
        <p role="alert" className="text-destructive">
          {error || access.error}
        </p>
      )}
    </div>
  );
}

export function NativeTeamProjectSettings({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const links = useEnvironmentQuery(teamProjects.state({ environmentId, input: {} }));
  const linked = links.data?.find((entry) => entry.link.projectId === projectId);
  const hasAccess =
    linked && !["account-changed", "access-revoked", "root-changed"].includes(linked.link.status);
  const state = useEnvironmentQuery(
    hasAccess && linked
      ? teamProjects.filesState({
          environmentId,
          sourceScope: sharedProjectSourceScope(linked.link),
          input: { projectId },
        })
      : null,
  );
  const files = useAtomCommand(teamProjects.files, { reportFailure: false });
  const control = useAtomCommand(teamProjects.control, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [include, setInclude] = useState("");
  const run = async (input: LocalTeamFilesControl | LocalTeamProjectControl) => {
    setBusy(true);
    setError("");
    const result =
      input.action === "unlink"
        ? await control({ environmentId, input })
        : await files({ environmentId, input: input as LocalTeamFilesControl });
    if (result._tag === "Failure") setError(failureText(result));
    links.refresh();
    state.refresh();
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => useTeamProjectDialog.getState().open({ action: "open", environmentId })}
        >
          Open shared project
        </Button>
        <Button
          variant="outline"
          onClick={() => useTeamProjectDialog.getState().open({ action: "create", environmentId })}
        >
          Create shared project
        </Button>
        {!linked && (
          <Button
            onClick={() =>
              useTeamProjectDialog.getState().open({ action: "share", environmentId, projectId })
            }
          >
            Share this project
          </Button>
        )}
      </div>
      {linked && (
        <>
          {hasAccess && (
            <ProjectMembers
              key={`${linked.link.id}:${linked.link.generation}`}
              sourceScope={sharedProjectSourceScope(linked.link)}
              environmentId={environmentId}
              projectId={projectId}
            />
          )}
          <p>
            Role: {linked.link.role}. Connection: {linked.link.status}. Files:{" "}
            {state.data?.status ?? "loading"}.
          </p>
          <p className="text-muted-foreground">
            Agents use this checkout on your machine. Teammate activity is reported by their T3
            environment. Sharing a project does not share earlier conversations.
          </p>
          <div className="flex flex-wrap gap-2">
            {(["enable", "disable", "reconcile", "fetch", "publish", "initialize"] as const).map(
              (action) => (
                <Button
                  key={action}
                  variant="outline"
                  disabled={
                    busy ||
                    (linked.link.role === "viewer" &&
                      (action === "publish" || action === "initialize"))
                  }
                  onClick={() => void run({ action, projectId })}
                >
                  {
                    {
                      enable: "Enable live files",
                      disable: "Pause live files",
                      reconcile: "Sync now",
                      fetch: "Fetch Git history",
                      publish: "Publish Git history",
                      initialize: "Initialize repository",
                    }[action]
                  }
                </Button>
              ),
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run({ action: "unlink", projectId })}
            >
              Unlink project
            </Button>
          </div>
          <p className="text-muted-foreground">
            Unlinking retains your local checkout and shared history. Git synchronization never
            automatically commits or merges changes.
          </p>
          {linked.link.role !== "viewer" && (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (include.trim())
                  void run({
                    action: "include",
                    projectId,
                    paths: include
                      .split("\n")
                      .map((path) => path.trim())
                      .filter(Boolean),
                  });
              }}
            >
              <Input
                aria-label="Include relative file path"
                value={include}
                onChange={(event) => setInclude(event.target.value)}
                placeholder="Relative file path"
              />
              <Button disabled={busy || !include.trim()} type="submit">
                Include file
              </Button>
            </form>
          )}
          {state.data?.conflicts?.map((conflict) => (
            <div key={conflict.path} className="rounded border p-2">
              <p>Conflict: {conflict.path}</p>
              {conflict.reason === "directory" && (
                <p>
                  Local children were preserved. Move them out of this directory before accepting
                  the shared file.
                </p>
              )}
              <div className="flex gap-2">
                {(["local", "remote"] as const).map((choice) => (
                  <Button
                    key={choice}
                    disabled={busy || (choice === "local" && linked.link.role === "viewer")}
                    variant="outline"
                    onClick={() =>
                      void run({
                        action: "resolve",
                        projectId,
                        path: conflict.path,
                        expectedLocal: conflict.localHash,
                        expectedRemote: conflict.remoteHash,
                        expectedLocalExecutable: conflict.localExecutable,
                        expectedRemoteExecutable: conflict.remoteExecutable,
                        choice,
                      })
                    }
                  >
                    {choice === "local" ? "Keep local" : "Use shared"}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
      {(error || links.error || state.error) && (
        <p role="alert" className="text-destructive">
          {error || links.error || state.error}
        </p>
      )}
    </div>
  );
}
