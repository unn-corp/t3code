import { useState } from "react";
import {
  openAndroidInstallPermission,
  openAndroidRecovery,
  openAndroidUpdateConfirmationPermission,
} from "../../android/updates";
import { Button } from "../ui/button";
import { isAndroidPwa, isElectron } from "../../env";
import { localForkUpdateController } from "../../state/forkUpdates";
import { ForkUpdateControls } from "./ForkUpdateControls";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Client preferences stay local even when Settings is scoped to a remote environment. */
export function AppUpdateSettings() {
  const [nativeError, setNativeError] = useState<string | null>(null);
  if (!isElectron && !isAndroidPwa) return null;
  const controller = localForkUpdateController();
  return (
    <SettingsSection id="app-updates" title="App updates">
      {isAndroidPwa && controller ? (
        <>
          <SettingsRow
            title="Android installation permission"
            description="Android may require permission and its own installation confirmation. Your connections stay on this phone."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void openAndroidInstallPermission()
                    .then(() => controller.refresh())
                    .catch((error) => setNativeError(error.message));
                }}
              >
                Open Android settings
              </Button>
            }
          />
          <SettingsRow
            title="Update confirmation notifications"
            description="The App updates notification channel must be enabled so Android can request installation confirmation while the app is closed."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void openAndroidUpdateConfirmationPermission()
                    .then(() => controller.refresh())
                    .catch((error) => setNativeError(error.message));
                }}
              >
                Open App updates notification settings
              </Button>
            }
          />
          <SettingsRow
            title="Native recovery"
            description="Recovery also opens from the launcher shortcut when the app interface cannot load."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void openAndroidRecovery().catch((error) => setNativeError(error.message));
                }}
              >
                Open recovery
              </Button>
            }
          />
          <SettingsRow
            title="Cancel a waiting installation"
            description="Withdraw the requested build and defer automatic installation. This does not change your update channel."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void controller
                    .action({ action: "cancel-countdown" })
                    .catch((error) => setNativeError(error.message));
                }}
              >
                Cancel waiting install
              </Button>
            }
          />
          {nativeError ? (
            <p role="alert" className="text-sm text-destructive">
              {nativeError}
            </p>
          ) : null}
        </>
      ) : null}
      {controller ? (
        <ForkUpdateControls controller={controller} device="This device" />
      ) : (
        <SettingsRow
          title="This device"
          description="This build needs the fork updater baseline. Follow the stopped-work bootstrap instructions before installing an update manually."
          control={
            <a
              className="text-xs underline"
              href="https://github.com/unn-corp/t3code/blob/main/docs/user/updating.md"
              target="_blank"
              rel="noreferrer"
            >
              Bootstrap instructions
            </a>
          }
        />
      )}
    </SettingsSection>
  );
}
