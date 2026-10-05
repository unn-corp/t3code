import {
  AGENT_NOTIFICATION_SOUND_IDS,
  type AgentNotificationKind,
  type AgentNotificationSoundId,
  type AgentNotificationSounds,
} from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import {
  agentNotificationSoundLabel,
  playAgentNotificationSoundId,
} from "../../agentNotifications/sound";
import {
  getBrowserNotificationStatus,
  showBrowserNotificationPreview,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
  type BrowserNotificationStatus,
} from "../../agentNotifications/browserNotifications";
import {
  registerPwaPushSubscription,
  removePwaPushSubscription,
  testPwaPushSubscription,
} from "../../agentNotifications/pwaPushRelay";
import { usePwaNotificationSetup } from "../../agentNotifications/usePwaNotificationSetup";
import { usePwaPushSubscriptionSync } from "../../agentNotifications/usePwaPushSubscriptionSync";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export const AGENT_NOTIFICATION_SOUND_ROWS: readonly {
  readonly kind: AgentNotificationKind;
  readonly title: string;
}[] = [
  { kind: "agent_completed", title: "Agent finished sound" },
  { kind: "plan_ready", title: "Plan ready sound" },
  { kind: "input_required", title: "Needs input sound" },
  { kind: "agent_failed", title: "Agent failed sound" },
];

