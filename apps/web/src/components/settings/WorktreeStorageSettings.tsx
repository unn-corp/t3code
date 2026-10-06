import { worktreeStorageUnavailableReason } from "@t3tools/shared/worktreeStorage";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ScopedSwitch } from "./ScopedSwitch";

export function WorktreeStorageSettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const reason = projectScope
    ? "Choose an environment or All environments to change this global setting."
    : worktreeStorageUnavailableReason(
        connectedEnvironments.map(
          (environment) => environment.serverConfig?.worktreeStorageSupport,
        ),
      );
  return (
    <SettingsSection title="Worktree storage">
      <SettingsRow
        {...searchableSetting("space-efficient-worktrees")}
        serverScoped
        settingKeys={["spaceEfficientWorktrees"]}
        aria-disabled={reason !== null}
        description={
          reason ??
          "Share unchanged file data between new worktrees while keeping edits independent. Applies to future worktrees."
        }
        control={
          <ScopedSwitch
            settingKeys={["spaceEfficientWorktrees"]}
            checked={settings.spaceEfficientWorktrees}
            disabled={reason !== null}
            aria-label="Space-efficient worktrees"
            onCheckedChange={(checked) =>
              updateSettings({ spaceEfficientWorktrees: Boolean(checked) })
            }
          />
        }
      />
    </SettingsSection>
  );
}
