import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

/** The live-work adapter supplies this only for its selected Codex patch call. */
export interface OrganizationPatchProcessObserverShape {
  readonly environment: Readonly<Record<string, string>>;
  readonly preparing: () => Effect.Effect<void>;
  readonly spawned: (handle: ChildProcessSpawner.ChildProcessHandle) => Effect.Effect<void>;
  readonly exited: (handle: ChildProcessSpawner.ChildProcessHandle) => Effect.Effect<void>;
}

export class OrganizationPatchProcessObserver extends Context.Reference<OrganizationPatchProcessObserverShape>(
  "t3/textGeneration/OrganizationPatchProcessObserver",
  {
    defaultValue: () => ({
      environment: {},
      preparing: () => Effect.void,
      spawned: () => Effect.void,
      exited: () => Effect.void,
    }),
  },
) {}
