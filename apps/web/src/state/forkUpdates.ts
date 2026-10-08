import type {
  ForkMaintenanceActionInput,
  ForkRecoveryRequest,
  ForkUpdatePolicyPatch,
  ForkUpdateStatus,
} from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";
import { isAndroidPwa } from "../env";
import {
  androidUpdateRequest,
  getAndroidUpdateStatus,
  subscribeAndroidUpdates,
  toForkUpdateStatus,
} from "../android/updates";

export interface ForkUpdateAdapter {
  status(): Promise<ForkUpdateStatus>;
  policy(patch: ForkUpdatePolicyPatch): Promise<ForkUpdateStatus>;
  action(input: ForkMaintenanceActionInput): Promise<ForkUpdateStatus>;
  recover(input: ForkRecoveryRequest): Promise<ForkUpdateStatus>;
  subscribe?(listener: (status: ForkUpdateStatus) => void): () => void;
}
export interface ForkUpdateView {
  status: ForkUpdateStatus | null;
  busy: boolean;
  error: string | null;
}
const INITIAL: ForkUpdateView = { status: null, busy: false, error: null };
/** UI requests are serialized here; native/host services alone decide admission and installation. */
export class ForkUpdateController {
  private view: ForkUpdateView = INITIAL;
  private listeners = new Set<() => void>();
  private pending: Promise<unknown> = Promise.resolve();
  private watchers = 0;
  private stopWatching: (() => void) | null = null;
  private actionError: string | null = null;
  readonly adapter: ForkUpdateAdapter;
  constructor(adapter: ForkUpdateAdapter) {
    this.adapter = adapter;
  }
  watch = () => {
    if (this.watchers++ === 0) {
      const refresh = () => {
        if (!this.view.busy) void this.refresh().catch(() => {});
      };
      refresh();
      const unsubscribe = this.adapter.subscribe?.(this.accept);
      const interval = window.setInterval(refresh, 15_000);
      window.addEventListener("focus", refresh);
      this.stopWatching = () => {
        unsubscribe?.();
        window.clearInterval(interval);
        window.removeEventListener("focus", refresh);
      };
    }
    return () => {
      if (--this.watchers === 0) {
        this.stopWatching?.();
        this.stopWatching = null;
      }
    };
  };
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  accept = (status: ForkUpdateStatus) => {
    if (
      status.phase === "completed" &&
      status.currentBuild.artifactSha256 !== this.view.status?.currentBuild.artifactSha256
    )
      this.actionError = null;
    this.view = { ...this.view, status, error: this.actionError };
    this.emit();
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private request(
    run: () => Promise<ForkUpdateStatus>,
    refreshOnly = false,
  ): Promise<ForkUpdateStatus> {
    const next = this.pending.then(async () => {
      // Polls and native status events must not erase a failed button action.
      // An explicit new action replaces its result; a successful poll only clears polling errors.
      if (!refreshOnly) this.actionError = null;
      this.view = { ...this.view, busy: true, error: this.actionError };
      this.emit();
      try {
        const status = await run();
        this.accept(status);
        return status;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Update request failed.";
        if (!refreshOnly) this.actionError = message;
        this.view = {
          ...this.view,
          error: this.actionError ?? message,
        };
        throw error;
      } finally {
        this.view = { ...this.view, busy: false };
        this.emit();
      }
    });
    this.pending = next.catch(() => undefined);
    return next;
  }
  refresh = () => this.request(() => this.adapter.status(), true);
  setPolicy = (patch: ForkUpdatePolicyPatch) => this.request(() => this.adapter.policy(patch));
  action = (input: ForkMaintenanceActionInput) => this.request(() => this.adapter.action(input));
  recover = (request: ForkRecoveryRequest) => this.request(() => this.adapter.recover(request));
}
let local: ForkUpdateController | null = null;
export function localForkUpdateController(): ForkUpdateController | null {
  if (local) return local;
  if (typeof window === "undefined") return null;
  if (isAndroidPwa && window.t3Updates) {
    const call = async (action: Parameters<typeof androidUpdateRequest>[0], payload?: unknown) =>
      toForkUpdateStatus(await androidUpdateRequest(action, payload));
    local = new ForkUpdateController({
      status: async () => toForkUpdateStatus(await getAndroidUpdateStatus()),
      policy: async (patch) => {
        if (patch.pinnedBuild !== undefined)
          await call(patch.pinnedBuild === null ? "resume" : "pin");
        return call("configure", {
          channel: patch.channel,
          automaticInstallation: patch.automaticInstallation,
        });
      },
      action: (input) => call(input.action === "check" ? "check" : "install", input),
      recover: (request) => call("recovery", request),
      subscribe: (listener) =>
        subscribeAndroidUpdates((status) => listener(toForkUpdateStatus(status))),
    });
  } else {
    const bridge = window.desktopBridge;
    if (
      !bridge?.getMaintenanceStatus ||
      !bridge.updateMaintenancePolicy ||
      !bridge.runMaintenanceAction ||
      !bridge.requestMaintenanceRecovery
    )
      return null;
    local = new ForkUpdateController({
      status: bridge.getMaintenanceStatus,
      policy: bridge.updateMaintenancePolicy,
      action: bridge.runMaintenanceAction,
      recover: bridge.requestMaintenanceRecovery,
      ...(bridge.onMaintenanceStatus ? { subscribe: bridge.onMaintenanceStatus } : {}),
    });
  }
  return local;
}
export function useForkUpdates(controller: ForkUpdateController | null) {
  const view = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => INITIAL),
    () => INITIAL,
  );
  useEffect(() => controller?.watch(), [controller]);
  return view;
}
