import { useEffect, useState } from "react";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import {
  androidNotificationRequest,
  type AndroidNotificationStatus,
} from "../../android/notifications";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AndroidNotificationSettings() {
  const preferences = useClientSettings((settings) => settings.agentNotifications);
  const update = useUpdateClientSettings();
  const [status, setStatus] = useState<AndroidNotificationStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const refresh = () => {
      void androidNotificationRequest("status")
        .then(setStatus)
        .catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const request = async (
    action: Parameters<typeof androidNotificationRequest>[0],
    payload?: unknown,
  ) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await androidNotificationRequest(action, payload);
      setStatus(next);
      return next;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update notifications.");
      return null;
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection {...searchableSetting("notifications")}>
      <SettingsRow
        title="Notifications on this phone"
        description={
          message ??
          (status?.permission === "permission-blocked"
            ? "Allow Arcwright Code notifications in Android settings, then turn alerts on."
            : "Android system alerts when an agent finishes, fails, has a plan ready, or needs your input.")
        }
        control={
          <Switch
            aria-label="Notifications on this phone"
            checked={preferences.enabled && status?.permission === "ready"}
            disabled={busy || status === null}
            onCheckedChange={async (enabled) => {
              if (enabled) {
                const next = await request("requestPermission");
                if (next?.permission !== "ready") return;
              }
              update({ agentNotifications: { ...preferences, enabled: Boolean(enabled) } });
            }}
          />
        }
      />
      <SettingsRow
        title="Keep alerts connected in the background"
        description="Uses your paired Tailscale environments while the app is closed. An ongoing Android notification lets you stop the connection. Force-stopping the app stops alerts."
        control={
          <Switch
            aria-label="Keep alerts connected in the background"
            checked={status?.background ?? false}
            disabled={busy || !preferences.enabled || status?.permission !== "ready"}
            onCheckedChange={(enabled) => {
              void request("background", { enabled: Boolean(enabled) });
            }}
          />
        }
      />
      {(
        [
          ["notifyOnCompletion", "Agent finished"],
          ["notifyOnInput", "Needs input or approval"],
          ["notifyOnFailure", "Agent failed"],
          ["notifyOnPlanReady", "Plan ready"],
          ["playSound", "Notification sound"],
          ["showProjectAndThreadNames", "Show thread names"],
        ] as const
      ).map(([key, title]) => (
        <SettingsRow
          key={key}
          title={title}
          control={
            <Switch
              aria-label={title}
              checked={preferences[key]}
              disabled={!preferences.enabled}
              onCheckedChange={(checked) =>
                update({ agentNotifications: { ...preferences, [key]: Boolean(checked) } })
              }
            />
          }
        />
      ))}
      <SettingsRow
        title="Test phone notification"
        description="Send a local Android notification without running an agent."
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={busy || status?.permission !== "ready"}
            onClick={() => {
              void request("test");
            }}
          >
            Send test
          </Button>
        }
      />
      <SettingsRow
        title="Android notification settings"
        description="Manage notification channels, sound, vibration, and lock-screen privacy."
        control={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void request("settings");
            }}
          >
            Open settings
          </Button>
        }
      />
      <SettingsRow
        title="Background battery settings"
        description="Android can delay network access while asleep. If background alerts are delayed, allow unrestricted battery use for Arcwright Code and keep Tailscale connected."
        control={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void request("battery");
            }}
          >
            Open battery settings
          </Button>
        }
      />
    </SettingsSection>
  );
}
