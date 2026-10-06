import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { type EnvironmentMachineKind, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import {
  clearClientCacheAtom,
  clientCacheSummaryAtom,
  type EnvironmentClientCacheSummary,
} from "../../state/client-cache-state";
import { useServerConfigs } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsControlRow } from "./components/SettingsControlRow";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsClientStorageRouteScreen() {
  const insets = useSafeAreaInsets();
  const summaryResult = useAtomValue(clientCacheSummaryAtom);
  const clearResult = useAtomValue(clearClientCacheAtom);
  const clearCache = useAtomSet(clearClientCacheAtom);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const serverConfigs = useServerConfigs();
  const isClearing = clearResult.waiting;
  const summary = AsyncResult.isSuccess(summaryResult) ? summaryResult.value : null;
  const environmentSummaries = useMemo(
    () =>
      [...(summary?.environments ?? [])].sort((left, right) => {
        const leftLabel = savedConnectionsById[left.environmentId]?.environmentLabel ?? "";
        const rightLabel = savedConnectionsById[right.environmentId]?.environmentLabel ?? "";
        return leftLabel.localeCompare(rightLabel);
      }),
    [savedConnectionsById, summary?.environments],
  );

  const confirmClearEnvironment = (environment: EnvironmentClientCacheSummary) => {
    const label =
      savedConnectionsById[environment.environmentId]?.environmentLabel ??
      environment.environmentId;
    Alert.alert(
      `Clear cache for ${label}?`,
      "This removes offline threads, server metadata, and cached branches for this environment. The saved connection and credentials stay intact.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear Cache",
          style: "destructive",
          onPress: () =>
            clearCache({ type: "environment", environmentId: environment.environmentId }),
        },
      ],
    );
  };

  const confirmClearAll = () => {
    Alert.alert(
      "Clear all client caches?",
      "This removes offline data for every environment. Connections, credentials, account data, and app preferences stay intact.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear All Caches",
          style: "destructive",
          onPress: () => clearCache({ type: "all" }),
        },
      ],
    );
  };

  return (
    <SettingsScreen title="Storage" trailing={<AndroidSettingsEnvironmentFilter />}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-[18px]"
      >
        <SettingsEnvironmentFilterHeader />
        <ConversationEvidenceSettings />
        <SettingsSection title="Environment caches">
          {AsyncResult.isFailure(summaryResult) ? (
            <View className="items-center gap-2 px-6 py-8">
              <SymbolView
                name="exclamationmark.triangle"
                size={28}
                tintColorClassName="accent-danger-foreground"
                type="monochrome"
                weight="regular"
              />
              <Text className="text-center text-base text-foreground">Storage unavailable</Text>
              <Text className="text-center text-sm text-foreground-muted">
                Restart the app and try again.
              </Text>
            </View>
          ) : !summary ? (
            <View className="items-center gap-3 px-6 py-8">
              <ActivityIndicator />
              <Text className="text-center text-sm text-foreground-muted">
                Inspecting cached data…
              </Text>
            </View>
          ) : environmentSummaries.length > 0 ? (
            environmentSummaries.map((environment, index) => (
              <CacheEnvironmentRow
                key={environment.environmentId}
                environment={environment}
                environmentLabel={
                  savedConnectionsById[environment.environmentId]?.environmentLabel ??
                  environment.environmentId
                }
                machine={resolveEnvironmentMachineKind(
                  serverConfigs.get(environment.environmentId) ?? null,
                )}
                disabled={isClearing}
                first={index === 0}
                onClear={() => confirmClearEnvironment(environment)}
              />
            ))
          ) : (
            <View className="items-center gap-2 px-6 py-8">
              <SymbolView
                name="checkmark.circle"
                size={28}
                tintColorClassName="accent-icon"
                type="monochrome"
                weight="regular"
              />
              <Text className="text-center text-base text-foreground">No cached data</Text>
              <Text className="text-center text-sm text-foreground-muted">
                Offline cache records will appear here after environments are used.
              </Text>
            </View>
          )}
        </SettingsSection>

        <View className="gap-3">
          <SettingsSection title="Actions">
            <SettingsActionRow
              icon="trash"
              label={summary ? `Clear ${formatBytes(summary.payloadBytes)}` : "Clear caches"}
              tone="danger"
              disabled={isClearing || !summary || summary.recordCount === 0}
              loading={isClearing}
              onPress={confirmClearAll}
            />
          </SettingsSection>
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Clearing caches never removes environment connections, credentials, account data, or
            appearance preferences.
          </Text>
          {AsyncResult.isFailure(summaryResult) || AsyncResult.isFailure(clearResult) ? (
            <Text selectable className="px-2 text-sm text-danger-foreground">
              Client storage is temporarily unavailable. Try again after restarting the app.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function CacheEnvironmentRow(props: {
  readonly environment: EnvironmentClientCacheSummary;
  readonly environmentLabel: string;
  readonly machine: EnvironmentMachineKind;
  readonly disabled: boolean;
  readonly first: boolean;
  readonly onClear: () => void;
}) {
  return (
    <View
      className={
        props.first
          ? "flex-row items-center gap-3 p-4"
          : "border-t border-border flex-row items-center gap-3 p-4"
      }
    >
      <EnvironmentMachineSymbol kind={props.machine} size={22} tintColorClassName="accent-icon" />
      <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
        {props.environmentLabel}
      </Text>
      <Pressable
        accessibilityLabel={`Clear cache for ${props.environmentLabel}`}
        accessibilityRole="button"
        disabled={props.disabled}
        onPress={props.onClear}
        className="rounded-full px-3 py-2 disabled:opacity-40"
      >
        <Text className="font-t3-medium tabular-nums text-danger-foreground" numberOfLines={1}>
          Clear {formatBytes(props.environment.payloadBytes)}
        </Text>
      </Pressable>
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function ConversationEvidenceSettings() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const capableTargets = selectedTargets.filter(
    (target) => target.serverConfig.environment.capabilities.conversationEvidenceStorage === true,
  );
  return (
    <View className="gap-3">
      {capableTargets.map((target) => (
        <EvidenceEnvironmentSettings key={target.environmentId} target={target} />
      ))}
      {capableTargets.length < selectedTargets.length ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Update selected environments to configure conversation evidence storage.
        </Text>
      ) : null}
    </View>
  );
}

function EvidenceEnvironmentSettings({ target }: { readonly target: SettingsTarget }) {
  const settings = target.serverConfig.settings.storageCleanup;
  const days = settings.conversationEvidenceAfterDays;
  const [draft, setDraft] = useState(String(days ?? 8));
  const [savedDays, setSavedDays] = useState(days);
  if (savedDays !== days) {
    setSavedDays(days);
    setDraft(String(days ?? 8));
  }
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "conversation evidence settings update",
    reportFailure: true,
  });
  const write = (patch: Partial<typeof settings>) => {
    void update({
      environmentId: target.environmentId,
      input: { patch: { storageCleanup: patch } },
    });
  };
  const commitDays = () => {
    const value = Number(draft);
    if (days === null || !Number.isInteger(value) || value < 1 || value > 3650) {
      setDraft(String(days ?? 8));
      return;
    }
    write({ conversationEvidenceAfterDays: value });
  };
  return (
    <View className="gap-3">
      <SettingsSection title={`Conversation evidence · ${target.label}`}>
        <SettingsSwitchRow
          icon="archivebox"
          label="Delete when archived"
          subtitle="Remove generated evidence when its conversation is archived and work has finished."
          value={settings.conversationEvidenceOnArchive}
          onValueChange={(conversationEvidenceOnArchive) =>
            write({ conversationEvidenceOnArchive })
          }
        />
        <SettingsSwitchRow
          icon="clock"
          label="Delete old evidence"
          subtitle="Remove generated files after the selected number of days."
          value={days !== null}
          onValueChange={(enabled) => write({ conversationEvidenceAfterDays: enabled ? 8 : null })}
        />
        {days !== null ? (
          <SettingsControlRow icon="clock" label="Keep for days">
            <TextInput
              accessibilityLabel={`Evidence retention days for ${target.label}`}
              value={draft}
              onChangeText={setDraft}
              onEndEditing={commitDays}
              keyboardType="number-pad"
              selectTextOnFocus
              className="min-w-16 rounded-lg bg-subtle px-3 py-2 text-right text-foreground"
            />
          </SettingsControlRow>
        ) : null}
      </SettingsSection>
      <Text className="px-2 text-sm leading-normal text-foreground-muted">
        Evidence links stop opening after cleanup. Uploaded attachments and project files are kept.
      </Text>
    </View>
  );
}
