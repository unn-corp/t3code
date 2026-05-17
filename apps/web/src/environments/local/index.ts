// Reconciles desktop-managed secondary local environments (today: the
// WSL backend when the user enables it) with what's currently in the
// saved-environment runtime registry.
//
// Why this lives alongside the saved-env machinery rather than inside
// `apps/web/src/environments/primary/`:
//   - It needs the same per-env bearer-token transport as remote
//     saved envs. The primary path is cookie-based and same-origin;
//     a WSL backend at a different localhost port is cross-origin
//     for cookies but fine for `Authorization: Bearer ...`.
//   - Reusing `ensureSavedEnvironmentConnection` plus the existing
//     saved-env stores means the env switcher, sidebar lists, project
//     env-id routing, and connection lifecycle pick these up without
//     a parallel set of UI surfaces.
//   - The persistence layer for saved envs filters records carrying
//     `desktopLocal`, so toggling the WSL backend off or switching
//     distros doesn't leave stale entries in the user's settings file
//     when the desktop bootstrap stops reporting them.
//
// Reconciliation is driven by `getLocalEnvironmentBootstraps()` from
// the desktop bridge. The primary entry (id === "primary") stays
// owned by the primary/ runtime; everything else flows through here.
// On each call, the reconciler:
//   1. Drops registry entries whose desktopLocal.instanceId no longer
//      appears in the bootstraps list.
//   2. Bootstraps + connects new entries that do appear.
// It's safe to call multiple times — pending work is deduped by
// `pendingByInstanceId` and entries already wired up are skipped.

import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopEnvironmentBootstrap,
  type EnvironmentId,
} from "@t3tools/contracts";

import { bootstrapRemoteBearerSession, fetchRemoteEnvironmentDescriptor } from "../remote/api";
import {
  ensureSavedEnvironmentConnection,
  removeSavedEnvironmentByInstance,
} from "../runtime/service";
import {
  getSavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  writeSavedEnvironmentBearerToken,
  type SavedEnvironmentRecord,
} from "../runtime/catalog";

interface PendingRegistration {
  readonly promise: Promise<SavedEnvironmentRecord | null>;
}

const pendingByInstanceId = new Map<string, PendingRegistration>();
let pendingReconcileRun: Promise<void> | null = null;

function readBootstraps(): readonly DesktopEnvironmentBootstrap[] {
  return window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
}

function findRecordByInstanceId(instanceId: string): SavedEnvironmentRecord | null {
  const byId = useSavedEnvironmentRegistryStore.getState().byId;
  for (const record of Object.values(byId)) {
    if (record.desktopLocal?.instanceId === instanceId) {
      return record;
    }
  }
  return null;
}

function isRegisteredForBootstrap(
  bootstrap: DesktopEnvironmentBootstrap,
  record: SavedEnvironmentRecord,
): boolean {
  // The httpBaseUrl is the load-bearing identity field: if the desktop
  // restarts the WSL backend on a new port (e.g. after a port collision)
  // we want to re-register so the renderer points at the new URL.
  return (
    record.desktopLocal?.instanceId === bootstrap.id &&
    record.httpBaseUrl === bootstrap.httpBaseUrl &&
    record.wsBaseUrl === bootstrap.wsBaseUrl
  );
}

