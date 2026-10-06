import { useEffect, useMemo, useState } from "react";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@t3tools/contracts";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { usePreparedConnection } from "../state/session";
import { androidNotificationRequest, supportsAndroidNotifications } from "./notifications";

export function AndroidNotificationCoordinator() {
  const { isReady, environments } = useEnvironments();
  const preferences = useClientSettings((settings) => settings.agentNotifications);
  const ids = useMemo(
    () =>
      environments
        .filter((environment) => environment.entry.enabled)
        .map((environment) => environment.environmentId),
    [environments],
  );
  const configuration = JSON.stringify({ preferences, environmentIds: ids });
  const [configured, setConfigured] = useState<string | null>(null);
  useEffect(() => {
    if (!isReady || !supportsAndroidNotifications()) return;
    let current = true;
    void androidNotificationRequest("configure", JSON.parse(configuration))
      .then(() => {
        if (current) setConfigured(configuration);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [isReady, configuration]);
  // Configure the native allowlist before copying credentials; stale registrations
  // cannot resurrect an environment after it has been disabled or removed.
  if (
    !isReady ||
    !preferences.enabled ||
    configured !== configuration ||
    !supportsAndroidNotifications()
  )
    return null;
  return ids.map((environmentId) => (
    <RegisterEnvironment key={environmentId} environmentId={environmentId} />
  ));
}

function RegisterEnvironment({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const prepared = usePreparedConnection(environmentId);
  useEffect(() => {
    if (Option.isNone(prepared)) return;
    const connection = prepared.value;
    const authorization = connection.httpAuthorization;
    // Direct pairing credentials can reconnect without a signed-in cloud account.
    // DPoP connections need a different native token-refresh path and are not copied.
    if (authorization?._tag !== "Bearer") return;
    void androidNotificationRequest("register", {
      environmentId,
      httpBaseUrl: connection.httpBaseUrl,
      token: authorization.token,
    }).catch(() => {});
  }, [environmentId, prepared]);
  return null;
}
