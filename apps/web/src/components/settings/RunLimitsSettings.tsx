import { type EnvironmentId, type ThreadId, type RunLimits } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useThreadShells, useServerConfigs, useProjects } from "../../state/entities";
import { useSettingsScope } from "./SettingsScopeContext";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function parseLimit(value: string, maximum: number): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error(`Enter a whole number from 1 to ${maximum}, or leave it blank.`);
  return parsed;
}

export function RunLimitsForm({
  value,
  onSave,
}: {
  readonly value: RunLimits;
  readonly onSave: (value: RunLimits) => void;
}) {
  const [minutes, setMinutes] = useState(value.maxDurationMinutes?.toString() ?? "");
  const [tokens, setTokens] = useState(value.maxOutputTokens?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <SettingsRow
        title="Maximum continuous work time"
        description="Minutes across a run and its continuations. Blank means unlimited."
        control={
          <div className="w-36">
            <Input
              type="number"
              min={1}
              max={10080}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              aria-label="Maximum work time in minutes"
            />
          </div>
        }
      />
      <SettingsRow
        title="Maximum reported output tokens"
        description="Main-agent output includes reasoning. Checked when the provider reports usage; the limit can be exceeded between reports. Blank means unlimited."
        control={
          <div className="w-36">
            <Input
              type="number"
              min={1}
              max={1000000000}
              value={tokens}
              onChange={(event) => setTokens(event.target.value)}
              aria-label="Maximum reported output tokens"
            />
          </div>
        }
      />
      <div className="flex items-center gap-2 px-4 py-3">
        <Button
          size="sm"
          onClick={() => {
            try {
              onSave({
                maxDurationMinutes: parseLimit(minutes, 10080),
                maxOutputTokens: parseLimit(tokens, 1000000000),
              });
              setError(null);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Check the limits.");
            }
          }}
        >
          Save limits
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setError(null);
            onSave({ maxDurationMinutes: null, maxOutputTokens: null });
          }}
        >
          Remove limits
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}

export function RunLimitsSettings() {
  const { targets } = useSettingsScope();
  const configs = useServerConfigs();
  const projects = useProjects();
  const environments = targets.filter(
    (target, index) =>
      targets.findIndex((other) => other.environmentId === target.environmentId) === index,
  );
  const threads = useThreadShells().filter(
    (thread) =>
      environments.some((target) => target.environmentId === thread.environmentId) &&
      configs.get(thread.environmentId)?.runLimits === true,
  );
  const [selection, setSelection] = useState("");
  const selectedThread = threads.find(
    (thread) => `${thread.environmentId}:${thread.id}` === selection,
  );
  const target =
    environments.find((environment) => `${environment.environmentId}:defaults` === selection) ??
    environments[0];
  return (
    <SettingsSection title="Run limits">
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Optional limits are enforced on the server, even while this app is closed. Reaching a limit
        stops work and holds queued messages.
      </p>
      <div className="px-4 py-3">
        <label className="text-xs">
          Apply to{" "}
          <select
            className="ml-2 rounded border bg-background px-2 py-1"
            value={selectedThread ? selection : target ? `${target.environmentId}:defaults` : ""}
            onChange={(event) => setSelection(event.target.value)}
          >
            {environments.map((environment) => (
              <option
                key={environment.environmentId}
                value={`${environment.environmentId}:defaults`}
              >
                {environment.label} defaults
              </option>
            ))}
            {threads.map((thread) => (
              <option
                key={`${thread.environmentId}:${thread.id}`}
                value={`${thread.environmentId}:${thread.id}`}
              >
                {
                  environments.find(
                    (environment) => environment.environmentId === thread.environmentId,
                  )?.label
                }
                {" / "}
                {projects.find(
                  (project) =>
                    project.environmentId === thread.environmentId &&
                    project.id === thread.projectId,
                )?.title ?? "Project"}
                {" / "}
                {thread.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selectedThread ? (
        <ThreadRunLimitsSettings
          key={`${selectedThread.environmentId}:${selectedThread.id}`}
          environmentId={selectedThread.environmentId}
          threadId={selectedThread.id}
        />
      ) : target && configs.get(target.environmentId)?.runLimits === true ? (
        <EnvironmentRunLimitsSettings
          key={target.environmentId}
          environmentId={target.environmentId}
        />
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Update this server to a build that supports run limits.
        </p>
      )}
    </SettingsSection>
  );
}
function EnvironmentRunLimitsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const update = useUpdateEnvironmentSettings(environmentId);
  return (
    <RunLimitsForm
      key={`${settings.runLimits.maxDurationMinutes}:${settings.runLimits.maxOutputTokens}`}
      value={settings.runLimits}
      onSave={(runLimits) => update({ runLimits })}
    />
  );
}

function ThreadRunLimitsSettings({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const update = useUpdateEnvironmentSettings(environmentId);
  const override = settings.threadRunLimits[threadId];
  const limits = override ?? settings.runLimits;
  return (
    <>
      <p className="px-4 text-xs text-muted-foreground">
        {override
          ? "This thread has its own limits."
          : "This thread inherits environment defaults."}
      </p>
      <RunLimitsForm
        key={`${override ? "override" : "inherited"}:${limits.maxDurationMinutes}:${limits.maxOutputTokens}`}
        value={limits}
        onSave={(limits) => update({ threadRunLimits: { [threadId]: limits } })}
      />
      <div className="px-4 pb-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => update({ threadRunLimits: { [threadId]: null } })}
        >
          Use environment defaults
        </Button>
      </div>
    </>
  );
}
