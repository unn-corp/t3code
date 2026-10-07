import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import {
  ProviderInstanceId,
  codexCloudEnvironmentId,
  type CodexCloudBinding,
  type CodexCloudCommandInput,
  type CodexCloudSnapshot,
  type CodexCloudWorkerSetupResult,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { codexCloud } from "../../state/codexCloud";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "../ui/dialog";

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const empty: CodexCloudSnapshot = { binding: null, runs: [], workers: [] };

// @effect-diagnostics-next-line cryptoRandomUUID:off -- Browser event IDs must persist across transport retries.
const newRequestId = () => globalThis.crypto.randomUUID();

export function CodexCloudPanel(props: { environmentId: EnvironmentId; projectId: ProjectId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (config?.environment.capabilities.codexCloudTasks !== true)
    return (
      <p className="text-sm text-muted-foreground">
        This server does not support Codex Cloud tasks yet.
      </p>
    );
  return <ConnectedCloudPanel key={`${props.environmentId}:${props.projectId}`} {...props} />;
}

function ConnectedCloudPanel({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const canOperate = useAtomValue(codexCloud.command.permissionAtom(environmentId));
  const canProvision = useAtomValue(codexCloud.setupWorker.permissionAtom(environmentId));
  const read = useAtomCommand(codexCloud.read);
  const command = useAtomCommand(codexCloud.command);
  const provision = useAtomCommand(codexCloud.setupWorker);
  const [state, setState] = useState(empty);
  const [account, setAccount] = useState("");
  const [cloudEnvironment, setCloudEnvironment] = useState("");
  const [label, setLabel] = useState("");
  const [branch, setBranch] = useState("");
  const [mode, setMode] = useState<"cloud" | "worker">("cloud");
  const [agent, setAgent] = useState<"codex" | "claude">("codex");
  const [workerId, setWorkerId] = useState("");
  const [continueRunId, setContinueRunId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [origin, setOrigin] = useState("");
  const [setup, setSetup] = useState<typeof CodexCloudWorkerSetupResult.Type | null>(null);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const actionLock = useRef(false);
  const submission = useRef<{ key: string; requestId: string } | null>(null);
  const loaded = useRef(false);
  const applySnapshot = useCallback((snapshot: CodexCloudSnapshot) => {
    setNow(Date.now());
    setState(snapshot);
    if (!loaded.current) {
      loaded.current = true;
      setAccount(snapshot.binding?.providerInstanceId ?? "");
      setCloudEnvironment(snapshot.binding?.environmentId ?? "");
      setLabel(snapshot.binding?.label ?? "");
      setBranch(snapshot.binding?.branch ?? "");
    }
  }, []);
  const refresh = useCallback(async () => {
    const result = await read({ environmentId, input: { projectId } });
    if (AsyncResult.isSuccess(result)) applySnapshot(result.value);
  }, [read, environmentId, projectId, applySnapshot]);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Synchronizes state after the asynchronous server read completes.
    void refresh();
  }, [refresh]);
  // Poll only a visible panel with outstanding worker work. Cloud task checks are explicit.
  useEffect(() => {
    if (
      !state.runs.some(
        (run) => run.mode === "worker" && ["queued", "running"].includes(run.status),
      ) &&
      !state.workers.some((w) => !w.revoked && new Date(w.expiresAt).getTime() > Date.now())
    )
      return;
    const timer = setTimeout(() => {
      void refresh();
    }, 4000);
    return () => clearTimeout(timer);
  }, [state, refresh]);
  const parsedEnvironmentId = codexCloudEnvironmentId(cloudEnvironment);
  const binding: CodexCloudBinding | null =
    account && parsedEnvironmentId
      ? {
          providerInstanceId: ProviderInstanceId.make(account),
          environmentId: parsedEnvironmentId,
          label: label.trim(),
          branch: branch.trim(),
        }
      : null;
  const saved =
    binding && state.binding && JSON.stringify(binding) === JSON.stringify(state.binding);
  const execute = async (input: CodexCloudCommandInput) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    try {
      const result = await command({ environmentId, input });
      if (AsyncResult.isSuccess(result)) {
        applySnapshot(result.value.snapshot);
        setOutput(result.value.output);
      }
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const submit = () => {
    const key = JSON.stringify({
      mode,
      agent,
      workerId,
      continueRunId,
      prompt,
      binding: state.binding,
    });
    if (!submission.current || submission.current.key !== key)
      submission.current = { key, requestId: newRequestId() };
    void execute({
      action: "submit",
      projectId,
      requestId: submission.current.requestId,
      mode,
      agent: mode === "cloud" ? "codex" : agent,
      prompt,
      ...(mode === "worker" ? { workerId } : {}),
      ...(continueRunId && mode === "worker" ? { continueRunId } : {}),
    });
  };
  const setupWorker = async (revokeWorkerId?: string) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    try {
      const result = await provision({
        environmentId,
        input: { projectId, origin, ...(revokeWorkerId ? { revokeWorkerId } : {}) },
      });
      if (AsyncResult.isSuccess(result)) {
        applySnapshot(result.value.snapshot);
        setSetup(revokeWorkerId ? null : result.value);
        setOutput(result.value.instructions);
      }
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const eligibleWorkers = state.workers.filter(
    (w) =>
      !w.revoked &&
      new Date(w.expiresAt).getTime() > now &&
      w.lastSeen !== null &&
      now - new Date(w.lastSeen).getTime() < 30_000 &&
      w.binding.providerInstanceId === state.binding?.providerInstanceId &&
      w.binding.environmentId === state.binding?.environmentId &&
      w.agents.includes(agent),
  );
  const accounts = providers.filter((p) => p.driver === "codex");
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Run tasks in a published Codex Cloud environment. Each task keeps its account and workspace.
        Claude requires a connected experimental worker.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          Codex account
          <Select
            value={account}
            onValueChange={(value) => {
              setAccount(value ?? "");
              setSetup(null);
            }}
            disabled={busy || !canOperate}
          >
            <SelectTrigger aria-label="Codex account">
              <SelectValue placeholder="Choose account">
                {accounts.find((p) => p.instanceId === account)?.displayName ??
                  (account || "Choose account")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {accounts.map((p) => (
                <SelectItem key={p.instanceId} value={p.instanceId}>
                  {p.displayName ?? p.instanceId}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Cloud environment ID or settings URL
          <Input
            aria-label="Cloud environment ID or settings URL"
            value={cloudEnvironment}
            onChange={(e) => {
              setCloudEnvironment(e.target.value);
              setSetup(null);
            }}
            disabled={busy || !canOperate}
            placeholder="Copy from ChatGPT environment settings"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Environment name
          <Input
            aria-label="Environment name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy || !canOperate}
            placeholder="Squidhub development"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Branch
          <Input
            aria-label="Branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            disabled={busy || !canOperate}
            placeholder="Cloud environment default"
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !canOperate || !binding}
          onClick={() => binding && void execute({ action: "save", projectId, binding })}
        >
          Save cloud default
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !canOperate || !binding}
          onClick={() => binding && void execute({ action: "probe", projectId, binding })}
        >
          Test account access
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !canOperate || !state.binding}
          onClick={() => {
            void execute({ action: "save", projectId, binding: null });
            setSetup(null);
          }}
        >
          Remove cloud default
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          Execution
          <Select value={mode} onValueChange={(v) => setMode(v === "worker" ? "worker" : "cloud")}>
            <SelectTrigger aria-label="Execution">
              <SelectValue>
                {mode === "cloud" ? "Codex Cloud task" : "Cloud worker (experimental)"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="cloud">Codex Cloud task</SelectItem>
              <SelectItem value="worker">Cloud worker (experimental)</SelectItem>
            </SelectPopup>
          </Select>
        </label>
        {mode === "worker" && (
          <label className="flex flex-col gap-1 text-sm">
            Agent
            <Select
              value={agent}
              onValueChange={(v) => setAgent(v === "claude" ? "claude" : "codex")}
            >
              <SelectTrigger aria-label="Agent">
                <SelectValue>{agent === "claude" ? "Claude" : "Codex"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="claude">Claude</SelectItem>
              </SelectPopup>
            </Select>
          </label>
        )}
      </div>
      {mode === "worker" && (
        <>
          <label className="flex flex-col gap-1 text-sm">
            Worker
            <Select
              value={workerId}
              onValueChange={(v) => {
                setWorkerId(v ?? "");
                setContinueRunId("");
              }}
            >
              <SelectTrigger aria-label="Worker">
                <SelectValue>
                  {eligibleWorkers.find((w) => w.id === workerId)
                    ? `${eligibleWorkers.find((w) => w.id === workerId)!.binding.label || "Cloud worker"} · ${workerId.slice(0, 8)}`
                    : "Connect a cloud worker"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {eligibleWorkers.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.binding.label || w.binding.environmentId} · {w.id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Conversation
            <Select value={continueRunId} onValueChange={(v) => setContinueRunId(v ?? "")}>
              <SelectTrigger aria-label="Conversation">
                <SelectValue>
                  {state.runs.find((r) => r.id === continueRunId)?.prompt.slice(0, 70) ??
                    "New conversation"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">New conversation</SelectItem>
                {state.runs
                  .filter(
                    (r) =>
                      r.workerId === workerId &&
                      r.agent === agent &&
                      r.sessionId &&
                      ["completed", "failed", "cancelled"].includes(r.status),
                  )
                  .map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.prompt.slice(0, 70)}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
          </label>
          <p className="text-sm text-muted-foreground">
            The worker edits files and runs commands in its own cloud checkout. Claude needs
            separate credentials there. Your local uncommitted files are not uploaded.
          </p>
        </>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Task
        <Textarea
          aria-label="Task"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy || !canOperate}
          placeholder="Describe the cloud work"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            busy ||
            !canOperate ||
            !saved ||
            !prompt.trim() ||
            (mode === "worker" && !eligibleWorkers.some((w) => w.id === workerId))
          }
          onClick={submit}
        >
          Run in {mode === "cloud" ? "Codex Cloud" : "cloud worker"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            submission.current = null;
            setPrompt("");
            setContinueRunId("");
          }}
          disabled={busy}
        >
          New task
        </Button>
      </div>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Connect an experimental worker
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            T3 controller HTTPS origin
            <Input
              aria-label="T3 controller HTTPS origin"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              disabled={busy || !canProvision}
              placeholder="https://your-host.tailnet.ts.net"
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !canProvision || !saved || !origin.trim()}
            onClick={() => void setupWorker()}
          >
            Prepare worker
          </Button>
          {setup && (
            <>
              <p className="text-sm text-muted-foreground">{setup.instructions}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => download("t3-cloud-worker.py", setup.script)}
                >
                  Download worker
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(setup.token)}
                >
                  Copy worker credential
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSetup(null)}>
                  Hide credential
                </Button>
              </div>
            </>
          )}
          {state.workers.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {w.id.slice(0, 8)} ·{" "}
                {w.revoked
                  ? "revoked"
                  : new Date(w.expiresAt).getTime() <= now
                    ? "expired"
                    : w.lastSeen
                      ? `last seen ${new Date(w.lastSeen).toLocaleTimeString()}`
                      : "waiting for connection"}{" "}
                · {w.agents.join(", ")}
              </span>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy || !canProvision || w.revoked}
                onClick={() => void setupWorker(w.id)}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      </details>
      {state.runs.map((run) => (
        <div key={run.id} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
          <p className="break-words text-sm font-medium">{run.prompt.slice(0, 180)}</p>
          <p className="text-xs text-muted-foreground">
            {run.binding.label || run.binding.environmentId} ·{" "}
            {accounts.find((p) => p.instanceId === run.binding.providerInstanceId)?.displayName ??
              run.binding.providerInstanceId}{" "}
            · {run.agent} · {run.status}
          </p>
          <div className="flex flex-wrap gap-2">
            {run.url && (
              <a className="text-sm underline" href={run.url} target="_blank" rel="noreferrer">
                Open cloud task
              </a>
            )}
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !canOperate}
              onClick={() => void execute({ action: "status", projectId, runId: run.id })}
            >
              {run.mode === "cloud" ? "Check status" : "View output"}
            </Button>
            {run.taskId && (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !canOperate}
                onClick={() => void execute({ action: "diff", projectId, runId: run.id })}
              >
                View changes
              </Button>
            )}
            {run.mode === "worker" && ["queued", "running"].includes(run.status) && (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy || !canOperate}
                onClick={() => void execute({ action: "cancel", projectId, runId: run.id })}
              >
                Stop
              </Button>
            )}
          </div>
          {run.mode === "worker" && run.output && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
              {run.output}
            </pre>
          )}
        </div>
      ))}
      {output && (
        <pre
          role="status"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs"
        >
          {output}
        </pre>
      )}
    </div>
  );
}

export function CodexCloudLauncher(props: { environmentId: EnvironmentId; projectId: ProjectId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (config?.environment.capabilities.codexCloudTasks !== true) return null;
  return (
    <Dialog>
      <DialogTrigger render={<Button size="xs" variant="ghost" />}>Cloud tasks</DialogTrigger>
      <DialogPopup>
        <DialogTitle>Codex Cloud</DialogTitle>
        <div className="mt-4 max-h-[75dvh] overflow-y-auto">
          <CodexCloudPanel {...props} />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