async function registerSecondaryLocalEnvironment(
  bootstrap: DesktopEnvironmentBootstrap,
): Promise<SavedEnvironmentRecord | null> {
  if (!bootstrap.httpBaseUrl || !bootstrap.wsBaseUrl) {
    return null;
  }
  const credential = bootstrap.bootstrapToken;
  if (!credential) {
    // No way to authenticate without the shared bootstrap token. The
    // desktop side fills this in for every instance with a config, so
    // a missing token means we're racing the WSL backend's first
    // start; the next reconcile pass will pick it up.
    return null;
  }

  const descriptor = await fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: bootstrap.httpBaseUrl,
  });
  const environmentId = descriptor.environmentId;

  // Drop any stale record pointing at a different bootstrap (URL
  // change, instance-id rename) before writing the new one. We can't
  // just upsert because the old record may have used a different
  // environmentId.
  const stale = findRecordByInstanceId(bootstrap.id);
  if (stale && stale.environmentId !== environmentId) {
    await removeSavedEnvironmentByInstance(stale.environmentId);
  }

  const bearerSession = await bootstrapRemoteBearerSession({
    httpBaseUrl: bootstrap.httpBaseUrl,
    credential,
  });

  const existing = getSavedEnvironmentRecord(environmentId);
  const record: SavedEnvironmentRecord = {
    environmentId,
    label: bootstrap.label,
    wsBaseUrl: bootstrap.wsBaseUrl,
    httpBaseUrl: bootstrap.httpBaseUrl,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastConnectedAt: new Date().toISOString(),
    desktopLocal: { instanceId: bootstrap.id },
  };

  // Order is load-bearing: write the bearer to the secret store before
  // upserting the record. The zustand subscriber on the registry fires
  // a saved-env sync as soon as upsert lands, and that path reads the
  // bearer back out of the secret store via readSavedEnvironmentBearerToken.
  // If we upserted first, the sync could race ahead, find no bearer,
  // and flip the runtime state to "requires-auth" before our explicit
  // ensureSavedEnvironmentConnection call below runs.
  await writeSavedEnvironmentBearerToken(environmentId, bearerSession.sessionToken);
  useSavedEnvironmentRegistryStore.getState().upsert(record);
  await ensureSavedEnvironmentConnection(record, {
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role,
  });
  return record;
}

async function reconcileOnce(): Promise<void> {
  const bootstraps = readBootstraps();
  const secondaries = bootstraps.filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
  const desiredInstanceIds = new Set(secondaries.map((entry) => entry.id));

  // Drop registry entries whose backend instance is gone (user toggled
  // the WSL backend off, switched distros, or the orchestrator
  // unregistered for any other reason).
  const registry = useSavedEnvironmentRegistryStore.getState().byId;
  const stale: EnvironmentId[] = [];
  for (const record of Object.values(registry)) {
    const instanceId = record.desktopLocal?.instanceId;
    if (instanceId !== undefined && !desiredInstanceIds.has(instanceId)) {
      stale.push(record.environmentId);
    }
  }
  for (const environmentId of stale) {
    await removeSavedEnvironmentByInstance(environmentId);
  }

  // Bring up entries we don't have yet. Concurrent reconcile calls
  // share a pending promise per instance id so we don't double-register.
  await Promise.all(
    secondaries.map(async (bootstrap) => {
      const existing = findRecordByInstanceId(bootstrap.id);
      if (existing && isRegisteredForBootstrap(bootstrap, existing)) {
        return;
      }

      const pending = pendingByInstanceId.get(bootstrap.id);
      if (pending) {
        await pending.promise.catch(() => undefined);
        return;
      }

      const promise = registerSecondaryLocalEnvironment(bootstrap)
        .catch((error) => {
          console.error("[LOCAL_SECONDARY] register failed", bootstrap.id, error);
          return null;
        })
        .finally(() => {
          pendingByInstanceId.delete(bootstrap.id);
        });
      pendingByInstanceId.set(bootstrap.id, { promise });
      await promise;
    }),
  );
}

// Public entry point. Idempotent and never throws — internal failures
// get logged and the caller can retry by calling again. Multiple
// concurrent calls share a single underlying reconcile pass.
export function reconcileLocalSecondaryEnvironments(): Promise<void> {
  if (pendingReconcileRun) {
    return pendingReconcileRun;
  }
  const next = reconcileOnce().finally(() => {
    if (pendingReconcileRun === next) {
      pendingReconcileRun = null;
    }
  });
  pendingReconcileRun = next;
  return next;
}