export function PwaNotificationSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const notificationPreferences = useClientSettings((value) => value.agentNotifications);
  const updateClientSettings = useUpdateClientSettings();
  const [status, setStatus] = useState<BrowserNotificationStatus>(() =>
    getBrowserNotificationStatus(),
  );
  const {
    vapidPublicKey,
    isConfigLoading,
    retry: retryNotificationSetup,
  } = usePwaNotificationSetup();
  const [isSaving, setIsSaving] = useState(false);
  const subscriptionIdRef = useRef<string | null>(
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem("t3code.webPushSubscriptionId"),
  );

  const refreshStatus = useCallback(() => {
    setStatus(getBrowserNotificationStatus());
  }, []);

  useEffect(() => {
    window.addEventListener("focus", refreshStatus);
    document.addEventListener("visibilitychange", refreshStatus);
    return () => {
      window.removeEventListener("focus", refreshStatus);
      document.removeEventListener("visibilitychange", refreshStatus);
    };
  }, [refreshStatus]);

  const updatePreferences = useCallback(
    (patch: Partial<typeof notificationPreferences>) => {
      updateClientSettings({
        agentNotifications: { ...notificationPreferences, ...patch },
      });
    },
    [notificationPreferences, updateClientSettings],
  );

  const persistRemoteSubscription = useCallback(
    async (subscription: PushSubscription, preferences: typeof notificationPreferences) => {
      if (!primaryEnvironment) throw new Error("Connect this PWA to a T3 Code server first.");
      const subscriptionId = await registerPwaPushSubscription({
        environmentId: primaryEnvironment.environmentId,
        subscription,
        preferences,
      });
      subscriptionIdRef.current = subscriptionId;
      window.localStorage.setItem("t3code.webPushSubscriptionId", subscriptionId);
    },
    [primaryEnvironment],
  );

  const enableNotifications = useCallback(async () => {
    if (!vapidPublicKey) {
      if (!isConfigLoading) retryNotificationSetup();
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Remote notifications are unavailable",
          description: isConfigLoading
            ? "The relay configuration is still loading. Try again in a moment."
            : "Retrying this device's notification setup. Tap Enable notifications again once setup finishes.",
        }),
      );
      return;
    }
    setIsSaving(true);
    try {
      // This is intentionally the first awaited browser operation in the click handler:
      // iOS only permits PushManager.subscribe while the direct user gesture is still valid.
      const result = await subscribeBrowserPush({ applicationServerKey: vapidPublicKey });
      if (result.state !== "subscribed" || result.subscription === null) {
        setStatus(
          result.state === "permission-blocked" ? "permission-blocked" : "permission-needed",
        );
        throw new Error(
          result.state === "not-installed"
            ? "Install T3 Code on your Home Screen before enabling push notifications."
            : result.state === "worker-failed"
              ? "Preparing this device for notifications. Tap Enable notifications again in a moment."
              : result.state === "permission-granted"
                ? "Permission is granted. Tap Enable notifications once more to subscribe this installation."
                : "Allow notifications for T3 Code, then try again.",
        );
      }
      const preferences = { ...notificationPreferences, enabled: true };
      await persistRemoteSubscription(result.subscription, preferences);
      updateClientSettings({ agentNotifications: preferences });
      setStatus("ready");
      toastManager.add(
        stackedThreadToast({ type: "success", title: "Remote notifications enabled" }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not enable notifications",
          description:
            error instanceof Error ? error.message : "Try again after reloading the PWA.",
        }),
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    isConfigLoading,
    retryNotificationSetup,
    notificationPreferences,
    persistRemoteSubscription,
    updateClientSettings,
    vapidPublicKey,
  ]);

  const synchronizeSubscription = useCallback(
    (subscription: PushSubscription) =>
      persistRemoteSubscription(subscription, notificationPreferences),
    [notificationPreferences, persistRemoteSubscription],
  );
  const repairMissingSubscription = useCallback(() => {
    const subscriptionId = subscriptionIdRef.current;
    subscriptionIdRef.current = null;
    window.localStorage.removeItem("t3code.webPushSubscriptionId");
    updatePreferences({ enabled: false });
    if (subscriptionId) {
      void removePwaPushSubscription(subscriptionId).catch(() => {
        // The browser no longer has a subscription to deliver to.
      });
    }
  }, [updatePreferences]);
  usePwaPushSubscriptionSync({
    enabled: notificationPreferences.enabled,
    onSubscription: synchronizeSubscription,
    onMissingSubscription: repairMissingSubscription,
  });

  const disableNotifications = useCallback(() => {
    void unsubscribeBrowserPush();
    const subscriptionId = subscriptionIdRef.current;
    subscriptionIdRef.current = null;
    window.localStorage.removeItem("t3code.webPushSubscriptionId");
    updatePreferences({ enabled: false });
    if (subscriptionId) {
      void removePwaPushSubscription(subscriptionId).catch(() => {
        // Local unsubscription already prevents delivery for this installation.
      });
    }
  }, [updatePreferences]);

  const remoteTest = useCallback(() => {
    const subscriptionId = subscriptionIdRef.current;
    if (!subscriptionId) return;
    void (async () => {
      try {
        await testPwaPushSubscription(subscriptionId);
        toastManager.add(stackedThreadToast({ type: "success", title: "Remote test queued" }));
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not queue remote test",
            description:
              error instanceof Error ? error.message : "Try enabling notifications again.",
          }),
        );
      }
    })();
  }, []);

  const previewNotification = useCallback(() => {
    void showBrowserNotificationPreview()
      .then((nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus === "ready") {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Preview notification sent",
              description: "Check this device's notification center if no banner appears.",
            }),
          );
          return;
        }
        throw new Error("Browser notifications are not ready.");
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not send preview notification",
            description:
              error instanceof Error ? error.message : "Try enabling notifications again.",
          }),
        );
      });
  }, []);

  const statusDescription: Record<BrowserNotificationStatus, string> = {
    unsupported: "Notifications are not supported by this browser or device.",
    "permission-needed": "Allow notifications to enable alerts on this browser or PWA.",
    "permission-blocked": "Notifications are blocked by your browser or system settings.",
    ready: notificationPreferences.enabled
      ? "Notifications are on for this browser or PWA."
      : "Notifications are available on this browser or PWA.",
  };
  const canManagePreferences = status === "ready" && notificationPreferences.enabled;

  return (
    <SettingsSection {...searchableSetting("notifications")}>
      <SettingsRow
        title="Notifications on this device"
        description={statusDescription[status]}
        control={
          <Switch
            checked={notificationPreferences.enabled}
            disabled={status === "unsupported" || isSaving}
            onCheckedChange={(checked) => {
              if (checked) {
                void enableNotifications();
              } else {
                disableNotifications();
              }
            }}
            aria-label="Enable notifications on this device"
          />
        }
      />

      {canManagePreferences ? (
        <>
          <SettingsRow
            title="Preview notification"
            description="Sends a local browser notification on this installation."
            control={
              <Button size="xs" variant="outline" onClick={previewNotification}>
                Send preview
              </Button>
            }
          />
          <SettingsRow
            title="Remote test"
            description="Queues a remote notification for this anonymous PWA installation."
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={subscriptionIdRef.current === null || isSaving}
                onClick={remoteTest}
              >
                Send remote test
              </Button>
            }
          />
          <SettingsRow
            title="Agent finished"
            description="Notify when agent work completes."
            control={
              <Switch
                checked={notificationPreferences.notifyOnCompletion}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnCompletion: Boolean(checked) })
                }
                aria-label="Notify when an agent finishes"
              />
            }
          />
          <SettingsRow
            title="Plan ready"
            description="Notify when an agent proposes a plan for review."
            control={
              <Switch
                checked={notificationPreferences.notifyOnPlanReady}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnPlanReady: Boolean(checked) })
                }
                aria-label="Notify when a plan is ready"
              />
            }
          />
          <SettingsRow
            title="Input needed"
            description="Notify when an agent needs approval or a response."
            control={
              <Switch
                checked={notificationPreferences.notifyOnInput}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnInput: Boolean(checked) })
                }
                aria-label="Notify when agent input is needed"
              />
            }
          />
          <SettingsRow
            title="Agent failed"
            description="Notify when an agent run ends with an error."
            control={
              <Switch
                checked={notificationPreferences.notifyOnFailure}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnFailure: Boolean(checked) })
                }
                aria-label="Notify when an agent fails"
              />
            }
          />
          <SettingsRow
            title="Show project and thread names"
            description="Turn this off to hide work names in notifications and on your lock screen."
            control={
              <Switch
                checked={notificationPreferences.showProjectAndThreadNames}
                onCheckedChange={(checked) =>
                  updatePreferences({ showProjectAndThreadNames: Boolean(checked) })
                }
                aria-label="Show project and thread names in notifications"
              />
            }
          />
          <SettingsRow
            title="Disable notifications"
            description="Turns off notifications for this browser or PWA installation."
            control={
              <Button size="xs" variant="outline" onClick={disableNotifications}>
                Disable
              </Button>
            }
          />
        </>
      ) : null}
      <p className="px-4 pb-2 text-xs text-muted-foreground">
        These settings apply only to this browser or PWA installation, not to your desktop app or
        other devices.
      </p>
    </SettingsSection>
  );
}

export function AgentNotificationSoundRow({
  kind,
  title,
  sounds,
  onChange,
}: {
  readonly kind: AgentNotificationKind;
  readonly title: string;
  readonly sounds: AgentNotificationSounds;
  readonly onChange: (kind: AgentNotificationKind, soundId: AgentNotificationSoundId) => void;
}) {
  const selected = sounds[kind];
  return (
    <SettingsRow
      title={title}
      description="Pick the sound this notification plays, or turn it off with None."
      control={
        <div className="flex w-full items-center gap-2 sm:w-56">
          <Select
            value={selected}
            onValueChange={(value) => onChange(kind, value as AgentNotificationSoundId)}
          >
            <SelectTrigger className="w-full" aria-label={title}>
              <SelectValue>{agentNotificationSoundLabel(selected)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {AGENT_NOTIFICATION_SOUND_IDS.map((soundId) => (
                <SelectItem hideIndicator key={soundId} value={soundId}>
                  {agentNotificationSoundLabel(soundId)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={selected === "none"}
            onClick={() => playAgentNotificationSoundId(selected)}
            aria-label={`Preview ${title}`}
          >
            <PlayIcon className="size-3.5" />
          </Button>
        </div>
      }
    />
  );
}
