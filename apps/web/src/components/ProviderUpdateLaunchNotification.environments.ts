import { useMemo } from "react";

import { getPrimaryKnownEnvironment } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useServerConfig } from "../rpc/serverState";
import {
  buildLocalEnvironmentUpdateGroups,
  deriveEnvironmentDisplayLabel,
  parseWslDistroFromInstanceId,
  type EnvironmentUpdateConnectionState,
  type LocalEnvironmentProvidersInput,
  type LocalEnvironmentUpdateGroup,
} from "./ProviderUpdateLaunchNotification.logic";

function normalizeConnectionState(state: string | undefined): EnvironmentUpdateConnectionState {
  switch (state) {
    case "connected":
      return "ready";
    case "connecting":
      return "connecting";
    case "error":
      return "error";
    case "disconnected":
      return "disconnected";
    default:
      // A desktopLocal record exists but its runtime has not been initialized
      // yet — treat it as still settling so the popover waits for it.
      return "connecting";
  }
}

/**
 * Reactively enumerate the enabled local environments (the primary plus any
 * desktopLocal secondary such as WSL) with each one's outdated one-click
 * candidates and a flag for whether any is still connecting. Drives the launch
 * popover's gating and its per-environment update triggers.
 */
export function useLocalEnvironmentUpdateGroups(): {
  readonly groups: LocalEnvironmentUpdateGroup[];
  readonly isAnySettling: boolean;
} {
  const primaryConfig = useServerConfig();
  const registryById = useSavedEnvironmentRegistryStore((store) => store.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((store) => store.byId);

  return useMemo(() => {
    const environments: LocalEnvironmentProvidersInput[] = [];

    const primary = getPrimaryKnownEnvironment();
    const primaryEnvironmentId = primary?.environmentId;
    if (primary && primaryEnvironmentId) {
      environments.push({
        environmentId: primaryEnvironmentId,
        // Label by platform so the row reads "Windows"/"WSL", not the account name.
        label: deriveEnvironmentDisplayLabel({
          isWsl: false,
          wslDistro: null,
          platformOs: primaryConfig?.environment?.platform?.os,
          fallbackLabel: primary.label,
        }),
        isPrimary: true,
        // The primary is the backend serving this renderer, so it is ready
        // whenever its providers are available.
        connectionState: "ready",
        providers: primaryConfig?.providers ?? [],
      });
    }

    for (const record of Object.values(registryById)) {
      // Local secondaries only (the WSL backend); skip SSH / relay / remote and
      // never the primary twice.
      if (!record.desktopLocal || record.environmentId === primaryEnvironmentId) {
        continue;
      }
      const runtime = runtimeById[record.environmentId];
      const instanceId = record.desktopLocal.instanceId;
      environments.push({
        environmentId: record.environmentId,
        label: deriveEnvironmentDisplayLabel({
          isWsl: instanceId.startsWith("wsl:"),
          wslDistro: parseWslDistroFromInstanceId(instanceId),
          platformOs: runtime?.descriptor?.platform?.os,
          fallbackLabel: record.label,
        }),
        isPrimary: false,
        connectionState: normalizeConnectionState(runtime?.connectionState),
        providers: runtime?.serverConfig?.providers ?? [],
      });
    }

    return buildLocalEnvironmentUpdateGroups(environments);
  }, [primaryConfig, registryById, runtimeById]);
}
