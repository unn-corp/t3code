import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, RunLimits } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";

export function RunLimitsPanel({
  environmentId,
  threadId,
  disabled = false,
}: {
  environmentId: EnvironmentId;
  threadId?: ThreadId;
  disabled?: boolean;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const override = threadId ? config?.settings.threadRunLimits[threadId] : null;
  const limits = override ?? config?.settings.runLimits;
  if (!config?.runLimits || !limits) return null;
  return (
    <RunLimitsForm
      key={`${environmentId}:${threadId}:${override ? "override" : "inherited"}:${limits.maxDurationMinutes}:${limits.maxOutputTokens}`}
      environmentId={environmentId}
      threadId={threadId}
      disabled={disabled}
      limits={limits}
      inherited={override == null}
    />
  );
}

function RunLimitsForm({
  environmentId,
  threadId,
  disabled,
  limits,
  inherited,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | undefined;
  disabled: boolean;
  limits: RunLimits;
  inherited: boolean;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [minutes, setMinutes] = useState(limits.maxDurationMinutes?.toString() ?? "");
  const [tokens, setTokens] = useState(limits.maxOutputTokens?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function save(inherit: boolean, clear: boolean) {
    function parse(value: string, max: number) {
      if (!value.trim()) return null;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
        throw new Error(`Enter a whole number from 1 to ${max}, or leave blank.`);
      return parsed;
    }
    try {
      setError(null);
      setSaving(true);
      const value = clear
        ? { maxDurationMinutes: null, maxOutputTokens: null }
        : { maxDurationMinutes: parse(minutes, 10080), maxOutputTokens: parse(tokens, 1000000000) };
      const result = await update({
        environmentId,
        input: {
          patch: threadId
            ? { threadRunLimits: { [threadId]: inherit ? null : value } }
            : { runLimits: value },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save limits.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsSection title={threadId ? "Thread run limits" : "Default run limits"}>
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">
          Time covers continuous work and continuations. Output limits use reported main-agent
          tokens and can overshoot between reports. Blank means unlimited. Reaching a limit stops
          work and holds the queue.
        </Text>
        {threadId ? (
          <Text className="text-xs text-foreground-muted">
            {inherited ? "Using environment defaults" : "Using thread limits"}
          </Text>
        ) : null}
        <Text>Maximum minutes</Text>
        <AppTextInput
          accessibilityLabel="Maximum work time in minutes"
          keyboardType="number-pad"
          value={minutes}
          onChangeText={setMinutes}
          editable={!disabled && !saving}
          className="rounded-xl border border-border p-3 text-foreground"
        />
        <Text>Maximum reported output tokens</Text>
        <AppTextInput
          accessibilityLabel="Maximum reported output tokens"
          keyboardType="number-pad"
          value={tokens}
          onChangeText={setTokens}
          editable={!disabled && !saving}
          className="rounded-xl border border-border p-3 text-foreground"
        />
        {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
      </View>
      <SettingsActionRow
        icon="checkmark"
        label="Save limits"
        disabled={disabled || saving}
        loading={saving}
        onPress={() => void save(false, false)}
      />
      <SettingsActionRow
        icon="xmark"
        label="Remove limits"
        disabled={disabled || saving}
        onPress={() => void save(false, true)}
      />
      {threadId ? (
        <SettingsActionRow
          icon="arrow.uturn.backward"
          label="Use environment defaults"
          disabled={disabled || saving}
          onPress={() => void save(true, true)}
        />
      ) : null}
    </SettingsSection>
  );
}
