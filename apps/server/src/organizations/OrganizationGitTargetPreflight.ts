import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  preflightOrganizationGitTarget,
  type OrganizationGitIntegrationRefError,
} from "./OrganizationGitIntegrationRef.ts";

export interface OrganizationGitTargetPreflightInput {
  readonly projectRoot: string;
  readonly targetRef: string;
  readonly baseCommit: string;
}

/** Separately injectable admission check; production uses the Git CAS guard's read-only path. */
export class OrganizationGitTargetPreflight extends Context.Service<
  OrganizationGitTargetPreflight,
  {
    readonly verify: (
      input: OrganizationGitTargetPreflightInput,
    ) => Effect.Effect<void, OrganizationGitIntegrationRefError>;
  }
>()("t3/organizations/OrganizationGitTargetPreflight") {}

export const OrganizationGitTargetPreflightLive = Layer.succeed(OrganizationGitTargetPreflight, {
  verify: preflightOrganizationGitTarget,
});
