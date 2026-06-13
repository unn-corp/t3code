import type {
  EnvironmentId,
  EnvironmentApi,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

import type { EnvironmentConnection, WsRpcClient } from "@t3tools/client-runtime";
import {
  getPrimaryEnvironmentConnection,
  getSavedEnvironmentRuntimeState,
  listSavedEnvironmentRecords,
  readEnvironmentConnection,
} from "./environments/runtime";

const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();

export function createEnvironmentApi(rpcClient: WsRpcClient): EnvironmentApi {
  return {
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      attach: (input, callback, options) =>
        rpcClient.terminal.attach(input as never, callback, options),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onMetadata: (callback, options) => rpcClient.terminal.onMetadata(callback, options),
    },
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
    },
    filesystem: {
      browse: rpcClient.filesystem.browse,
    },
    sourceControl: {
      lookupRepository: rpcClient.sourceControl.lookupRepository,
      cloneRepository: rpcClient.sourceControl.cloneRepository,
      publishRepository: rpcClient.sourceControl.publishRepository,
    },
    vcs: {
      pull: rpcClient.vcs.pull,
      refreshStatus: rpcClient.vcs.refreshStatus,
      onStatus: (input, callback, options) => rpcClient.vcs.onStatus(input, callback, options),
      listRefs: rpcClient.vcs.listRefs,
      createWorktree: rpcClient.vcs.createWorktree,
      removeWorktree: rpcClient.vcs.removeWorktree,
      createRef: rpcClient.vcs.createRef,
      switchRef: rpcClient.vcs.switchRef,
      init: rpcClient.vcs.init,
    },
    git: {
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
    },
    review: {
      getDiffPreview: rpcClient.review.getDiffPreview,
    },
    orchestration: {
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      getArchivedShellSnapshot: rpcClient.orchestration.getArchivedShellSnapshot,
      subscribeShell: (callback, options) =>
        rpcClient.orchestration.subscribeShell(callback, options),
      subscribeThread: (input, callback, options) =>
        rpcClient.orchestration.subscribeThread(input, callback, options),
    },
  };
}

export function readEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (!environmentId) {
    return undefined;
  }

  const overriddenApi = environmentApiOverridesForTests.get(environmentId);
  if (overriddenApi) {
    return overriddenApi;
  }

  const connection = readEnvironmentConnection(environmentId);
  return connection ? createEnvironmentApi(connection.client) : undefined;
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(`Environment API not found for environment ${environmentId}`);
  }
  return api;
}

/**
 * The settled result of dispatching a provider update to a single local
 * backend. `provider` is the matching snapshot from that backend's update
 * payload, carrying its terminal `updateState` (succeeded / unchanged /
 * failed) — `null` only if the backend did not return the targeted instance.
 * Callers use this to detect a secondary backend that *resolved* with a failed
 * or unchanged provider, which a bare promise (rejection-only) would miss.
 */
export interface LocalProviderUpdateOutcome {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | null;
}

function dispatchProviderUpdate(
  connection: EnvironmentConnection,
  isPrimary: boolean,
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
): Promise<LocalProviderUpdateOutcome> {
  return connection.client.server
    .updateProvider({ provider: driver, instanceId })
    .then((payload) => ({
      environmentId: connection.environmentId,
      isPrimary,
      driver,
      instanceId,
      provider:
        payload.providers.find(
          (candidate) => candidate.driver === driver && candidate.instanceId === instanceId,
        ) ?? null,
    }));
}

/** The live connection for a local environment, whether it is the primary or a saved secondary. */
function readLocalEnvironmentConnection(
  environmentId: EnvironmentId,
): EnvironmentConnection | null {
  const primary = getPrimaryEnvironmentConnection();
  return primary.environmentId === environmentId
    ? primary
    : readEnvironmentConnection(environmentId);
}

/**
 * Dispatch a provider update to every connected local backend that has the
 * provider configured — the primary plus any local secondary (e.g. WSL) — and
 * return one in-flight outcome per environment so callers can aggregate results
 * across backends. The update candidate always comes from the primary's
 * provider list, so its instance id is passed in for the primary; each
 * secondary's instance id is looked up from that environment's own server
 * config, since the same driver has a distinct instance id per environment.
 */
export function updateProviderAcrossLocalEnvironments(
  driver: ProviderDriverKind,
  primaryInstanceId: ProviderInstanceId,
): ReadonlyArray<Promise<LocalProviderUpdateOutcome>> {
  const primary = getPrimaryEnvironmentConnection();
  const dispatches: Array<Promise<LocalProviderUpdateOutcome>> = [
    dispatchProviderUpdate(primary, true, driver, primaryInstanceId),
  ];

  for (const record of listSavedEnvironmentRecords()) {
    // Local backends only (skip SSH / relay / remote), and never the primary twice.
    if (!record.desktopLocal || record.environmentId === primary.environmentId) {
      continue;
    }
    const connection = readEnvironmentConnection(record.environmentId);
    if (!connection) {
      continue; // not connected / not settled
    }
    const providers =
      getSavedEnvironmentRuntimeState(record.environmentId).serverConfig?.providers ?? [];
    const match = providers.find((provider) => provider.driver === driver);
    if (!match) {
      continue; // provider not configured in this environment
    }
    dispatches.push(dispatchProviderUpdate(connection, false, driver, match.instanceId));
  }

  return dispatches;
}

/**
 * Dispatch updates to a single local environment — the per-environment trigger
 * behind the launch popover's split "update all" buttons. Each target carries
 * the instance id resolved from that environment's own server config. Returns
 * one in-flight outcome per target (empty if the environment is not connected).
 */
export function updateProvidersInEnvironment(
  environmentId: EnvironmentId,
  targets: ReadonlyArray<{ readonly driver: ProviderDriverKind; readonly instanceId: ProviderInstanceId }>,
): ReadonlyArray<Promise<LocalProviderUpdateOutcome>> {
  const connection = readLocalEnvironmentConnection(environmentId);
  if (!connection) {
    return [];
  }
  const isPrimary = connection.environmentId === getPrimaryEnvironmentConnection().environmentId;
  return targets.map((target) =>
    dispatchProviderUpdate(connection, isPrimary, target.driver, target.instanceId),
  );
}

export function __setEnvironmentApiOverrideForTests(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
): void {
  environmentApiOverridesForTests.set(environmentId, api);
}

export function __resetEnvironmentApiOverridesForTests(): void {
  environmentApiOverridesForTests.clear();
}
