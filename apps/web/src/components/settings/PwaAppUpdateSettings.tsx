import { useState } from "react";
import { isAndroidPwa, isElectron } from "../../env";
import { clearPwaCachesAndReload } from "../../pwa";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function PwaAppUpdateSettings() {
  const [clearing, setClearing] = useState(false);
  if (typeof window === "undefined" || isElectron || isAndroidPwa) return null;
  return (
    <SettingsSection id="app-updates" title="App updates">
      <SettingsRow
        title="Reload the app from the server"
        description="Discards this device's cached app files and fetches the current build. Pairing, environments and settings are untouched."
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={clearing}
            onClick={() => {
              setClearing(true);
              void clearPwaCachesAndReload();
            }}
          >
            {clearing ? "Reloading…" : "Reload from server"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
